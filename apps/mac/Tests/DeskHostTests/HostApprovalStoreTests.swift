import Foundation
import Testing
@testable import DeskHost

// Contract section 21.4's approval in the protected store (the Claude Code
// adapter's PR 3d): saved by native only, revocable, kept across a reopen
// and across the page's commits, read strictly, and never readable as
// approved while the store cannot be read. Invented data only.

@Suite("Host approval in the protected store (contract section 21.4)")
struct HostApprovalStoreTests {
    private static let approvedAt = Date(timeIntervalSince1970: 1_793_000_000.123_9)

    private func commit(_ store: ProofStore, revision: Int) throws -> CommitOutcome {
        try store.commit(CommitAttempt(requestId: UUID(), payloadHash: "invented-hash-\(revision)", expectedRevision: revision - 1,
                                       recordRevision: revision, record: inventedRecord("x", revision: revision)))
    }

    private func stateKeys(_ store: ProofStore) throws -> [String: JSONValue] {
        try #require(try JSONValue.decode(store.plainStateForTesting()).objectValue)
    }

    @Test("A fresh store approves nothing and writes no approvals key; approving saves one entry with the wire's time, kept across a reopen; a second approval keeps the first")
    func approveAndReopen() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(store.isApproved(host: HostApproval.anthropic) == false)
        #expect(try stateKeys(store)["approvals"] == nil, "a store that never approved keeps its earlier bytes")
        let before = try store.plainStateForTesting()

        let approval = try store.approveHost(HostApproval.anthropic, at: Self.approvedAt)
        #expect(approval.host == "anthropic")
        #expect(approval.approvedAt == "2026-10-26T07:33:20.123Z", "milliseconds floored, in the wire's form")
        #expect(store.isApproved(host: HostApproval.anthropic) == true)
        #expect(store.isApproved(host: "this-mac") == false)
        #expect(try stateKeys(store)["approvals"]
                == .array([.object(["host": .string("anthropic"), "approvedAt": .string("2026-10-26T07:33:20.123Z")])]))
        #expect(try store.plainStateForTesting() != before)

        let again = try store.approveHost(HostApproval.anthropic, at: Self.approvedAt.addingTimeInterval(60))
        #expect(again == approval, "kept as it was")
        store.close()

        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(try reopened.hostApproval(HostApproval.anthropic) == approval)
        #expect(reopened.isApproved(host: HostApproval.anthropic) == true)
    }

    @Test("Only anthropic can be approved: another host is refused and nothing is written")
    func onlyAnthropic() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        let before = try store.plainStateForTesting()
        for host in ["this-mac", "Anthropic", "anthropic ", "", "openai"] {
            #expect(throws: ProofStoreError.invalidHost) { try store.approveHost(host, at: Self.approvedAt) }
        }
        #expect(try store.plainStateForTesting() == before)
        #expect(HostApproval(host: "anthropic", approvedAt: "2026-10-26T07:33:20Z") == nil, "the wire's form only")
        #expect(HostApproval(host: "anthropic", approvedAt: "2026-02-30T00:00:00.000Z") == nil)
    }

    @Test("Revoking removes it at once and drops the key; revoking with none writes nothing; it survives a reopen as revoked")
    func revoke() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let none = try store.plainStateForTesting()
        try store.revokeHost(HostApproval.anthropic)
        #expect(try store.plainStateForTesting() == none, "nothing to revoke, nothing written")

        try store.approveHost(HostApproval.anthropic, at: Self.approvedAt)
        try store.revokeHost(HostApproval.anthropic)
        #expect(store.isApproved(host: HostApproval.anthropic) == false)
        #expect(try stateKeys(store)["approvals"] == nil)
        store.close()
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.isApproved(host: HostApproval.anthropic) == false)
    }

    @Test("The page's commits carry the approval over unchanged and can never set or clear it")
    func commitsKeepIt() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        #expect(try commit(store, revision: 1) == .committed(revision: 1))
        #expect(store.isApproved(host: HostApproval.anthropic) == false, "a commit never approves")
        let approval = try store.approveHost(HostApproval.anthropic, at: Self.approvedAt)
        #expect(try commit(store, revision: 2) == .committed(revision: 2))
        #expect(try store.hostApproval(HostApproval.anthropic) == approval, "a commit never clears it")
        #expect(try store.read().record["approvals"] == nil, "the page's record never holds it")
    }

    @Test("While the store is locked or closed the approval cannot be read (nil, never approved), and approving or revoking throws")
    func lockedOrClosed() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        try store.approveHost(HostApproval.anthropic, at: Self.approvedAt)
        store.lockStore()
        #expect(store.isApproved(host: HostApproval.anthropic) == nil)
        #expect(throws: ProofStoreError.locked) { try store.revokeHost(HostApproval.anthropic) }
        #expect(throws: ProofStoreError.locked) { try store.approveHost(HostApproval.anthropic) }
        store.unlockStore()
        #expect(store.isApproved(host: HostApproval.anthropic) == true)
        store.close()
        #expect(store.isApproved(host: HostApproval.anthropic) == nil)
    }

    @Test("A stored approvals key that is not exactly a non-empty list of valid, distinct approvals makes the store corrupt")
    func strictRead() throws {
        let valid: JSONValue = .object(["host": .string("anthropic"), "approvedAt": .string("2026-10-26T07:33:20.123Z")])
        let bad: [(String, JSONValue)] = [
            ("empty list", .array([])),
            ("null", .null),
            ("an object", valid),
            ("twice", .array([valid, valid])),
            ("another host", .array([.object(["host": .string("this-mac"), "approvedAt": .string("2026-10-26T07:33:20.123Z")])])),
            ("an extra key", .array([.object(["host": .string("anthropic"), "approvedAt": .string("2026-10-26T07:33:20.123Z"),
                                              "by": .string("page")])])),
            ("a missing time", .array([.object(["host": .string("anthropic")])])),
            ("a bad time", .array([.object(["host": .string("anthropic"), "approvedAt": .string("yesterday")])])),
        ]
        for (name, value) in bad {
            let fixture = try DeskHostFixture()
            defer { fixture.clean() }
            let store = try fixture.makeStore()
            var state = try stateKeys(store)
            state["approvals"] = value
            try JSONValue.object(state).canonicalData().writePlainState(to: store)
            store.close()
            let reopened = try fixture.makeStore()
            defer { reopened.close() }
            #expect(reopened.status == .corrupt, "\(name)")
            #expect(reopened.isApproved(host: HostApproval.anthropic) == nil, "\(name): never approved")
        }

        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        var state = try stateKeys(store)
        state["approvals"] = .array([valid])
        try JSONValue.object(state).canonicalData().writePlainState(to: store)
        store.close()
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        #expect(reopened.isApproved(host: HostApproval.anthropic) == true)
    }

    @Test("No store, no approval: NoHostApproval approves nothing")
    func noStore() {
        #expect(NoHostApproval().isApproved(host: HostApproval.anthropic) == false)
    }
}
