import Foundation
import Testing
@testable import DeskHost

/// Regressions from the October 9 Codex review, N6 to N8: final dictation
/// goes to the draft captured at recording start or nowhere; late callbacks
/// after lock or close are dropped; no event sink means nothing is consumed.
@Suite("Recording tokens")
struct RecordingTokenTests {
    static let sessionA = "52abcdef-0000-4000-8abc-00000000000a"
    static let sessionB = "52abcdef-0000-4000-8abc-00000000000b"
    static let sessionC = "52abcdef-0000-4000-8abc-00000000000c"

    @Test("N6: bind A, start recording, bind B, deliver A's final: pushed with A's identity, B untouched; a captured draft that was unbound, consumed, or lost its connection or document holds the text, never retargeted")
    func finalGoesToTheCapturedDraftOnly() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let a = try await harness.bind(expectedRevision: 0, sessionId: Self.sessionA)
        let token = await harness.host.beginRecording()
        #expect(token.generation == 0)
        #expect(token.target == CapturedTarget(bindingId: a, connectionId: harness.connection.id, generation: 0, sessionId: Self.sessionA, expectedRevision: 0))
        let b = try await harness.bind(expectedRevision: 0, sessionId: Self.sessionB)
        #expect(harness.drafts.currentBinding(generation: 0)?.bindingId == b, "B is the newest binding when A's final arrives")

        let delivery = await harness.host.deliverFinal(token, text: "A's words")
        guard case .delivered(let deliveryId, let bindingId, let connectionId, let generation) = delivery else {
            Issue.record("expected delivery, got \(delivery)")
            return
        }
        #expect(bindingId == a, "the recording's own draft, not the newest one")
        #expect(connectionId == harness.connection.id)
        #expect(generation == 0)
        #expect(harness.sink.finals == [.dictationFinal(connectionId: harness.connection.id, generation: 0, bindingId: a, deliveryId: deliveryId, text: "A's words")])
        #expect(harness.drafts.binding(a)?.deliveryId == deliveryId)
        #expect(harness.drafts.binding(b)?.deliveryId == nil, "B is untouched")
        #expect(try harness.store.delivery(for: deliveryId)?.sessionId == Self.sessionA)
        #expect(try harness.store.delivery(for: deliveryId)?.bindingId == a)
        let saved = await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("a-saved", revision: 1), deliveryId: deliveryId))
        #expect(saved.outcome == .ok, "the commit names A's delivery and A's binding matches it")

        // The captured draft is unbound before the final arrives: held, never C.
        let tokenB = await harness.host.beginRecording()
        #expect(tokenB.target?.bindingId == b)
        #expect(await harness.host.handle(harness.unbindRequest(bindingId: b)).outcome == .ok)
        let c = try await harness.bind(expectedRevision: 1, sessionId: Self.sessionC)
        let lateB = await harness.host.deliverFinal(tokenB, text: "B's words")
        guard case .held(let heldB) = lateB else { Issue.record("expected held, got \(lateB)"); return }
        #expect(heldB.reason == .targetChanged)
        #expect(heldB.text == "B's words")
        #expect(heldB.generation == 0)
        #expect(harness.drafts.binding(c)?.deliveryId == nil, "C never receives B's recording")
        #expect(harness.sink.finalTexts == ["A's words"])

        // Two recordings captured the same draft: the second finds it consumed and holds.
        let tokenC1 = await harness.host.beginRecording()
        let tokenC2 = await harness.host.beginRecording()
        #expect(tokenC1.target?.bindingId == c && tokenC2.target?.bindingId == c)
        guard case .delivered(_, let deliveredC, _, _) = await harness.host.deliverFinal(tokenC1, text: "C first") else { Issue.record("expected delivery"); return }
        #expect(deliveredC == c)
        let consumed = await harness.host.deliverFinal(tokenC2, text: "C second")
        guard case .held(let heldC) = consumed else { Issue.record("expected held, got \(consumed)"); return }
        #expect(heldC.reason == .targetChanged)
        #expect(harness.sink.finalTexts == ["A's words", "C first"])

        // No draft bound at recording start: held even though one is bound before the final.
        let unbound = await harness.host.beginRecording()
        #expect(unbound.target == nil, "every binding is consumed or gone")
        let d = try await harness.bind(expectedRevision: 1, sessionId: Self.sessionA)
        let noTarget = await harness.host.deliverFinal(unbound, text: "words without a target")
        guard case .held(let heldNone) = noTarget else { Issue.record("expected held, got \(noTarget)"); return }
        #expect(heldNone.reason == .noBinding)
        #expect(harness.drafts.binding(d)?.deliveryId == nil, "D is not retargeted")

        // The document changed under the recording: held with the recording's generation, never the new document's draft.
        let tokenD = await harness.host.beginRecording()
        #expect(tokenD.target?.bindingId == d)
        await harness.host.beginGeneration()
        let next = await harness.host.issueConnection()
        let f = try await harness.bind(expectedRevision: 1, sessionId: Self.sessionC, connection: next)
        let navigated = await harness.host.deliverFinal(tokenD, text: "D's words")
        guard case .held(let heldD) = navigated else { Issue.record("expected held, got \(navigated)"); return }
        #expect(heldD.reason == .targetChanged)
        #expect(heldD.generation == 0, "held text records the recording's document")
        #expect(harness.drafts.binding(f)?.deliveryId == nil)

        // The captured draft's connection is gone: held.
        let other = await harness.host.issueConnection()
        let e = try await harness.bind(expectedRevision: 1, sessionId: Self.sessionB, connection: other)
        let tokenE = await harness.host.beginRecording()
        #expect(tokenE.target?.bindingId == e)
        harness.connections.invalidate(other.id)
        let lostConnection = await harness.host.deliverFinal(tokenE, text: "E's words")
        guard case .held(let heldE) = lostConnection else { Issue.record("expected held, got \(lostConnection)"); return }
        #expect(heldE.reason == .targetChanged)
        #expect(heldE.generation == 1)
        #expect(harness.drafts.binding(e)?.deliveryId == nil)
        #expect(harness.drafts.binding(f)?.deliveryId == nil, "F, the other live draft, is never a fallback target")
        #expect(harness.sink.finalTexts == ["A's words", "C first"], "nothing else was pushed anywhere")
        #expect(harness.drafts.heldDeliveries.map(\.text) == ["B's words", "C second", "words without a target", "C first", "D's words", "E's words"],
                "C's pushed but unsaved text was set aside when its document went away")
        let state = String(decoding: try harness.store.plainStateForTesting(), as: UTF8.self)
        #expect(!state.contains("words"), "no dictated text reaches the store")
    }

    @Test("N7: a late final after lock is held in memory, never pushed; a recording started while locked is held too; after unlock and a new document the old recording is held, never the new generation's delivered text")
    func lateFinalAfterLockIsHeld() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        _ = try await harness.bind(expectedRevision: 0, sessionId: Self.sessionA)
        let token = await harness.host.beginRecording()
        #expect(token.target != nil)
        await harness.host.lock()
        let late = await harness.host.deliverFinal(token, text: "late after lock")
        guard case .held(let heldLate) = late else { Issue.record("expected held, got \(late)"); return }
        #expect(heldLate.reason == .locked)
        #expect(harness.drafts.pendingDeliveries.isEmpty)
        #expect(harness.sink.finals.isEmpty, "nothing is pushed while locked")
        let whileLocked = await harness.host.beginRecording()
        #expect(whileLocked.target == nil)
        let lockedOutcome = await harness.host.deliverFinal(whileLocked, text: "while locked")
        #expect(lockedOutcome.isHeld)

        await harness.host.unlock()
        let generation = await harness.host.beginGeneration()
        let fresh = await harness.host.issueConnection()
        let newBinding = try await harness.bind(expectedRevision: 0, sessionId: Self.sessionB, connection: fresh)
        let newToken = await harness.host.beginRecording()
        #expect(newToken.target?.bindingId == newBinding)
        let old = await harness.host.deliverFinal(token, text: "old words")
        #expect(old.isHeld, "an old recording is held, never delivered to the new document")
        #expect(harness.drafts.binding(newBinding)?.deliveryId == nil, "and never becomes its delivered text")
        let delivered = await harness.host.deliverFinal(newToken, text: "new words")
        guard case .delivered(_, let bindingId, let connectionId, let deliveredGeneration) = delivered else { Issue.record("expected delivery, got \(delivered)"); return }
        #expect(bindingId == newBinding)
        #expect(connectionId == fresh.id)
        #expect(deliveredGeneration == generation)
        #expect(harness.sink.finalTexts == ["new words"], "only the new recording's text was ever pushed")
        #expect(harness.drafts.heldDeliveries.map(\.text) == ["late after lock", "while locked", "old words"])
        let state = String(decoding: try harness.store.plainStateForTesting(), as: UTF8.self)
        #expect(!state.contains("words"), "held text is never written to the store")
    }

    @Test("N7: after close a late final is dropped and nothing is retained, in memory or on disk")
    func lateFinalAfterCloseIsDropped() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        _ = try await harness.bind(expectedRevision: 0, sessionId: Self.sessionA)
        let token = await harness.host.beginRecording()
        let stateBefore = try harness.store.plainStateForTesting()
        await harness.host.close()
        #expect(await harness.host.deliverFinal(token, text: "late after close") == .dropped(.revoked))
        #expect(await harness.host.deliverFinal(await harness.host.beginRecording(), text: "after close") == .dropped(.revoked))
        #expect(harness.drafts.heldDeliveries.isEmpty)
        #expect(harness.drafts.pendingDeliveries.isEmpty)
        #expect(harness.drafts.activeBindingCount == 0)
        #expect(harness.sink.finals.isEmpty)
        #expect(try harness.store.plainStateForTesting() == stateBefore, "close wrote nothing")
    }

    @Test("N8: without an event sink a final is held, the binding is not consumed, no delivery record is written, and the held text is handed to the app once")
    func nilSinkHoldsWithoutConsuming() async throws {
        let harness = try HostHarness(withSink: false)
        defer { harness.clean() }
        #expect(harness.sink.all.isEmpty, "the harness sink is not wired")
        let bindingId = try await harness.bind(expectedRevision: 0, sessionId: Self.sessionA)
        let token = await harness.host.beginRecording()
        #expect(token.target?.bindingId == bindingId)
        let outcome = await harness.host.deliverFinal(token, text: "words without a sink")
        guard case .held(let held) = outcome else { Issue.record("expected held, got \(outcome)"); return }
        #expect(held.reason == .noEventSink)
        #expect(held.text == "words without a sink")
        #expect(harness.drafts.binding(bindingId)?.deliveryId == nil, "the binding is not consumed")
        #expect(harness.drafts.currentBinding(generation: 0)?.bindingId == bindingId, "the draft is still current")
        #expect(harness.drafts.pendingDeliveries.isEmpty)
        #expect(try harness.store.delivery(for: held.deliveryId) == nil, "no delivery record claims a push that never happened")
        #expect(await harness.host.handle(harness.commitRequest(expectedRevision: 0, record: inventedRecord("x", revision: 1), deliveryId: held.deliveryId)).reason == .unknownDelivery)
        #expect(harness.drafts.takeHeldDelivery(held.deliveryId) == held, "the only copy is handed over once")
        #expect(harness.drafts.takeHeldDelivery(held.deliveryId) == nil)
        #expect(!String(decoding: try harness.store.plainStateForTesting(), as: UTF8.self).contains("without a sink"))
        // A read-only host still answers requests; it just cannot push.
        #expect(await harness.host.handle(harness.readRequest()).outcome == .ok)
        #expect(harness.sink.all.isEmpty)
    }
}
