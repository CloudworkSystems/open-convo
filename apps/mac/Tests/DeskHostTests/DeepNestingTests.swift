import Foundation
import Testing
@testable import DeskHost

/// Deeply nested JSON must never overflow the protocol actor's stack
/// (cooperative threads run on 512 KB in a debug build). Every walk over a
/// request or a stored record is bounded by `JSONValue.maxNestingDepth`
/// containers, counting the envelope root; deeper bytes are refused as
/// `malformed-envelope` with nothing echoed, before any other processing.
@Suite("Deep nesting is refused, never walked")
struct DeepNestingTests {
    /// The cooperative pool's stack in a debug build.
    static let actorStackBytes = 512 * 1024

    /// Runs `work` on a thread with exactly `stackBytes` of stack and waits
    /// for its answer. A stack overflow kills the test process, which is the
    /// point: there is no softer way to observe one.
    static func onStack<T>(_ stackBytes: Int, _ work: @escaping () -> T) -> T {
        let done = DispatchSemaphore(value: 0)
        var result: T?
        let thread = Thread {
            result = work()
            done.signal()
        }
        thread.stackSize = stackBytes
        thread.start()
        done.wait()
        return result!
    }

    /// `n` nested arrays around the number 1: `[[[1]]]` for 3.
    static func nestedArrays(_ n: Int) -> String {
        String(repeating: "[", count: n) + "1" + String(repeating: "]", count: n)
    }

    /// `n` nested objects around the number 1: `{"a":{"a":1}}` for 2.
    static func nestedObjects(_ n: Int) -> String {
        String(repeating: "{\"a\":", count: n) + "1" + String(repeating: "}", count: n)
    }

    /// The record `commitEnvelope` carries, built in memory: `revision` plus
    /// `deep`, `arrays` nested arrays around the number 1.
    static func deepRecord(arrays: Int, revision: Int) -> [String: JSONValue] {
        var deep: JSONValue = .number(1)
        for _ in 0..<arrays { deep = .array([deep]) }
        return ["revision": .number(Double(revision)), "deep": deep]
    }

    /// A commit envelope whose record holds `nestedArrays(depth - 3)`. The
    /// envelope root, the payload and the record are three containers, so
    /// the whole envelope is exactly `depth` containers deep.
    static func commitEnvelope(depth: Int, harness: HostHarness, requestId: UUID = UUID(), revision: Int = 1) -> Data {
        precondition(depth >= 3)
        let record = "{\"revision\":\(revision),\"deep\":\(nestedArrays(depth - 3))}"
        let payload = "{\"workspaceHandle\":\"\(harness.handle)\",\"expectedRevision\":\(revision - 1),\"record\":\(record)}"
        return envelope("workspace.commitProof", payload: payload, harness: harness, requestId: requestId)
    }

    static func capabilitiesEnvelope(harness: HostHarness) -> Data {
        envelope("host.capabilities", payload: "{}", harness: harness)
    }

    static func readEnvelope(harness: HostHarness) -> Data {
        envelope("workspace.read", payload: "{\"workspaceHandle\":\"\(harness.handle)\"}", harness: harness)
    }

    private static func envelope(_ operation: String, payload: String, harness: HostHarness, requestId: UUID = UUID()) -> Data {
        Data(("{\"v\":1,\"requestId\":\"\(requestId.canonicalString)\",\"connectionId\":\"\(harness.connection.id)\","
              + "\"generation\":\(harness.connection.generation),\"operation\":\"\(operation)\",\"payload\":\(payload)}").utf8)
    }

    @Test("A 512-deep and a 5000-deep envelope are refused on a 512 KB stack and on the actor; the host answers the next request",
          .serialized, arguments: [512, 5_000])
    func deepEnvelopeIsRefusedNotWalked(depth: Int) async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let bytes = Self.commitEnvelope(depth: depth, harness: harness)

        // The synchronous half of `handle(data:)`, on a thread no larger
        // than the actor's.
        let onThread: Result<HostRequest, Error> = Self.onStack(Self.actorStackBytes) { Result { try HostRequest.decode(bytes) } }
        switch onThread {
        case .success: Issue.record("a \(depth)-deep envelope was admitted")
        case .failure(let error):
            let rejection = try #require(error as? HostRequestRejection)
            #expect(rejection.refusal == .malformedEnvelope)
            #expect(rejection.echo == HostEcho(), "nothing from a refused-deep envelope is echoed")
        }

        // The whole path on the protocol actor itself.
        let response = await harness.host.handle(data: bytes)
        #expect(response.outcome == .refused)
        #expect(response.reason == .malformedEnvelope)
        #expect(response.echo == HostEcho())

        let next = await harness.host.handle(data: Self.capabilitiesEnvelope(harness: harness))
        #expect(next.outcome == .ok, "the host is alive and answers the next valid request")
        #expect(next.capabilities?["workspaceHandle"]?.stringValue == harness.handle)
        #expect(await harness.read()?.revision == 0, "nothing was committed")
    }

    @Test("Depth edge: 64 containers decode, 65 are refused as malformed-envelope with nothing echoed")
    func depthEdgeOnBytes() async throws {
        #expect(JSONValue.maxNestingDepth == 64)
        #expect(try JSONValue.decode(Data(Self.nestedArrays(64).utf8)).nestingDepth == 64)
        #expect(throws: JSONValueError.tooDeep) { try JSONValue.decode(Data(Self.nestedArrays(65).utf8)) }
        #expect(try JSONValue.decode(Data(Self.nestedObjects(64).utf8)).nestingDepth == 64)
        #expect(throws: JSONValueError.tooDeep) { try JSONValue.decode(Data(Self.nestedObjects(65).utf8)) }
        #expect(try JSONValue.decode(Data("1".utf8)).nestingDepth == 0)

        let harness = try HostHarness()
        defer { harness.clean() }
        let admitted = Self.commitEnvelope(depth: 64, harness: harness)
        let decoded = try Self.onStack(Self.actorStackBytes) { Result { try HostRequest.decode(admitted) } }.get()
        #expect(decoded.operation == .workspaceCommitProof)
        #expect(JSONValue.object(decoded.payload).nestingDepth == 63, "the envelope root is the 64th container")

        let tooDeep = Self.commitEnvelope(depth: 65, harness: harness)
        let refused = Self.onStack(Self.actorStackBytes) { Result { try HostRequest.decode(tooDeep) } }
        switch refused {
        case .success: Issue.record("a 65-deep envelope was admitted")
        case .failure(let error):
            let rejection = try #require(error as? HostRequestRejection)
            #expect(rejection.refusal == .malformedEnvelope)
            #expect(rejection.echo == HostEcho())
        }
        let response = await harness.host.handle(data: tooDeep)
        #expect(response.outcome == .refused)
        #expect(response.reason == .malformedEnvelope)
        #expect(response.echo == HostEcho())
    }

    @Test("Brackets inside strings are text, not depth; the byte gate tracks strings and escapes")
    func bracketsInsideStringsDoNotCount() throws {
        let brackets = String(repeating: "[{", count: 100)
        let text = "{\"a\":\"\(brackets)\",\"b\":\"\\\"[\",\"c\":\"\\\\\",\"d\":[\"]\"],\"e\":\"\\u005b\"}"
        #expect(JSONValue.nestingFitsLimit(Data(text.utf8)))
        let value = try JSONValue.decode(Data(text.utf8))
        #expect(value.objectValue?["a"]?.stringValue == brackets)
        #expect(value.objectValue?["b"]?.stringValue == "\"[")
        #expect(value.objectValue?["c"]?.stringValue == "\\")
        #expect(value.objectValue?["d"] == .array([.string("]")]))
        #expect(value.objectValue?["e"]?.stringValue == "[")
        #expect(value.nestingDepth == 2)
        #expect(!JSONValue.nestingFitsLimit(Data(Self.nestedArrays(65).utf8)))
        #expect(!JSONValue.nestingFitsLimit(Data(String(repeating: "{", count: 5_000).utf8)), "unterminated containers still count")
        #expect(JSONValue.nestingFitsLimit(Data(("\"" + String(repeating: "[", count: 5_000)).utf8)), "an unterminated string is the parser's to refuse")
        #expect(throws: JSONValueError.malformed) { try JSONValue.decode(Data(("\"" + String(repeating: "[", count: 5_000)).utf8)) }
    }

    @Test("The bridge refuses the 65th container on the parsed graph even without the byte gate")
    func bridgeCapsDepthOnItsOwn() throws {
        func arrays(_ n: Int) -> Any {
            var value: Any = NSNumber(value: 1)
            for _ in 0..<n { value = NSArray(object: value) }
            return value
        }
        func objects(_ n: Int) -> Any {
            var value: Any = NSNumber(value: 1)
            for _ in 0..<n { value = NSDictionary(dictionary: ["k": value]) }
            return value
        }
        #expect(try JSONValue.bridge(arrays(64), maxDepth: 64).nestingDepth == 64)
        #expect(throws: JSONValueError.tooDeep) { try JSONValue.bridge(arrays(65), maxDepth: 64) }
        #expect(try JSONValue.bridge(objects(64), maxDepth: 64).nestingDepth == 64)
        #expect(throws: JSONValueError.tooDeep) { try JSONValue.bridge(objects(65), maxDepth: 64) }
        #expect(throws: JSONValueError.tooDeep) { try JSONValue.bridge(arrays(1), maxDepth: 0) }
        let mixed = try JSONSerialization.jsonObject(with: Data("{\"a\":[1,true,false,null,\"x\",{\"b\":2.5},[],{}],\"n\":0}".utf8))
        #expect(try JSONValue.bridge(mixed, maxDepth: 64)
                == .object(["a": .array([.number(1), .bool(true), .bool(false), .null, .string("x"), .object(["b": .number(2.5)]),
                                         .array([]), .object([:])]), "n": .number(0)]))
        #expect(try JSONValue.bridge(NSNull(), maxDepth: 0) == .null)
    }

    @Test("A decoded request nested past the limit is refused on the typed path before any walk over its payload")
    func typedPathHoldsTheSameLimit() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        // Envelope, payload, record and 61 arrays: 64 containers, admitted.
        let admitted = harness.commitRequest(expectedRevision: 0, record: Self.deepRecord(arrays: 61, revision: 1))
        #expect(JSONValue.object(admitted.payload).nestingDepth == 63)
        let ok = await harness.host.handle(admitted)
        #expect(ok.outcome == .ok)
        #expect(ok.revision == 1)

        let tooDeep = harness.commitRequest(expectedRevision: 1, record: Self.deepRecord(arrays: 62, revision: 2))
        #expect(JSONValue.object(tooDeep.payload).nestingDepth == 64)
        let refused = await harness.host.handle(tooDeep)
        #expect(refused.outcome == .refused)
        #expect(refused.reason == .malformedEnvelope)
        #expect(refused.echo == tooDeep.echo, "a typed request already carries validated correlation fields")
        #expect(await harness.read()?.revision == 1, "nothing past the limit was committed")
    }

    @Test("A record at the depth limit commits through the byte path, reads back, replays, and survives a reopen of the store")
    func deepRecordCommitsAndReadsBack() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let requestId = UUID()
        let bytes = Self.commitEnvelope(depth: 64, harness: harness, requestId: requestId)
        let expected = Self.deepRecord(arrays: 61, revision: 1)

        let committed = await harness.host.handle(data: bytes)
        #expect(committed.outcome == .ok)
        #expect(committed.revision == 1)
        let read = await harness.host.handle(data: Self.readEnvelope(harness: harness))
        #expect(read.outcome == .ok)
        #expect(read.record == expected)
        #expect(JSONValue.object(read.record ?? [:]).nestingDepth == 62)
        #expect(read.canonicalData().count > 0, "the reply serializes without recursion")
        let replayed = await harness.host.handle(data: bytes)
        #expect(replayed.outcome == .ok)
        #expect(replayed.revision == 1, "the exact retry replays through the payload hash of the deep record")

        // Reopen on the actor-sized stack: the state file is read back
        // through the bounded decode.
        harness.store.close()
        let reopened = try Self.onStack(Self.actorStackBytes) { Result { try harness.fixture.makeStore() } }.get()
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        let workspace = try reopened.read()
        #expect(workspace.revision == 1)
        #expect(workspace.record == expected)
        #expect(workspace.requestId == requestId)
    }

    @Test("A state file nested 600 deep opens as store-corrupt on the actor-sized stack; nothing crashes, the file is untouched")
    func deepStateFileOpensCorrupt() async throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let handle = store.workspaceHandle
        store.close()
        let hostile = Data(("{\"formatVersion\":1,\"workspace\":" + Self.nestedArrays(600) + "}").utf8)
        try hostile.writePlainState(to: store)

        let reopened = try Self.onStack(Self.actorStackBytes) { Result { try fixture.makeStore() } }.get()
        defer { reopened.close() }
        #expect(reopened.status == .corrupt)
        #expect(reopened.workspaceHandle == handle, "the handle survives through the marker")
        #expect(throws: ProofStoreError.corrupt) { try reopened.read() }
        #expect(try store.plainStateForTesting() == hostile, "nothing was written back")

        let connections = ConnectionRegistry()
        let host = DeskHostProtocol(store: reopened, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info)
        let connection = connections.issue()
        func request(_ operation: HostOperation, _ payload: [String: JSONValue]) -> HostRequest {
            HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation, operation: operation, payload: payload)
        }
        let read = await host.handle(request(.workspaceRead, ["workspaceHandle": .string(handle)]))
        #expect(read.outcome == .refused)
        #expect(read.reason == .storeCorrupt)
        let capabilities = await host.handle(request(.capabilities, [:]))
        #expect(capabilities.outcome == .ok, "the host is alive")
        #expect(capabilities.capabilities?["store"]?.stringValue == "corrupt")
    }

    @Test("A marker nested 600 deep refuses to open as corrupt state on the actor-sized stack; nothing crashes")
    func deepMarkerRefusesOpen() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        store.close()
        let hostile = Data(Self.nestedArrays(600).utf8)
        try hostile.write(to: store.markerURL)
        let outcome = Self.onStack(Self.actorStackBytes) { Result { try fixture.makeStore() } }
        switch outcome {
        case .success(let opened):
            opened.close()
            Issue.record("a store with an unreadable marker opened")
        case .failure(let error):
            #expect(error as? ProofStoreError == .corruptState)
        }
        #expect(try Data(contentsOf: store.markerURL) == hostile, "nothing was written back")
    }

    @Test("Equality, the canonical writer, the text scan and Codable hold at the limit without recursion")
    func walkersIterateAtTheLimit() throws {
        func build(leaf: String) -> JSONValue {
            var inner: JSONValue = .string(leaf)
            for _ in 0..<63 { inner = .array([inner]) }
            return .object(["k": inner, "long-key-xxxxx": .number(2)])
        }
        let value = build(leaf: "leaf")
        let same = build(leaf: "leaf")
        let other = build(leaf: "leaf!")
        #expect(value.nestingDepth == 64)
        #expect(value == same)
        #expect(value != other)
        #expect(value != .array([]))
        #expect(JSONValue.object(["a": .number(1), "b": .number(2)]) != .object(["a": .number(1), "c": .number(2)]))
        let canonical = "{\"k\":" + String(repeating: "[", count: 63) + "\"leaf\"" + String(repeating: "]", count: 63) + ",\"long-key-xxxxx\":2}"
        #expect(String(decoding: value.canonicalData(), as: UTF8.self) == canonical)
        #expect(value.longestTextItemBytes == "long-key-xxxxx".utf8.count)
        #expect(PayloadHash.hex(of: value) == PayloadHash.hex(of: same))
        #expect(PayloadHash.hex(of: value) != PayloadHash.hex(of: other))
        #expect(Self.onStack(Self.actorStackBytes) {
            value == same && value != other && value.canonicalData() == same.canonicalData() && value.longestTextItemBytes == 14
        })

        let mixed = JSONValue.object(["b": .array([.number(1), .number(2.5), .object(["a": .null]), .array([]), .object([:])]),
                                      "a": .string("x\n\"\\\u{01}")])
        #expect(String(decoding: mixed.canonicalData(), as: UTF8.self) == "{\"a\":\"x\\n\\\"\\\\\\u0001\",\"b\":[1,2.5,{\"a\":null},[],{}]}")

        #expect(try JSONDecoder().decode(JSONValue.self, from: Data(Self.nestedArrays(64).utf8)).nestingDepth == 64)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(JSONValue.self, from: Data(Self.nestedArrays(65).utf8)) }
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(JSONValue.self, from: Data(Self.nestedObjects(65).utf8)) }
        let roundTrip = try JSONDecoder().decode(JSONValue.self, from: try JSONEncoder().encode(value))
        #expect(roundTrip == value)
    }

    // MARK: Encoding

    /// `text` in `encoding`, with or without that encoding's byte-order mark.
    static func bytes(_ text: String, as encoding: String.Encoding, bom: Bool) -> Data {
        var data = Data()
        if bom {
            switch encoding {
            case .utf16LittleEndian: data.append(contentsOf: [0xFF, 0xFE])
            case .utf16BigEndian: data.append(contentsOf: [0xFE, 0xFF])
            case .utf32LittleEndian: data.append(contentsOf: [0xFF, 0xFE, 0x00, 0x00])
            case .utf32BigEndian: data.append(contentsOf: [0x00, 0x00, 0xFE, 0xFF])
            default: preconditionFailure("no byte-order mark for \(encoding)")
            }
        }
        data.append(text.data(using: encoding)!)
        return data
    }

    /// The encodings `JSONSerialization` recognises besides UTF-8.
    static let foreignEncodings: [String.Encoding] = [.utf16LittleEndian, .utf16BigEndian, .utf32LittleEndian, .utf32BigEndian]

    /// A key whose UTF-16 code unit holds a backslash byte (0x5C). Read as
    /// UTF-8, the byte scan takes that byte for an escape, never sees the
    /// string close, and counts no bracket after it; the parser, having
    /// recognised UTF-16, parses the real graph. The October 9 review's
    /// bypass: the encoding rule in `JSONValue.decode` is what closes it.
    static let blindingKey = "\u{5C00}"

    @Test("UTF-16 and UTF-32 bytes are refused as malformed before any parser, shallow or 600 deep, on the actor-sized stack")
    func foreignEncodingsAreRefusedBeforeParsing() throws {
        let deep = "{\"\(Self.blindingKey)\":" + Self.nestedObjects(600) + "}"
        let shallow = "{\"\(Self.blindingKey)\":[1]}"
        let blinded = Self.bytes(deep, as: .utf16LittleEndian, bom: false)
        #expect(JSONValue.nestingFitsLimit(blinded), "the byte scan reads UTF-8 and cannot count UTF-16 containers; the encoding rule must come first")
        #expect(String(data: blinded, encoding: .utf8) != nil, "ASCII with interleaved NULs is valid UTF-8, so a UTF-8 check alone does not refuse it")
        for encoding in Self.foreignEncodings {
            for bom in [false, true] {
                for text in [deep, shallow] {
                    let data = Self.bytes(text, as: encoding, bom: bom)
                    let outcome = Self.onStack(Self.actorStackBytes) { Result { try JSONValue.decode(data) } }
                    switch outcome {
                    case .success: Issue.record("\(encoding) bom=\(bom) \(text.count) chars was parsed")
                    case .failure(let error): #expect(error as? JSONValueError == .malformed, "\(encoding) bom=\(bom)")
                    }
                }
            }
        }
    }

    @Test("A raw NUL or a 0xFE/0xFF byte is malformed; an escaped NUL and non-ASCII keys decode as UTF-8")
    func nulBytesAreRefusedEscapesAndUnicodeAreNot() throws {
        var inString = Data("{\"a\":\"x".utf8)
        inString.append(0)
        inString.append(contentsOf: Data("y\"}".utf8))
        #expect(throws: JSONValueError.malformed) { try JSONValue.decode(inString) }
        var trailing = Data("[1]".utf8)
        trailing.append(0)
        #expect(throws: JSONValueError.malformed) { try JSONValue.decode(trailing) }
        #expect(throws: JSONValueError.malformed) { try JSONValue.decode(Data([0xFE, 0xFF])) }
        #expect(throws: JSONValueError.malformed) { try JSONValue.decode(Data([0xFF, 0xFE, 0x5B, 0x5D])) }

        #expect(try JSONValue.decode(Data("{\"a\":\"x\\u0000y\"}".utf8)).objectValue?["a"]?.stringValue == "x\u{0}y")
        let unicode = "{\"\(Self.blindingKey)\":" + Self.nestedObjects(63) + ",\"é\":\"\u{1F600}\"}"
        let value = try JSONValue.decode(Data(unicode.utf8))
        #expect(value.nestingDepth == 64)
        #expect(value.objectValue?["é"]?.stringValue == "\u{1F600}")
        #expect(value.objectValue?[Self.blindingKey]?.objectValue?["a"] != nil)
    }

    @Test("A UTF-16 or UTF-32 commit envelope nested 510 deep is refused as malformed-envelope on the actor with nothing echoed; the host answers the next request")
    func foreignEncodedEnvelopeIsRefusedNotWalked() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let record = "{\"revision\":1,\"\(Self.blindingKey)\":" + Self.nestedObjects(510) + "}"
        let payload = "{\"workspaceHandle\":\"\(harness.handle)\",\"expectedRevision\":0,\"record\":\(record)}"
        let text = String(decoding: Self.envelope("workspace.commitProof", payload: payload, harness: harness), as: UTF8.self)
        for encoding in Self.foreignEncodings {
            let bytes = Self.bytes(text, as: encoding, bom: false)
            let onThread = Self.onStack(Self.actorStackBytes) { Result { try HostRequest.decode(bytes) } }
            switch onThread {
            case .success: Issue.record("a \(encoding) envelope was admitted")
            case .failure(let error):
                let rejection = try #require(error as? HostRequestRejection)
                #expect(rejection.refusal == .malformedEnvelope)
                #expect(rejection.echo == HostEcho(), "nothing from a refused envelope is echoed")
            }
            let response = await harness.host.handle(data: bytes)
            #expect(response.outcome == .refused)
            #expect(response.reason == .malformedEnvelope)
            #expect(response.echo == HostEcho())
        }
        let next = await harness.host.handle(data: Self.capabilitiesEnvelope(harness: harness))
        #expect(next.outcome == .ok, "the host is alive and answers the next valid request")
        #expect(await harness.read()?.revision == 0, "nothing was committed")
    }

    @Test("A UTF-16 state file nested 510 deep opens as store-corrupt and a UTF-16 marker refuses to open, on the actor-sized stack; the files are untouched")
    func foreignEncodedStoreFilesReadAsCorrupt() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let handle = store.workspaceHandle
        store.close()
        let deepField = "\"\(Self.blindingKey)\":" + Self.nestedObjects(510)
        let hostileState = Self.bytes("{\"formatVersion\":1,\(deepField),\"workspace\":{}}", as: .utf16LittleEndian, bom: false)
        try hostileState.writePlainState(to: store)

        let reopened = try Self.onStack(Self.actorStackBytes) { Result { try fixture.makeStore() } }.get()
        #expect(reopened.status == .corrupt)
        #expect(reopened.workspaceHandle == handle, "the handle survives through the marker")
        #expect(throws: ProofStoreError.corrupt) { try reopened.read() }
        #expect(try store.plainStateForTesting() == hostileState, "nothing was written back")
        reopened.close()

        // The marker the store wrote, with the deep field added and re-encoded.
        let marker = String(decoding: try Data(contentsOf: store.markerURL), as: UTF8.self)
        let hostileMarker = Self.bytes("{" + deepField + "," + marker.dropFirst(), as: .utf16BigEndian, bom: false)
        try hostileMarker.write(to: store.markerURL)
        let outcome = Self.onStack(Self.actorStackBytes) { Result { try fixture.makeStore() } }
        switch outcome {
        case .success(let opened):
            opened.close()
            Issue.record("a store with an unreadable marker opened")
        case .failure(let error):
            #expect(error as? ProofStoreError == .corruptState)
        }
        #expect(try Data(contentsOf: store.markerURL) == hostileMarker, "nothing was written back")
    }

    @Test("A manifest in UTF-16 or nested 600 deep is refused by load on the actor-sized stack")
    func hostileManifestIsRefusedNotWalked() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let url = fixture.directory.appendingPathComponent("manifest.json")
        try Data("{\"assets\":[{\"path\":\"index.html\",\"mediaType\":\"text/html\"}]}".utf8).write(to: url)
        #expect(try BundleManifest.load(from: url).asset(at: "index.html") != nil)

        let utf16 = "{\"\(Self.blindingKey)\":" + Self.nestedObjects(510) + ",\"assets\":[]}"
        try Self.bytes(utf16, as: .utf16LittleEndian, bom: false).write(to: url)
        let foreign = Self.onStack(Self.actorStackBytes) { Result { try BundleManifest.load(from: url) } }
        switch foreign {
        case .success: Issue.record("a UTF-16 manifest loaded")
        case .failure(let error): #expect(error as? JSONValueError == .malformed)
        }

        try Data(("{\"assets\":" + Self.nestedArrays(600) + "}").utf8).write(to: url)
        let deep = Self.onStack(Self.actorStackBytes) { Result { try BundleManifest.load(from: url) } }
        switch deep {
        case .success: Issue.record("a 600-deep manifest loaded")
        case .failure(let error): #expect(error as? JSONValueError == .tooDeep)
        }
    }
}
