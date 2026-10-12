import Foundation
import Testing
@testable import DeskHost

/// The shared invented vectors from the Desk side
/// (`apps/desk/tests/fixtures/native-host-v1.json`, Codex candidate ace0d43),
/// replayed through the real protocol against a store seeded as the vectors
/// describe. Each reply must match the vector's reply byte for byte after
/// canonical serialization. The one agreed exception: the vector's
/// `capabilities.operations` lists the five page operations and the host
/// advertises seven, so that list is compared as a subset.
@Suite("Shared native-host v1 vectors")
struct NativeHostVectorTests {
    struct Vector {
        let name: String
        let request: JSONValue
        let reply: JSONValue
    }

    struct Vectors {
        let connectionId: String
        let generation: Int
        let cases: [Vector]

        func named(_ name: String) throws -> Vector { try #require(cases.first { $0.name == name }) }
    }

    static func load() throws -> Vectors {
        let url = try #require(Bundle.module.url(forResource: "native-host-v1", withExtension: "json"))
        let root = try #require(try JSONValue.decode(Data(contentsOf: url)).objectValue)
        let context = try #require(root["context"]?.objectValue)
        let cases = try #require(root["cases"]?.arrayValue).map { entry -> Vector in
            let object = entry.objectValue ?? [:]
            return Vector(name: object["name"]?.stringValue ?? "", request: object["request"] ?? .null, reply: object["reply"] ?? .null)
        }
        return Vectors(connectionId: try #require(context["connectionId"]?.stringValue),
                       generation: try #require(context["documentGeneration"]?.safeIntegerValue), cases: cases)
    }

    static let correlatedCommit = "workspace.commitProof with dictation delivery"

    private static func payload(_ vector: Vector) -> [String: JSONValue] { vector.request.objectValue?["payload"]?.objectValue ?? [:] }

    private static func withoutOperations(_ reply: JSONValue) -> JSONValue {
        guard var object = reply.objectValue, var capabilities = object["capabilities"]?.objectValue else { return reply }
        capabilities.removeValue(forKey: "operations")
        object["capabilities"] = .object(capabilities)
        return .object(object)
    }

    @Test("Every vector replays byte for byte through the protocol, in order, against a store seeded from the read vector")
    func vectorsReplayByteForByte() async throws {
        let vectors = try Self.load()
        #expect(vectors.cases.count == 6)
        let read = try vectors.named("workspace.read")
        let seedRecord = try #require(read.reply.objectValue?["record"]?.objectValue)
        let handle = try #require(Self.payload(read)["workspaceHandle"]?.stringValue)
        let bind = try vectors.named("dictation.bindDraft")
        let bindingId = try #require(bind.reply.objectValue?["bindingId"]?.canonicalUUIDv4Value)
        let correlated = try vectors.named(Self.correlatedCommit)
        let deliveryId = try #require(Self.payload(correlated)["dictationDeliveryId"]?.canonicalUUIDv4Value)
        let commitRequestId = try #require(correlated.request.objectValue?["requestId"]?.canonicalUUIDv4Value)

        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(seed: WorkspaceSeed(workspaceHandle: handle, record: seedRecord))
        let connections = ConnectionRegistry()
        let sink = RecordingSink()
        // Scripted ids first, random ones after: a vector set that ever binds or
        // delivers twice fails the byte comparison instead of spinning the
        // registry's uniqueness loop forever.
        let bindingIds = IdSequence([bindingId])
        let deliveryIds = IdSequence([deliveryId])
        let drafts = DraftBindingRegistry(makeBindingId: { bindingIds.next() }, makeDeliveryId: { deliveryIds.next() })
        let host = DeskHostProtocol(store: store, connections: connections, drafts: drafts,
                                    info: HostInfo(appVersion: "invented-proof-version", hostBuild: "invented-proof-build"), events: sink)
        while connections.currentGeneration < vectors.generation { await host.beginGeneration() }
        let connection = connections.adopt(id: vectors.connectionId)
        #expect(connection.generation == vectors.generation)

        for vector in vectors.cases {
            if vector.name == Self.correlatedCommit {
                // The sixth vector needs the host's own pushed delivery for the bound draft:
                // a recording started after the bind vector, finished before the commit.
                let token = await host.beginRecording()
                #expect(token.target?.bindingId == bindingId)
                let delivery = await host.deliverFinal(token, text: "invented dictation")
                #expect(delivery == .delivered(deliveryId: deliveryId, bindingId: bindingId, connectionId: vectors.connectionId, generation: vectors.generation))
                #expect(sink.finals == [.dictationFinal(connectionId: vectors.connectionId, generation: vectors.generation, bindingId: bindingId,
                                                        deliveryId: deliveryId, text: "invented dictation")])
            }
            let response = await host.handle(data: vector.request.canonicalData())
            var actual = response.jsonValue
            var expected = vector.reply
            if vector.name == "host.capabilities" {
                let hostOperations = Set(response.capabilities?["operations"]?.arrayValue?.compactMap(\.stringValue) ?? [])
                let vectorOperations = Set(expected.objectValue?["capabilities"]?.objectValue?["operations"]?.arrayValue?.compactMap(\.stringValue) ?? [])
                #expect(vectorOperations.count == 5)
                #expect(vectorOperations.isSubset(of: hostOperations), "the host advertises every operation the vector lists")
                #expect(hostOperations == Set(HostOperation.advertised.map(\.rawValue)))
                actual = Self.withoutOperations(actual)
                expected = Self.withoutOperations(expected)
            }
            let actualBytes = String(decoding: actual.canonicalData(), as: UTF8.self)
            let expectedBytes = String(decoding: expected.canonicalData(), as: UTF8.self)
            #expect(actualBytes == expectedBytes, "\(vector.name): \(Self.firstDifference(actualBytes, expectedBytes))")
        }

        #expect(sink.receipts == [.dictationReceipt(connectionId: vectors.connectionId, generation: vectors.generation, deliveryId: deliveryId,
                                                    commitRequestId: commitRequestId, revision: 4)])
        // The agreed proof points, stated explicitly.
        let goalId = read.reply.objectValue?["record"]?.objectValue?["goals"]?.arrayValue?.first?.objectValue?["id"]?.stringValue
        #expect(goalId == "A1000000-0000-1000-8000-000000000001", "the uppercase UUIDv1 record id is preserved")
        let gap = try vectors.named("workspace.commitProof")
        #expect(Self.payload(gap)["expectedRevision"]?.safeIntegerValue == 1)
        #expect(gap.reply.objectValue?["revision"]?.safeIntegerValue == 3, "the commit gap 1 to 3 is accepted")
        let selection = Self.payload(bind)["selection"]?.objectValue
        #expect(selection?["start"]?.safeIntegerValue == 7 && selection?["end"]?.safeIntegerValue == 9, "the UTF-16 selection covers the whole emoji")

        // Durability: the committed record and the saved delivery survive a reopen unchanged.
        store.close()
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        let workspace = try reopened.read()
        #expect(workspace.revision == 4)
        #expect(JSONValue.object(workspace.record).canonicalData() == (Self.payload(correlated)["record"] ?? .null).canonicalData())
        #expect(try reopened.delivery(for: deliveryId)?.commitRequestId == commitRequestId)
        #expect(try reopened.delivery(for: deliveryId)?.revision == 4)
        // The page's own saved draft legitimately holds the words; the host's delivery receipts never do.
        let state = try JSONValue.decode(Data(contentsOf: reopened.stateURL)).objectValue
        let deliveries = String(decoding: (state?["deliveries"] ?? .null).canonicalData(), as: UTF8.self)
        #expect(deliveries.lowercased().contains(deliveryId.canonicalString))
        #expect(!deliveries.contains("invented dictation"), "delivery receipts carry identities only")
        #expect(!deliveries.contains("\"text\""))
    }

    @Test("Every request vector decodes as a canonical envelope; its hash ignores key order and whitespace but covers the payload and the operation; a half-emoji selection is refused")
    func requestVectorsDecode() async throws {
        let vectors = try Self.load()
        let looseEncoder = JSONEncoder()
        looseEncoder.outputFormatting = [.prettyPrinted]
        for vector in vectors.cases {
            let request = try HostRequest.decode(vector.request.canonicalData())
            #expect(request.connectionId == vectors.connectionId)
            #expect(request.generation == vectors.generation)
            #expect(request.requestIdString == vector.request.objectValue?["requestId"]?.stringValue)
            // The same request as the page might actually post it: unsorted keys, whitespace.
            let loose = try looseEncoder.encode(vector.request)
            #expect(loose != vector.request.canonicalData(), "the loose encoding really is different bytes")
            #expect(try HostRequest.decode(loose).payloadHash == request.payloadHash, "\(vector.name): the hash is over canonical content, not bytes")
            // A changed payload is a different hash; so is the same payload under another operation.
            var changed = request.payload
            changed["inventedExtra"] = .bool(true)
            let other = HostRequest(requestId: UUID(), connectionId: request.connectionId, generation: request.generation,
                                    operation: request.operation, payload: changed)
            #expect(other.payloadHash != request.payloadHash)
            let otherOperation = request.operation == .capabilities ? HostOperation.workspaceRead : .capabilities
            let renamed = HostRequest(requestId: UUID(), connectionId: request.connectionId, generation: request.generation,
                                      operation: otherOperation, payload: request.payload)
            #expect(renamed.payloadHash != request.payloadHash, "\(vector.name): the hash covers the operation")
            #expect(request.payloadHash.count == 64 && request.payloadHash == request.payloadHash.lowercased())
        }
        let bind = try vectors.named("dictation.bindDraft")
        var payload = Self.payload(bind)
        payload["selection"] = .object(["start": .number(8), "end": .number(9)])
        let halfEmoji = try HostRequest(validating: .object((bind.request.objectValue ?? [:]).merging(["payload": .object(payload)]) { $1 }))
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(seed: WorkspaceSeed(workspaceHandle: payload["workspaceHandle"]?.stringValue, record: ["revision": .number(3)]))
        defer { store.close() }
        let connections = ConnectionRegistry()
        let host = DeskHostProtocol(store: store, connections: connections, drafts: DraftBindingRegistry(), info: HostInfo(appVersion: "v", hostBuild: "b"))
        while connections.currentGeneration < vectors.generation { await host.beginGeneration() }
        _ = connections.adopt(id: vectors.connectionId)
        let refused = await host.handle(halfEmoji)
        #expect(refused.outcome == .refused)
        #expect(refused.reason == .malformedEnvelope)
        let whole = await host.handle(try HostRequest(validating: bind.request))
        #expect(whole.outcome == .ok)
        #expect(whole.revision == 3)
    }

    private static func firstDifference(_ a: String, _ b: String) -> String {
        let aChars = Array(a), bChars = Array(b)
        guard let index = zip(aChars, bChars).enumerated().first(where: { $0.element.0 != $0.element.1 })?.offset ?? (aChars.count != bChars.count ? min(aChars.count, bChars.count) : nil) else {
            return "identical"
        }
        let window = 60
        let lower = max(0, index - window)
        return "differs at \(index): actual …\(String(aChars[lower..<min(aChars.count, index + window)]))… expected …\(String(bChars[lower..<min(bChars.count, index + window)]))…"
    }
}
