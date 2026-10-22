import Foundation
import Testing
@testable import DeskHost

@Suite("Desk host protocol")
struct DeskHostProtocolTests {
    @Test("Capabilities carry exactly the agreed keys, the seven operations, the limits and the handle, and no key or path")
    func capabilities() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let request = harness.request(.capabilities)
        let response = await harness.host.handle(request)
        #expect(response.outcome == .ok)
        #expect(response.echo == request.echo)
        #expect(Set(response.fields.keys) == ["capabilities"])
        let capabilities = try #require(response.capabilities)
        #expect(Set(capabilities.keys) == ["contractVersion", "hostBuild", "appVersion", "store", "lock", "operations", "workspaceHandle", "limits"])
        #expect(capabilities["contractVersion"] == .number(1))
        #expect(capabilities["hostBuild"] == .string("test-build"))
        #expect(capabilities["appVersion"] == .string("0.0-test"))
        #expect(capabilities["store"] == .string("ready"))
        #expect(capabilities["lock"] == .string("unlocked"))
        #expect(capabilities["workspaceHandle"] == .string(harness.handle))
        #expect(capabilities["operations"] == .array([
            "host.capabilities", "workspace.read", "workspace.commitProof", "dictation.bindDraft", "dictation.unbindDraft",
            "workspace.reconcile", "dictation.receipt"
        ].map { .string($0) }))
        #expect(capabilities["limits"] == .object([
            "recordBytes": .number(1_048_576), "envelopeBytes": .number(1_114_112), "textItemBytes": .number(65_536), "outstandingMutations": .number(1)
        ]))
        let text = String(decoding: response.canonicalData(), as: UTF8.self)
        #expect(!text.contains("material"))
        #expect(!text.contains(harness.fixture.directory.path))
        #expect(!text.contains("deliverFinal"))
        #expect(await harness.host.handle(harness.request(.capabilities, payload: ["path": .string("/")])).reason == .unknownField)
    }

    @Test("Stale generations and unknown connections cannot read or mutate; lifecycle events name each connection")
    func staleAndUnknownConnections() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let stale = await harness.host.handle(harness.readRequest(connection: HostConnection(id: harness.connection.id, generation: 1)))
        #expect(stale.outcome == .refused)
        #expect(stale.reason == .staleGeneration)
        #expect(stale.generation == 1)
        #expect(stale.operation == "workspace.read")
        let unknown = await harness.host.handle(harness.readRequest(connection: HostConnection(id: "guessed-or-copied", generation: 0)))
        #expect(unknown.reason == .unknownConnection)
        let commit = await harness.commit("x", expectedRevision: 0, connection: HostConnection(id: "guessed-or-copied", generation: 0))
        #expect(commit.reason == .unknownConnection)
        #expect(try harness.store.read().revision == 0)

        #expect(await harness.host.handle(harness.readRequest()).outcome == .ok)
        let generation = await harness.host.beginGeneration()
        #expect(generation == 1)
        #expect(harness.sink.connectionEvents == [.hostConnection(connectionId: harness.connection.id, generation: 0, state: .revoked, reason: .navigation)])
        let superseded = await harness.host.handle(harness.readRequest())
        #expect(superseded.reason == .staleGeneration)
        let reused = await harness.host.handle(harness.readRequest(connection: HostConnection(id: harness.connection.id, generation: 1)))
        #expect(reused.reason == .unknownConnection)
        let fresh = await harness.host.issueConnection()
        #expect(fresh.generation == 1)
        #expect(harness.sink.connectionEvents.last == .hostConnection(connectionId: fresh.id, generation: 1, state: .ready, reason: .ready))
        #expect(await harness.host.handle(harness.readRequest(connection: fresh)).outcome == .ok)
        let detail = HostEvent.hostConnection(connectionId: fresh.id, generation: 1, state: .ready, reason: .ready).jsonDetail.objectValue
        #expect(detail?["type"] == .string("host.connection"))
        #expect(detail?["reason"] == .string("ready"))
    }

    @Test("S10's split close: revokeForShutdown pushes revoked (shutdown) to every live connection, invalidates them, revokes recording tokens and refuses new recordings, and leaves the store open for the participant lane's writes; closeStore then locks and closes the store, pushing nothing; close() is exactly those two, unchanged for its callers")
    func splitClose() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let second = harness.connections.issue()
        let earlier = await harness.host.beginRecording()
        await harness.host.revokeForShutdown()
        #expect(harness.drafts.heldDeliveries.isEmpty, "close drops held text")
        let revoked = harness.sink.connectionEvents
        #expect(revoked == [harness.connection, second].sorted { $0.id < $1.id }.map {
            .hostConnection(connectionId: $0.id, generation: 0, state: .revoked, reason: .shutdown)
        }, "\(revoked)")
        #expect(await harness.host.handle(harness.readRequest()).reason == .unknownConnection)
        #expect(await harness.host.handle(harness.readRequest(connection: second)).reason == .unknownConnection)
        #expect(await harness.host.deliverFinal(earlier, text: "invented earlier text") == .dropped(.revoked))
        let later = await harness.host.beginRecording()
        #expect(await harness.host.deliverFinal(later, text: "invented later text") == .dropped(.revoked), "no recording is taken")
        #expect(!harness.store.isLocked && !harness.store.publishedRuns.closed, "the store stays open for the lane's terminal writes")
        #expect(try harness.store.read().revision == 0)

        await harness.host.closeStore()
        #expect(throws: ProofStoreError.closed) { try harness.store.read() }
        #expect(harness.store.publishedRuns.closed && harness.store.isLocked)
        #expect(harness.sink.connectionEvents == revoked, "closing the store pushes nothing")
        #expect(harness.sink.finalTexts.isEmpty)
        await harness.host.revokeForShutdown()
        #expect(harness.sink.connectionEvents == revoked, "a repeat has nothing left to revoke")

        // close() is the two halves, as every existing caller had it.
        let whole = try HostHarness()
        defer { whole.clean() }
        await whole.host.close()
        #expect(whole.sink.connectionEvents == [.hostConnection(connectionId: whole.connection.id, generation: 0, state: .revoked, reason: .shutdown)])
        #expect(await whole.host.handle(whole.readRequest()).reason == .unknownConnection)
        #expect(throws: ProofStoreError.closed) { try whole.store.read() }
        #expect(whole.store.publishedRuns.closed)
    }

    @Test("The vectors' issue-connection test hook: issueConnection(adopting:) registers the fixed id in the current generation and pushes ready for it, as issueConnection() does for a random one")
    func issueConnectionAdopting() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        await harness.host.beginGeneration()
        let fixed = "51000000-0000-4000-8000-0000000000e1"
        let adopted = await harness.host.issueConnection(adopting: fixed)
        #expect(adopted == HostConnection(id: fixed, generation: 1))
        #expect(harness.sink.connectionEvents.last == .hostConnection(connectionId: fixed, generation: 1, state: .ready, reason: .ready))
        #expect(await harness.host.handle(harness.readRequest(connection: adopted)).outcome == .ok)
        #expect(harness.connections.validConnections() == (1, [fixed]))
    }

    @Test("Unknown operations and fields are refused through the byte path and the typed path; payload defects get their fixed reasons")
    func unknownOpsAndFields() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let base: [String: String] = ["connectionId": "\"\(harness.connection.id)\""]
        let unknownOp = await harness.host.handle(data: envelopeJSON(base.merging(["operation": "\"provider.run\""]) { $1 }))
        #expect(unknownOp.outcome == .refused)
        #expect(unknownOp.reason == .unknownOperation)
        #expect(unknownOp.operation == "provider.run")
        #expect(unknownOp.connectionId == harness.connection.id)
        let withdrawn = await harness.host.handle(data: envelopeJSON(base.merging(["operation": "\"dictation.deliverFinal\""]) { $1 }))
        #expect(withdrawn.reason == .unknownOperation)
        let oldName = await harness.host.handle(data: envelopeJSON(base, dropping: ["operation"], extra: ["op": "\"host.capabilities\""]))
        #expect(oldName.reason == .unknownOperation)
        let extraField = await harness.host.handle(data: envelopeJSON(base, extra: ["path": "\"/tmp\""]))
        #expect(extraField.reason == .unknownField)
        let garbage = await harness.host.handle(data: Data("{".utf8))
        #expect(garbage.reason == .malformedEnvelope)
        #expect(garbage.requestId == "")
        let upper = UUID().uuidString
        let uppercaseId = await harness.host.handle(data: envelopeJSON(base.merging(["requestId": "\"\(upper)\""]) { $1 }))
        #expect(uppercaseId.reason == .invalidIdentity)
        #expect(uppercaseId.requestId == upper, "the reply correlates by the exact string the Desk sent")
        let collapsing = envelopeJSON(base.merging([
            "operation": "\"workspace.commitProof\"",
            "payload": "{\"workspaceHandle\":\"\(harness.handle)\",\"expectedRevision\":0,\"record\":{\"revision\":1,\"\u{00E9}\":1,\"e\u{0301}\":2}}"
        ]) { $1 })
        let refusedKeys = await harness.host.handle(data: collapsing)
        #expect(refusedKeys.reason == .malformedEnvelope)
        #expect(try harness.store.read().revision == 0)

        let readExtra = await harness.host.handle(harness.request(.workspaceRead, payload: ["workspaceHandle": .string(harness.handle), "path": .string("/tmp")]))
        #expect(readExtra.reason == .unknownField)
        #expect(await harness.host.handle(harness.request(.workspaceRead, payload: ["workspaceHandle": .string("ws-other")])).reason == .unknownHandle)
        #expect(await harness.host.handle(harness.request(.workspaceRead, payload: ["workspaceHandle": .string(harness.fixture.storeDirectory.path)])).reason == .unknownHandle)
        #expect(await harness.host.handle(harness.request(.workspaceRead, payload: ["workspaceHandle": .number(1)])).reason == .invalidIdentity)
        #expect(await harness.host.handle(harness.request(.workspaceRead, payload: [:])).reason == .invalidIdentity)

        let handle = JSONValue.string(harness.handle)
        let missingRevision = await harness.host.handle(harness.request(.workspaceCommitProof, payload: ["workspaceHandle": handle, "record": .object(["revision": .number(1)])]))
        #expect(missingRevision.reason == .invalidRevision)
        let recordArray = await harness.host.handle(harness.request(.workspaceCommitProof, payload: ["workspaceHandle": handle, "expectedRevision": .number(0), "record": .array([])]))
        #expect(recordArray.reason == .malformedEnvelope)
        let recordNoRevision = await harness.host.handle(harness.request(.workspaceCommitProof, payload: ["workspaceHandle": handle, "expectedRevision": .number(0), "record": .object([:])]))
        #expect(recordNoRevision.reason == .invalidRevision)
        let notAdvanced = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: inventedRecord("same", revision: 1)))
        #expect(notAdvanced.reason == .revisionNotAdvanced)
        let badDelivery = await harness.host.handle(harness.request(.workspaceCommitProof, payload: [
            "workspaceHandle": handle, "expectedRevision": .number(0), "record": .object(inventedRecord("d", revision: 1)), "dictationDeliveryId": .string("not-an-id")
        ]))
        #expect(badDelivery.reason == .invalidIdentity)
        let commitExtra = await harness.host.handle(harness.request(.workspaceCommitProof, payload: [
            "workspaceHandle": handle, "expectedRevision": .number(0), "record": .object(inventedRecord("f", revision: 1)), "force": .bool(true)
        ]))
        #expect(commitExtra.reason == .unknownField)
        #expect(try harness.store.read().revision == 0)

        let bindBadSession = await harness.host.handle(harness.bindRequest(sessionId: "session-1"))
        #expect(bindBadSession.reason == .invalidIdentity)
        let bindHalfEmoji = await harness.host.handle(harness.bindRequest(selection: (8, 9)))
        #expect(bindHalfEmoji.reason == .malformedEnvelope)
        let bindPastEnd = await harness.host.handle(harness.bindRequest(selection: (0, 16)))
        #expect(bindPastEnd.reason == .malformedEnvelope)
        let bindMaxRevision = await harness.host.handle(harness.bindRequest(expectedRevision: ProofLimits.maxSafeInteger))
        #expect(bindMaxRevision.reason == .invalidRevision)
        let bindExtraSelection = await harness.host.handle(harness.request(.dictationBindDraft, payload: [
            "workspaceHandle": handle, "sessionId": .string(UUID().canonicalString), "expectedRevision": .number(0), "expectedText": .string("x"),
            "selection": .object(["start": .number(0), "end": .number(1), "line": .number(1)])
        ]))
        #expect(bindExtraSelection.reason == .malformedEnvelope)
        #expect(await harness.host.handle(harness.request(.dictationUnbindDraft, payload: ["bindingId": .string(UUID().uuidString)])).reason == .invalidIdentity)
        #expect(await harness.host.handle(harness.request(.dictationReceipt, payload: ["deliveryId": .string("x")])).reason == .invalidIdentity)
        #expect(await harness.host.handle(harness.request(.workspaceReconcile, payload: ["workspaceHandle": handle, "targetRequestId": .number(1)])).reason == .invalidIdentity)
        #expect(harness.drafts.activeBindingCount == 0)

        let typed = harness.commitRequest(expectedRevision: 0, record: inventedRecord("bytes", revision: 1))
        let viaBytes = await harness.host.handle(data: try JSONEncoder().encode(typed))
        #expect(viaBytes.outcome == .ok)
        #expect(viaBytes.revision == 1)
        #expect(viaBytes.requestId == typed.requestIdString)
        #expect(Set(viaBytes.fields.keys) == ["revision"])
    }

    @Test("Oversize records, envelopes and text items are refused and the committed record stays intact")
    func oversizeRefusals() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let original = inventedRecord("original", revision: 1)
        #expect(await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: original)).revision == 1)

        let chunk = String(repeating: "x", count: 60_000)
        let huge: [String: JSONValue] = ["revision": .number(2), "items": .array(Array(repeating: .string(chunk), count: 18))]
        let oversizeRecord = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: huge))
        #expect(oversizeRecord.outcome == .refused)
        #expect(oversizeRecord.reason == .payloadTooLarge)

        let bigText = String(repeating: "y", count: ProofLimits.textItemBytes + 1)
        let oversizeText = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: ["revision": .number(2), "note": .string(bigText)]))
        #expect(oversizeText.reason == .textTooLarge)
        let nestedKey = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: ["revision": .number(2), "ok": .object([bigText: .number(1)])]))
        #expect(nestedKey.reason == .textTooLarge)
        let edge = String(repeating: "z", count: ProofLimits.textItemBytes)
        #expect(await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: ["revision": .number(2), "note": .string(edge)])).outcome == .ok)
        #expect(await harness.host.handle(harness.bindRequest(expectedText: bigText, selection: (0, 0))).reason == .textTooLarge)

        let workspace = try harness.store.read()
        #expect(workspace.revision == 2)
        #expect(workspace.record == ["revision": .number(2), "note": .string(edge)])
        let rawOversize = Data(repeating: UInt8(ascii: "{"), count: ProofLimits.envelopeBytes + 1)
        #expect(await harness.host.handle(data: rawOversize).reason == .payloadTooLarge)

        #expect(await harness.deliver(bigText) == .held(try #require(harness.drafts.heldDeliveries.first)))
        #expect(harness.drafts.heldDeliveries.first?.reason == .textTooLarge)
        #expect(harness.sink.finals.isEmpty)
    }

    @Test("Competing commits produce one durable success and one recoverable conflict; revision gaps are allowed")
    func competingCommits() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let other = await harness.host.issueConnection()
        #expect(await harness.read()?.revision == 0)

        let winner = inventedRecord("winner", revision: 3)
        let loser = inventedRecord("loser", revision: 1)
        let loserId = UUID()
        let won = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: winner))
        #expect(won.outcome == .ok)
        #expect(won.revision == 3, "the committed revision is the record's, not current + 1")
        let lost = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: loser, requestId: loserId, connection: other))
        #expect(lost.outcome == .conflict)
        #expect(lost.revision == 3)
        #expect(lost.reason == .revisionMismatch)
        #expect(Set(lost.fields.keys) == ["revision", "reason"])

        let committed = try harness.store.read()
        #expect(committed.revision == 3)
        #expect(committed.record == winner)
        let retained = harness.store.attemptedDirectory.appendingPathComponent("\(loserId.canonicalString).json")
        #expect(FileManager.default.fileExists(atPath: retained.path))
        let attempt = try JSONDecoder().decode(JSONValue.self, from: harness.store.plainAttemptedForTesting(loserId))
        #expect(attempt.objectValue?["record"] == .object(loser))

        let rebased = await harness.host.handle(harness.commitRequest(expectedRevision: 3, record: inventedRecord("loser", revision: 4), connection: other))
        #expect(rebased.outcome == .ok)
        #expect(rebased.revision == 4)
        #expect(try harness.store.read().record["label"] == .string("loser"))
        let readBack = await harness.host.handle(harness.readRequest())
        #expect(readBack.revision == 4)
        #expect(readBack.record?["revision"] == .number(4), "record.revision equals revision")
    }

    @Test("On a live connection an exact retry replays its one result; a changed payload under the same identity is refused")
    func retrySemantics() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let requestId = UUID()
        let record = inventedRecord("once", revision: 1)
        let request = harness.commitRequest(expectedRevision: 0, record: record, requestId: requestId)
        let original = await harness.host.handle(request)
        #expect(original.outcome == .ok)
        #expect(original.revision == 1)
        let retry = await harness.host.handle(request)
        #expect(retry == original)
        #expect(try harness.store.read().revision == 1)

        let changed = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: inventedRecord("changed", revision: 2), requestId: requestId))
        #expect(changed.outcome == .refused)
        #expect(changed.reason == .payloadMismatch)
        var bumped = record
        bumped["revision"] = .number(2)
        let sameRecordNewRevision = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: bumped, requestId: requestId))
        #expect(sameRecordNewRevision.reason == .payloadMismatch)
        let staleShape = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: record, requestId: requestId))
        #expect(staleShape.reason == .revisionNotAdvanced, "a malformed re-send is refused for its shape before its identity")
        #expect(try harness.store.read().revision == 1)
        #expect(try harness.store.read().record == record)

        let bindId = UUID()
        let bind = harness.bindRequest(expectedRevision: 1, requestId: bindId)
        let bound = await harness.host.handle(bind)
        #expect(bound.outcome == .ok)
        #expect(bound.revision == 1)
        let bindingId = try #require(bound.bindingId)
        #expect(Set(bound.fields.keys) == ["revision", "bindingId"])
        #expect(await harness.host.handle(bind) == bound, "the retry returns the same binding id")
        #expect(harness.drafts.activeBindingCount == 1)
        let changedBind = await harness.host.handle(harness.bindRequest(expectedRevision: 9, requestId: bindId))
        #expect(changedBind.reason == .payloadMismatch)
        let unbindId = UUID()
        let unbind = harness.unbindRequest(bindingId: bindingId, requestId: unbindId)
        let unbound = await harness.host.handle(unbind)
        #expect(unbound.outcome == .ok)
        #expect(unbound.fields.isEmpty)
        #expect(await harness.host.handle(unbind) == unbound)
        let freshUnbind = await harness.host.handle(harness.unbindRequest(bindingId: bindingId))
        #expect(freshUnbind.reason == .unknownBinding)
    }

    @Test("One mutation per workspace: a second mutation from any connection is refused while the first is outstanding; reads and queries still answer")
    func outstandingMutation() async throws {
        let executor = GatedExecutor()
        let harness = try HostHarness(executor: executor)
        defer { harness.clean() }
        let other = await harness.host.issueConnection()
        let host = harness.host
        let firstId = UUID()
        let firstRequest = harness.commitRequest(expectedRevision: 0, record: inventedRecord("first", revision: 1), requestId: firstId)
        let first = Task { await host.handle(firstRequest) }
        await executor.gate.waitForArrival()
        #expect(await harness.host.outstandingMutation == firstId)

        let second = await harness.commit("second", expectedRevision: 0)
        #expect(second.outcome == .refused)
        #expect(second.reason == .mutationOutstanding)
        let sameBytes = await harness.host.handle(firstRequest)
        #expect(sameBytes.outcome == .unknown, "the holder's own bytes are nonterminal while its outcome is undecided, never a refusal")
        #expect(sameBytes.fields.isEmpty)
        #expect(await harness.commit("other", expectedRevision: 0, connection: other).reason == .mutationOutstanding, "the barrier is per workspace")
        // Ephemeral bind and unbind are not gated by the durable barrier; only the holder's own id is.
        let boundMeanwhile = await harness.host.handle(harness.bindRequest())
        #expect(boundMeanwhile.outcome == .ok, "a bind proceeds while a commit is outstanding")
        let otherBound = await harness.host.handle(harness.bindRequest(connection: other))
        #expect(otherBound.outcome == .ok)
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: try #require(otherBound.bindingId), connection: other)).outcome == .ok)
        #expect(await harness.host.handle(harness.bindRequest(requestId: firstId)).reason == .payloadMismatch, "the in-flight id under other bytes is a changed payload, never a bind")
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: try #require(boundMeanwhile.bindingId), requestId: firstId)).reason == .payloadMismatch)
        #expect(harness.drafts.activeBindingCount == 1)
        #expect(try await harness.host.recoverUnresolvedDispatch() == .inFlight(firstId), "recovery never touches a request whose outcome is being decided")
        #expect(await harness.host.outstandingMutation == firstId)
        let read = await harness.host.handle(harness.readRequest())
        #expect(read.outcome == .ok)
        #expect(read.revision == 0)
        #expect(await harness.host.handle(harness.request(.capabilities)).outcome == .ok)
        let inFlightQuery = await harness.host.handle(harness.reconcileRequest(target: firstId))
        #expect(inFlightQuery.outcome == .unknown)
        #expect(inFlightQuery.fields.isEmpty)
        let strangerQuery = await harness.host.handle(harness.reconcileRequest(target: UUID()))
        #expect(strangerQuery.reason == .unknownRequest, "a random query cannot release another request's barrier")
        #expect(await harness.host.outstandingMutation == firstId)

        await executor.gate.open()
        let firstResponse = await first.value
        #expect(firstResponse.outcome == .ok)
        #expect(firstResponse.revision == 1)
        #expect(await harness.host.outstandingMutation == nil)
        let afterwards = await harness.commit("third", expectedRevision: 1)
        #expect(afterwards.outcome == .ok)
        #expect(afterwards.revision == 2)
        #expect(try harness.store.read().record["label"] == .string("third"))
    }

    @Test("Lock before dispatch: the lost connection gets a terminal refusal (never unknown with a free barrier), nothing was logged, and reconcile says not-dispatched")
    func lockBeforeDispatch() async throws {
        let executor = GatedExecutor()
        let harness = try HostHarness(executor: executor)
        defer { harness.clean() }
        _ = try await harness.bind(expectedRevision: 0)
        let host = harness.host
        let inFlightId = UUID()
        let inFlight = harness.commitRequest(expectedRevision: 0, record: inventedRecord("in-flight", revision: 1), requestId: inFlightId)
        let pending = Task { await host.handle(inFlight) }
        await executor.gate.waitForArrival()

        await harness.host.lock()
        #expect(harness.sink.connectionEvents.last == .hostConnection(connectionId: harness.connection.id, generation: 0, state: .locked, reason: .lock))
        #expect(harness.store.isLocked)
        #expect(harness.connections.activeConnectionCount == 0)
        #expect(harness.drafts.activeBindingCount == 0)
        #expect(throws: ProofStoreError.locked) { try harness.store.read() }
        let lateRead = await harness.host.handle(harness.readRequest())
        #expect(lateRead.reason == .unknownConnection)
        #expect(await harness.commit("late", expectedRevision: 0).reason == .unknownConnection)

        await executor.gate.open()
        let unresolved = await pending.value
        #expect(unresolved.outcome == .refused, "a failure before dispatch is terminal: unknown is reserved for a held barrier")
        #expect(unresolved.reason == .storeLocked)
        #expect(Set(unresolved.fields.keys) == ["reason"])
        #expect(await harness.host.outstandingMutation == nil, "nothing was dispatched, so nothing holds the barrier")
        #expect(try await harness.host.recoverUnresolvedDispatch() == .nothingOutstanding)

        await harness.host.unlock()
        #expect(try harness.store.read().revision == 0)
        #expect(try harness.store.dispatchReceipt(for: inFlightId) == nil)
        let fresh = await harness.host.issueConnection()
        #expect(await harness.host.handle(harness.reconcileRequest(target: inFlightId, connection: fresh)).original == ["outcome": .string("not-dispatched")])
        let resent = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("in-flight", revision: 1),
                                                                     requestId: inFlightId, connection: fresh))
        #expect(resent.outcome == .ok, "after not-dispatched the same id is a fresh mutation")
        #expect(resent.revision == 1)
    }

    @Test("Lock after a durable commit: the lost connection gets unknown and the barrier holds while nothing can ask; a fresh document releases the orphaned barrier as a restart would, and the ledger still replays, reconciles and refuses the original id")
    func lockHoldsTheBarrier() async throws {
        let executor = PostWorkGatedExecutor()
        let harness = try HostHarness(executor: executor)
        defer { harness.clean() }
        let host = harness.host
        let inFlightId = UUID()
        let record = inventedRecord("in-flight", revision: 1)
        let inFlight = harness.commitRequest(expectedRevision: 0, record: record, requestId: inFlightId)
        let pending = Task { await host.handle(inFlight) }
        await executor.gate.waitForArrival()
        #expect(try harness.store.ledgerEntry(for: inFlightId)?.revision == 1, "the commit is already durable")

        await harness.host.lock()
        await executor.gate.open()
        let unresolved = await pending.value
        #expect(unresolved.outcome == .unknown)
        #expect(unresolved.fields.isEmpty)
        #expect(await harness.host.outstandingMutation == inFlightId, "the barrier survives the lost connection")

        await harness.host.unlock()
        #expect(harness.sink.connectionEvents.filter { if case .hostConnection(_, _, .ready, _) = $0 { return true } else { return false } }.isEmpty,
                "no ready is pushed to reopen an old connection")
        #expect(try harness.store.read().revision == 1)
        #expect(await harness.host.outstandingMutation == inFlightId, "nothing has joined yet, so the barrier is still reported")
        let fresh = await harness.host.issueConnection()
        #expect(harness.sink.connectionEvents.last == .hostConnection(connectionId: fresh.id, generation: 0, state: .ready, reason: .ready))
        #expect(await harness.host.outstandingMutation == nil,
                "the revoked document dropped the request, so the durable result is owed to no one: released as a restart would")
        #expect(try await harness.host.recoverUnresolvedDispatch() == .nothingOutstanding)
        #expect(try harness.store.dispatchReceipt(for: inFlightId) != nil, "nothing on disk changed")
        let otherBytes = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("in-flight", revision: 1),
                                                                         requestId: inFlightId, connection: fresh))
        #expect(otherBytes.reason == .payloadMismatch, "the original id under other bytes is still a changed payload, from the ledger")
        #expect(await harness.host.handle(harness.bindRequest(expectedRevision: 1, connection: fresh)).outcome == .ok, "ephemeral binds are not gated")
        #expect(await harness.host.handle(harness.reconcileRequest(target: UUID(), connection: fresh)).original == ["outcome": .string("not-dispatched")])
        #expect(await harness.host.handle(harness.readRequest(connection: fresh)).revision == 1, "reads still answer")
        #expect(await harness.commit("new", expectedRevision: 1, connection: fresh).revision == 2,
                "the fresh document saves without workspace.reconcile, which the pinned page cannot send")

        let reconciled = await harness.host.handle(harness.reconcileRequest(target: inFlightId, connection: fresh))
        #expect(reconciled.outcome == .ok)
        #expect(reconciled.targetRequestId == inFlightId)
        #expect(reconciled.original == ["outcome": .string("ok"), "revision": .number(1)])
        #expect(Set(reconciled.fields.keys) == ["targetRequestId", "original"])
        #expect(await harness.host.outstandingMutation == nil)
        #expect(await harness.host.handle(harness.reconcileRequest(target: inFlightId, connection: fresh)).original?["outcome"] == .string("ok"),
                "the query is read-only and repeatable")
        let changed = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("in-flight", revision: 1),
                                                                      requestId: inFlightId, connection: fresh))
        #expect(changed.reason == .payloadMismatch, "the same id with other bytes is a changed payload")
        let replayed = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: record, requestId: inFlightId, connection: fresh))
        #expect(replayed.outcome == .ok)
        #expect(replayed.revision == 1)
        #expect(try harness.store.read().revision == 2, "a replay never commits twice")
        #expect(await harness.commit("next", expectedRevision: 2, connection: fresh).revision == 3)

        await harness.host.close()
        #expect(harness.sink.connectionEvents.last == .hostConnection(connectionId: fresh.id, generation: 0, state: .revoked, reason: .shutdown))
        #expect(await harness.host.handle(harness.readRequest(connection: fresh)).reason == .unknownConnection)
        #expect(throws: ProofStoreError.closed) { try harness.store.read() }
    }

    @Test("Reconcile answers not-dispatched for an id neither log knows; that id may then be sent once as a fresh mutation")
    func reconcileNotDispatched() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let id = UUID()
        let query = await harness.host.handle(harness.reconcileRequest(target: id))
        #expect(query.outcome == .ok)
        #expect(query.original == ["outcome": .string("not-dispatched")])
        #expect(try harness.store.read().revision == 0)
        #expect(await harness.commit("fresh", expectedRevision: 0, requestId: id).revision == 1)
        #expect(await harness.host.handle(harness.reconcileRequest(target: id)).original == ["outcome": .string("ok"), "revision": .number(1)])

        let loserId = UUID()
        #expect(await harness.commit("loser", expectedRevision: 0, requestId: loserId).outcome == .conflict)
        let conflictQuery = await harness.host.handle(harness.reconcileRequest(target: loserId))
        #expect(conflictQuery.original == ["outcome": .string("conflict"), "revision": .number(1), "reason": .string("revision-mismatch")])

        let bindId = UUID()
        let bindingId = try #require(await harness.host.handle(harness.bindRequest(expectedRevision: 1, requestId: bindId)).bindingId)
        #expect(await harness.host.handle(harness.reconcileRequest(target: bindId)).original == ["outcome": .string("ok"), "revision": .number(1)])
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId)).outcome == .ok)
        #expect(await harness.host.handle(harness.reconcileRequest(target: UUID(), connection: harness.connection))
                    .original == ["outcome": .string("not-dispatched")])
        #expect(await harness.host.handle(harness.request(.workspaceReconcile, payload: ["workspaceHandle": .string("ws-x"), "targetRequestId": .string(id.canonicalString)]))
                    .reason == .unknownHandle)
    }

    @Test("A commit write failure after the receipt is withdrawn and refused with nothing applied; if even the withdrawal fails the result is unknown and the barrier survives restart")
    func commitWriteFailures() async throws {
        let files = FlakyFileManager()
        let harness = try HostHarness(fileManager: files)
        defer { harness.clean() }
        let withdrawnId = UUID()
        files.arm(failing: [1])
        let withdrawn = await harness.commit("withdrawn", expectedRevision: 0, requestId: withdrawnId)
        files.disarm()
        #expect(withdrawn.outcome == .refused)
        #expect(withdrawn.reason == .storeCorrupt)
        #expect(await harness.host.outstandingMutation == nil)
        #expect(try harness.store.read().revision == 0)
        #expect(try harness.store.dispatchReceipt(for: withdrawnId) == nil)
        #expect(await harness.host.handle(harness.reconcileRequest(target: withdrawnId)).original == ["outcome": .string("not-dispatched")])
        #expect(await harness.commit("withdrawn", expectedRevision: 0, requestId: withdrawnId).revision == 1, "the retry is a fresh dispatch")

        let stuckId = UUID()
        files.arm(failing: [1, 2])
        let stuck = await harness.commit("stuck", expectedRevision: 1, requestId: stuckId)
        files.disarm()
        #expect(stuck.outcome == .unknown)
        #expect(await harness.host.outstandingMutation == stuckId)
        #expect(try harness.store.read().revision == 1, "nothing was applied, but nothing proves it to the page")
        #expect(try harness.store.dispatchReceipt(for: stuckId) != nil)
        #expect(try harness.store.ledgerEntry(for: stuckId) == nil)
        #expect(harness.store.unresolvedDispatch == stuckId)
        #expect(await harness.commit("blocked", expectedRevision: 1).reason == .mutationOutstanding)
        #expect(await harness.host.handle(harness.reconcileRequest(target: stuckId)).outcome == .unknown)
        #expect(await harness.host.handle(harness.readRequest()).outcome == .ok, "reads still answer")
        // Dictation keeps working against the wedged barrier: binding is ephemeral and the text goes to the page, not into the host.
        let wedgedBinding = try await harness.bind(expectedRevision: 1)
        guard case .delivered(let wedgedDelivery, _, _, _) = await harness.deliver("words while wedged") else { Issue.record("expected delivery"); return }
        #expect(harness.sink.finalTexts == ["words while wedged"])
        let wedgedCommit = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: inventedRecord("wedged", revision: 2), deliveryId: wedgedDelivery))
        #expect(wedgedCommit.reason == .mutationOutstanding, "the durable save still waits for the barrier")
        #expect(harness.drafts.binding(wedgedBinding) != nil)
        // Recovery is explicit and needs the disk back: while it is not, the barrier stays.
        files.failWrites = true
        await #expect(throws: ProofStoreError.self) { try await harness.host.recoverUnresolvedDispatch() }
        files.failWrites = false
        #expect(await harness.host.outstandingMutation == stuckId)
        #expect(try harness.store.dispatchReceipt(for: stuckId) != nil)

        // Restart: the receipt without a result restores the barrier holder.
        harness.store.close()
        let reopened = try ProofStore(directory: harness.fixture.storeDirectory, keys: harness.fixture.keys)
        defer { reopened.close() }
        let connections = ConnectionRegistry()
        let restarted = DeskHostProtocol(store: reopened, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info)
        #expect(await restarted.outstandingMutation == stuckId)
        let connection = await restarted.issueConnection()
        func commitAfter(_ label: String, requestId: UUID = UUID()) async -> HostResponse {
            await restarted.handle(HostRequest(requestId: requestId, connectionId: connection.id, generation: 0, operation: .workspaceCommitProof, payload: [
                "workspaceHandle": .string(reopened.workspaceHandle), "expectedRevision": .number(1), "record": .object(inventedRecord(label, revision: 2))
            ]))
        }
        func reconcileAfter(_ target: UUID) async -> HostResponse {
            await restarted.handle(HostRequest(requestId: UUID(), connectionId: connection.id, generation: 0, operation: .workspaceReconcile, payload: [
                "workspaceHandle": .string(reopened.workspaceHandle), "targetRequestId": .string(target.canonicalString)
            ]))
        }
        #expect(await commitAfter("after").reason == .mutationOutstanding)
        #expect(await reconcileAfter(stuckId).outcome == .unknown, "reconcile never infers; the receipt-only holder stays unknown")

        // Explicit recovery: the receipt is withdrawn, the barrier is free, and the page learns not-dispatched.
        #expect(try await restarted.recoverUnresolvedDispatch() == .withdrawn(stuckId))
        #expect(await restarted.outstandingMutation == nil)
        #expect(try reopened.dispatchReceipt(for: stuckId) == nil)
        #expect(reopened.unresolvedDispatch == nil)
        #expect(try reopened.read().revision == 1, "recovery applies nothing")
        #expect(await reconcileAfter(stuckId).original == ["outcome": .string("not-dispatched")])
        #expect(try await restarted.recoverUnresolvedDispatch() == .nothingOutstanding)
        let resent = await commitAfter("stuck", requestId: stuckId)
        #expect(resent.outcome == .ok, "after not-dispatched the stuck id is a fresh mutation")
        #expect(resent.revision == 2)
        #expect(await reconcileAfter(stuckId).original == ["outcome": .string("ok"), "revision": .number(2)])
        // The withdrawal itself survives a reopen.
        reopened.close()
        let again = try ProofStore(directory: harness.fixture.storeDirectory, keys: harness.fixture.keys)
        defer { again.close() }
        #expect(again.status == .ready)
        #expect(again.unresolvedDispatch == nil)
        #expect(try again.read().revision == 2)
    }

    @Test("A result that was durable but never acknowledged holds the barrier for the host's lifetime only; after a restart the revision check and exact replay cover it")
    func unacknowledgedResultAcrossRestart() async throws {
        let executor = PostWorkGatedExecutor()
        let harness = try HostHarness(executor: executor)
        defer { harness.clean() }
        let host = harness.host
        let inFlightId = UUID()
        let record = inventedRecord("in-flight", revision: 1)
        let inFlight = harness.commitRequest(expectedRevision: 0, record: record, requestId: inFlightId)
        let pending = Task { await host.handle(inFlight) }
        await executor.gate.waitForArrival()
        await harness.host.lock()
        await executor.gate.open()
        #expect(await pending.value.outcome == .unknown)
        #expect(await harness.host.outstandingMutation == inFlightId)

        harness.store.close()
        let reopened = try ProofStore(directory: harness.fixture.storeDirectory, keys: harness.fixture.keys)
        defer { reopened.close() }
        let connections = ConnectionRegistry()
        let restarted = DeskHostProtocol(store: reopened, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info)
        #expect(await restarted.outstandingMutation == nil, "only a receipt-only holder is rebuilt from disk")
        #expect(try await restarted.recoverUnresolvedDispatch() == .nothingOutstanding)
        let connection = await restarted.issueConnection()
        func commit(_ record: [String: JSONValue], expectedRevision: Int, requestId: UUID = UUID()) async -> HostResponse {
            await restarted.handle(HostRequest(requestId: requestId, connectionId: connection.id, generation: 0, operation: .workspaceCommitProof, payload: [
                "workspaceHandle": .string(reopened.workspaceHandle), "expectedRevision": .number(Double(expectedRevision)), "record": .object(record)
            ]))
        }
        let stale = await commit(inventedRecord("stale", revision: 1), expectedRevision: 0)
        #expect(stale.outcome == .conflict, "a page that never learned the result loses the revision race, never doubles it")
        #expect(stale.revision == 1)
        let replayed = await commit(record, expectedRevision: 0, requestId: inFlightId)
        #expect(replayed.outcome == .ok)
        #expect(replayed.revision == 1)
        #expect(try reopened.read().revision == 1, "the exact re-send replays, it does not commit again")
        #expect(try reopened.read().record == record)
        #expect(await commit(inventedRecord("next", revision: 2), expectedRevision: 1).revision == 2)
    }

    @Test("Final dictation is pushed once to the bound draft, saved only by the commit that names it, and confirmed by a receipt")
    func dictationRoundTrip() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let text = "Hello,\nworld. Submit now\r\n"
        let heldFirst = await harness.deliver(text)
        guard case .held(let held) = heldFirst else { Issue.record("expected held, got \(heldFirst)"); return }
        #expect(held.reason == .noBinding)
        #expect(held.text == text)
        #expect(harness.drafts.heldDeliveries == [held])
        #expect(harness.sink.finals.isEmpty, "nothing is pushed without a binding")
        #expect(harness.drafts.takeHeldDelivery(held.deliveryId) == held)

        let sessionId = "52abcdef-0000-4000-8abc-000000000001"
        let bindingId = try await harness.bind(expectedRevision: 0, sessionId: sessionId)
        let delivery = await harness.deliver(text)
        guard case .delivered(let deliveryId, let deliveredBinding, let connectionId, let generation) = delivery else {
            Issue.record("expected delivery, got \(delivery)")
            return
        }
        #expect(deliveredBinding == bindingId)
        #expect(connectionId == harness.connection.id)
        #expect(generation == 0)
        #expect(harness.sink.finals == [.dictationFinal(connectionId: harness.connection.id, generation: 0, bindingId: bindingId, deliveryId: deliveryId, text: text)])
        #expect(harness.sink.finals.first?.jsonDetail.objectValue?["type"] == .string("dictation.final"))
        #expect(harness.drafts.binding(bindingId)?.deliveryId == deliveryId)
        #expect(harness.drafts.pendingDeliveries.map(\.deliveryId) == [deliveryId])
        #expect(try harness.store.delivery(for: deliveryId)?.isSaved == false, "the receipt is written before the text moves")
        #expect(!String(decoding: try harness.store.plainStateForTesting(), as: UTF8.self).contains("Submit now"))
        #expect(!String(reflecting: harness.drafts.pendingDeliveries).contains("Submit now"))
        let uncorrelated = await harness.host.handle(harness.receiptRequest(deliveryId: deliveryId))
        #expect(uncorrelated.outcome == .unknown)
        #expect(await harness.host.handle(harness.receiptRequest(deliveryId: UUID())).reason == .unknownDelivery)
        #expect(await harness.deliver("second final").isHeld, "a consumed binding is no longer current")

        let unrelated = await harness.commit("unrelated", expectedRevision: 0)
        #expect(unrelated.revision == 1)
        #expect(try harness.store.delivery(for: deliveryId)?.isSaved == false, "an unrelated commit never marks a delivery saved")
        #expect(await harness.host.handle(harness.receiptRequest(deliveryId: deliveryId)).outcome == .unknown)
        #expect(harness.sink.receipts.isEmpty)
        let movedOn = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: inventedRecord("moved", revision: 2), deliveryId: deliveryId))
        #expect(movedOn.reason == .bindingStale, "the binding captured revision 0, the workspace is at 1")
        #expect(try harness.store.read().revision == 1)
        let unknownId = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: inventedRecord("x", revision: 2), deliveryId: UUID()))
        #expect(unknownId.reason == .unknownDelivery)

        // A fresh binding at the current revision, a fresh final, then the correlated commit.
        let secondBinding = try await harness.bind(expectedRevision: 1, sessionId: sessionId)
        guard case .delivered(let secondDelivery, _, _, _) = await harness.deliver("second words") else { Issue.record("expected delivery"); return }
        let other = await harness.host.issueConnection()
        let foreign = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: inventedRecord("foreign", revision: 2),
                                                                      deliveryId: secondDelivery, connection: other))
        #expect(foreign.reason == .bindingStale, "another connection cannot claim this delivery")
        let commitId = UUID()
        let saved = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: inventedRecord("dictated", revision: 2),
                                                                    deliveryId: secondDelivery, requestId: commitId))
        #expect(saved.outcome == .ok)
        #expect(saved.revision == 2)
        #expect(harness.sink.receipts == [.dictationReceipt(connectionId: harness.connection.id, generation: 0, deliveryId: secondDelivery,
                                                              commitRequestId: commitId, revision: 2)])
        let confirmed = await harness.host.handle(harness.receiptRequest(deliveryId: secondDelivery))
        #expect(confirmed.outcome == .ok)
        #expect(confirmed.fields == ["deliveryId": .string(secondDelivery.canonicalString), "commitRequestId": .string(commitId.canonicalString), "revision": .number(2)])
        #expect(harness.drafts.pendingDeliveries.map(\.deliveryId) == [deliveryId], "the saved delivery is pending no longer")
        let again = await harness.host.handle(harness.commitRequest(expectedRevision: 2, record: inventedRecord("again", revision: 3), deliveryId: secondDelivery))
        #expect(again.reason == .duplicateDelivery)
        #expect(try harness.store.read().revision == 2)
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: secondBinding)).outcome == .ok)
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId)).outcome == .ok)
        #expect(harness.sink.finalTexts == [text, "second words"], "the sink is the only holder of text")
    }

    @Test("A failed write-ahead delivery record holds the text natively: nothing is pushed and the page can commit nothing for it")
    func deliveryWriteFailure() async throws {
        let files = FlakyFileManager()
        let harness = try HostHarness(fileManager: files)
        defer { harness.clean() }
        let bindingId = try await harness.bind(expectedRevision: 0)
        files.failWrites = true
        let outcome = await harness.deliver("once")
        files.failWrites = false
        guard case .held(let held) = outcome else { Issue.record("expected held, got \(outcome)"); return }
        #expect(held.reason == .storeUnavailable)
        #expect(harness.sink.finals.isEmpty, "a refusal means the text went nowhere")
        #expect(harness.drafts.binding(bindingId)?.deliveryId == nil, "the binding is still current")
        #expect(harness.drafts.pendingDeliveries.isEmpty)
        #expect(try harness.store.delivery(for: held.deliveryId) == nil)
        #expect(await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("d", revision: 1), deliveryId: held.deliveryId)).reason == .unknownDelivery)

        guard case .delivered(let deliveryId, _, _, _) = await harness.deliver("once") else { Issue.record("expected delivery"); return }
        #expect(harness.sink.finalTexts == ["once"])
        #expect(try harness.store.delivery(for: deliveryId)?.bindingId == bindingId)
    }

    @Test("One request identity spans commits, binds and unbinds; reuse for another operation is a changed payload")
    func requestIdentitySpansOps() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let commitId = UUID()
        #expect(await harness.commit("a", expectedRevision: 0, requestId: commitId).revision == 1)
        let bindWithCommitId = await harness.host.handle(harness.bindRequest(expectedRevision: 1, requestId: commitId))
        #expect(bindWithCommitId.outcome == .refused)
        #expect(bindWithCommitId.reason == .payloadMismatch)
        #expect(harness.drafts.activeBindingCount == 0)

        let bindId = UUID()
        let bindingId = try #require(await harness.host.handle(harness.bindRequest(expectedRevision: 1, requestId: bindId)).bindingId)
        let commitWithBindId = await harness.commit("b", expectedRevision: 1, requestId: bindId)
        #expect(commitWithBindId.reason == .payloadMismatch)
        #expect(try harness.store.read().revision == 1)
        let unbindWithBindId = await harness.host.handle(harness.unbindRequest(bindingId: bindingId, requestId: bindId))
        #expect(unbindWithBindId.reason == .payloadMismatch)
        let unbindWithCommitId = await harness.host.handle(harness.unbindRequest(bindingId: bindingId, requestId: commitId))
        #expect(unbindWithCommitId.reason == .payloadMismatch)
        #expect(harness.drafts.binding(bindingId) != nil)
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId)).outcome == .ok)
    }

    @Test("A binding answers only the connection and generation that made it; navigation and lock keep unsaved words as held text in memory, close drops them")
    func bindingLifetime() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let other = await harness.host.issueConnection()
        let bindingId = try await harness.bind(expectedRevision: 0)
        let foreignUnbind = await harness.host.handle(harness.unbindRequest(bindingId: bindingId, connection: other))
        #expect(foreignUnbind.reason == .unknownBinding)
        #expect(harness.drafts.binding(bindingId) != nil)
        guard case .delivered(let deliveryId, _, _, _) = await harness.deliver("private words one") else { Issue.record("expected delivery"); return }
        let heldOutcome = await harness.deliver("private words held")
        #expect(heldOutcome.isHeld)

        await harness.host.beginGeneration()
        #expect(harness.drafts.activeBindingCount == 0, "a new document drops the old generation's bindings")
        #expect(harness.drafts.pendingDeliveries.isEmpty)
        #expect(harness.drafts.heldDeliveries.map(\.text) == ["private words held", "private words one"],
                "held text survives navigation, and text pushed but never saved is set aside with it")
        let next = await harness.host.issueConnection()
        let lateUnbind = await harness.host.handle(harness.unbindRequest(bindingId: bindingId, connection: next))
        #expect(lateUnbind.reason == .unknownBinding)
        let lateCommit = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("late", revision: 1),
                                                                         deliveryId: deliveryId, connection: next))
        #expect(lateCommit.reason == .bindingStale, "the delivery outlived its binding; nothing is applied")
        #expect(try harness.store.read().revision == 0)
        #expect(await harness.host.handle(harness.receiptRequest(deliveryId: deliveryId, connection: next)).outcome == .unknown, "pushed, never saved")

        _ = try await harness.bind(expectedRevision: 0, connection: next)
        #expect(!(await harness.deliver("private words two")).isHeld)
        await harness.host.lock()
        #expect(harness.drafts.heldDeliveries.map(\.text) == ["private words held", "private words one", "private words two"],
                "lock keeps held text and sets aside unsaved text (owner decision A)")
        #expect(harness.drafts.pendingDeliveries.isEmpty)
        #expect(harness.drafts.activeBindingCount == 0)
        #expect(harness.sink.finalTexts == ["private words one", "private words two"])
        let state = String(decoding: try harness.store.plainStateForTesting(), as: UTF8.self)
        #expect(!state.contains("private words"))
    }

    @Test("A corrupt or missing store is reported, never reset: reads refuse, reconcile is unknown, capabilities say so")
    func degradedStore() async throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let first = try fixture.makeStore()
        let handle = first.workspaceHandle
        first.close()
        try Data("{not json".utf8).writePlainState(to: first)
        let corrupt = try fixture.makeStore()
        defer { corrupt.close() }
        let connections = ConnectionRegistry()
        let host = DeskHostProtocol(store: corrupt, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info)
        let connection = await host.issueConnection()
        func request(_ operation: HostOperation, _ payload: [String: JSONValue]) -> HostRequest {
            HostRequest(requestId: UUID(), connectionId: connection.id, generation: 0, operation: operation, payload: payload)
        }
        let capabilities = await host.handle(request(.capabilities, [:]))
        #expect(capabilities.capabilities?["store"] == .string("corrupt"))
        #expect(capabilities.capabilities?["workspaceHandle"] == .string(handle))
        #expect(await host.handle(request(.workspaceRead, ["workspaceHandle": .string(handle)])).reason == .storeCorrupt)
        let commit = await host.handle(request(.workspaceCommitProof, ["workspaceHandle": .string(handle), "expectedRevision": .number(0), "record": .object(inventedRecord("x", revision: 1))]))
        #expect(commit.reason == .storeCorrupt)
        #expect(await host.handle(request(.workspaceReconcile, ["workspaceHandle": .string(handle), "targetRequestId": .string(UUID().canonicalString)])).outcome == .unknown)
        #expect(await host.handle(request(.dictationReceipt, ["deliveryId": .string(UUID().canonicalString)])).outcome == .unknown)
        #expect(await host.handle(request(.dictationBindDraft, [
            "workspaceHandle": .string(handle), "sessionId": .string(UUID().canonicalString), "expectedRevision": .number(0),
            "expectedText": .string("x"), "selection": .object(["start": .number(0), "end": .number(0)])
        ])).reason == .storeCorrupt)
        #expect(try first.plainStateForTesting() == Data("{not json".utf8), "nothing was replaced")
        await host.close()

        try fixture.files.removeItem(at: first.stateURL)
        let missing = try fixture.makeStore()
        defer { missing.close() }
        let missingHost = DeskHostProtocol(store: missing, connections: ConnectionRegistry(), drafts: DraftBindingRegistry(), info: HostHarness.info)
        let missingConnection = await missingHost.issueConnection()
        let read = await missingHost.handle(HostRequest(requestId: UUID(), connectionId: missingConnection.id, generation: 0, operation: .workspaceRead,
                                                        payload: ["workspaceHandle": .string(handle)]))
        #expect(read.reason == .storeMissing)
        #expect(await missingHost.handle(HostRequest(requestId: UUID(), connectionId: missingConnection.id, generation: 0, operation: .capabilities, payload: [:]))
                    .capabilities?["store"] == .string("missing"))
        #expect(!fixture.files.fileExists(atPath: first.stateURL.path))
    }

    static let participantOperations: [HostOperation] = [
        .participantAvailability, .participantStart, .participantStop, .participantStatus, .participantEvents
    ]

    @Test("A host without participants answers every participant name as an unknown one, before the connection check, byte for byte as before")
    func participantNamesOffByDefault() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        #expect(!harness.host.acceptsParticipant, "the one switch both transports read is off")
        for operation in Self.participantOperations {
            let typed = harness.request(operation, payload: ["workspaceHandle": .string(harness.handle)])
            let typedReply = await harness.host.handle(typed)
            #expect(typedReply == .refused(.unknownOperation, echo: typed.echo), "\(operation.rawValue)")
            let staleTyped = harness.request(operation, generation: harness.connection.generation + 1)
            #expect(await harness.host.handle(staleTyped) == .refused(.unknownOperation, echo: staleTyped.echo),
                    "a typed name is refused before the connection check too, as on the byte path")
            let guessedTyped = HostRequest(requestId: UUID(), connectionId: "guessed", generation: 7, operation: operation,
                                           payload: ["text": .string(String(repeating: "x", count: ProofLimits.textItemBytes + 1))])
            #expect(await harness.host.handle(guessedTyped) == .refused(.unknownOperation, echo: guessedTyped.echo),
                    "and before the text-item check")

            let requestId = UUID().canonicalString
            let overrides = ["requestId": "\"\(requestId)\"", "connectionId": "\"\(harness.connection.id)\"",
                             "operation": "\"\(operation.rawValue)\""]
            let echo = HostEcho(requestId: requestId, connectionId: harness.connection.id, generation: 0, operation: operation.rawValue)
            let expected = HostResponse.refused(.unknownOperation, echo: echo).canonicalData()
            #expect(await harness.host.handle(data: envelopeJSON(overrides)).canonicalData() == expected)
            #expect(await harness.host.handle(data: envelopeJSON(overrides, extra: ["path": "\"/tmp\""])).canonicalData() == expected,
                    "the name is refused before the envelope keys are checked")
            let stale = await harness.host.handle(data: envelopeJSON(overrides.merging(["connectionId": "\"guessed\"", "generation": "7"]) { $1 }))
            #expect(stale.reason == .unknownOperation, "the name is refused before the connection check")
        }
        #expect(await harness.host.handle(harness.request(.capabilities)).capabilities?["operations"]
                == .array(HostOperation.advertised.map { .string($0.rawValue) }))
        #expect(try harness.store.read().revision == 0)
    }

    @Test("A participant host lists the twelve operations in the contract's order and decodes their names; until a lane is wired they still refuse")
    func participantHostCapabilities() async throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        let pin = try #require(ParticipantPin(id: "claude-code", label: "Claude Code", model: "invented-pinned-model", executionHost: "this-mac"))
        let connections = ConnectionRegistry()
        let host = DeskHostProtocol(store: store, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info,
                                    participants: ParticipantHostConfiguration(pin: pin, inputBound: ParticipantLimits.firstTrialInputBound))
        #expect(host.acceptsParticipant)
        let connection = await host.issueConnection()
        func request(_ operation: HostOperation, _ payload: [String: JSONValue] = [:]) -> HostRequest {
            HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation, operation: operation, payload: payload)
        }

        let response = await host.handle(request(.capabilities))
        #expect(response.outcome == .ok)
        let capabilities = try #require(response.capabilities)
        #expect(Set(capabilities.keys) == ["contractVersion", "hostBuild", "appVersion", "store", "lock", "operations", "workspaceHandle", "limits"])
        #expect(capabilities["operations"] == .array([
            "host.capabilities", "workspace.read", "workspace.commitProof", "dictation.bindDraft", "dictation.unbindDraft",
            "workspace.reconcile", "dictation.receipt", "participant.availability", "participant.start", "participant.stop",
            "participant.status", "participant.events"
        ].map { .string($0) }))
        #expect(capabilities["contractVersion"] == .number(1))
        #expect(capabilities["limits"] == ProofLimits.capabilitiesValue, "capability keys and limits are unchanged")

        for operation in Self.participantOperations {
            let typed = request(operation)
            #expect(await host.handle(typed) == .refused(.unknownOperation, echo: typed.echo), "\(operation.rawValue)")
            let stale = HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation + 1,
                                    operation: operation, payload: [:])
            #expect(await host.handle(stale).reason == .staleGeneration, "a known name passes the shared v1 preflight first")
            let base = ["connectionId": "\"\(connection.id)\"", "operation": "\"\(operation.rawValue)\""]
            let decoded = await host.handle(data: envelopeJSON(base))
            #expect(decoded.reason == .unknownOperation, "decoded, then refused by the defence: no lane is wired")
            #expect(decoded.operation == operation.rawValue)
            #expect(await host.handle(data: envelopeJSON(base, extra: ["path": "\"/tmp\""])).reason == .unknownField,
                    "an accepted name reaches the envelope-key check")
        }
        #expect(await host.handle(request(.workspaceRead, ["workspaceHandle": .string(store.workspaceHandle)])).outcome == .ok,
                "v1 operations are served as before")
        await host.close()
    }

    // MARK: One request-identity space (participant contract section 3; Codex Q20, Q22)

    @Test("On a participant host, a start's id registered by hand in the shared index, starting or recorded, is payload-mismatch for commit, bind and unbind and unknown to reconcile; nothing is held, bound or claimed")
    func startIdsInTheSharedIndex() async throws {
        let configuration = ParticipantHostConfiguration(pin: IdentityInvented.pin)
        let identities = configuration.identities
        let harness = try HostHarness(participants: configuration)
        defer { harness.clean() }
        let starting = UUID(), recorded = UUID()
        #expect(identities.claimStarting(starting, payloadHash: "starting-hash") == .claimed)
        #expect(identities.claimStarting(recorded, payloadHash: "recorded-hash") == .claimed)
        identities.recordStart(recorded)
        let bindingId = try await harness.bind(expectedRevision: 0)

        for (label, id) in [("starting", starting), ("recorded", recorded)] {
            #expect(await harness.commit("under a start id", expectedRevision: 0, requestId: id).reason == .payloadMismatch, "\(label) commit")
            #expect(await harness.host.outstandingMutation == nil, "\(label): no barrier was taken")
            #expect(await harness.host.handle(harness.bindRequest(requestId: id)).reason == .payloadMismatch, "\(label) bind")
            #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId, requestId: id)).reason == .payloadMismatch,
                    "\(label) unbind")
            let reconcile = await harness.host.handle(harness.reconcileRequest(target: id))
            #expect(reconcile.outcome == .unknown, "\(label) reconcile: unknown, never not-dispatched")
            #expect(reconcile.fields.isEmpty)
        }
        #expect(try harness.store.read().revision == 0)
        #expect(harness.drafts.activeBindingCount == 1)
        #expect(harness.drafts.binding(bindingId) != nil, "the refused unbinds touched nothing")
        #expect(identities.claimStarting(starting, payloadHash: "other") == .starting(payloadHash: "starting-hash"),
                "the refusals left the start's claim as it was")
        #expect(identities.claimStarting(recorded, payloadHash: "other") == .recorded(payloadHash: "recorded-hash"))

        // Released by authority (nothing was written), the id is an ordinary fresh mutation.
        identities.releaseStarting(starting)
        #expect(await harness.commit("fresh", expectedRevision: 0, requestId: starting).revision == 1)
        #expect(identities.claimStarting(starting, payloadHash: "starting-hash") == .v1Identity, "now a commit's identity")
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId)).outcome == .ok)
    }

    @Test("Codex Q22's order on a participant host: a different workspace holder answers mutation-outstanding before a start's id is checked; bind, unbind and reconcile under a start's id stay outside the barrier")
    func startIdOrderBesideTheBarrier() async throws {
        let configuration = ParticipantHostConfiguration(pin: IdentityInvented.pin)
        let identities = configuration.identities
        let executor = GatedExecutor()
        let harness = try HostHarness(executor: executor, participants: configuration)
        defer { harness.clean() }
        let startId = UUID()
        #expect(identities.claimStarting(startId, payloadHash: "start-hash") == .claimed)
        let bindingId = try await harness.bind(expectedRevision: 0)

        let holderId = UUID()
        let host = harness.host
        let holderRequest = harness.commitRequest(expectedRevision: 0, record: inventedRecord("held", revision: 1), requestId: holderId)
        let held = Task { await host.handle(holderRequest) }
        await executor.gate.waitForArrival()
        #expect(identities.claimStarting(holderId, payloadHash: "start-hash") == .v1Identity, "the start lane sees the barrier holder")

        #expect(await harness.commit("under the start id", expectedRevision: 0, requestId: startId).reason == .mutationOutstanding,
                "another holder first")
        #expect(await harness.host.handle(harness.bindRequest(requestId: startId)).reason == .payloadMismatch, "outside the barrier")
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId, requestId: startId)).reason == .payloadMismatch)
        #expect(await harness.host.handle(harness.reconcileRequest(target: startId)).outcome == .unknown)
        #expect(await harness.host.handle(harness.bindRequest()).outcome == .ok, "an ordinary bind still proceeds under the barrier")

        await executor.gate.open()
        #expect(await held.value.revision == 1)
        #expect(await harness.host.outstandingMutation == nil)
        #expect(identities.claimStarting(holderId, payloadHash: "start-hash") == .v1Identity, "the durable result keeps it a commit's")
        #expect(await harness.commit("under the start id", expectedRevision: 1, requestId: startId).reason == .payloadMismatch,
                "with the barrier free, the start's id")
        #expect(try harness.store.read().revision == 1)
    }

    @Test("A start that claims a commit's id after the commit's start-id check, while the commit waits inside its delivery check, wins: the commit loses the barrier claim and is payload-mismatch, holding, dispatching and saving nothing, and the start's claim is unchanged (Codex Q22)")
    func commitLosesTheBarrierClaim() async throws {
        let configuration = ParticipantHostConfiguration(pin: IdentityInvented.pin)
        let identities = configuration.identities
        let harness = try HostHarness(participants: configuration)
        defer { harness.clean() }
        _ = try await harness.bind(expectedRevision: 0)
        guard case .delivered(let deliveryId, _, _, _) = await harness.deliver("invented words") else {
            Issue.record("expected a pending delivery")
            return
        }

        // The commit stops inside its delivery check, past the start-id
        // check and the store's delivery evidence, before it reads the
        // draft registry, and stays there until released.
        let held = HeldCheck()
        let host = harness.host
        await host.setDeliveryCheckWillReadDrafts { held.hold() }
        defer { held.release.signal() }

        let commitId = UUID()
        let request = harness.commitRequest(expectedRevision: 0, record: inventedRecord("lost the claim", revision: 1),
                                            deliveryId: deliveryId, requestId: commitId)
        let answered = Box<Bool>()
        let commit = Task {
            let reply = await host.handle(request)
            answered.value = true
            return reply
        }
        try #require(await waitOffPool(held.reached, seconds: 60), "the commit is held inside its delivery check")
        #expect(identities.claimStarting(commitId, payloadHash: "start-hash") == .claimed, "the start claims the id the commit already checked")
        let waitedPastTheCheck = answered.value != true
        held.release.signal()
        let reply = await commit.value

        #expect(waitedPastTheCheck, "the commit was inside its delivery check, past the start-id check, when the start claimed")
        #expect(!held.releasedByTimeout)
        #expect(reply == .refused(.payloadMismatch, echo: request.echo), "the barrier claim refuses it")
        #expect(await host.outstandingMutation == nil, "nothing is held")
        #expect(try harness.store.dispatchReceipt(for: commitId) == nil, "nothing was dispatched")
        #expect(try harness.store.terminalResult(for: commitId) == nil)
        #expect(harness.drafts.pendingDelivery(deliveryId) != nil, "the delivery is still pending, unsaved")
        #expect(identities.claimStarting(commitId, payloadHash: "other") == .starting(payloadHash: "start-hash"),
                "the start's claim is unchanged")
        #expect(await host.handle(harness.reconcileRequest(target: commitId)).outcome == .unknown, "a start's id, never not-dispatched")
    }

    @Test("On a participant host, a start the store's published copy still reserves after a non-authoritative reload dropped it from memory before the host registered is payload-mismatch for commit, bind and unbind and unknown to reconcile; only the authoritative re-read frees it (Codex Q5's overlay)")
    func publishedReservationOverlay() async throws {
        let configuration = ParticipantHostConfiguration(pin: IdentityInvented.pin)
        let identities = configuration.identities
        let harness = try HostHarness(participants: configuration) { store in
            try IdentityInvented.prepare(1, on: store, revision: 1)
            try store.recordStart(runId: IdentityInvented.runId(1), IdentityInvented.start(1))
            try IdentityInvented.dropStartOnDisk(1, store: store)
        }
        defer { harness.clean() }
        let startId = IdentityInvented.startId(1)
        #expect(harness.store.publishedRuns.reservedStartRequestIds.contains(startId.canonicalString), "the published copy keeps reserving it")
        #expect(!identities.isStartId(startId), "memory, and so the index, no longer shows it")
        let bindingId = try await harness.bind(expectedRevision: 1)

        #expect(await harness.commit("under a start id", expectedRevision: 1, requestId: startId).reason == .payloadMismatch)
        #expect(await harness.host.outstandingMutation == nil)
        #expect(await harness.host.handle(harness.bindRequest(expectedRevision: 1, requestId: startId)).reason == .payloadMismatch)
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId, requestId: startId)).reason == .payloadMismatch)
        let reconcile = await harness.host.handle(harness.reconcileRequest(target: startId))
        #expect(reconcile.outcome == .unknown, "unknown, never not-dispatched")
        #expect(try harness.store.dispatchReceipt(for: startId) == nil)
        #expect(try harness.store.read().revision == 1)
        #expect(harness.drafts.activeBindingCount == 1)

        // The authoritative re-read no longer shows the start: released, the id is an ordinary fresh mutation.
        #expect(try harness.store.rereadRuns().entry(for: IdentityInvented.runId(1))?.start == nil)
        #expect(!harness.store.publishedRuns.reservedStartRequestIds.contains(startId.canonicalString))
        #expect(await harness.commit("fresh", expectedRevision: 1, requestId: startId).revision == 2)
        #expect(identities.claimStarting(startId, payloadHash: "h") == .v1Identity, "now a commit's identity")
    }

    @Test("The workspace lane's identities reach the start lane through the shared index: binds and unbinds while replayable, durable results and the barrier; refused requests and forgotten binds claim nothing")
    func workspaceIdentitiesReachTheStartLane() async throws {
        let configuration = ParticipantHostConfiguration(pin: IdentityInvented.pin)
        let identities = configuration.identities
        let harness = try HostHarness(participants: configuration)
        defer { harness.clean() }
        func startClaim(_ id: UUID) -> RequestIdentityIndex.StartClaim {
            let claim = identities.claimStarting(id, payloadHash: "probe")
            if claim == .claimed { identities.releaseStarting(id) }
            return claim
        }

        let bindId = UUID()
        let bindingId = try #require(await harness.host.handle(harness.bindRequest(requestId: bindId)).bindingId)
        #expect(startClaim(bindId) == .v1Identity, "a bind result")
        let unbindId = UUID()
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId, requestId: unbindId)).outcome == .ok)
        #expect(startClaim(unbindId) == .v1Identity, "an unbind result")
        let refusedUnbind = UUID()
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId, requestId: refusedUnbind)).reason == .unknownBinding)
        #expect(startClaim(refusedUnbind) == .claimed, "a refusal leaves no identity")

        let committed = UUID()
        #expect(await harness.commit("committed", expectedRevision: 0, requestId: committed).revision == 1)
        #expect(startClaim(committed) == .v1Identity, "a durable result, reported by the store")
        let conflicted = UUID()
        #expect(await harness.commit("stale", expectedRevision: 0, requestId: conflicted).outcome == .conflict)
        #expect(startClaim(conflicted) == .v1Identity, "a conflict is a durable result too")
        let undelivered = UUID()
        let refusedCommit = await harness.host.handle(harness.commitRequest(expectedRevision: 1, record: inventedRecord("x", revision: 2),
                                                                            deliveryId: UUID(), requestId: undelivered))
        #expect(refusedCommit.reason == .unknownDelivery)
        #expect(startClaim(undelivered) == .claimed, "refused before dispatch: no identity, no barrier")
        #expect(await harness.host.outstandingMutation == nil)

        // A new document forgets the bind results, in the index too.
        await harness.host.beginGeneration()
        let fresh = await harness.host.issueConnection()
        #expect(startClaim(bindId) == .claimed, "a forgotten bind id is free")
        #expect(identities.claimStarting(bindId, payloadHash: "start-hash") == .claimed)
        #expect(await harness.host.handle(harness.bindRequest(expectedRevision: 1, requestId: bindId, connection: fresh)).reason == .payloadMismatch,
                "and once a start claims it, a bind under it is a changed payload")
        #expect(harness.drafts.activeBindingCount == 0)
    }

    @Test("Bind results past capacity leave the index as they leave the host's replay table")
    func evictedBindsLeaveTheIndex() async throws {
        let configuration = ParticipantHostConfiguration(pin: IdentityInvented.pin)
        let identities = configuration.identities
        let harness = try HostHarness(ledgerCapacity: 2, participants: configuration)
        defer { harness.clean() }
        let ids = [UUID(), UUID(), UUID()]
        for id in ids { #expect(await harness.host.handle(harness.bindRequest(requestId: id)).outcome == .ok) }
        #expect(identities.claimStarting(ids[0], payloadHash: "h") == .claimed, "the oldest was forgotten")
        #expect(identities.claimStarting(ids[1], payloadHash: "h") == .v1Identity)
        #expect(identities.claimStarting(ids[2], payloadHash: "h") == .v1Identity)
    }

    @Test("A host without participants refuses a recorded start's id for commit, bind and unbind and answers reconcile unknown from the store's reservations; its v1 answers are otherwise unchanged")
    func unconfiguredHostReadsStoreReservations() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        #expect(!harness.host.acceptsParticipant)
        try IdentityInvented.prepare(1, on: harness.store, revision: 1)
        try harness.store.recordStart(runId: IdentityInvented.runId(1), IdentityInvented.start(1))
        let startId = IdentityInvented.startId(1)
        let bindingId = try await harness.bind(expectedRevision: 1)

        #expect(await harness.commit("under a start id", expectedRevision: 1, requestId: startId).reason == .payloadMismatch)
        #expect(await harness.host.handle(harness.bindRequest(expectedRevision: 1, requestId: startId)).reason == .payloadMismatch)
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId, requestId: startId)).reason == .payloadMismatch)
        #expect(await harness.host.handle(harness.reconcileRequest(target: startId)).outcome == .unknown)
        #expect(harness.drafts.activeBindingCount == 1)
        #expect(try harness.store.read().revision == 1)
        #expect(await harness.commit("plain", expectedRevision: 1).revision == 2)
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: bindingId)).outcome == .ok)
    }

    @Test("validConnections reads the generation and its live ids together, never one generation's ids with another's number")
    func validConnectionsArePaired() throws {
        let connections = ConnectionRegistry()
        _ = connections.adopt(id: "g0-a")
        let first = connections.validConnections()
        #expect(first.generation == 0 && first.ids == ["g0-a"])
        connections.advanceGeneration()
        let advanced = connections.validConnections()
        #expect(advanced.generation == 1 && advanced.ids.isEmpty, "a new generation revokes every connection")

        let done = DispatchSemaphore(value: 0)
        Thread {
            for _ in 0..<2_000 {
                let generation = connections.advanceGeneration()
                _ = connections.adopt(id: "g\(generation)-a")
                _ = connections.adopt(id: "g\(generation)-b")
            }
            done.signal()
        }.start()
        var mismatches: [String] = []
        while done.wait(timeout: .now()) == .timedOut {
            let (generation, ids) = connections.validConnections()
            if let stray = ids.first(where: { !$0.hasPrefix("g\(generation)-") }) { mismatches.append("\(generation): \(stray)") }
        }
        #expect(mismatches.isEmpty, "\(mismatches.prefix(5))")
        #expect(connections.validConnections().generation == 2_001)
    }
}

extension FinalDelivery {
    var isHeld: Bool {
        if case .held = self { return true }
        return false
    }
}
