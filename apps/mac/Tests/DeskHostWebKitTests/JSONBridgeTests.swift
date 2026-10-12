import DeskHost
import DeskHostWebKit
import Foundation
import XCTest

final class JSONBridgeTests: XCTestCase {
    /// Every shared vector, bridged from the Foundation objects WebKit would
    /// hand over, equals what DeskHost's own byte decoder produces.
    func testBridgedSharedVectorsMatchByteDecoder() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "native-host-v1", withExtension: "json"))
        let bytes = try Data(contentsOf: url)
        let expected = try JSONValue.decode(bytes)
        let objects = try JSONSerialization.jsonObject(with: bytes)
        XCTAssertEqual(try JSONBridge.jsonValue(from: objects), expected)
        guard case .object(let root) = expected, case .array(let cases)? = root["cases"] else { return XCTFail("fixture shape") }
        XCTAssertEqual(cases.count, 6, "the five page operations plus the commit that carries a dictation delivery")
        for item in cases {
            guard case .object(let fields) = item, let request = fields["request"], let reply = fields["reply"] else { return XCTFail("case shape") }
            XCTAssertEqual(try JSONBridge.jsonValue(from: JSONBridge.foundationObject(from: request)), request)
            XCTAssertEqual(try JSONBridge.jsonValue(from: JSONBridge.foundationObject(from: reply)), reply)
        }
    }

    func testBooleansAndNumbersAreToldApart() throws {
        let object: NSDictionary = ["flag": true, "one": 1, "zero": 0, "off": false, "pi": 3.5, "big": 9_007_199_254_740_991]
        let value = try JSONBridge.jsonValue(from: object)
        XCTAssertEqual(value, .object([
            "flag": .bool(true), "one": .number(1), "zero": .number(0), "off": .bool(false), "pi": .number(3.5),
            "big": .number(9_007_199_254_740_991)
        ]))
    }

    func testBridgedBooleansStayBooleansForJavaScript() throws {
        let bridged = try XCTUnwrap(JSONBridge.foundationObject(from: .object(["t": .bool(true), "f": .bool(false), "n": .number(1)])) as? NSDictionary)
        for key in ["t", "f"] {
            let number = try XCTUnwrap(bridged[key] as? NSNumber)
            XCTAssertEqual(CFGetTypeID(number), CFBooleanGetTypeID(), "\(key) must be a CFBoolean, not a plain number")
        }
        let one = try XCTUnwrap(bridged["n"] as? NSNumber)
        XCTAssertNotEqual(CFGetTypeID(one), CFBooleanGetTypeID())
        XCTAssertTrue(JSONBridge.foundationObject(from: .null) is NSNull)
        XCTAssertTrue(JSONBridge.foundationObject(from: .array([.string("a")])) is NSArray)
        XCTAssertTrue(JSONBridge.foundationObject(from: .string("a")) is NSString)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(JSONBridge.foundationObject(from: .object(["k": .array([.null, .number(2)])]))))
    }

    func testNestedGraphsRoundTrip() throws {
        let value: JSONValue = .object([
            "record": .object(["revision": .number(3), "items": .array([.string("é"), .null, .bool(false), .object([:])])]),
            "empty": .array([])
        ])
        XCTAssertEqual(try JSONBridge.jsonValue(from: JSONBridge.foundationObject(from: value)), value)
    }

    func testRefusesWhatJSONCannotCarry() {
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: NSDictionary(dictionary: ["when": Date()]))) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .unsupportedValue)
        }
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: NSDictionary(dictionary: ["n": Double.nan]))) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .nonFiniteNumber)
        }
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: NSDictionary(dictionary: ["n": Double.infinity]))) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .nonFiniteNumber)
        }
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: NSDictionary(dictionary: [NSNumber(value: 1): "x"]))) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .nonStringKey)
        }
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: Data([1, 2]))) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .unsupportedValue)
        }
    }

    /// The bridge stops at `maxNestingDepth` containers, for arrays and
    /// objects alike; the byte decoder's `JSONSerialization` goes on to 512.
    /// The gap is deliberate (see `JSONBridge`): what the bridge admits must
    /// also survive DeskHost's recursion on the actor's thread, which the
    /// headless proof checks at the edge. A graph far beyond either limit
    /// is a refusal, not a stack overflow.
    func testNestingIsBoundedAtTheSameDepthAsTheByteDecoder() throws {
        func arrays(_ depth: Int) -> Any { var value: Any = 1; for _ in 0..<depth { value = NSArray(object: value) }; return value }
        func objects(_ depth: Int) -> Any {
            var value: Any = 1
            for _ in 0..<depth { value = NSDictionary(object: value, forKey: "a" as NSString) }
            return value
        }
        func arrayBytes(_ depth: Int) -> Data { Data((String(repeating: "[", count: depth) + "1" + String(repeating: "]", count: depth)).utf8) }
        func objectBytes(_ depth: Int) -> Data { Data((String(repeating: "{\"a\":", count: depth) + "1" + String(repeating: "}", count: depth)).utf8) }
        let limit = JSONBridge.maxNestingDepth
        XCTAssertEqual(limit, 64)
        XCTAssertEqual(try JSONBridge.jsonValue(from: arrays(limit)), try JSONValue.decode(arrayBytes(limit)))
        XCTAssertEqual(try JSONBridge.jsonValue(from: objects(limit)), try JSONValue.decode(objectBytes(limit)))
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: arrays(limit + 1))) { XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooDeep) }
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: objects(limit + 1))) { XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooDeep) }
        // Since main f281228 the byte decoder refuses past the same 64 containers
        // (before JSONSerialization runs), so both paths share one depth limit.
        XCTAssertThrowsError(try JSONValue.decode(arrayBytes(limit + 1))) { XCTAssertEqual($0 as? JSONValueError, .tooDeep) }
        XCTAssertThrowsError(try JSONValue.decode(objectBytes(limit + 1))) { XCTAssertEqual($0 as? JSONValueError, .tooDeep) }
        XCTAssertThrowsError(try JSONValue.decode(arrayBytes(512))) { XCTAssertEqual($0 as? JSONValueError, .tooDeep) }
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: arrays(512))) { XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooDeep) }
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: arrays(20_000))) { XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooDeep) }
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: NSDictionary(object: arrays(limit), forKey: "payload" as NSString))) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooDeep, "the enclosing object counts as a level, as it does for bytes")
        }
    }

    /// WebKit hands over a lone surrogate intact in an `NSString`; the byte
    /// decoder refuses the same text as an escape. Both refuse, in a value
    /// or a key, and a whole pair is ordinary text to both.
    func testUnpairedSurrogatesAreRefusedLikeTheByteDecoder() throws {
        let loneHigh = NSString(characters: [0x61, 0xD800, 0x62], length: 3)
        let loneLow = NSString(characters: [0xDC00], length: 1)
        let reversedPair = NSString(characters: [0xDE00, 0xD83D], length: 2)
        let highAtEnd = NSString(characters: [0x61, 0xD83D], length: 2)
        let pair = NSString(characters: [0xD83D, 0xDE00], length: 2)
        for broken in [loneHigh, loneLow, reversedPair, highAtEnd] {
            XCTAssertTrue(JSONBridge.containsUnpairedSurrogate(broken))
            XCTAssertThrowsError(try JSONBridge.jsonValue(from: NSDictionary(object: broken, forKey: "text" as NSString))) {
                XCTAssertEqual($0 as? JSONBridge.BridgeError, .unpairedSurrogate)
            }
            XCTAssertThrowsError(try JSONBridge.jsonValue(from: NSDictionary(object: 1, forKey: broken))) {
                XCTAssertEqual($0 as? JSONBridge.BridgeError, .unpairedSurrogate, "keys are text too")
            }
        }
        XCTAssertFalse(JSONBridge.containsUnpairedSurrogate(pair))
        XCTAssertFalse(JSONBridge.containsUnpairedSurrogate(""))
        XCTAssertFalse(JSONBridge.containsUnpairedSurrogate("plain é"))
        XCTAssertEqual(try JSONBridge.jsonValue(from: NSArray(object: pair)), .array([.string("\u{1F600}")]))
        XCTAssertEqual(try JSONBridge.jsonValue(from: NSDictionary(object: 1, forKey: pair)), .object(["\u{1F600}": .number(1)]))
        XCTAssertThrowsError(try JSONValue.decode(Data("[\"a\\ud800b\"]".utf8))) { XCTAssertEqual($0 as? JSONValueError, .malformed) }
        XCTAssertThrowsError(try JSONValue.decode(Data("[\"\\udc00\"]".utf8))) { XCTAssertEqual($0 as? JSONValueError, .malformed) }
        XCTAssertEqual(try JSONValue.decode(Data("[\"\\ud83d\\ude00\"]".utf8)), .array([.string("\u{1F600}")]))
    }

    /// The budget charges a lower bound of the canonical bytes as it walks
    /// (brackets, separators, quotes, colons, a digit per number, the UTF-16
    /// units of every key and string), refuses as soon as it is spent, and
    /// never refuses what the byte limit admits because the charge never
    /// exceeds the canonical bytes.
    func testByteBudgetRefusesEarlyAndNeverBelowTheByteLimit() throws {
        let small: NSDictionary = ["a": "xyz"]
        XCTAssertEqual(try JSONBridge.jsonValue(from: small).canonicalData().count, 11, #"{"a":"xyz"}"#)
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: small, byteBudget: 10)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooLarge)
        }
        XCTAssertNoThrow(try JSONBridge.jsonValue(from: small, byteBudget: 11))
        let scalars: NSArray = [0, NSNull(), true, false, 12345]
        XCTAssertEqual(try JSONBridge.jsonValue(from: scalars).canonicalData().count, 25, "[0,null,true,false,12345]")
        XCTAssertNoThrow(try JSONBridge.jsonValue(from: scalars, byteBudget: 21), "a number is charged one digit: 21 charged for 25 bytes")
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: scalars, byteBudget: 20)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooLarge)
        }
        let twoByteEach = String(repeating: "é", count: 8)
        XCTAssertNoThrow(try JSONBridge.jsonValue(from: NSArray(object: twoByteEach), byteBudget: 12), "8 units charged, 16 UTF-8 bytes written")
        let fourByteEach = String(repeating: "\u{1F600}", count: 4)
        XCTAssertNoThrow(try JSONBridge.jsonValue(from: NSArray(object: fourByteEach), byteBudget: 12), "8 units charged, 16 UTF-8 bytes written")
        let limit = ProofLimits.envelopeBytes
        let exactly = ["t": String(repeating: "x", count: limit - 8)] as NSDictionary
        XCTAssertEqual(try JSONBridge.jsonValue(from: exactly).canonicalData().count, limit, "admitted at exactly the limit, by default")
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: ["t": String(repeating: "x", count: limit - 7)] as NSDictionary)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooLarge, "one byte over the default budget is refused before conversion")
        }
    }

    /// W3 (Codex review of 6052518): a container's count alone can prove the
    /// envelope too large, so it is refused before any element or key is
    /// touched, before anything is reserved or copied. The hooks report the
    /// count WebKit would, and count what the bridge asks for.
    func testImpossibleContainerCountsAreRefusedBeforeAnyElementIsTouched() {
        let array = CountingArray(reportedCount: 10_000_000)
        var started = Date()
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: ["v": 1, "payload": array] as NSDictionary)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooLarge)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2)
        XCTAssertEqual(array.elementAccesses, 0, "refused from the count alone; no element was read, so no JSONValue array of that size was built")

        let nulls = CountingArray(reportedCount: 3_000_000)
        started = Date()
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: ["v": 1, "payload": nulls] as NSDictionary)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooLarge)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2)
        XCTAssertEqual(nulls.elementAccesses, 0)

        let object = CountingDictionary(reportedCount: 1_000_000)
        started = Date()
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: ["v": 1, "payload": object] as NSDictionary)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooLarge)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2)
        XCTAssertEqual(object.keyAccesses, 0, "refused from the count alone; its keys were never enumerated or copied")

        // The same shapes as real objects, as WebKit would hand them over.
        let zeros = [NSNumber](repeating: 0, count: 10_000_000) as NSArray
        started = Date()
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: ["v": 1, "payload": zeros] as NSDictionary)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooLarge)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2, "ten million zeros")
        let threeMillionNulls = [NSNull](repeating: NSNull(), count: 3_000_000) as NSArray
        started = Date()
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: ["v": 1, "payload": threeMillionNulls] as NSDictionary)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooLarge)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2, "three million nulls")
        var million: [String: Any] = Dictionary(minimumCapacity: 1_000_000)
        for index in 0..<1_000_000 { million["k\(index)"] = 0 }
        let millionKeys = million as NSDictionary
        started = Date()
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: ["v": 1, "payload": millionKeys] as NSDictionary)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .tooLarge)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2, "a million keys")

        // Afterwards the bridge converts an ordinary graph as before.
        XCTAssertEqual(try JSONBridge.jsonValue(from: ["v": 1, "payload": ["a": [0, NSNull(), true]]] as NSDictionary),
                       .object(["v": .number(1), "payload": .object(["a": .array([.number(0), .null, .bool(true)])])]))
    }

    /// A precomposed and a decomposed "é" are two keys to JavaScript (and to
    /// NSDictionary) but one key to a Swift dictionary; refuse rather than
    /// drop one silently, exactly as DeskHost's byte decoder does.
    func testCanonicallyEquivalentKeysAreRefused() throws {
        let precomposed = "caf\u{E9}" as NSString
        let decomposed = "cafe\u{301}" as NSString
        let dictionary = NSMutableDictionary()
        dictionary[precomposed] = 1
        dictionary[decomposed] = 2
        XCTAssertEqual(dictionary.count, 2)
        XCTAssertThrowsError(try JSONBridge.jsonValue(from: dictionary)) {
            XCTAssertEqual($0 as? JSONBridge.BridgeError, .duplicateKey)
        }
        let bytes = try JSONSerialization.data(withJSONObject: dictionary)
        XCTAssertThrowsError(try JSONValue.decode(bytes)) { XCTAssertEqual($0 as? JSONValueError, .duplicateKey) }
    }
}

/// An `NSArray` that reports a count WebKit could deliver and counts how
/// many elements the bridge asks for.
final class CountingArray: NSArray {
    private var reportedCount = 0
    private(set) var elementAccesses = 0

    convenience init(reportedCount: Int) {
        self.init()
        self.reportedCount = reportedCount
    }

    override var count: Int { reportedCount }

    override func object(at index: Int) -> Any {
        elementAccesses += 1
        return NSNumber(value: 0)
    }
}

/// An `NSDictionary` that reports a count WebKit could deliver and counts
/// every key enumeration or lookup the bridge makes.
final class CountingDictionary: NSDictionary {
    private var reportedCount = 0
    private(set) var keyAccesses = 0

    convenience init(reportedCount: Int) {
        self.init()
        self.reportedCount = reportedCount
    }

    override var count: Int { reportedCount }

    override func keyEnumerator() -> NSEnumerator {
        keyAccesses += 1
        return NSArray().objectEnumerator()
    }

    override var allKeys: [Any] {
        keyAccesses += 1
        return []
    }

    override func object(forKey aKey: Any) -> Any? {
        keyAccesses += 1
        return nil
    }
}
