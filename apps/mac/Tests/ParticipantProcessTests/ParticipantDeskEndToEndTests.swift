import AppKit
@testable import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
@testable import ParticipantCoordinator
@testable import ParticipantProcess
import WebKit
import XCTest

/// Plan S11's end-to-end proof with invented data (Codex's S10 carried
/// requirements 2 and 5): the real built Desk page, in a real `WKWebView`,
/// talks through the app's own `DeskSession`, `DeskWebViewHost` and WebKit
/// glue to the real `ParticipantCoordinator`, whose runs are scripted on the
/// virtual clock (moved along with real time) instead of the real CLI. The
/// page's own participant client asks for availability, prepares a run
/// through `workspace.commitProof`, starts it, shows its streamed text and
/// stops it; then a reload (the run goes on and its later events reach the
/// new connection), a lock (the run is stopped, its text dropped, nothing
/// pushed), an unlock, a window close and a quit within the real
/// `DeskTermination` bound. A push already under way when the lock and the
/// window close run the lane's step on the main thread is held in the
/// session's own sink and returns without that thread.
///
/// Set `TRUECONVO_DESK_BUNDLE` to a built Desk (`native-dist`) to run it;
/// without it the proof is skipped, never faked, and set to anything else it
/// fails. Nothing runs the real CLI, spends anything, or touches a
/// credential, the Keychain or Packaging. What it does not show: native
/// stale-answer and stale-push suppression (no stale case is set up here;
/// `ParticipantLaneWiringTests` and `CoordinatorAppWiringTests` hold that),
/// and the quit inside `NSApp.terminate`'s own nested loop (the reply is
/// driven from this test, on the main actor).
///
/// The second proof is section 18's combined renderer proof (Codex's S10
/// ruling 1 and S11 ruling (c)), on the same real page and coordinator: a
/// Start held before step 14, a lock, the refused start settled, an unlock
/// into a fresh document, no launch and no start record through a bounded
/// interval, then one explicit Start that launches the prepared run once.
final class ParticipantDeskEndToEndTests: CoordinatorDeskTestCase {
    private var exchanges: [HostExchange] = []
    /// `exchanges.count` just before the last Send was clicked.
    private var sendIndex = 0

    private static let question = "Invented question one: what is two plus two?"

    // MARK: Page helpers (invented data only)

    private func page(_ session: DeskSession, _ javaScript: String) async throws -> Any? {
        try await evaluate(try XCTUnwrap(session.host).webView, javaScript)
    }

    /// What the page shows, for a failure message (the Desk holds only
    /// invented data here).
    private func shown(_ session: DeskSession) async -> String {
        let text = (try? await page(session, "document.body ? document.body.innerText : ''")) as? String ?? "(no page)"
        return String(text.prefix(1_500))
    }

    private func pageBool(_ session: DeskSession, _ javaScript: String) async -> Bool {
        (try? await page(session, javaScript)) as? Bool == true
    }

    /// Clicks the first element matching `selector` that is enabled.
    private func click(_ session: DeskSession, _ selector: String, _ what: String) async throws {
        let quoted = String(data: try JSONSerialization.data(withJSONObject: [selector]), encoding: .utf8)!
        try await eventually("\(what) to be clickable", detail: { await self.shown(session) }) {
            let result = try await page(session, """
            (function () {
              var found = Array.from(document.querySelectorAll(\(quoted)[0])).filter(function (e) { return !e.disabled; });
              if (!found.length) return 'missing';
              found[found.length - 1].click();
              return 'clicked';
            })()
            """) as? String
            return result == "clicked"
        }
    }

    /// Types `text` into the message box as a person's input would set it.
    private func type(_ session: DeskSession, _ text: String) async throws {
        try await eventually("the message box", detail: { await self.shown(session) }) {
            let result = try await call(try XCTUnwrap(session.host).webView, """
            const field = document.getElementById('message-draft');
            if (!field || field.disabled) return 'missing';
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, text);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            return field.value === text ? 'typed' : 'not-yet';
            """, ["text": text]) as? String
            return result == "typed"
        }
    }

    private func outputs(_ session: DeskSession) async -> [String] {
        ((try? await page(session, "Array.from(document.querySelectorAll('.run-output')).map(function (e) { return e.textContent; })")) as? [String]) ?? []
    }

    /// Waits for the session's page to finish its handshake on a connection
    /// newer than `previous` and render the Desk.
    private func waitForDesk(_ session: DeskSession, after previous: HostConnection?) async throws -> HostConnection {
        try await eventually("a Desk document after generation \(previous?.generation ?? 0)", timeout: 30) {
            guard let connection = session.host?.currentConnection else { return false }
            return connection.generation > (previous?.generation ?? 0)
        }
        try await eventually("the Desk shell to render", timeout: 30, detail: { await self.shown(session) }) {
            await self.pageBool(session, "document.querySelector('.application-shell') !== null && document.querySelector('main.recovery-page') === null")
        }
        return try XCTUnwrap(session.host?.currentConnection)
    }

    private func replied(_ operation: String, _ outcome: HostOutcome = .ok, on connection: HostConnection) -> Int {
        exchanges.filter { $0 == .replied(operation: operation, connectionId: connection.id, generation: connection.generation, outcome: outcome, reason: nil) }.count
    }

    private func entry(_ store: ProofStore, _ run: ScriptedParticipantRun) -> ParticipantRunEntry? {
        store.publishedRuns.runs.first { $0.runId == run.identity.runId }
    }

    /// The run's entry as the session's run folder holds it on disk, read
    /// through a store of its own (the session's store must be closed), with
    /// the session's in-memory key.
    private func durableEntry(_ session: DeskSession, _ run: ScriptedParticipantRun) throws -> ParticipantRunEntry? {
        XCTAssertNil(session.store, "the session's own store is closed")
        let store = try ProofStore(directory: try XCTUnwrap(session.runFolder), keys: session.keys)
        defer { store.close() }
        // An opened store publishes its durable runs only after this.
        return try store.refreshPublishedRuns().runs.first { $0.runId == run.identity.runId }
    }

    /// Types `text`, waits for Send and presses it; returns the run the
    /// coordinator launched for it.
    private func send(_ session: DeskSession, _ text: String, launcher: ScriptedLauncher) async throws -> ScriptedParticipantRun {
        let launched = launcher.runs.count
        try await type(session, text)
        try await eventually("Send to be enabled", detail: { await self.shown(session) }) {
            await self.pageBool(session, "(function () { var b = document.querySelector('button[aria-label=\"Send message\"]'); return !!b && !b.disabled; })()")
        }
        sendIndex = exchanges.count
        try await click(session, "button[aria-label=\"Send message\"]", "Send")
        try await eventually("the coordinator to launch the run", timeout: 20, detail: { await self.shown(session) }) {
            launcher.runs.count == launched + 1
        }
        let run = launcher.runs[launched]
        // Its script's init line first: text before it would be a process
        // error, as from a real CLI.
        try await eventually("the run's started event", detail: { "\(run.recordedUpdates)" }) {
            run.events.contains { $0.type == .started }
        }
        return run
    }

    /// A run's own text, streamed: one text delta, emitted 250 ms later.
    private func stream(_ run: ScriptedParticipantRun, _ text: String) {
        run.deliver(ScriptStep(atMs: 0, .textDelta(text)))
    }

    /// The run's process ended and the coordinator owes nothing for it.
    private func settled(_ run: ScriptedParticipantRun, _ coordinator: ParticipantCoordinator) async throws {
        try await eventually("the run to end and its writes to be durable", timeout: 20) {
            let unresolved = await coordinator.hasUnresolvedWrites
            return run.isFinished && !unresolved
        }
    }

    /// Clicks the last enabled button whose text is exactly `label`.
    private func clickButton(_ session: DeskSession, labelled label: String) async throws {
        try await eventually("a \"\(label)\" button to be clickable", timeout: 30, detail: { await self.shown(session) }) {
            let result = try await call(try XCTUnwrap(session.host).webView, """
            const found = Array.from(document.querySelectorAll('button')).filter(function (b) { return !b.disabled && b.textContent.trim() === label; });
            if (!found.length) return 'missing';
            found[found.length - 1].click();
            return 'clicked';
            """, ["label": label]) as? String
            return result == "clicked"
        }
    }

    /// Waits `seconds` of real time, failing at once if `broken` turns true
    /// on any 100 ms check; returns the last check's answer otherwise.
    private func holdsThrough(_ seconds: TimeInterval, _ what: String, broken: () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await broken() { return XCTFail("\(what) within the \(Int(seconds)) s interval") }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        if await broken() { XCTFail("\(what) at the end of the \(Int(seconds)) s interval") }
    }

    // MARK: The proof

    func testTheRealPageDrivesTheRealCoordinatorThroughTheDeskSession() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment[DeskBundleLocation.environmentKey], !path.isEmpty else {
            throw XCTSkip("Set TRUECONVO_DESK_BUNDLE to a built Desk native-dist copy to run the end-to-end proof.")
        }
        let bundle = try XCTUnwrap(DeskBundleLocation.developmentFolder(URL(fileURLWithPath: path, isDirectory: true)),
                                   "TRUECONVO_DESK_BUNDLE is set but does not name a built Desk folder")
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let world = CoordinatorDesk.world()
        let launcher = ScriptedLauncher(world: world, script: [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 0, .rateLimitOK)])
        let coordinator = CoordinatorDesk.coordinator(world: world, launcher: launcher)
        let pump = RealTimePump(world: world)
        pump.start()
        defer { pump.stop() }
        let lines = DeskLines()
        var made = 0
        let session = DeskSession(paths: folder.paths, bundle: bundle, info: CoordinatorDesk.info, log: lines.log,
                                  makeParticipantLane: { made += 1; return coordinator })
        // Every document's exchanges, identifiers only, from its first message.
        session.onPageStarted = { [unowned session, unowned self] in
            session.host?.messageHandler.observer = { [unowned self] exchange in self.exchanges.append(exchange) }
        }
        // A reload may leave the page's unsaved text; the run keeps it.
        session.confirmLeavingUnsavedWork = { _, _ in true }

        // 1. Open: the lane builds the stack's host; the page asks for
        // availability through its participant client.
        try await bounded("the first unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        XCTAssertEqual(session.state, .open)
        XCTAssertTrue((session.participantLane as? ParticipantCoordinator) === coordinator)
        let first = try await waitForDesk(session, after: nil)
        try await eventually("the page's own availability call", detail: { "\(self.exchanges)" }) {
            replied("host.capabilities", on: first) >= 1 && replied("participant.availability", on: first) >= 1
        }
        let store = try XCTUnwrap(session.store)

        // 2. A session, the participant chosen in the page's picker, a draft.
        try await click(session, "button[aria-label=\"New session\"]", "New session")
        try await click(session, "button[aria-label^=\"Model and participant: \"]", "the participant picker")
        try await click(session, "button[aria-label=\"Choose participant: Claude Code, invented-pinned-model\"]", "the participant choice")
        try await click(session, "button.participant-picker-done", "Done")
        try await eventually("the choice to be saved", detail: { await self.shown(session) }) {
            await self.pageBool(session, "document.querySelector('button[aria-label=\"Model and participant: Claude Code, invented-pinned-model\"]') !== null")
        }

        // 3. Prepare and start: the page commits the prepared run, then starts
        // it; the coordinator records the start and launches it.
        let one = try await send(session, Self.question, launcher: launcher)
        try await eventually("the start's reply") { replied("participant.start", on: first) == 1 }
        let prepared = try XCTUnwrap(entry(store, one), "prepared through workspace.commitProof")
        XCTAssertNotNil(prepared.start, "the start record is durable")
        XCTAssertGreaterThanOrEqual(replied("workspace.commitProof", on: first), 2, "the choice and the preparation were commits")
        let startIndex = try XCTUnwrap(exchanges.firstIndex(of: .replied(operation: "participant.start", connectionId: first.id,
                                                                         generation: first.generation, outcome: .ok, reason: nil)))
        XCTAssertLessThan(sendIndex, startIndex)
        XCTAssertTrue(exchanges[sendIndex..<startIndex].contains(.replied(operation: "workspace.commitProof", connectionId: first.id,
                                                                          generation: first.generation, outcome: .ok, reason: nil)),
                      "the preparation's commit came after Send was pressed and before the start")

        // 4. Streamed events reach the page.
        stream(one, "Invented reply: four.")
        try await eventually("the streamed text on the page", detail: { await self.shown(session) }) {
            await self.outputs(session).contains { $0.contains("Invented reply: four.") }
        }
        XCTAssertGreaterThanOrEqual(lines.participantPushes(generation: first.generation), 2, "started and text, pushed to this document")

        // 5. Stop, from the page.
        try await click(session, ".run-stop", "Stop")
        try await eventually("the Stop's reply") { replied("participant.stop", on: first) >= 1 }
        XCTAssertFalse(one.stopCalls.isEmpty, "the run was sent stop")
        try await settled(one, coordinator)
        try await eventually("the stopped terminal to be durable") { entry(store, one)?.terminal?.type == "stopped" }

        // 6. Reload: a second run goes on across it, and its later events
        // reach the new connection only.
        let two = try await send(session, "Invented question two.", launcher: launcher)
        stream(two, "Second reply, before the reload. ")
        try await eventually("the second run's text", detail: { await self.shown(session) }) {
            await self.outputs(session).contains { $0.contains("before the reload") }
        }
        let pushesToFirst = lines.participantPushes(generation: first.generation)
        try XCTUnwrap(session.host).reload()
        let second = try await waitForDesk(session, after: first)
        XCTAssertTrue(two.stopCalls.isEmpty, "the run went on across the reload")
        stream(two, "Later words, after the reload.")
        try await eventually("a push to the new document", timeout: 15) { lines.participantPushes(generation: second.generation) >= 1 }
        try await eventually("the later text on the new page", detail: { await self.shown(session) }) {
            await self.outputs(session).contains { $0.contains("after the reload") }
        }
        XCTAssertEqual(lines.participantPushes(generation: first.generation), pushesToFirst, "nothing more for the old document")

        // 7. Lock while the run streams, with a push under way (held in the
        // session's own sink): the lane's lock on the main thread waits for
        // that push alone, the run is stopped, its text dropped, and nothing
        // is pushed after it.
        lines.hold.arm()
        stream(two, "Words in a push under way at the lock.")
        try await eventually("a push to be under way") { lines.hold.entered }
        lines.hold.release(after: 0.3)
        // Every push so far, the held one included: its sink line is
        // written before it is held.
        let pushesAtLock = lines.participantPushes
        let lockBegan = Date()
        session.lockNow(reason: .menu)
        let lockTook = Date().timeIntervalSince(lockBegan)
        lines.hold.note("lock returned")
        XCTAssertEqual(lines.hold.journal, ["push held main=false", "push returned released=true", "lock returned"])
        XCTAssertGreaterThanOrEqual(lockTook, 0.25, "the lane's lock waited for the push under way")
        XCTAssertLessThan(lockTook, 5)
        XCTAssertEqual(session.state, .locked)
        XCTAssertTrue(coordinator.gate.isLocked)
        XCTAssertFalse(two.stopCalls.isEmpty, "the lock sent the run stop")
        try await eventually("the page to close its workspace", detail: { await self.shown(session) }) {
            await self.pageBool(session, "document.querySelector('main.recovery-page h1')?.textContent === 'Workspace connection closed'")
        }
        try await eventually("the stopped run's process to end", timeout: 20) { two.isFinished }
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(lines.participantPushes, pushesAtLock, "nothing pushed once the lock began, the terminal included")
        XCTAssertNil(entry(store, two)?.terminal, "the terminal is held, unwritten, while locked")

        // 8. Unlock: the held terminal is written, the text stays dropped.
        try await bounded("the unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        XCTAssertEqual(session.state, .open)
        XCTAssertFalse(coordinator.gate.isLocked)
        let third = try await waitForDesk(session, after: second)
        try await eventually("the held terminal to be written") { entry(store, two)?.terminal?.type == "stopped" }
        let events = await coordinator.handle(CoordinatorDesk.request(.participantEvents, [
            "workspaceHandle": .string(store.workspaceHandle), "runId": .string(two.identity.runId), "sessionId": .string(two.identity.sessionId),
            "afterSequence": .number(0), "maxEvents": .number(64)
        ], on: third))
        XCTAssertEqual(events.outcome, .ok, "\(events.jsonValue)")
        XCTAssertEqual(events.fields["lost"]?.objectValue?["reason"], .string("locked"), "\(events.jsonValue)")
        guard case .array(let kept)? = events.fields["events"] else { return XCTFail("\(events.jsonValue)") }
        XCTAssertFalse(kept.contains { $0.objectValue?["type"] == .string("text") }, "no text kept across the lock")

        // 9. Window close with a run streaming and a push under way: the
        // lane's close step waits for that push, then the close ends well
        // within the participant bound.
        try await settled(two, coordinator)
        let three = try await send(session, "Invented question three.", launcher: launcher)
        stream(three, "Third reply, streaming at the close. ")
        try await eventually("the third run's text", detail: { await self.shown(session) }) {
            await self.outputs(session).contains { $0.contains("streaming at the close") }
        }
        lines.hold.arm()
        stream(three, "Words in a push under way at the close.")
        try await eventually("a push to be under way") { lines.hold.heldCount == 2 }
        lines.hold.release(after: 0.3)
        let closeBegan = Date()
        try await bounded("the window close") { await session.close() }
        let closeTook = Date().timeIntervalSince(closeBegan)
        lines.hold.note("close returned")
        XCTAssertEqual(Array(lines.hold.journal.suffix(3)), ["push held main=false", "push returned released=true", "close returned"])
        XCTAssertGreaterThanOrEqual(closeTook, 0.25)
        XCTAssertLessThan(closeTook, DeskTermination.participantTimeout, "within the one bound")
        XCTAssertEqual(session.state, .closed)
        XCTAssertFalse(three.stopCalls.isEmpty)
        // Read on its own now, before any reopen could write it: the close
        // wrote the terminal while its store was open.
        XCTAssertEqual(try durableEntry(session, three)?.terminal?.type, "stopped", "the close wrote the terminal before its store closed")

        // 10. Quit with a run streaming: the real termination reply, its
        // participant bound chosen, answered once the lane is done.
        try await bounded("the reopen") { await session.unlock(verifier: StubUnlockVerifier()) }
        XCTAssertEqual(session.state, .open, "reopened without asking")
        // A new stack: its own registry, so its generations start again.
        _ = try await waitForDesk(session, after: nil)
        let reopened = try XCTUnwrap(session.store)
        XCTAssertFalse(reopened === store, "a new store over the same folder")
        XCTAssertEqual(entry(reopened, three)?.terminal?.type, "stopped", "still there after the reopen")
        try await settled(three, coordinator)
        // The real coordinator owes nothing once its runs settled, so a quit
        // now would take the plain bound (the quit itself is
        // CoordinatorAppWiringTests'; this one quits with a run live).
        try await eventually("nothing owed once runs one to three settled", timeout: 10) { await coordinator.obligations().isEmpty }
        let four = try await send(session, "Invented question four.", launcher: launcher)
        stream(four, "Fourth reply, streaming at the quit.")
        try await eventually("the fourth run's text", detail: { await self.shown(session) }) {
            await self.outputs(session).contains { $0.contains("streaming at the quit") }
        }
        var replies: [Bool] = []
        let quitBegan = Date()
        let answer = DeskTermination.reply(for: session, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater)
        try await eventually("the app's one yes", timeout: DeskTermination.participantTimeout + 5) { !replies.isEmpty }
        let quitTook = Date().timeIntervalSince(quitBegan)
        XCTAssertEqual(replies, [true])
        XCTAssertLessThan(quitTook, DeskTermination.participantTimeout, "within the real bound")
        XCTAssertTrue(lines.all.contains("desk.terminate.participants owed=true limit=17s"), "\(lines.all)")
        XCTAssertFalse(lines.all.contains { $0.hasPrefix("desk.terminate.cap-reached") }, "\(lines.all)")
        XCTAssertEqual(session.state, .closed)
        XCTAssertFalse(four.stopCalls.isEmpty)
        XCTAssertTrue(four.isFinished, "the quit waited for the run's process to end")
        let unresolved = await coordinator.hasUnresolvedWrites
        XCTAssertFalse(unresolved, "the quit left no participant write owed")
        XCTAssertEqual(try durableEntry(session, four)?.terminal?.type, "stopped", "the quit wrote the terminal before its store closed")
        XCTAssertEqual(made, 1, "one coordinator for the whole run of the app")
        XCTAssertEqual(launcher.runs.count, 4)
        XCTAssertEqual(pump.failures, [])
    }

    // MARK: The combined renderer proof (section 18, item 2)

    /// Section 7 under lock, through the real page: a Start held at step
    /// 13's availability recheck (before step 14's start record), then a
    /// lock. The start is refused `store-locked` and writes nothing, and its
    /// answer, ready after the lock began, is dropped by native. After the
    /// unlock the fresh document restores the prepared run, and nothing
    /// starts it by itself: no launch and no start record through an
    /// interval longer than the page's quiet poll. Then one explicit Start,
    /// from the page's own button, launches that same prepared run once.
    func testAStartHeldBeforeStep14AcrossALockNeverStartsByItselfAndStartsOnceWhenAsked() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment[DeskBundleLocation.environmentKey], !path.isEmpty else {
            throw XCTSkip("Set TRUECONVO_DESK_BUNDLE to a built Desk native-dist copy to run the combined renderer proof.")
        }
        let bundle = try XCTUnwrap(DeskBundleLocation.developmentFolder(URL(fileURLWithPath: path, isDirectory: true)),
                                   "TRUECONVO_DESK_BUNDLE is set but does not name a built Desk folder")
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let world = CoordinatorDesk.world()
        let launcher = ScriptedLauncher(world: world, script: [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 0, .rateLimitOK)])
        let availability = RecheckHold()
        let coordinator = CoordinatorDesk.coordinator(world: world, launcher: launcher, availability: availability)
        let pump = RealTimePump(world: world)
        pump.start()
        defer { pump.stop() }
        let lines = DeskLines()
        let session = DeskSession(paths: folder.paths, bundle: bundle, info: CoordinatorDesk.info, log: lines.log,
                                  makeParticipantLane: { coordinator })
        session.onPageStarted = { [unowned session, unowned self] in
            session.host?.messageHandler.observer = { [unowned self] exchange in self.exchanges.append(exchange) }
        }
        session.confirmLeavingUnsavedWork = { _, _ in true }

        try await bounded("the first unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        let first = try await waitForDesk(session, after: nil)
        try await eventually("the page's own availability call", detail: { "\(self.exchanges)" }) {
            replied("participant.availability", on: first) >= 1
        }
        let store = try XCTUnwrap(session.store)
        try await click(session, "button[aria-label=\"New session\"]", "New session")
        try await click(session, "button[aria-label^=\"Model and participant: \"]", "the participant picker")
        try await click(session, "button[aria-label=\"Choose participant: Claude Code, invented-pinned-model\"]", "the participant choice")
        try await click(session, "button.participant-picker-done", "Done")
        try await eventually("the choice to be saved", detail: { await self.shown(session) }) {
            await self.pageBool(session, "document.querySelector('button[aria-label=\"Model and participant: Claude Code, invented-pinned-model\"]') !== null")
        }

        // 1. Send: the page prepares the run, then starts it; the start is
        // held at its availability recheck, before step 14.
        let gate = availability.arm()
        try await type(session, "Invented question held at the lock.")
        try await eventually("Send to be enabled", detail: { await self.shown(session) }) {
            await self.pageBool(session, "(function () { var b = document.querySelector('button[aria-label=\"Send message\"]'); return !!b && !b.disabled; })()")
        }
        try await click(session, "button[aria-label=\"Send message\"]", "Send")
        try await eventually("the start to reach its recheck", timeout: 20, detail: { await self.shown(session) }) { gate.arrived == 1 }
        let prepared = try XCTUnwrap(store.publishedRuns.runs.first, "prepared through workspace.commitProof")
        XCTAssertNil(prepared.start, "held before step 14: no start record")
        let phase = await coordinator.phase(of: prepared.runId)
        XCTAssertEqual(phase, "starting")
        XCTAssertTrue(launcher.requests.isEmpty)

        // 2. Lock while it is held, then let the refused start settle.
        session.lockNow(reason: .menu)
        XCTAssertEqual(session.state, .locked)
        gate.open()
        try await eventually("the held start's answer to be dropped", timeout: 15, detail: { "\(self.exchanges)" }) {
            self.exchanges.contains(.transportFailure(.staleReply))
        }
        try await eventually("the start to let go of the run") { await coordinator.phase(of: prepared.runId) == nil }
        XCTAssertFalse(exchanges.contains { if case .replied("participant.start", _, _, _, _) = $0 { return true } else { return false } },
                       "the refused start's answer never reached the page: \(exchanges)")
        try await eventually("the page to close its workspace", detail: { await self.shown(session) }) {
            await self.pageBool(session, "document.querySelector('main.recovery-page h1')?.textContent === 'Workspace connection closed'")
        }
        XCTAssertTrue(launcher.requests.isEmpty, "nothing launched")
        XCTAssertNil(store.publishedRuns.runs.first { $0.runId == prepared.runId }?.start, "nothing written, not even a terminal")
        XCTAssertNil(store.publishedRuns.runs.first { $0.runId == prepared.runId }?.terminal)

        // 3. Unlock into a fresh document: it restores the prepared run and
        // never starts it by itself, through more than one quiet poll.
        try await bounded("the unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        XCTAssertEqual(session.state, .open)
        let fresh = try await waitForDesk(session, after: first)
        let freshStartsBefore = exchanges.count
        try await holdsThrough(20, "a launch or a start record appeared") {
            !launcher.requests.isEmpty || store.publishedRuns.runs.first { $0.runId == prepared.runId }?.start != nil
        }
        XCTAssertFalse(exchanges[freshStartsBefore...].contains { if case .replied("participant.start", _, _, _, _) = $0 { return true } else { return false } },
                       "the fresh document sent no start by itself: \(exchanges[freshStartsBefore...])")
        XCTAssertGreaterThanOrEqual(replied("participant.status", on: fresh), 1, "the fresh document read the run's status")

        // 4. One explicit Start, from the page: the prepared run, once.
        // The page may decline a click without sending a start (seen on CI:
        // its restored controller reads status, replays and asks for
        // availability, then sends nothing). Each such click dispatches
        // nothing, which this counts; the first one that sends a start must
        // be the only start, and it must launch once.
        var clicks = 0
        // Every start the fresh document sent, whatever its answer.
        func sentStarts() -> Int {
            exchanges.filter {
                if case .replied("participant.start", fresh.id, fresh.generation, _, _) = $0 { return true } else { return false }
            }.count
        }
        while sentStarts() == 0, clicks < 3 {
            let beforeClick = exchanges.count
            try await clickButton(session, labelled: "Start prepared message")
            clicks += 1
            let deadline = Date().addingTimeInterval(8)
            while Date() < deadline, sentStarts() == 0 { try await Task.sleep(nanoseconds: 100_000_000) }
            if sentStarts() == 0 {
                print("PR3a combined proof: click \(clicks) sent no start; exchanges since it: \(exchanges[beforeClick...]); page: \(await shown(session))")
                XCTAssertTrue(launcher.requests.isEmpty, "a click that sent no start launched nothing")
            }
        }
        print("PR3a combined proof: the explicit Start took \(clicks) click(s)")
        try await eventually("the coordinator to launch the run", timeout: 20, detail: { "\(self.exchanges); page: \(await self.shown(session))" }) {
            launcher.runs.count == 1
        }
        let run = launcher.runs[0]
        XCTAssertEqual(run.identity.runId, prepared.runId, "the retained prepared run")
        XCTAssertEqual(run.identity.sessionId, prepared.sessionId)
        try await eventually("the start's reply") { replied("participant.start", on: fresh) == 1 }
        XCTAssertEqual(sentStarts(), 1, "one start sent, answered ok")
        let started = try XCTUnwrap(store.publishedRuns.runs.first { $0.runId == prepared.runId })
        XCTAssertNotNil(started.start, "its start record is durable")
        XCTAssertEqual(started.prepareRequestId, prepared.prepareRequestId, "the same preparation")
        XCTAssertEqual(started.inputHash, prepared.inputHash)
        XCTAssertEqual(started.participant, prepared.participant)
        try await holdsThrough(5, "a second launch appeared") { launcher.requests.count != 1 }
        XCTAssertEqual(replied("participant.start", on: fresh), 1, "started once")

        try await click(session, ".run-stop", "Stop")
        try await settled(run, coordinator)
        try await bounded("the window close") { await session.close() }
        XCTAssertEqual(session.state, .closed)
        XCTAssertEqual(launcher.runs.count, 1)
        XCTAssertEqual(availability.gateTimeouts, 0, "the held recheck was opened by the test")
        XCTAssertEqual(pump.failures, [])
    }
}

/// Available, with no confirmation (as `CoordinatorDesk.available`), and a
/// start's recheck (section 7 step 13) held at a gate once armed. The
/// page's own availability calls never wait.
final class RecheckHold: AvailabilityReporting, @unchecked Sendable {
    private let inner = CoordinatorDesk.available
    private let lock = NSLock()
    private var armed: AsyncGate?
    private var gates: [AsyncGate] = []

    /// The next recheck waits at the returned gate until it opens.
    func arm() -> AsyncGate {
        lock.lock(); defer { lock.unlock() }
        let gate = AsyncGate()
        armed = gate
        gates.append(gate)
        return gate
    }

    /// Times a gate opened itself because nothing opened it.
    var gateTimeouts: Int {
        lock.lock(); defer { lock.unlock() }
        return gates.reduce(0) { $0 + $1.timedOut }
    }

    func report() async -> ParticipantAvailabilityReport {
        await inner.report()
    }

    func recheck() async -> ParticipantAvailabilityReport {
        lock.lock()
        let gate = armed
        armed = nil
        lock.unlock()
        if let gate { await gate.pass() }
        return await inner.recheck()
    }
}
