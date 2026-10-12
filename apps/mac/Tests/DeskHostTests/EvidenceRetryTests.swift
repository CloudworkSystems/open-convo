import Foundation
import Testing
@testable import DeskHost

/// Regressions from the October 9 Codex review, N2 and N3: an identical retry
/// of the barrier holder is never a terminal refusal, and bounded eviction of
/// full results never makes a completed request look undispatched.
@Suite("Barrier retry and durable identity evidence")
struct EvidenceRetryTests {
    @Test("N2: an identical retry of the in-flight holder is unknown; a changed payload under its id is refused; once resolved both see the one result and the record is committed once")
    func identicalRetryOfHolderIsUnknownThenReplayed() async throws {
        let executor = GatedExecutor()
        let harness = try HostHarness(executor: executor)
        defer { harness.clean() }
        let host = harness.host
        let id = UUID()
        let record = inventedRecord("once", revision: 1)
        let request = harness.commitRequest(expectedRevision: 0, record: record, requestId: id)
        let original = Task { await host.handle(request) }
        await executor.gate.waitForArrival()
        #expect(await harness.host.outstandingMutation == id)

        let retry = await harness.host.handle(request)
        #expect(retry.outcome == .unknown, "the holder's own exact bytes are nonterminal while its result is undecided")
        #expect(retry.fields.isEmpty, "unknown carries base fields only")
        #expect(await harness.host.outstandingMutation == id)
        let changed = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("other", revision: 1), requestId: id))
        #expect(changed.outcome == .refused)
        #expect(changed.reason == .payloadMismatch, "the same id with other bytes is a changed payload, not another mutation")
        let other = await harness.commit("second", expectedRevision: 0)
        #expect(other.reason == .mutationOutstanding, "a different request behind the barrier is still refused")
        #expect(await harness.host.handle(harness.reconcileRequest(target: id)).outcome == .unknown)

        await executor.gate.open()
        let first = await original.value
        #expect(first.outcome == .ok)
        #expect(first.revision == 1)
        #expect(await harness.host.outstandingMutation == nil)
        let later = await harness.host.handle(request)
        #expect(later == first, "a later identical retry replays the one result")
        #expect(await harness.host.handle(harness.reconcileRequest(target: id)).original == ["outcome": .string("ok"), "revision": .number(1)])
        let committed = try harness.store.read()
        #expect(committed.revision == 1)
        #expect(committed.record == record, "committed once")
        #expect(try harness.store.ledgerEntry(for: id)?.revision == 1)
        #expect(await harness.commit("next", expectedRevision: 1).revision == 2)
    }

    @Test("N2: after the connection is lost, the exact re-send of the durable holder from a fresh connection replays its one result and other bytes stay refused; the fresh document is not blocked by the orphaned barrier")
    func exactResendOfDurableHolderReplays() async throws {
        let executor = PostWorkGatedExecutor()
        let harness = try HostHarness(executor: executor)
        defer { harness.clean() }
        let host = harness.host
        let id = UUID()
        let record = inventedRecord("durable", revision: 1)
        let request = harness.commitRequest(expectedRevision: 0, record: record, requestId: id)
        let pending = Task { await host.handle(request) }
        await executor.gate.waitForArrival()
        await harness.host.lock()
        await executor.gate.open()
        #expect(await pending.value.outcome == .unknown)
        #expect(await harness.host.outstandingMutation == id)

        await harness.host.unlock()
        #expect(await harness.host.outstandingMutation == id, "until a fresh document joins the barrier is still reported")
        let fresh = await harness.host.issueConnection()
        #expect(await harness.host.outstandingMutation == nil, "the lost document dropped the request: the orphaned barrier is released as a restart would")
        let changed = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("durable-changed", revision: 1),
                                                                      requestId: id, connection: fresh))
        #expect(changed.reason == .payloadMismatch, "a changed payload under the original id is still refused, from the ledger")
        let resent = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: record, requestId: id, connection: fresh))
        #expect(resent.outcome == .ok, "never a terminal refusal for the original bytes, barrier or not")
        #expect(resent.revision == 1)
        #expect(try harness.store.read().revision == 1, "a replay never commits twice")
        #expect(await harness.host.handle(harness.reconcileRequest(target: id, connection: fresh)).original == ["outcome": .string("ok"), "revision": .number(1)])
        #expect(await harness.commit("other", expectedRevision: 1, connection: fresh).revision == 2, "a different save from the fresh document is not blocked")
        #expect(await harness.commit("after", expectedRevision: 2, connection: fresh).revision == 3)
    }

    @Test("A fresh document that joins while the lost commit is still deciding waits for it: the barrier holds until the result is durable, then releases at that document's next save, so no save is refused for good")
    func orphanedBarrierWaitsForTheInFlightResult() async throws {
        let executor = PostWorkGatedExecutor()
        let harness = try HostHarness(executor: executor)
        defer { harness.clean() }
        let host = harness.host
        let id = UUID()
        let lostRequest = harness.commitRequest(expectedRevision: 0, record: inventedRecord("lost", revision: 1), requestId: id)
        let pending = Task { await host.handle(lostRequest) }
        await executor.gate.waitForArrival()
        await harness.host.beginGeneration()
        let fresh = await harness.host.issueConnection()
        #expect(await harness.host.outstandingMutation == id, "still deciding: nothing is released while the outcome is in flight")
        #expect(await harness.commit("early", expectedRevision: 1, connection: fresh).reason == .mutationOutstanding)
        #expect(try await harness.host.recoverUnresolvedDispatch() == .inFlight(id))

        await executor.gate.open()
        let lost = await pending.value
        #expect(lost.outcome == .unknown, "the dispatching document is gone, so its reply is unknown")
        #expect(lost.fields.isEmpty)
        #expect(await harness.host.outstandingMutation == id, "unknown always means the barrier is held at reply time")
        #expect(await harness.commit("after", expectedRevision: 1, connection: fresh).revision == 2, "the next save finds the barrier orphaned and proceeds")
        #expect(await harness.host.outstandingMutation == nil)
        #expect(await harness.host.handle(harness.reconcileRequest(target: id, connection: fresh)).original == ["outcome": .string("ok"), "revision": .number(1)])
        #expect(try harness.store.read().revision == 2)
    }

    @Test("A durable result still owed to a valid connection is not orphaned: a second connection, recovery and other saves leave the barrier until that connection's exact re-send replays it")
    func barrierOwedToValidConnectionIsKept() async throws {
        let faults = WriteFaultScript()
        let harness = try HostHarness(faults: faults)
        defer { harness.clean() }
        let id = UUID()
        let request = harness.commitRequest(expectedRevision: 0, record: inventedRecord("owed", revision: 1), requestId: id)
        // Write 0 is the dispatch receipt, write 1 the result: visible, not provably durable.
        faults.arm([1: .directoryFlush])
        #expect(await harness.host.handle(request).outcome == .unknown)
        faults.failFlushRetries = true
        let other = await harness.host.issueConnection()
        #expect(await harness.host.outstandingMutation == id, "the dispatching connection is still valid, so the result is owed to it")
        #expect(try await harness.host.recoverUnresolvedDispatch() == .awaitingReconcile(id))
        #expect(await harness.commit("other", expectedRevision: 1, connection: other).reason == .mutationOutstanding)
        #expect(await harness.commit("same-document", expectedRevision: 1).reason == .mutationOutstanding)
        #expect(await harness.host.handle(request).outcome == .unknown, "the exact re-send stays unknown until the flush succeeds")
        #expect(await harness.host.outstandingMutation == id)

        faults.failFlushRetries = false
        let replayed = await harness.host.handle(request)
        #expect(replayed.outcome == .ok)
        #expect(replayed.revision == 1)
        #expect(await harness.host.outstandingMutation == nil, "the one result reached the connection it was owed to")
        #expect(await harness.commit("after", expectedRevision: 1, connection: other).revision == 2)
    }

    @Test("A lost connection's result that is visible but not provably durable keeps its barrier through a fresh document; it is released only once the flush succeeds, at that document's next save")
    func orphanedBarrierNeedsADurableResult() async throws {
        let faults = WriteFaultScript()
        let harness = try HostHarness(faults: faults)
        defer { harness.clean() }
        let id = UUID()
        faults.arm([1: .directoryFlush])
        #expect(await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("lost", revision: 1), requestId: id)).outcome == .unknown)
        faults.failFlushRetries = true
        await harness.host.lock()
        await harness.host.unlock()
        let fresh = await harness.host.issueConnection()
        #expect(await harness.host.outstandingMutation == id, "not provably durable: nothing is released")
        #expect(try await harness.host.recoverUnresolvedDispatch() == .awaitingReconcile(id))
        #expect(await harness.commit("blocked", expectedRevision: 1, connection: fresh).reason == .mutationOutstanding)

        faults.failFlushRetries = false
        #expect(await harness.commit("after", expectedRevision: 1, connection: fresh).revision == 2, "durable now and owed to no one: released at this save")
        #expect(await harness.host.outstandingMutation == nil)
        #expect(await harness.host.handle(harness.reconcileRequest(target: id, connection: fresh)).original == ["outcome": .string("ok"), "revision": .number(1)])
    }

    @Test("At capacity 1 an unsaved delivery is never evicted by a later push; a saved one that is evicted still answers dictation.receipt and refuses a second commit as duplicate, never unknown, across a restart")
    func evictedSavedDeliveryStaysKnown() async throws {
        let harness = try HostHarness(ledgerCapacity: 1)
        defer { harness.clean() }
        _ = try await harness.bind(expectedRevision: 0)
        guard case .delivered(let first, _, _, _) = await harness.deliver("first words") else { Issue.record("expected the first delivery"); return }
        _ = try await harness.bind(expectedRevision: 0)
        guard case .delivered(let second, _, _, _) = await harness.deliver("second words") else { Issue.record("expected the second delivery"); return }
        #expect(try harness.store.delivery(for: first)?.isSaved == false, "an unsaved delivery is the only proof it was pushed: never evicted")
        #expect(try harness.store.delivery(for: second)?.isSaved == false)

        let saveFirst = UUID()
        let saved = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("first", revision: 1), deliveryId: first, requestId: saveFirst))
        #expect(saved.outcome == .ok)
        #expect(saved.revision == 1)
        _ = try await harness.bind(expectedRevision: 1)
        guard case .delivered(let third, _, _, _) = await harness.deliver("third words") else { Issue.record("expected the third delivery"); return }
        #expect(try harness.store.delivery(for: first) == nil, "past capacity the saved record is the one evicted")
        #expect(try harness.store.delivery(for: second)?.isSaved == false, "the unsaved one stays")
        #expect(try harness.store.delivery(for: third)?.isSaved == false)

        func check(_ host: DeskHostProtocol, _ store: ProofStore, connection: HostConnection) async throws {
            func request(_ operation: HostOperation, _ payload: [String: JSONValue]) -> HostRequest {
                HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation, operation: operation, payload: payload)
            }
            #expect(try store.deliveryEvidence(for: first) == .saved(commitRequestId: saveFirst, revision: 1))
            let receipt = await host.handle(request(.dictationReceipt, ["deliveryId": .string(first.canonicalString)]))
            #expect(receipt.outcome == .ok)
            #expect(receipt.fields == ["deliveryId": .string(first.canonicalString), "commitRequestId": .string(saveFirst.canonicalString), "revision": .number(1)])
            let again = await host.handle(request(.workspaceCommitProof, [
                "workspaceHandle": .string(store.workspaceHandle), "expectedRevision": .number(1),
                "record": .object(inventedRecord("again", revision: 2)), "dictationDeliveryId": .string(first.canonicalString)
            ]))
            #expect(again.outcome == .refused)
            #expect(again.reason == .duplicateDelivery, "a saved delivery is never unknown, however old")
            #expect(try store.read().revision == 1, "nothing was applied")
            #expect(await host.handle(request(.dictationReceipt, ["deliveryId": .string(second.canonicalString)])).outcome == .unknown, "pushed and never saved: still pending")
            #expect(await host.handle(request(.dictationReceipt, ["deliveryId": .string(UUID().canonicalString)])).reason == .unknownDelivery, "a delivery this store never pushed")
        }
        try await check(harness.host, harness.store, connection: harness.connection)

        harness.store.close()
        let reopened = try ProofStore(directory: harness.fixture.storeDirectory, keys: harness.fixture.keys, ledgerCapacity: 1)
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        #expect(try reopened.delivery(for: first) == nil)
        let restarted = DeskHostProtocol(store: reopened, connections: ConnectionRegistry(), drafts: DraftBindingRegistry(), info: HostHarness.info)
        let connection = await restarted.issueConnection()
        try await check(restarted, reopened, connection: connection)
    }

    @Test("N3: at capacity 1 a completed request stays known after its full result is evicted; reconcile answers its real outcome, never not-dispatched; a changed payload under its id is refused; all of it across a restart")
    func evictedResultStaysKnown() async throws {
        let harness = try HostHarness(ledgerCapacity: 1)
        defer { harness.clean() }
        let a = UUID()
        let b = UUID()
        let recordA = inventedRecord("a", revision: 1)
        let requestA = harness.commitRequest(expectedRevision: 0, record: recordA, requestId: a)
        #expect(await harness.host.handle(requestA).revision == 1)
        #expect(await harness.commit("b", expectedRevision: 1, requestId: b).revision == 2)
        #expect(try harness.store.ledgerEntry(for: a) == nil, "the full result was evicted")
        #expect(try harness.store.dispatchReceipt(for: a) == nil)
        #expect(try harness.store.ledgerEntry(for: b)?.revision == 2)

        func check(_ host: DeskHostProtocol, _ store: ProofStore, connection: HostConnection) async throws {
            func request(_ operation: HostOperation, _ payload: [String: JSONValue], requestId: UUID = UUID()) -> HostRequest {
                HostRequest(requestId: requestId, connectionId: connection.id, generation: connection.generation, operation: operation, payload: payload)
            }
            let handle = JSONValue.string(store.workspaceHandle)
            let reconciled = await host.handle(request(.workspaceReconcile, ["workspaceHandle": handle, "targetRequestId": .string(a.canonicalString)]))
            #expect(reconciled.outcome == .ok)
            #expect(reconciled.original?["outcome"] != .string("not-dispatched"), "absence from the bounded lists is not proof of non-dispatch")
            #expect(reconciled.original == ["outcome": .string("ok"), "revision": .number(1)])
            let reused = await host.handle(request(.workspaceCommitProof, [
                "workspaceHandle": handle, "expectedRevision": .number(2), "record": .object(inventedRecord("a-again", revision: 3))
            ], requestId: a))
            #expect(reused.outcome == .refused)
            #expect(reused.reason == .payloadMismatch, "a known identity with other bytes stays refused after eviction")
            #expect(try store.read().revision == 2, "nothing was applied")
            let exact = await host.handle(request(.workspaceCommitProof, [
                "workspaceHandle": handle, "expectedRevision": .number(0), "record": .object(recordA)
            ], requestId: a))
            #expect(exact.outcome == .ok)
            #expect(exact.revision == 1, "the exact bytes replay the one result and never commit again")
            #expect(try store.read().revision == 2)
            let bindReuse = await host.handle(request(.dictationBindDraft, [
                "workspaceHandle": handle, "sessionId": .string(UUID().canonicalString), "expectedRevision": .number(2),
                "expectedText": .string("x"), "selection": .object(["start": .number(0), "end": .number(0)])
            ], requestId: a))
            #expect(bindReuse.reason == .payloadMismatch)
            let fresh = await host.handle(request(.workspaceReconcile, ["workspaceHandle": handle, "targetRequestId": .string(UUID().canonicalString)]))
            #expect(fresh.original == ["outcome": .string("not-dispatched")], "a genuinely new id still answers not-dispatched")
        }
        try await check(harness.host, harness.store, connection: harness.connection)

        harness.store.close()
        let reopened = try ProofStore(directory: harness.fixture.storeDirectory, keys: harness.fixture.keys, ledgerCapacity: 1)
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        #expect(try reopened.ledgerEntry(for: a) == nil)
        let restarted = DeskHostProtocol(store: reopened, connections: ConnectionRegistry(), drafts: DraftBindingRegistry(), info: HostHarness.info)
        let connection = await restarted.issueConnection()
        try await check(restarted, reopened, connection: connection)
    }

    @Test("R1: a completed request never clears a newer request's in-flight marker. A commits durably and pauses; reconcile releases A; B takes the barrier and pauses before its store work; A returns. B stays in flight: its retry and reconcile are unknown, recovery reports in-flight (never withdrawn, never not-dispatched), another mutation is refused, and B then commits exactly once at the right revision")
    func completedRequestLeavesNewerInFlightMarkerAlone() async throws {
        let executor = TwoStageExecutor()
        let harness = try HostHarness(executor: executor)
        defer { harness.clean() }
        let host = harness.host
        let a = UUID()
        let b = UUID()
        let recordA = inventedRecord("a", revision: 1)
        let recordB = inventedRecord("b", revision: 2)
        let requestA = harness.commitRequest(expectedRevision: 0, record: recordA, requestId: a)
        let requestB = harness.commitRequest(expectedRevision: 1, record: recordB, requestId: b)

        // 1. A's store commit is durable; its executor pauses before returning.
        let pendingA = Task { await host.handle(requestA) }
        await executor.afterFirst.waitForArrival()
        #expect(await harness.host.outstandingMutation == a)
        #expect(try harness.store.ledgerEntry(for: a)?.revision == 1, "A's result is on disk")

        // 2. reconcile(A) reads the durable result and releases A's holder.
        let reconciledA = await harness.host.handle(harness.reconcileRequest(target: a))
        #expect(reconciledA.original == ["outcome": .string("ok"), "revision": .number(1)])
        #expect(await harness.host.outstandingMutation == nil, "A's barrier is released by the reconcile")

        // 3. B starts, takes the barrier and the in-flight marker, and pauses before its store work.
        let pendingB = Task { await host.handle(requestB) }
        await executor.beforeSecond.waitForArrival()
        #expect(await harness.host.outstandingMutation == b)
        #expect(try harness.store.dispatchReceipt(for: b) == nil, "B has not written its receipt")

        // 4. A's executor returns while B is in flight.
        await executor.afterFirst.open()
        let repliedA = await pendingA.value
        #expect(repliedA.outcome == .ok)
        #expect(repliedA.revision == 1)
        #expect(await harness.host.outstandingMutation == b, "A's completion releases nothing of B's")

        // 5. Recovery runs while B has no receipt yet: B is still being decided.
        #expect(try await harness.host.recoverUnresolvedDispatch() == .inFlight(b), "B's outcome is undecided: never withdrawn")
        #expect(await harness.host.outstandingMutation == b, "B's barrier stays")
        let retryB = await harness.host.handle(requestB)
        #expect(retryB.outcome == .unknown, "B's own exact bytes are nonterminal while it is in flight")
        #expect(retryB.fields.isEmpty)
        let reconciledB = await harness.host.handle(harness.reconcileRequest(target: b))
        #expect(reconciledB.outcome == .unknown, "B is dispatched and undecided")
        #expect(reconciledB.original?["outcome"] != .string("not-dispatched"))
        #expect(await harness.commit("c", expectedRevision: 1).reason == .mutationOutstanding, "no other mutation is admitted behind B")
        #expect(try harness.store.read().revision == 1, "nothing else was applied")
        #expect(try await harness.host.recoverUnresolvedDispatch() == .inFlight(b), "a second recovery says the same")

        // 6. B's executor resumes and commits exactly once.
        await executor.beforeSecond.open()
        let repliedB = await pendingB.value
        #expect(repliedB.outcome == .ok)
        #expect(repliedB.revision == 2, "B committed at the revision it asked for")
        #expect(await harness.host.outstandingMutation == nil)
        let committed = try harness.store.read()
        #expect(committed.revision == 2)
        #expect(committed.record == recordB, "committed once, nothing doubled")
        #expect(try harness.store.ledgerEntry(for: b)?.revision == 2)
        #expect(try harness.store.ledgerEntry(for: a)?.revision == 1)
        #expect(await harness.host.handle(harness.reconcileRequest(target: b)).original == ["outcome": .string("ok"), "revision": .number(2)])
        #expect(await harness.host.handle(harness.reconcileRequest(target: a)).original == ["outcome": .string("ok"), "revision": .number(1)])
        #expect(await harness.host.handle(requestB) == repliedB, "B's later identical retry replays its one result")
        #expect(try await harness.host.recoverUnresolvedDispatch() == .nothingOutstanding)
        #expect(await harness.commit("after", expectedRevision: 2).revision == 3, "the barrier is free for the next save")
    }
}
