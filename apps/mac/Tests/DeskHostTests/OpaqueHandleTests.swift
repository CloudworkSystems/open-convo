import Foundation
import Testing
@testable import DeskHost

/// Participant contract section 18, item 5: one rule for opaque host-issued
/// handles, byte equality, with no normalization on the way in or in storage.
/// Every handle here is invented.
@Suite("Opaque handles compare as bytes")
struct OpaqueHandleTests {
    /// Pairs Swift's `String ==` calls equal (canonical equivalence) that are
    /// different UTF-8 bytes, so different handles.
    static let equivalentPairs: [(stored: String, sent: String)] = [
        ("ws-caf\u{00E9}", "ws-cafe\u{0301}"),
        ("ws-cafe\u{0301}", "ws-caf\u{00E9}"),
        ("ws-\u{212A}elvin", "ws-Kelvin"),
        ("ws-\u{00C5}ngstrom", "ws-\u{212B}ngstrom")
    ]

    @Test("ASCII handles compare as before; canonically equivalent handles with different bytes are different")
    func rule() {
        #expect(OpaqueHandle.same("ws-0b1e2c3d-invented", "ws-0b1e2c3d-invented"))
        #expect(!OpaqueHandle.same("ws-0b1e2c3d-invented", "ws-0b1e2c3d-inventeD"))
        #expect(!OpaqueHandle.same("ws-a", "ws-a "))
        #expect(!OpaqueHandle.same("ws-a", ""))
        for pair in Self.equivalentPairs {
            #expect(pair.stored == pair.sent, "Swift's own == calls these equal")
            #expect(!OpaqueHandle.same(pair.stored, pair.sent), "the handle rule does not")
            #expect(OpaqueHandle.same(pair.stored, pair.stored))
        }
    }

    @Test("Every v1 workspace operation refuses a canonically equivalent handle as unknown-handle and takes the exact bytes")
    func hostChecks() async throws {
        for pair in Self.equivalentPairs {
            let harness = try HostHarness(seed: WorkspaceSeed(workspaceHandle: pair.stored, record: WorkspaceSeed.inventedRevisionZero().record))
            defer { harness.clean() }
            #expect(Array(harness.handle.utf8) == Array(pair.stored.utf8), "the seed's handle is stored as given")
            let sent = JSONValue.string(pair.sent)

            let read = await harness.host.handle(harness.request(.workspaceRead, payload: ["workspaceHandle": sent]))
            #expect(read.reason == .unknownHandle)
            #expect(read.record == nil, "a refused read carries no record")
            let commit = await harness.host.handle(harness.request(.workspaceCommitProof, payload: [
                "workspaceHandle": sent, "expectedRevision": .number(0), "record": .object(inventedRecord("other handle", revision: 1))
            ]))
            #expect(commit.reason == .unknownHandle)
            #expect(try harness.store.read().revision == 0, "nothing is written under another handle")
            let bind = await harness.host.handle(harness.request(.dictationBindDraft, payload: [
                "workspaceHandle": sent, "sessionId": .string(UUID().canonicalString), "expectedRevision": .number(0),
                "expectedText": .string("Invented draft"), "selection": .object(["start": .number(0), "end": .number(0)])
            ]))
            #expect(bind.reason == .unknownHandle)
            let reconcile = await harness.host.handle(harness.request(.workspaceReconcile, payload: [
                "workspaceHandle": sent, "targetRequestId": .string(UUID().canonicalString)
            ]))
            #expect(reconcile.reason == .unknownHandle)

            // The same request on the byte path: JSON carries the text as
            // sent, and nothing on the way in normalizes it.
            let escaped = pair.sent.unicodeScalars.map { $0.isASCII ? String($0) : String(format: "\\u%04x", $0.value) }.joined()
            let onWire = await harness.host.handle(data: envelopeJSON([
                "connectionId": "\"\(harness.connection.id)\"", "operation": "\"workspace.read\"",
                "payload": "{\"workspaceHandle\":\"\(escaped)\"}"
            ]))
            #expect(onWire.reason == .unknownHandle)

            #expect(await harness.host.handle(harness.readRequest()).outcome == .ok, "the exact bytes still read")
            #expect(await harness.commit("exact handle", expectedRevision: 0).outcome == .ok, "and still commit")
        }
    }

    @Test("A stored non-ASCII handle keeps its exact bytes across close and reopen and is reported as stored")
    func storagePreservesBytes() async throws {
        for pair in Self.equivalentPairs {
            let fixture = try DeskHostFixture()
            defer { fixture.clean() }
            let first = try fixture.makeStore(seed: WorkspaceSeed(workspaceHandle: pair.stored, record: WorkspaceSeed.inventedRevisionZero().record))
            #expect(Array(first.workspaceHandle.utf8) == Array(pair.stored.utf8))
            first.close()

            // The reopen ignores its seed: an established store keeps its
            // own handle, so a seed holding the equivalent text changes
            // nothing.
            let reopened = try fixture.makeStore(seed: WorkspaceSeed(workspaceHandle: pair.sent, record: WorkspaceSeed.inventedRevisionZero().record))
            defer { reopened.close() }
            #expect(reopened.status == .ready, "the state file's handle matches its marker byte for byte")
            #expect(Array(reopened.workspaceHandle.utf8) == Array(pair.stored.utf8), "never normalized in storage")

            let connections = ConnectionRegistry()
            let host = DeskHostProtocol(store: reopened, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info,
                                        events: nil, executor: BackgroundMutationExecutor(), participants: nil)
            let connection = connections.issue()
            func request(_ operation: HostOperation, _ payload: [String: JSONValue] = [:]) -> HostRequest {
                HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation, operation: operation, payload: payload)
            }
            let capabilities = try #require(await host.handle(request(.capabilities)).capabilities)
            guard case .string(let reported) = capabilities["workspaceHandle"] else {
                Issue.record("capabilities carry no handle")
                continue
            }
            #expect(Array(reported.utf8) == Array(pair.stored.utf8), "reported to the page as stored")
            #expect(await host.handle(request(.workspaceRead, ["workspaceHandle": .string(pair.stored)])).outcome == .ok)
            #expect(await host.handle(request(.workspaceRead, ["workspaceHandle": .string(pair.sent)])).reason == .unknownHandle)
        }
    }
}
