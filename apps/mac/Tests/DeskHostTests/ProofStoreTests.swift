import Foundation
import Testing
@testable import DeskHost

@Suite("Proof store")
struct ProofStoreTests {
    private func attempt(_ requestId: UUID = UUID(), hash: String, expected: Int, revision: Int, label: String = "x",
                         deliveryId: UUID? = nil) -> CommitAttempt {
        CommitAttempt(requestId: requestId, payloadHash: hash, expectedRevision: expected, recordRevision: revision,
                      record: inventedRecord(label, revision: revision), deliveryId: deliveryId)
    }

    @Test("A fresh store is provisioned once with the invented revision-0 fixture, one placeholder key and a held lock file")
    func freshStore() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        let workspace = try store.read()
        #expect(store.status == .ready)
        #expect(workspace.revision == 0)
        #expect(workspace.record["revision"] == .number(0))
        #expect(workspace.record["goals"]?.arrayValue?.count == 1, "the seed carries one invented folder so the renderer can open it")
        #expect(workspace.record["sessions"] == .array([]))
        #expect(workspace.workspaceHandle == store.workspaceHandle)
        #expect(store.workspaceHandle.hasPrefix("ws-"))
        #expect(!store.workspaceHandle.contains("/"), "a handle is never a path")
        #expect(store.unresolvedDispatch == nil)
        #expect(fixture.keys.heldKeyCount == 1)
        #expect(try fixture.keys.existingKey(for: store.workspaceId)?.custody == InventedInMemoryKeyProvider.custody)
        #expect(store.keyCustody == InventedInMemoryKeyProvider.custody)
        #expect(fixture.files.fileExists(atPath: store.stateURL.path))
        #expect(fixture.files.fileExists(atPath: store.markerURL.path))
        #expect(fixture.files.fileExists(atPath: store.lockURL.path))
        let state = String(decoding: try Data(contentsOf: store.stateURL), as: UTF8.self)
        #expect(!state.contains("material"))
        #expect(throws: ProofStoreError.invalidSeed) {
            try ProofStore(directory: fixture.directory.appendingPathComponent("bad"), keys: fixture.keys, seed: WorkspaceSeed(record: ["x": .null]))
        }
    }

    @Test("A seeded store keeps the given handle and record, including uppercase record ids")
    func seededStore() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let record: [String: JSONValue] = ["revision": .number(1), "goals": .array([.object(["id": .string("A1000000-0000-1000-8000-000000000001")])])]
        let store = try fixture.makeStore(seed: WorkspaceSeed(workspaceHandle: "invented-workspace-handle", record: record))
        defer { store.close() }
        #expect(store.workspaceHandle == "invented-workspace-handle")
        #expect(try store.read().revision == 1)
        #expect(try store.read().record == record)
    }

    @Test("A second writer on the same folder is refused until the first closes")
    func secondWriterRefused() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let first = try fixture.makeStore()
        #expect(throws: ProofStoreError.secondWriter) { try fixture.makeStore() }
        first.close()
        let second = try fixture.makeStore()
        defer { second.close() }
        #expect(second.workspaceId == first.workspaceId)
        #expect(second.workspaceHandle == first.workspaceHandle)
        #expect(throws: ProofStoreError.closed) { try first.read() }
    }

    @Test("Commit replaces the state atomically, allows revision gaps, survives reopen, and replays its exact retry")
    func commitIsDurable() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let requestId = UUID()
        let first = attempt(requestId, hash: "hash-1", expected: 0, revision: 3, label: "first")
        #expect(try store.commit(first) == .committed(revision: 3))
        #expect(try store.dispatchReceipt(for: requestId)?.payloadHash == "hash-1")
        #expect(store.unresolvedDispatch == nil, "a recorded result resolves its receipt")
        store.close()

        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        let workspace = try reopened.read()
        #expect(workspace.revision == 3)
        #expect(workspace.record == first.record)
        #expect(workspace.requestId == requestId)
        #expect(try reopened.commit(first)
                == .replayed(ReplayEntry(requestId: requestId, operation: .workspaceCommitProof, payloadHash: "hash-1", outcome: .ok, revision: 3)))
        #expect(try reopened.commit(attempt(requestId, hash: "hash-2", expected: 3, revision: 4)) == .payloadMismatch)
        #expect(try reopened.read().revision == 3)
        #expect(throws: ProofStoreError.corruptState) { try reopened.commit(attempt(hash: "h", expected: 3, revision: 3)) }
        let leftovers = try fixture.files.contentsOfDirectory(atPath: fixture.storeDirectory.path).filter { $0.contains(".tmp-") }
        #expect(leftovers.isEmpty)
    }

    @Test("A stale expected revision keeps the committed record and retains the attempted record")
    func conflictRetainsAttempt() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        let winner = attempt(hash: "w", expected: 0, revision: 1, label: "winner")
        #expect(try store.commit(winner) == .committed(revision: 1))
        let loserId = UUID()
        let loser = attempt(loserId, hash: "l", expected: 0, revision: 1, label: "loser")
        let outcome = try store.commit(loser)
        guard case .conflict(let current, let attempted) = outcome else {
            Issue.record("expected conflict, got \(outcome)")
            return
        }
        #expect(current == 1)
        #expect(attempted.lastPathComponent == "\(loserId.canonicalString).json")
        let retained = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: attempted))
        #expect(retained.objectValue?["record"] == .object(loser.record))
        #expect(retained.objectValue?["expectedRevision"] == .number(0))
        #expect(retained.objectValue?["currentRevision"] == .number(1))
        #expect(try store.read().record == winner.record)
        #expect(try store.read().revision == 1)
        #expect(try store.commit(loser)
                == .replayed(ReplayEntry(requestId: loserId, operation: .workspaceCommitProof, payloadHash: "l", outcome: .conflict,
                                         revision: 1, reason: .revisionMismatch)))
        #expect(store.unresolvedDispatch == nil)
    }

    @Test("An existing store with a missing key refuses to open and nothing is regenerated or replaced")
    func missingKeyRefuses() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try store.commit(attempt(hash: "h", expected: 0, revision: 1, label: "kept")) == .committed(revision: 1))
        let workspaceId = store.workspaceId
        let stateBefore = try Data(contentsOf: store.stateURL)
        store.close()
        fixture.keys.forgetKey(for: workspaceId)
        #expect(throws: ProofStoreError.keyMissing) { try fixture.makeStore() }
        #expect(fixture.keys.heldKeyCount == 0)
        #expect(try Data(contentsOf: fixture.storeDirectory.appendingPathComponent("state.json")) == stateBefore)
        // The refused opener released the writer lock, so a holder with the key can still open.
        _ = try fixture.keys.createKey(for: workspaceId)
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(try reopened.read().revision == 1)
    }

    @Test("An established store whose state is unreadable opens as corrupt: reads and writes refuse, the file is left untouched")
    func corruptStateIsReportedNotReplaced() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let handle = store.workspaceHandle
        store.close()
        let garbage = Data("{\"formatVersion\": \"nope\"".utf8)
        try garbage.write(to: store.stateURL)
        let corrupt = try fixture.makeStore()
        defer { corrupt.close() }
        #expect(corrupt.status == .corrupt)
        #expect(corrupt.workspaceHandle == handle, "the handle survives through the marker")
        #expect(throws: ProofStoreError.corrupt) { try corrupt.read() }
        #expect(throws: ProofStoreError.corrupt) { try corrupt.commit(attempt(hash: "h", expected: 0, revision: 1)) }
        #expect(throws: ProofStoreError.corrupt) { try corrupt.ledgerEntry(for: UUID()) }
        #expect(try Data(contentsOf: store.stateURL) == garbage)
        #expect(fixture.keys.heldKeyCount == 1, "no key is regenerated")
    }

    @Test("A state file naming a participant operation in its ledger or receipts opens as corrupt, as it did before the names existed")
    func participantOperationInStateIsCorrupt() throws {
        for section in ["ledger", "receipts"] {
            let fixture = try DeskHostFixture()
            defer { fixture.clean() }
            let store = try fixture.makeStore()
            #expect(try store.commit(attempt(hash: "h", expected: 0, revision: 1)) == .committed(revision: 1))
            store.close()
            var state = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: store.stateURL)) as? [String: Any])
            var entries = try #require(state[section] as? [[String: Any]])
            #expect(entries.count == 1)
            #expect(entries.first?["operation"] as? String == "workspace.commitProof")

            // The same file rewritten unchanged still opens: only the name matters.
            try JSONSerialization.data(withJSONObject: state).write(to: store.stateURL)
            let control = try fixture.makeStore()
            #expect(control.status == .ready, "\(section): the rewrite alone is harmless")
            control.close()

            entries[0]["operation"] = "participant.start"
            state[section] = entries
            let edited = try JSONSerialization.data(withJSONObject: state)
            try edited.write(to: store.stateURL)
            let reopened = try fixture.makeStore()
            defer { reopened.close() }
            #expect(reopened.status == .corrupt, "\(section)")
            #expect(throws: ProofStoreError.corrupt) { try reopened.read() }
            #expect(try Data(contentsOf: store.stateURL) == edited, "the file is left untouched")
        }
    }

    @Test("An established store whose state file is gone opens as missing and is never re-provisioned")
    func missingStateIsReportedNotReprovisioned() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        store.close()
        try fixture.files.removeItem(at: store.stateURL)
        let missing = try fixture.makeStore()
        defer { missing.close() }
        #expect(missing.status == .missing)
        #expect(throws: ProofStoreError.missing) { try missing.read() }
        #expect(throws: ProofStoreError.missing) { try missing.commit(attempt(hash: "h", expected: 0, revision: 1)) }
        #expect(!fixture.files.fileExists(atPath: store.stateURL.path), "nothing was written back")
        #expect(fixture.keys.heldKeyCount == 1)
    }

    @Test("Lock refuses reads and writes until unlock; close refuses for good")
    func lockAndClose() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        store.lockStore()
        #expect(store.isLocked)
        #expect(throws: ProofStoreError.locked) { try store.read() }
        #expect(throws: ProofStoreError.locked) { try store.commit(attempt(hash: "h", expected: 0, revision: 1)) }
        #expect(throws: ProofStoreError.locked) { try store.ledgerEntry(for: UUID()) }
        store.unlockStore()
        #expect(try store.read().revision == 0)
        store.close()
        #expect(throws: ProofStoreError.closed) { try store.read() }
        #expect(throws: ProofStoreError.closed) { try store.commit(attempt(hash: "h", expected: 0, revision: 1)) }
    }

    @Test("A delivery is recorded before any text moves, saved only by the commit that names it, and found again after reopen")
    func deliveryReceiptsAreDurable() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let deliveryId = UUID()
        let record = DeliveryRecord(deliveryId: deliveryId, bindingId: UUID(), connectionId: "c", generation: 0,
                                    sessionId: "52abcdef-0000-4000-8abc-000000000001", expectedRevision: 0, pushedAt: Date())
        try store.recordPendingDelivery(record)
        #expect(throws: ProofStoreError.replayExists) { try store.recordPendingDelivery(record) }
        #expect(try store.delivery(for: deliveryId)?.isSaved == false)
        #expect(throws: ProofStoreError.unknownDelivery) { try store.commit(attempt(hash: "u", expected: 0, revision: 1, deliveryId: UUID())) }

        #expect(try store.commit(attempt(hash: "plain", expected: 0, revision: 1, label: "unrelated")) == .committed(revision: 1))
        #expect(try store.delivery(for: deliveryId)?.isSaved == false, "an unrelated commit never marks a delivery saved")
        let commitId = UUID()
        #expect(try store.commit(attempt(commitId, hash: "d", expected: 1, revision: 2, label: "dictated", deliveryId: deliveryId)) == .committed(revision: 2))
        let saved = try #require(try store.delivery(for: deliveryId))
        #expect(saved.commitRequestId == commitId)
        #expect(saved.revision == 2)
        #expect(throws: ProofStoreError.duplicateDelivery) { try store.commit(attempt(hash: "again", expected: 2, revision: 3, deliveryId: deliveryId)) }
        #expect(try store.read().revision == 2)
        store.close()

        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(try reopened.delivery(for: deliveryId)?.commitRequestId == commitId)
        #expect(!String(decoding: try Data(contentsOf: reopened.stateURL), as: UTF8.self).contains("\"text\""))
    }

    @Test("A commit whose second write fails withdraws its receipt; a failed write-ahead receipt dispatches nothing")
    func writeFailuresLeaveNoDispatch() throws {
        let files = FlakyFileManager()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(fileManager: files)
        defer { store.close() }
        let requestId = UUID()
        files.failWrites = true
        #expect(throws: ProofStoreError.self) { try store.commit(attempt(requestId, hash: "h", expected: 0, revision: 1)) }
        files.failWrites = false
        #expect(try store.dispatchReceipt(for: requestId) == nil, "nothing reached the receipt log")
        #expect(try store.ledgerEntry(for: requestId) == nil)
        #expect(try store.read().revision == 0)
        #expect(store.unresolvedDispatch == nil)
        #expect(try store.commit(attempt(requestId, hash: "h", expected: 0, revision: 1)) == .committed(revision: 1), "the retry is a fresh dispatch")
    }

    @Test("A receipt without a ledger entry (a crash in flight) restores the barrier holder on reopen; two of them read as corrupt")
    func unresolvedReceiptSurvivesRestart() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try store.commit(attempt(hash: "h", expected: 0, revision: 1)) == .committed(revision: 1))
        store.close()
        var state = try JSONDecoder.iso.decode(JSONValue.self, from: Data(contentsOf: store.stateURL)).objectValue!
        let inFlight = UUID()
        let receipt = JSONValue.object(["requestId": .string(inFlight.uuidString), "operation": .string("workspace.commitProof"),
                                        "payloadHash": .string("crashed"), "dispatchedAt": .string("2026-10-09T00:00:00Z")])
        state["receipts"] = .array((state["receipts"]?.arrayValue ?? []) + [receipt])
        try JSONEncoder().encode(JSONValue.object(state)).write(to: store.stateURL)
        let reopened = try fixture.makeStore()
        #expect(reopened.status == .ready)
        #expect(reopened.unresolvedDispatch == inFlight)
        #expect(try reopened.dispatchReceipt(for: inFlight) != nil)
        #expect(try reopened.ledgerEntry(for: inFlight) == nil)
        reopened.close()

        let second = JSONValue.object(["requestId": .string(UUID().uuidString), "operation": .string("workspace.commitProof"),
                                       "payloadHash": .string("also"), "dispatchedAt": .string("2026-10-09T00:00:00Z")])
        state["receipts"] = .array((state["receipts"]?.arrayValue ?? []) + [second])
        try JSONEncoder().encode(JSONValue.object(state)).write(to: store.stateURL)
        let inconsistent = try fixture.makeStore()
        defer { inconsistent.close() }
        #expect(inconsistent.status == .corrupt, "two unresolved dispatches cannot both be the one in flight")
    }

    @Test("A first open whose provisioning write fails leaves no store behind, so the next open provisions fresh instead of reporting missing")
    func failedProvisioningLeavesNoStore() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let files = FlakyFileManager()
        for failing in [0, 1] {
            files.arm(failing: [failing])
            #expect(throws: ProofStoreError.self) { try fixture.makeStore(fileManager: files) }
            files.disarm()
            #expect(!fixture.files.fileExists(atPath: fixture.storeDirectory.appendingPathComponent("workspace.json").path),
                    "write \(failing) failed: no marker may vouch for a state that never landed")
            #expect(!fixture.files.fileExists(atPath: fixture.storeDirectory.appendingPathComponent("state.json").path))
        }
        let store = try fixture.makeStore()
        defer { store.close() }
        #expect(store.status == .ready)
        #expect(try store.read().revision == 0)
        #expect(fixture.files.fileExists(atPath: store.markerURL.path))
    }

    @Test("The writer lock releases its descriptor once: a second release (the deinit after a failed first open) never closes a number another file has since been given")
    func writerLockReleasesOnce() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let lock = try ProofStore.acquireWriterLock(at: fixture.directory.appendingPathComponent("proof.lock"))
        let number = lock.descriptor
        #expect(number >= 0)
        #expect(lock.isHeld)
        lock.release()
        #expect(!lock.isHeld)
        #expect(lock.descriptor == -1)
        // The lowest free number is handed out first, so this file normally
        // receives the lock's old number; the checks below hold either way.
        let victim = open(fixture.directory.appendingPathComponent("victim").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        #expect(victim >= 0)
        defer { Darwin.close(victim) }
        lock.release()
        #expect(fcntl(victim, F_GETFD) != -1, "the second release closed descriptor \(victim); the lock's number was \(number)")
        let note = Data("ok".utf8)
        #expect(note.withUnsafeBytes { write(victim, $0.baseAddress, $0.count) } == 2, "the victim's descriptor still writes")
        #expect(!lock.isHeld)
    }

    @Test("Explicit recovery withdraws a receipt that never got its result, durably; resolved and unknown ids are left alone; a record naming the id is contradictory")
    func withdrawUnresolvedDispatch() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let resolved = UUID()
        #expect(try store.commit(attempt(resolved, hash: "h", expected: 0, revision: 1)) == .committed(revision: 1))
        store.close()
        var state = try JSONDecoder.iso.decode(JSONValue.self, from: Data(contentsOf: store.stateURL)).objectValue!
        let inFlight = UUID()
        let receipt = JSONValue.object(["requestId": .string(inFlight.uuidString), "operation": .string("workspace.commitProof"),
                                        "payloadHash": .string("crashed"), "dispatchedAt": .string("2026-10-09T00:00:00Z")])
        state["receipts"] = .array((state["receipts"]?.arrayValue ?? []) + [receipt])
        try JSONEncoder().encode(JSONValue.object(state)).write(to: store.stateURL)

        let reopened = try fixture.makeStore()
        #expect(reopened.unresolvedDispatch == inFlight)
        #expect(try reopened.withdrawUnresolvedDispatch(resolved) == .alreadyResolved, "a result in the ledger is reconciliation's, not recovery's")
        #expect(try reopened.withdrawUnresolvedDispatch(UUID()) == .nothingToWithdraw)
        #expect(reopened.unresolvedDispatch == inFlight)
        #expect(try reopened.withdrawUnresolvedDispatch(inFlight) == .withdrawn)
        #expect(reopened.unresolvedDispatch == nil)
        #expect(try reopened.dispatchReceipt(for: inFlight) == nil)
        #expect(try reopened.ledgerEntry(for: resolved)?.revision == 1, "nothing else moved")
        #expect(try reopened.read().revision == 1)
        #expect(try reopened.withdrawUnresolvedDispatch(inFlight) == .nothingToWithdraw, "withdrawn once")
        reopened.lockStore()
        #expect(throws: ProofStoreError.locked) { try reopened.withdrawUnresolvedDispatch(inFlight) }
        reopened.close()

        let again = try fixture.makeStore()
        #expect(again.unresolvedDispatch == nil, "the withdrawal is on disk")
        #expect(try again.dispatchReceipt(for: inFlight) == nil)
        again.close()

        // A committed record that names the id while the ledger lacks it cannot come from this store's own writes.
        var contradictory = try JSONDecoder.iso.decode(JSONValue.self, from: Data(contentsOf: store.stateURL)).objectValue!
        var workspace = contradictory["workspace"]?.objectValue ?? [:]
        workspace["requestId"] = .string(inFlight.uuidString)
        contradictory["workspace"] = .object(workspace)
        contradictory["receipts"] = .array((contradictory["receipts"]?.arrayValue ?? []) + [receipt])
        try JSONEncoder().encode(JSONValue.object(contradictory)).write(to: store.stateURL)
        let suspect = try fixture.makeStore()
        defer { suspect.close() }
        #expect(suspect.unresolvedDispatch == inFlight)
        #expect(throws: ProofStoreError.corrupt) { try suspect.withdrawUnresolvedDispatch(inFlight) }
        #expect(try suspect.dispatchReceipt(for: inFlight) != nil, "contradictory evidence is left for a person")
    }

    @Test("Each bounded list keeps only the newest results up to its capacity; the identity record of an evicted result stays and still answers")
    func capacityEvictsOldest() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try ProofStore(directory: fixture.storeDirectory, keys: fixture.keys, ledgerCapacity: 3)
        defer { store.close() }
        #expect(ProofStore.defaultLedgerCapacity == 512)
        let ids = (0..<4).map { _ in UUID() }
        for (index, id) in ids.enumerated() {
            #expect(try store.commit(attempt(id, hash: "h\(index)", expected: index, revision: index + 1)) == .committed(revision: index + 1))
        }
        #expect(try store.ledgerEntry(for: ids[0]) == nil, "the oldest full result is gone once capacity is exceeded")
        #expect(try store.dispatchReceipt(for: ids[0]) == nil)
        #expect(try store.ledgerEntry(for: ids[1])?.revision == 2)
        #expect(try store.ledgerEntry(for: ids[3])?.revision == 4)
        #expect(store.unresolvedDispatch == nil)
        let evicted = try #require(try store.terminalResult(for: ids[0]))
        #expect(evicted.outcome == .ok && evicted.revision == 1 && evicted.payloadHash == "h0", "the identity record outlives the full result")
        #expect(try store.terminalResult(for: ids[3])?.deliveryId == nil)
        #expect(try store.commit(attempt(ids[0], hash: "h0", expected: 0, revision: 1)) == .replayed(evicted), "an exact retry replays, never commits again")
        #expect(try store.commit(attempt(ids[0], hash: "changed", expected: 4, revision: 5)) == .payloadMismatch, "a changed payload under an evicted id is still refused")
        #expect(try store.read().revision == 4)
        #expect(try store.terminalResult(for: UUID()) == nil)
    }

    @Test("A state file whose revision is negative, past the safe-integer bound, or disagrees with its record opens as corrupt and is left untouched",
          arguments: ["-1", "9007199254740992", "9223372036854775807", "7"])
    func outOfRangeRevisionIsCorrupt(revision: String) throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let workspaceId = store.workspaceId
        let handle = store.workspaceHandle
        store.close()
        let edited = Data("""
        {"formatVersion":3,"ledger":[],"receipts":[],"identities":[],"deliveries":[],"workspace":{"revision":\(revision),"record":{"revision":6},"workspaceId":"\(workspaceId.uuidString)","workspaceHandle":"\(handle)"}}
        """.utf8)
        try edited.write(to: store.stateURL)
        let corrupt = try fixture.makeStore()
        #expect(corrupt.status == .corrupt)
        #expect(try Data(contentsOf: store.stateURL) == edited)
        corrupt.close()
        // The same file with a consistent in-range revision opens, so the refusal is the bound, not the hand-written shape.
        let sane = Data("""
        {"formatVersion":3,"ledger":[],"receipts":[],"identities":[],"deliveries":[],"workspace":{"revision":9007199254740991,"record":{"revision":9007199254740991},"workspaceId":"\(workspaceId.uuidString)","workspaceHandle":"\(handle)"}}
        """.utf8)
        try sane.write(to: store.stateURL)
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        #expect(try reopened.read().revision == ProofLimits.maxSafeInteger)
    }
}

private extension JSONDecoder {
    static let iso: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
