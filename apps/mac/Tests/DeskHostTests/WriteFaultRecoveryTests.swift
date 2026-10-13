import Foundation
import Testing
@testable import DeskHost

/// Regressions from the October 9 Codex review, N4 and N5: write outcomes
/// are stage-aware, recovery trusts the folder and never rolls a commit back,
/// and the lock file and attempted records never follow a link.
@Suite("Write faults, recovery and link safety")
struct WriteFaultRecoveryTests {
    private func diskState(_ store: ProofStore) throws -> [String: JSONValue] {
        try #require(try JSONValue.decode(store.plainStateForTesting()).objectValue)
    }

    private func diskRevision(_ store: ProofStore) throws -> Int? {
        try diskState(store)["workspace"]?.objectValue?["revision"]?.safeIntegerValue
    }

    private func diskLedgerIds(_ store: ProofStore) throws -> [String] {
        (try diskState(store)["ledger"]?.arrayValue ?? []).compactMap { $0.objectValue?["requestId"]?.stringValue?.lowercased() }
    }

    private func diskReceiptIds(_ store: ProofStore) throws -> [String] {
        (try diskState(store)["receipts"]?.arrayValue ?? []).compactMap { $0.objectValue?["requestId"]?.stringValue?.lowercased() }
    }

    @Test("N4: every stage before the rename leaves the old file and applies nothing; a folder-flush failure after the rename is reported as visible-but-unsynced, memory adopts it, and durable answers retry the flush",
          arguments: [AtomicWriteStage.create, .write, .sync, .close, .rename])
    func stageOutcomes(stage: AtomicWriteStage) throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        let before = try store.plainStateForTesting()
        let record = DeliveryRecord(deliveryId: UUID(), bindingId: UUID(), connectionId: "c", generation: 0,
                                    sessionId: "52abcdef-0000-4000-8abc-000000000001", expectedRevision: 0, pushedAt: Date())
        faults.arm([0: stage])
        #expect(throws: ProofStoreError.writeFailed(EIO)) { try store.recordPendingDelivery(record) }
        #expect(try store.plainStateForTesting() == before, "\(stage): the old file is intact")
        #expect(try store.delivery(for: record.deliveryId) == nil, "\(stage): memory did not adopt a write that never became visible")
        let leftovers = try fixture.files.contentsOfDirectory(atPath: fixture.storeDirectory.path).filter { $0.contains(".tmp-") }
        #expect(leftovers.isEmpty, "\(stage): no temp file is left behind")

        faults.arm([0: .directoryFlush])
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.recordPendingDelivery(record) }
        #expect(try store.plainStateForTesting() != before, "the rename happened: the new file is visible")
        #expect(String(decoding: try store.plainStateForTesting(), as: UTF8.self).lowercased().contains(record.deliveryId.canonicalString))
        faults.failFlushRetries = true
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.delivery(for: record.deliveryId) }
        #expect(try store.visibleWorkspace().revision == 0, "the visible read serves what the folder shows")
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.read() }
        faults.failFlushRetries = false
        #expect(try store.delivery(for: record.deliveryId)?.isSaved == false, "once the flush retry succeeds the answer is durable")
        #expect(try store.delivery(for: record.deliveryId) != nil)
    }

    @Test("N4: a folder-flush failure after the commit rename leaves the commit in place: the reply is unknown, recovery re-reads the folder and reports awaiting-reconcile (never withdrawn, never rolled back), and reconcile answers ok once a flush succeeds")
    func flushFailureAfterCommitRename() async throws {
        let faults = WriteFaultScript()
        let harness = try HostHarness(faults: faults)
        defer { harness.clean() }
        let id = UUID()
        let record = inventedRecord("committed", revision: 1)
        // Write 0 is the dispatch receipt, write 1 the result.
        faults.arm([1: .directoryFlush])
        let reply = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: record, requestId: id))
        #expect(reply.outcome == .unknown, "visible but not provably durable is not ok")
        #expect(await harness.host.outstandingMutation == id)
        #expect(try diskRevision(harness.store) == 1, "the folder shows the commit")
        #expect(try diskLedgerIds(harness.store) == [id.canonicalString])
        #expect(try harness.store.visibleWorkspace().revision == 1, "memory adopted what the folder shows")

        faults.failFlushRetries = true
        #expect(try await harness.host.recoverUnresolvedDispatch() == .awaitingReconcile(id), "recovery sees the result on disk and withdraws nothing")
        #expect(await harness.host.outstandingMutation == id)
        #expect(try diskRevision(harness.store) == 1, "recovery never wrote an older record over the commit")
        #expect(try diskLedgerIds(harness.store) == [id.canonicalString])
        #expect(await harness.host.handle(harness.reconcileRequest(target: id)).outcome == .unknown, "not durable yet, so not ok yet")
        #expect(await harness.commit("blocked", expectedRevision: 1).reason == .mutationOutstanding)
        #expect(try harness.store.visibleWorkspace().record == record)
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try harness.store.read() }

        faults.failFlushRetries = false
        let reconciled = await harness.host.handle(harness.reconcileRequest(target: id))
        #expect(reconciled.original == ["outcome": .string("ok"), "revision": .number(1)])
        #expect(await harness.host.outstandingMutation == nil)
        #expect(try await harness.host.recoverUnresolvedDispatch() == .nothingOutstanding)
        #expect(await harness.commit("next", expectedRevision: 1).revision == 2)
        #expect(try diskRevision(harness.store) == 2)
    }

    @Test("N4: a result write that never became visible followed by a failed rollback write is unknown; recovery re-reads the folder, withdraws the receipt, and the page learns not-dispatched with the record untouched")
    func rollbackFailureAfterInvisibleResult() async throws {
        let faults = WriteFaultScript()
        let harness = try HostHarness(faults: faults)
        defer { harness.clean() }
        let id = UUID()
        // Write 1 (the result) fails at the rename, write 2 (the rollback) at the temp file.
        faults.arm([1: .rename, 2: .create])
        let reply = await harness.commit("never visible", expectedRevision: 0, requestId: id)
        #expect(reply.outcome == .unknown)
        #expect(await harness.host.outstandingMutation == id)
        #expect(try diskRevision(harness.store) == 0)
        #expect(try diskReceiptIds(harness.store) == [id.canonicalString], "the receipt is on disk without a result")
        #expect(try diskLedgerIds(harness.store).isEmpty)
        #expect(try harness.store.read().revision == 0)

        #expect(try await harness.host.recoverUnresolvedDispatch() == .withdrawn(id))
        #expect(await harness.host.outstandingMutation == nil)
        #expect(try diskReceiptIds(harness.store).isEmpty, "the withdrawal is on disk")
        #expect(try diskRevision(harness.store) == 0, "nothing was applied and nothing was rolled anywhere")
        #expect(await harness.host.handle(harness.reconcileRequest(target: id)).original == ["outcome": .string("not-dispatched")])
        #expect(await harness.commit("never visible", expectedRevision: 0, requestId: id).revision == 1, "the same id is a fresh mutation")
    }

    @Test("N4: a rollback write whose folder flush fails still refuses accurately (nothing applied) with the barrier free, and the next durable answer retries the flush")
    func rollbackFlushFailure() async throws {
        let faults = WriteFaultScript()
        let harness = try HostHarness(faults: faults)
        defer { harness.clean() }
        let id = UUID()
        faults.arm([1: .create, 2: .directoryFlush])
        let reply = await harness.commit("refused", expectedRevision: 0, requestId: id)
        #expect(reply.outcome == .refused)
        #expect(reply.reason == .storeCorrupt)
        #expect(await harness.host.outstandingMutation == nil)
        #expect(try diskReceiptIds(harness.store).isEmpty, "the withdrawal is visible")
        #expect(try harness.store.dispatchReceipt(for: id) == nil)
        #expect(try diskRevision(harness.store) == 0)
        #expect(await harness.commit("refused", expectedRevision: 0, requestId: id).revision == 1, "the flush retry succeeded and the retry dispatched fresh")
        #expect(try diskRevision(harness.store) == 1)
    }

    @Test("N4: recovery reads the folder, not memory: a newer committed state on disk is adopted and never overwritten, and an unreadable state file makes the store corrupt instead of being replaced")
    func recoveryReadsTheFolder() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let resolved = UUID()
        let first = CommitAttempt(requestId: resolved, payloadHash: "h", expectedRevision: 0, recordRevision: 1, record: inventedRecord("first", revision: 1))
        #expect(try store.commit(first) == .committed(revision: 1))
        store.close()
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var state = try #require(try decoder.decode(JSONValue.self, from: store.plainStateForTesting()).objectValue)
        let inFlight = UUID()
        let receipt = JSONValue.object(["requestId": .string(inFlight.uuidString), "operation": .string("workspace.commitProof"),
                                        "payloadHash": .string("crashed"), "dispatchedAt": .string("2026-10-09T00:00:00Z")])
        state["receipts"] = .array((state["receipts"]?.arrayValue ?? []) + [receipt])
        try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: store)
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.unresolvedDispatch == inFlight, "memory holds a receipt with no result")

        // Behind the store's back the folder moves on: the in-flight commit applied at revision 5.
        var newer = state
        var workspace = try #require(newer["workspace"]?.objectValue)
        workspace["revision"] = .number(5)
        workspace["record"] = .object(inventedRecord("newer", revision: 5))
        workspace["requestId"] = .string(inFlight.uuidString)
        newer["workspace"] = .object(workspace)
        newer["ledger"] = .array((newer["ledger"]?.arrayValue ?? []) + [.object([
            "requestId": .string(inFlight.uuidString), "operation": .string("workspace.commitProof"), "payloadHash": .string("crashed"),
            "outcome": .string("ok"), "revision": .number(5)
        ])])
        newer["identities"] = .array((newer["identities"]?.arrayValue ?? []) + [.object([
            "requestId": .string(inFlight.uuidString), "payloadHash": .string("crashed"), "outcome": .string("ok"), "revision": .number(5)
        ])])
        let newerBytes = try JSONEncoder().encode(JSONValue.object(newer))
        try newerBytes.writePlainState(to: store)
        #expect(try reopened.read().revision == 1, "memory is stale on purpose")
        #expect(try reopened.withdrawUnresolvedDispatch(inFlight) == .alreadyResolved, "the folder shows the commit applied")
        #expect(try store.plainStateForTesting() == newerBytes, "recovery wrote nothing over the newer state")
        #expect(try reopened.read().revision == 5, "memory now matches the folder")
        #expect(try reopened.terminalResult(for: inFlight)?.revision == 5)
        #expect(reopened.unresolvedDispatch == nil)

        try Data("{not state".utf8).writePlainState(to: store)
        #expect(throws: ProofStoreError.corrupt) { try reopened.withdrawUnresolvedDispatch(inFlight) }
        #expect(reopened.status == .corrupt)
        #expect(try store.plainStateForTesting() == Data("{not state".utf8), "nothing was replaced")
        #expect(throws: ProofStoreError.corrupt) { try reopened.read() }
    }

    @Test("N5: a proof.lock that is a link is refused before anything is truncated or written: the link target and a hard-linked twin keep their bytes")
    func linkedLockFileIsRefused() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        try fixture.files.createDirectory(at: fixture.storeDirectory, withIntermediateDirectories: true)
        let canary = fixture.directory.appendingPathComponent("canary.txt")
        let canaryBytes = Data("canary bytes that must survive\n".utf8)
        try canaryBytes.write(to: canary)
        let lock = fixture.storeDirectory.appendingPathComponent("proof.lock")

        try fixture.files.createSymbolicLink(at: lock, withDestinationURL: canary)
        #expect(throws: ProofStoreError.unsafeFile) { try fixture.makeStore() }
        #expect(try Data(contentsOf: canary) == canaryBytes, "the symlink target was not truncated or written")
        #expect(PathNode.inspect(lock.path) == .other, "the link itself is still a link")
        #expect(!fixture.files.fileExists(atPath: fixture.storeDirectory.appendingPathComponent("workspace.json").path), "nothing was provisioned")
        #expect(!fixture.files.fileExists(atPath: fixture.storeDirectory.appendingPathComponent("state.json").path))
        try fixture.files.removeItem(at: lock)

        let twin = fixture.directory.appendingPathComponent("twin.lock")
        let twinBytes = Data("hard-linked canary\n".utf8)
        try twinBytes.write(to: lock)
        try fixture.files.linkItem(at: lock, to: twin)
        #expect(PathNode.inspect(lock.path) == .regular(links: 2))
        #expect(throws: ProofStoreError.unsafeFile) { try fixture.makeStore() }
        #expect(try Data(contentsOf: twin) == twinBytes, "the hard-linked twin was not truncated or written")
        #expect(try Data(contentsOf: lock) == twinBytes)
        #expect(!fixture.files.fileExists(atPath: fixture.storeDirectory.appendingPathComponent("workspace.json").path))
        try fixture.files.removeItem(at: twin)
        #expect(PathNode.inspect(lock.path) == .regular(links: 1))

        let store = try fixture.makeStore()
        defer { store.close() }
        #expect(store.status == .ready, "a regular single-link lock file opens, and is the store's to write")
        #expect(String(decoding: try Data(contentsOf: lock), as: UTF8.self).hasPrefix("pid "))
        #expect(try Data(contentsOf: canary) == canaryBytes)
    }

    @Test("N5: the attempted folder and an attempted record that are links are refused, never followed; the losing commit is refused with its receipt withdrawn and the committed record intact")
    func linkedAttemptedPathsAreRefused() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        let winner = CommitAttempt(requestId: UUID(), payloadHash: "w", expectedRevision: 0, recordRevision: 1, record: inventedRecord("winner", revision: 1))
        #expect(try store.commit(winner) == .committed(revision: 1))
        let canaryDirectory = fixture.directory.appendingPathComponent("canary-dir", isDirectory: true)
        try fixture.files.createDirectory(at: canaryDirectory, withIntermediateDirectories: true)
        try fixture.files.createSymbolicLink(at: store.attemptedDirectory, withDestinationURL: canaryDirectory)
        let loserId = UUID()
        let loser = CommitAttempt(requestId: loserId, payloadHash: "l", expectedRevision: 0, recordRevision: 1, record: inventedRecord("loser", revision: 1))
        #expect(throws: ProofStoreError.unsafeFile) { try store.commit(loser) }
        #expect(try fixture.files.contentsOfDirectory(atPath: canaryDirectory.path).isEmpty, "nothing was written through the folder link")
        #expect(try store.dispatchReceipt(for: loserId) == nil, "the receipt was withdrawn")
        #expect(try store.terminalResult(for: loserId) == nil)
        #expect(try store.read().revision == 1)
        #expect(try store.read().record == winner.record)
        try fixture.files.removeItem(at: store.attemptedDirectory)

        try fixture.files.createDirectory(at: store.attemptedDirectory, withIntermediateDirectories: false)
        let canaryFile = fixture.directory.appendingPathComponent("canary.json")
        let canaryBytes = Data("{\"canary\":true}".utf8)
        try canaryBytes.write(to: canaryFile)
        let linkedRecord = store.attemptedDirectory.appendingPathComponent("\(loserId.canonicalString).json")
        try fixture.files.createSymbolicLink(at: linkedRecord, withDestinationURL: canaryFile)
        #expect(throws: ProofStoreError.unsafeFile) { try store.commit(loser) }
        #expect(try Data(contentsOf: canaryFile) == canaryBytes, "the record link target was not written")
        #expect(PathNode.inspect(linkedRecord.path) == .other, "the link was not replaced either")
        #expect(try store.dispatchReceipt(for: loserId) == nil)
        #expect(try store.read().revision == 1)
        try fixture.files.removeItem(at: linkedRecord)

        guard case .conflict(let current, let attempted) = try store.commit(loser) else { Issue.record("expected a conflict once the paths are honest"); return }
        #expect(current == 1)
        #expect(PathNode.inspect(attempted.path) == .regular(links: 1))
        #expect(try store.read().record == winner.record)
    }

    @Test("N5: a state.json that is a link opens as corrupt and is neither followed nor replaced")
    func linkedStateFileIsCorrupt() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let handle = store.workspaceHandle
        store.close()
        let real = try store.plainStateForTesting()
        let elsewhere = fixture.directory.appendingPathComponent("elsewhere.json")
        try real.write(to: elsewhere)
        try fixture.files.removeItem(at: store.stateURL)
        try fixture.files.createSymbolicLink(at: store.stateURL, withDestinationURL: elsewhere)
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .corrupt)
        #expect(reopened.workspaceHandle == handle)
        #expect(throws: ProofStoreError.corrupt) { try reopened.read() }
        #expect(PathNode.inspect(store.stateURL.path) == .other, "the link is still there")
        #expect(try Data(contentsOf: elsewhere) == real, "its target is untouched")
    }

    @Test("R2: a fresh document's authoritative read never serves a visible-but-unconfirmed commit as ok. The read retries the folder flush and answers unknown (base fields only) while it keeps failing, so the pinned page cannot mark the workspace saved; the newer record stays visible for recovery and nothing older is restored; once a flush succeeds the read is ok at the committed revision")
    func unconfirmedCommitIsNeverServedAsSaved() async throws {
        let faults = WriteFaultScript()
        let harness = try HostHarness(faults: faults)
        defer { harness.clean() }
        let id = UUID()
        let record = inventedRecord("committed", revision: 1)
        // Write 0 is the dispatch receipt, write 1 the result: visible, not provably durable.
        faults.arm([1: .directoryFlush])
        #expect(await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: record, requestId: id)).outcome == .unknown)
        #expect(try diskRevision(harness.store) == 1, "the folder shows the commit")
        faults.failFlushRetries = true

        // A fresh document: navigation, then bootstrap through issueConnection, capabilities and read.
        await harness.host.beginGeneration()
        let fresh = await harness.host.issueConnection()
        #expect(await harness.host.outstandingMutation == id, "not provably durable: the orphaned barrier is kept too")
        let capabilities = await harness.host.handle(harness.request(.capabilities, connection: fresh))
        #expect(capabilities.outcome == .ok)
        #expect(capabilities.capabilities?["store"] == .string("ready"), "capabilities serve no record; the codec-pinned status is unchanged")
        let read = await harness.host.handle(harness.readRequest(connection: fresh))
        #expect(read.outcome == .unknown, "the read cannot confirm the record, so it is not ok and the page cannot say saved")
        #expect(read.fields.isEmpty, "unknown carries base fields only")
        #expect(read.operation == HostOperation.workspaceRead.rawValue)
        #expect(await harness.host.handle(harness.readRequest(connection: fresh)).outcome == .unknown, "and again while the flush keeps failing")

        // Store level: the plain read is the confirmed read and refuses; the visible read is for recovery.
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try harness.store.read() }
        #expect(try harness.store.visibleWorkspace().revision == 1, "the newer record stays visible for recovery")
        #expect(try harness.store.visibleWorkspace().record == record)
        #expect(harness.store.status == .ready, "unconfirmed is not corrupt or missing")
        #expect(try diskRevision(harness.store) == 1, "nothing older was written over the commit and nothing was regenerated")
        #expect(try diskLedgerIds(harness.store) == [id.canonicalString])
        #expect(try await harness.host.recoverUnresolvedDispatch() == .awaitingReconcile(id), "recovery withdraws nothing")

        faults.failFlushRetries = false
        let confirmed = await harness.host.handle(harness.readRequest(connection: fresh))
        #expect(confirmed.outcome == .ok, "the retry flushed the folder: the record is confirmed")
        #expect(confirmed.revision == 1)
        #expect(confirmed.record == record)
        #expect(try harness.store.read().revision == 1)
        #expect(try diskRevision(harness.store) == 1)
        #expect(await harness.commit("after", expectedRevision: 1, connection: fresh).revision == 2, "durable now and owed to no one: the fresh document saves")
        #expect(await harness.host.outstandingMutation == nil)
        #expect(await harness.host.handle(harness.readRequest(connection: fresh)).revision == 2)
    }

    @Test("R2 across a reopen: a store opened on an established folder cannot know whether the last replacement's folder flush completed, so its first durable answer flushes once. After a visible-but-unconfirmed commit, close and reopen: the read refuses while the flush keeps failing, the restarted host answers unknown (never ok) to a fresh connection and refuses a save with nothing written, nothing older is restored, and the record is served at the committed revision only once a flush succeeds")
    func reopenedStoreConfirmsTheFolderBeforeServing() async throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        let id = UUID()
        let record = inventedRecord("committed", revision: 1)
        // Write 0 is the dispatch receipt, write 1 the result: visible, not provably durable.
        faults.arm([1: .directoryFlush])
        let attempt = CommitAttempt(requestId: id, payloadHash: "invented-hash", expectedRevision: 0, recordRevision: 1, record: record)
        #expect(throws: ProofStoreError.undetermined(requestId: id)) { try store.commit(attempt) }
        faults.failFlushRetries = true
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.read() }
        #expect(try diskRevision(store) == 1, "the folder shows the commit")
        store.close()

        // Same folder, new store, retries still failing: the memory of the pending flush is gone, the contract is not.
        let reopened = try fixture.makeStore(faults: faults)
        defer { reopened.close() }
        let writesBeforeReopen = faults.log.count
        #expect(reopened.status == .ready, "unconfirmed is not corrupt or missing")
        #expect(reopened.unresolvedDispatch == nil, "the result is on disk; nothing is receipt-only")
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try reopened.read() }
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try reopened.terminalResult(for: id) }
        #expect(try reopened.visibleWorkspace().revision == 1, "the newer record stays visible for recovery")
        #expect(try reopened.visibleWorkspace().record == record)
        #expect(faults.log.count == writesBeforeReopen, "opening and refusing wrote nothing")
        #expect(try diskRevision(reopened) == 1, "nothing older was restored")
        #expect(try diskLedgerIds(reopened) == [id.canonicalString])

        // A fresh document on the restarted host: bootstrap, then the authoritative read and a save.
        let restarted = DeskHostProtocol(store: reopened, connections: ConnectionRegistry(), drafts: DraftBindingRegistry(), info: HostHarness.info)
        #expect(await restarted.outstandingMutation == nil)
        #expect(try await restarted.recoverUnresolvedDispatch() == .nothingOutstanding)
        let connection = await restarted.issueConnection()
        let handle = JSONValue.string(reopened.workspaceHandle)
        func request(_ operation: HostOperation, _ payload: [String: JSONValue] = [:]) -> HostRequest {
            HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation, operation: operation,
                        payload: payload.merging(["workspaceHandle": handle]) { own, _ in own })
        }
        let read = await restarted.handle(request(.workspaceRead))
        #expect(read.outcome == .unknown, "the read cannot confirm the record, so the page cannot say saved")
        #expect(read.fields.isEmpty, "unknown carries base fields only")
        let next = inventedRecord("after", revision: 2)
        let save = await restarted.handle(request(.workspaceCommitProof, ["expectedRevision": .number(1), "record": .object(next)]))
        #expect(save.outcome == .refused, "no save on top of a record the store cannot vouch for")
        #expect(faults.log.count == writesBeforeReopen, "the refusal dispatched nothing: no receipt, no result")
        #expect(try diskRevision(reopened) == 1)
        #expect(await restarted.outstandingMutation == nil)

        faults.failFlushRetries = false
        let confirmed = await restarted.handle(request(.workspaceRead))
        #expect(confirmed.outcome == .ok, "one successful flush confirms the folder")
        #expect(confirmed.revision == 1)
        #expect(confirmed.record == record)
        #expect(faults.log.count == writesBeforeReopen, "confirming is a flush, not a write")
        #expect(try reopened.read().revision == 1)
        #expect(try reopened.terminalResult(for: id)?.revision == 1)
        let saved = await restarted.handle(request(.workspaceCommitProof, ["expectedRevision": .number(1), "record": .object(next)]))
        #expect(saved.outcome == .ok, "durable now: the fresh document saves")
        #expect(saved.revision == 2)
        #expect(try diskRevision(reopened) == 2)
        reopened.close()

        // A clean close makes no difference to the next open: it cannot know either, so it flushes once before its first durable answer.
        let again = try fixture.makeStore(faults: faults)
        defer { again.close() }
        let writesBeforeAgain = faults.log.count
        faults.failFlushRetries = true
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try again.read() }
        #expect(try again.visibleWorkspace().revision == 2)
        faults.failFlushRetries = false
        #expect(try again.read().revision == 2)
        #expect(try again.read().record == next)
        #expect(faults.log.count == writesBeforeAgain, "nothing was written to confirm")
    }
}
