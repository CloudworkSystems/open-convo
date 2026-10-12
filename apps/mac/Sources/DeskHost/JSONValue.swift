import Foundation

/// JSON the host carries without interpreting. Numbers follow the JavaScript
/// model (one IEEE double), so an integer above 2^53 is not exact here any more
/// than it is in the Desk; the contract only admits safe integers where the host
/// reads a number itself (revisions, generations).
///
/// Depth is bounded, and no walk in this file recurses. The protocol actor runs
/// on a cooperative thread with a 512 KB stack, and a recursive walk over a
/// few hundred nested containers overflowed it (October 9 glue review). So:
/// decoding reads UTF-8 only, refuses more than `maxNestingDepth` containers
/// before the parser runs, and bridges the parser's graph with an explicit
/// stack; equality, the canonical writer (behind the payload hash and record
/// size), the text-item scan and the depth measure all iterate over explicit
/// stacks. The one recursive path left is `Codable`,
/// whose `Decoder`/`Encoder` frames belong to Foundation: `init(from:)` refuses
/// a container past the same depth through `codingPath`, and every file the
/// store reads is passed through `decode(_:)` before `JSONDecoder` sees it, so
/// neither side of `Codable` ever meets input deeper than the limit.
public enum JSONValue: Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

public enum JSONValueError: Error, Equatable, Sendable {
    case malformed
    /// Two keys in one object that differ in bytes but compare equal as Swift
    /// strings; storing them would silently drop one entry.
    case duplicateKey
    /// More than `JSONValue.maxNestingDepth` nested containers.
    case tooDeep
}

public extension JSONValue {
    /// Most containers (arrays and objects) on any path from the root, the root
    /// container included: 64, the same cap the WebKit glue's bridge applies to
    /// a page message. A request envelope is its own root, so a payload may be
    /// 63 deep and the record inside a commit 62.
    static let maxNestingDepth = 64

    /// Parses request bytes. This is the request path, used instead of
    /// `Decodable` because `JSONDecoder` builds Swift dictionaries, and Swift
    /// compares strings by canonical equivalence: a precomposed and a decomposed
    /// "é" are one key to it and two keys to JavaScript, so one value would
    /// vanish from an "opaque" snapshot. Here every key the sender wrote is
    /// seen, and an object whose keys would collapse is refused. Byte-identical
    /// duplicate keys resolve to one value in the parser (JSON.stringify never
    /// emits them). Numbers that are not finite are refused.
    ///
    /// Depth is refused before the parser runs: a single pass over the bytes
    /// counts container openers outside strings, so a blob nested thousands
    /// deep is turned away without being parsed or walked. The bridge then
    /// enforces the same limit on the parsed graph with an explicit stack.
    ///
    /// The bytes are UTF-8 or nothing. `JSONSerialization` recognises UTF-16
    /// and UTF-32 from their byte-order marks and from the NUL bytes their
    /// ASCII characters carry, and would then parse a graph the UTF-8 byte
    /// scan never counted (a UTF-16 key holding a backslash byte blinds the
    /// scan to every bracket after it; October 9 host review). So bytes that
    /// cannot be UTF-8 JSON are refused first, and the scan and the parser
    /// read the same text.
    static func decode(_ data: Data) throws -> JSONValue {
        guard encodingIsUTF8(data) else { throw JSONValueError.malformed }
        guard nestingFitsLimit(data) else { throw JSONValueError.tooDeep }
        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            throw JSONValueError.malformed
        }
        return try bridge(raw, maxDepth: maxNestingDepth)
    }

    /// True when the parser will read the bytes as UTF-8: no NUL byte and no
    /// 0xFE or 0xFF byte anywhere. UTF-8 JSON text never holds either (a
    /// control character inside a string must be escaped, NUL is not
    /// whitespace, and 0xFE/0xFF are never UTF-8), so nothing valid is lost.
    /// Every UTF-16 and UTF-32 form of a JSON text holds NUL bytes, because
    /// its structural characters are ASCII, and its byte-order marks are
    /// `FE FF` and `FF FE`; those are exactly what `JSONSerialization` sniffs
    /// to switch encodings. One pass, no recursion, no allocation.
    static func encodingIsUTF8(_ data: Data) -> Bool {
        !data.contains { $0 == 0x00 || $0 >= 0xFE }
    }

    /// True when the bytes open at most `maxNestingDepth` containers along any
    /// path. Valid JSON opens a container only with `[` or `{` outside a
    /// string, so for valid input this is the exact depth; for invalid input
    /// the count is meaningless and the parser refuses the bytes anyway. No
    /// recursion, no allocation. Every byte that matters is ASCII, so in
    /// UTF-8 (which `encodingIsUTF8` has established by the time this runs) a
    /// multi-byte sequence can never be mistaken for one.
    static func nestingFitsLimit(_ data: Data) -> Bool {
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) -> Bool in
            var depth = 0
            var inString = false
            var escaped = false
            for byte in bytes {
                if inString {
                    if escaped {
                        escaped = false
                    } else if byte == 0x5C { // backslash
                        escaped = true
                    } else if byte == 0x22 { // quote
                        inString = false
                    }
                    continue
                }
                switch byte {
                case 0x22: // quote
                    inString = true
                case 0x5B, 0x7B: // [ {
                    depth += 1
                    if depth > maxNestingDepth { return false }
                case 0x5D, 0x7D: // ] }
                    depth -= 1
                default:
                    break
                }
            }
            return true
        }
    }

    /// Containers on the deepest path through this value, counting this value
    /// when it is one; 0 for a scalar. Iterative.
    var nestingDepth: Int {
        var deepest = 0
        var pending: [(value: JSONValue, depth: Int)] = [(self, 1)]
        while let (value, depth) = pending.popLast() {
            switch value {
            case .null, .bool, .number, .string:
                break
            case .array(let values):
                deepest = max(deepest, depth)
                for value in values { pending.append((value, depth + 1)) }
            case .object(let values):
                deepest = max(deepest, depth)
                for value in values.values { pending.append((value, depth + 1)) }
            }
        }
        return deepest
    }
}

// MARK: Bridging the parser's graph

extension JSONValue {
    /// Builds the tree from `JSONSerialization`'s object graph with an explicit
    /// stack of unfinished containers, so the depth of the input never becomes
    /// call depth. `maxDepth` counts the root container as 1; a container that
    /// would be the `maxDepth + 1`th is refused as `tooDeep` the moment it is
    /// met, before anything under it is looked at.
    static func bridge(_ root: Any, maxDepth: Int) throws -> JSONValue {
        if let leaf = try leaf(root) { return leaf }
        guard maxDepth >= 1 else { throw JSONValueError.tooDeep }
        var stack: [BridgeFrame] = [try BridgeFrame(root)]
        while true {
            let top = stack.count - 1
            if let child = stack[top].next() {
                if let leaf = try leaf(child) {
                    try stack[top].append(leaf)
                } else {
                    guard stack.count < maxDepth else { throw JSONValueError.tooDeep }
                    stack.append(try BridgeFrame(child))
                }
            } else {
                let finished = stack.removeLast().value
                if stack.isEmpty { return finished }
                try stack[stack.count - 1].append(finished)
            }
        }
    }

    /// A scalar as a value, a container as nil, anything else refused.
    private static func leaf(_ raw: Any) throws -> JSONValue? {
        switch raw {
        case is NSDictionary, is NSArray:
            return nil
        case let number as NSNumber:
            // Booleans arrive as NSNumber too; the type id tells them apart
            // before 0 and 1 could be mistaken for false and true.
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            let value = number.doubleValue
            guard value.isFinite else { throw JSONValueError.malformed }
            return .number(value)
        case let string as String:
            return .string(string)
        case is NSNull:
            return .null
        default:
            throw JSONValueError.malformed
        }
    }

    /// One container under construction: its children still to visit and the
    /// values built so far.
    private struct BridgeFrame {
        private let isObject: Bool
        private let keys: [String]
        private let children: [Any]
        private var index = 0
        private var currentKey = ""
        private var array: [JSONValue] = []
        private var object: [String: JSONValue] = [:]

        init(_ raw: Any) throws {
            if let dictionary = raw as? NSDictionary {
                isObject = true
                var keys: [String] = []
                var children: [Any] = []
                keys.reserveCapacity(dictionary.count)
                children.reserveCapacity(dictionary.count)
                for (key, value) in dictionary {
                    guard let key = key as? String else { throw JSONValueError.malformed }
                    keys.append(key)
                    children.append(value)
                }
                self.keys = keys
                self.children = children
                object.reserveCapacity(dictionary.count)
            } else if let array = raw as? NSArray {
                isObject = false
                keys = []
                children = array.map { $0 }
                self.array.reserveCapacity(array.count)
            } else {
                throw JSONValueError.malformed
            }
        }

        mutating func next() -> Any? {
            guard index < children.count else { return nil }
            if isObject { currentKey = keys[index] }
            defer { index += 1 }
            return children[index]
        }

        mutating func append(_ value: JSONValue) throws {
            if isObject {
                guard object.updateValue(value, forKey: currentKey) == nil else { throw JSONValueError.duplicateKey }
            } else {
                array.append(value)
            }
        }

        var value: JSONValue { isObject ? .object(object) : .array(array) }
    }
}

// MARK: Equality

extension JSONValue: Equatable {
    /// Structural equality over an explicit stack of pairs, so comparing two
    /// deep records (replay checks, tests) never recurses.
    public static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        var pending: [(JSONValue, JSONValue)] = [(lhs, rhs)]
        while let (left, right) = pending.popLast() {
            switch (left, right) {
            case (.null, .null):
                continue
            case (.bool(let a), .bool(let b)):
                guard a == b else { return false }
            case (.number(let a), .number(let b)):
                guard a == b else { return false }
            case (.string(let a), .string(let b)):
                guard a == b else { return false }
            case (.array(let a), .array(let b)):
                guard a.count == b.count else { return false }
                pending.append(contentsOf: zip(a, b))
            case (.object(let a), .object(let b)):
                guard a.count == b.count else { return false }
                for (key, value) in a {
                    guard let other = b[key] else { return false }
                    pending.append((value, other))
                }
            default:
                return false
            }
        }
        return true
    }
}

/// `Codable` is for host-written files (state, retained attempts, manifests)
/// and typed tests. It collapses canonically equivalent keys; requests go
/// through `JSONValue.decode(_:)` instead. Both directions recurse inside
/// Foundation's coder, one frame per container: `init(from:)` refuses a
/// container past `maxNestingDepth` by its coding path, and the store runs
/// every file through the bounded `decode(_:)` first, so `JSONDecoder` never
/// parses deeper input either. `encode(to:)` only ever sees values the host
/// admitted under the same limit.
extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else {
            // The root's coding path is empty, so a container reached through
            // `maxNestingDepth` keys would be the one too many.
            guard decoder.codingPath.count < Self.maxNestingDepth else {
                throw DecodingError.dataCorruptedError(
                    in: container, debugDescription: "JSON nested deeper than \(Self.maxNestingDepth) containers")
            }
            if let array = try? container.decode([JSONValue].self) {
                self = .array(array)
            } else if let object = try? container.decode([String: JSONValue].self) {
                self = .object(object)
            } else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
            }
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

public extension JSONValue {
    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// A nonnegative integer at or below `ProofLimits.maxSafeInteger`.
    var safeIntegerValue: Int? {
        guard case .number(let value) = self, value.isFinite, value >= 0, value == value.rounded(),
              value <= Double(ProofLimits.maxSafeInteger) else { return nil }
        return Int(value)
    }

    /// A canonical lowercase UUIDv4 string (native-issued identities).
    var canonicalUUIDv4Value: UUID? {
        guard case .string(let value) = self else { return nil }
        return UUID.canonicalV4(value)
    }

    /// An existing DeskState record id (RFC 4122 v1-5, case preserved),
    /// returned exactly as written.
    var recordIdValue: String? {
        guard case .string(let value) = self, UUID.isRecordId(value) else { return nil }
        return value
    }

    /// A nonempty opaque string (connection ids, workspace handles).
    var opaqueStringValue: String? {
        guard case .string(let value) = self, !value.isEmpty else { return nil }
        return value
    }

    /// Longest UTF-8 string anywhere in the tree, keys included. Iterative.
    var longestTextItemBytes: Int {
        var longest = 0
        var pending: [JSONValue] = [self]
        while let value = pending.popLast() {
            switch value {
            case .null, .bool, .number:
                break
            case .string(let text):
                longest = max(longest, text.utf8.count)
            case .array(let values):
                pending.append(contentsOf: values)
            case .object(let values):
                for (key, value) in values {
                    longest = max(longest, key.utf8.count)
                    pending.append(value)
                }
            }
        }
        return longest
    }

    /// Deterministic bytes: sorted keys, no whitespace, integers without a
    /// fraction. Two equal values always produce the same bytes, which is all
    /// the replay ledger needs from a payload hash.
    func canonicalData() -> Data {
        var output = ""
        writeCanonical(into: &output)
        return Data(output.utf8)
    }

}

private extension JSONValue {
    /// One container being written: its children in output order, the keys
    /// that precede them for an object, and the bracket that closes it.
    struct CanonicalFrame {
        let closer: String
        let keys: [String]?
        let values: [JSONValue]
        var index = 0
    }

    /// Writes the value with an explicit stack of open containers, one frame
    /// per level, so a deep record costs heap, never stack.
    func writeCanonical(into output: inout String) {
        var stack: [CanonicalFrame] = []
        Self.open(self, into: &output, stack: &stack)
        while let top = stack.indices.last {
            let index = stack[top].index
            guard index < stack[top].values.count else {
                output += stack[top].closer
                stack.removeLast()
                continue
            }
            stack[top].index += 1
            if index > 0 { output += "," }
            if let keys = stack[top].keys {
                Self.writeEscaped(keys[index], into: &output)
                output += ":"
            }
            let child = stack[top].values[index]
            Self.open(child, into: &output, stack: &stack)
        }
    }

    /// Writes a scalar whole; for a container writes its opening bracket and
    /// pushes the frame that will write its contents and close it.
    static func open(_ value: JSONValue, into output: inout String, stack: inout [CanonicalFrame]) {
        switch value {
        case .null:
            output += "null"
        case .bool(let value):
            output += value ? "true" : "false"
        case .number(let value):
            if value.isFinite, value == value.rounded(), abs(value) <= Double(ProofLimits.maxSafeInteger) {
                output += String(Int64(value))
            } else {
                output += "\(value)"
            }
        case .string(let value):
            writeEscaped(value, into: &output)
        case .array(let values):
            output += "["
            stack.append(CanonicalFrame(closer: "]", keys: nil, values: values))
        case .object(let values):
            output += "{"
            let keys = values.keys.sorted()
            stack.append(CanonicalFrame(closer: "}", keys: keys, values: keys.map { values[$0]! }))
        }
    }

    static func writeEscaped(_ string: String, into output: inout String) {
        output += "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            case "\u{08}": output += "\\b"
            case "\u{0C}": output += "\\f"
            default:
                if scalar.value < 0x20 {
                    output += String(format: "\\u%04x", scalar.value)
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        output += "\""
    }
}
