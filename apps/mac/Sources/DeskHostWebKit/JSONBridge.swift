import DeskHost
import Foundation

/// Converts between the Foundation objects WebKit hands to native code
/// (`NSDictionary`, `NSArray`, `NSNumber`, `NSString`, `NSNull`) and
/// DeskHost's `JSONValue`. No text is produced or parsed on either path: the
/// page posts an object, native reads an object, and a reply or event detail
/// goes back as an object.
///
/// Inbound, the bridge refuses what DeskHost's private byte decoder
/// (`JSONValue.decode`) refuses, so a graph posted as an object and the same
/// graph sent as bytes get the same answer: two keys that differ in bytes but
/// compare equal as Swift strings, a number that is not finite, a value JSON
/// cannot carry. Two more refusals exist here because an object graph never
/// passes through `JSONSerialization`, which enforces them for bytes:
/// - nesting deeper than `maxNestingDepth` containers is refused the moment
///   it is seen. The walk below keeps its own stack of open containers
///   instead of recursing, so the native stack never grows with what the
///   page posts (WebKit itself delivers bodies tens of thousands deep
///   intact), on whichever thread the bridge is called. The limit is far
///   below the 512 that `JSONSerialization` allows bytes, deliberately: what
///   the bridge admits goes on to DeskHost's own recursive text-item measure
///   and canonical hash on the protocol actor's thread, whose 512 KB stack a
///   graph some 400 deep overflowed in a debug build (headless probe,
///   2026-10-09), while the deepest shared vector nests 5;
/// - a key or value with an unpaired UTF-16 surrogate (WebKit delivers it
///   intact in an `NSString`; JSONSerialization refuses it as an escape) is
///   refused instead of being carried lazily and repaired to U+FFFD on its
///   way to disk, which would make the served and the durable record differ.
/// A byte budget refuses a graph before it is converted, from a lower bound
/// of its canonical size charged as the walk goes: every container pays its
/// brackets and separators and proves, from its count alone, that its
/// members can fit (one digit each, plus quotes and colon for every key)
/// before any capacity is reserved or any element or key is read; every
/// value then pays its own minimum (a digit, `null`, `true`, `false`, or a
/// string's quotes and UTF-16 length, never more than its UTF-8). Nothing the
/// byte limit admits is refused by the budget, because the charge never
/// exceeds the canonical bytes; the exact canonical measure still runs
/// afterwards in `HostRequestPipeline`. So ten million zeros posted as an
/// array are refused from their count, with no element visited (Codex
/// review of 6052518, W3). The test target checks both decoders agree on
/// every shared vector and on each of these edges.
public enum JSONBridge {
    public enum BridgeError: Error, Equatable, Sendable {
        /// A value JSON cannot carry (a date, data, or any other object).
        case unsupportedValue
        case nonFiniteNumber
        case nonStringKey
        /// Two keys that would collapse into one Swift dictionary entry.
        case duplicateKey
        /// More than `maxNestingDepth` containers deep.
        case tooDeep
        /// A key or value whose UTF-16 has a lone high or low surrogate.
        case unpairedSurrogate
        /// A lower bound of the canonical bytes exceeds the byte budget.
        case tooLarge
    }

    /// Containers deep, counting the envelope itself: room for many times
    /// the deepest agreed payload (5), a wide margin under the depth that
    /// overflows DeskHost's recursion on the actor's thread. Raise it only
    /// together with that measurement.
    public static let maxNestingDepth = 64

    /// Foundation object graph in, `JSONValue` out. Booleans are told apart
    /// from numbers by their CoreFoundation type, exactly as DeskHost does.
    /// `byteBudget` is the most canonical bytes the graph may come to, by
    /// the lower bound described above; an envelope can never legitimately
    /// exceed the default.
    public static func jsonValue(from object: Any, byteBudget: Int = ProofLimits.envelopeBytes) throws -> JSONValue {
        var remaining = byteBudget
        return try convert(object, remaining: &remaining)
    }

    /// Minimal canonical bytes, as `JSONValue.canonicalData()` writes them.
    private enum Cost {
        /// One digit.
        static let number = 1
        static let null = 4
        static let trueValue = 4
        static let falseValue = 5
        /// Around every string and key.
        static let quotes = 2
        /// `[]` or `{}`.
        static let brackets = 2
        /// After every key.
        static let colon = 1
        /// Commas between members.
        static func separators(_ count: Int) -> Int { max(0, count - 1) }
    }

    private static func charge(_ bytes: Int, from remaining: inout Int) throws {
        remaining -= bytes
        guard remaining >= 0 else { throw BridgeError.tooLarge }
    }

    /// One open container on the explicit stack: what is being filled, which
    /// child is being converted, and (for objects) the key it will go under.
    private struct OpenContainer {
        enum Kind {
            case array(NSArray)
            case object(NSDictionary, keys: [Any])
        }

        let kind: Kind
        var index = 0
        var name = ""
        var values: [JSONValue] = []
        var fields: [String: JSONValue] = [:]
    }

    private static func convert(_ root: Any, remaining: inout Int) throws -> JSONValue {
        var open: [OpenContainer] = []
        var next: Any = root
        descend: while true {
            // 1. `next` becomes a value, or opens a container and descends
            //    into its first child.
            var value: JSONValue
            switch next {
            case let dictionary as NSDictionary:
                guard open.count < maxNestingDepth else { throw BridgeError.tooDeep }
                // From the count alone, before the keys are copied or any
                // capacity reserved: braces, commas, and for every member its
                // quotes, colon and at least one byte of value.
                let count = dictionary.count
                let structure = Cost.brackets + Cost.separators(count) + count * (Cost.quotes + Cost.colon)
                guard remaining >= structure + count * Cost.number else { throw BridgeError.tooLarge }
                try charge(structure, from: &remaining)
                let keys = dictionary.allKeys
                if let first = keys.first {
                    var container = OpenContainer(kind: .object(dictionary, keys: keys))
                    container.name = try name(of: first, remaining: &remaining)
                    container.fields.reserveCapacity(keys.count)
                    open.append(container)
                    next = try child(of: dictionary, at: first)
                    continue descend
                }
                value = .object([:])
            case let array as NSArray:
                guard open.count < maxNestingDepth else { throw BridgeError.tooDeep }
                // From the count alone, before any element is read or any
                // capacity reserved: brackets, commas, one byte per element.
                let count = array.count
                let structure = Cost.brackets + Cost.separators(count)
                guard remaining >= structure + count * Cost.number else { throw BridgeError.tooLarge }
                try charge(structure, from: &remaining)
                if count > 0 {
                    var container = OpenContainer(kind: .array(array))
                    container.values.reserveCapacity(count)
                    open.append(container)
                    next = array[0]
                    continue descend
                }
                value = .array([])
            case let number as NSNumber:
                if CFGetTypeID(number) == CFBooleanGetTypeID() {
                    let flag = number.boolValue
                    try charge(flag ? Cost.trueValue : Cost.falseValue, from: &remaining)
                    value = .bool(flag)
                } else {
                    let double = number.doubleValue
                    guard double.isFinite else { throw BridgeError.nonFiniteNumber }
                    try charge(Cost.number, from: &remaining)
                    value = .number(double)
                }
            case let string as NSString:
                value = .string(try text(string, extra: Cost.quotes, remaining: &remaining))
            case is NSNull:
                try charge(Cost.null, from: &remaining)
                value = .null
            default:
                throw BridgeError.unsupportedValue
            }
            // 2. The value goes into the innermost open container; a container
            //    that is now complete becomes the value for the one below it.
            while true {
                guard !open.isEmpty else { return value }
                let top = open.count - 1
                let following = open[top].index + 1
                switch open[top].kind {
                case .array(let array):
                    open[top].values.append(value)
                    if following < array.count {
                        open[top].index = following
                        next = array[following]
                        continue descend
                    }
                    value = .array(open[top].values)
                case .object(let dictionary, let keys):
                    guard open[top].fields.updateValue(value, forKey: open[top].name) == nil else { throw BridgeError.duplicateKey }
                    if following < keys.count {
                        open[top].index = following
                        open[top].name = try name(of: keys[following], remaining: &remaining)
                        next = try child(of: dictionary, at: keys[following])
                        continue descend
                    }
                    value = .object(open[top].fields)
                }
                open.removeLast()
            }
        }
    }

    /// A key's quotes and colon were charged when its object was opened.
    private static func name(of key: Any, remaining: inout Int) throws -> String {
        guard let key = key as? NSString else { throw BridgeError.nonStringKey }
        return try text(key, extra: 0, remaining: &remaining)
    }

    private static func child(of dictionary: NSDictionary, at key: Any) throws -> Any {
        guard let child = dictionary.object(forKey: key) else { throw BridgeError.unsupportedValue }
        return child
    }

    /// Charges `extra` and the UTF-16 length (never more than the UTF-8 the
    /// canonical form writes) to the budget, and checks the units WebKit
    /// delivered before bridging, so a lone surrogate never becomes a Swift
    /// string here.
    private static func text(_ string: NSString, extra: Int, remaining: inout Int) throws -> String {
        try charge(extra + string.length, from: &remaining)
        guard !containsUnpairedSurrogate(string) else { throw BridgeError.unpairedSurrogate }
        return string as String
    }

    /// True when any high surrogate is not followed by a low one, or a low
    /// one is not preceded by a high one. Reads the `NSString`'s own units;
    /// a bridged Swift string may already have repaired them.
    public static func containsUnpairedSurrogate(_ string: NSString) -> Bool {
        let length = string.length
        guard length > 0 else { return false }
        var units = [unichar](repeating: 0, count: length)
        string.getCharacters(&units, range: NSRange(location: 0, length: length))
        var index = 0
        while index < length {
            let unit = units[index]
            if UTF16.isLeadSurrogate(unit) {
                guard index + 1 < length, UTF16.isTrailSurrogate(units[index + 1]) else { return true }
                index += 2
            } else if UTF16.isTrailSurrogate(unit) {
                return true
            } else {
                index += 1
            }
        }
        return false
    }

    /// `JSONValue` in, Foundation objects out, in the shapes WebKit converts
    /// to plain JavaScript values: `NSDictionary` becomes an ordinary object,
    /// `NSArray` an array, `kCFBooleanTrue`/`kCFBooleanFalse` a boolean (a
    /// plain `NSNumber` would arrive as `1`/`0`), `NSNull` becomes `null`.
    public static func foundationObject(from value: JSONValue) -> Any {
        switch value {
        case .null:
            return NSNull()
        case .bool(let flag):
            return flag ? kCFBooleanTrue as Any : kCFBooleanFalse as Any
        case .number(let number):
            return NSNumber(value: number)
        case .string(let string):
            return NSString(string: string)
        case .array(let values):
            return NSArray(array: values.map(foundationObject(from:)))
        case .object(let fields):
            let dictionary = NSMutableDictionary(capacity: fields.count)
            for (key, field) in fields { dictionary[NSString(string: key)] = foundationObject(from: field) }
            return NSDictionary(dictionary: dictionary)
        }
    }
}
