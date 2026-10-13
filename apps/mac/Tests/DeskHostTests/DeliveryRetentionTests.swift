import Foundation
import Testing
@testable import DeskHost

/// Owner decision A (October 12) with Codex's second review of #7: words a
/// commit saves are never offered again, even when a lock set them aside
/// while that commit was running.
@Suite("Delivery retention")
struct DeliveryRetentionTests {
    @Test("A lock during a commit that then saves: the words are set aside, then forgotten once the save is on disk")
    func lockDuringSavingCommit() async throws {
        let executor = PostWorkGatedExecutor()
        let harness = try HostHarness(executor: executor)
        defer { harness.clean() }
        let host = harness.host
        let bound = await host.handle(harness.bindRequest())
        #expect(bound.outcome == .ok)
        guard case .delivered(let deliveryId, _, _, _) = await harness.deliver("invented words") else {
            Issue.record("the final should be pushed")
            return
        }
        #expect(harness.drafts.keepsUnsavedWords, "kept until the save is confirmed")
        let commit = harness.commitRequest(expectedRevision: 0, record: inventedRecord("dictated", revision: 1), deliveryId: deliveryId)
        let saving = Task { await host.handle(commit) }
        await executor.gate.waitForArrival()
        await host.lock()
        #expect(harness.drafts.heldDeliveries.map(\.text) == ["invented words"], "the lock set the unconfirmed words aside")
        await executor.gate.open()
        _ = await saving.value
        #expect(harness.drafts.heldDeliveries.isEmpty, "saved words are not offered again")
        #expect(!harness.drafts.keepsUnsavedWords)
    }

    /// Codex P1 on #7, round 3: an exact resend that finds the saved result
    /// forgets the words too (as after an undetermined write).
    @Test("An exact resend of a saved commit forgets the set-aside words")
    func exactResendForgetsSavedWords() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let host = harness.host
        #expect(await host.handle(harness.bindRequest()).outcome == .ok)
        guard case .delivered(let deliveryId, _, _, _) = await harness.deliver("invented words") else {
            Issue.record("the final should be pushed")
            return
        }
        let commit = harness.commitRequest(expectedRevision: 0, record: inventedRecord("dictated", revision: 1), deliveryId: deliveryId)
        #expect(await host.handle(commit).outcome == .ok)
        // Stand in for words set aside while the first answer was lost.
        harness.drafts.hold(HeldDelivery(deliveryId: deliveryId, generation: harness.connection.generation, reason: .notSaved,
                                         text: "invented words", heldAt: Date()))
        #expect(harness.drafts.keepsUnsavedWords)
        #expect(await host.handle(commit).outcome == .ok, "the exact resend gets the saved result")
        #expect(harness.drafts.heldDeliveries.isEmpty, "saved words are not offered again")
    }
}
