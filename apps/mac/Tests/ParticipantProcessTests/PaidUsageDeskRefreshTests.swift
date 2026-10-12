import AppKit
@testable import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
@testable import ParticipantCoordinator
@testable import ParticipantDeskControls
@testable import ParticipantProcess
import WebKit
import XCTest

/// Answers the statement sheet "continue" at once.
@MainActor
final class ContinuingStatement: DeskPaidUsageStatementPrompting {
    private(set) var asked = 0
    func ask(in window: NSWindow) async -> Bool {
        asked += 1
        return true
    }
    func dismiss() {}
}

/// Dispatches the AppKit events this test process receives, as the app's own
/// event loop does (a test process runs the main run loop but not
/// `NSApplication.run`): without it the window server's occlusion change
/// never reaches WebKit, and the page stays `hidden` though its window is on
/// screen. Every 20 ms, on the main run loop, in the common modes.
@MainActor
final class AppKitEventPump {
    private var timer: Timer?

    func start() {
        let application = NSApplication.shared
        application.finishLaunching()
        let timer = Timer(timeInterval: 0.02, repeats: true) { _ in
            MainActor.assumeIsolated {
                while let event = application.nextEvent(matching: .any, until: .distantPast, inMode: .default, dequeue: true) {
                    application.sendEvent(event)
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }
}

/// Codex F0 answer 14 with the real built Desk page in a real `WKWebView`,
/// in the real Desk window, over the real coordinator whose availability and
/// confirmation are section 17's real owner (fake local checks, a fake
/// authenticator: no LocalAuthentication, no CLI): the page starts from its
/// cached unavailable answer; a completed native confirmation makes the web
/// view first responder; the page reads availability again by itself, and
/// Send and the confirmation's message update with no reload, no picker
/// interaction, no injected DOM focus, and no dispatch. Both the case where
/// the page was not first responder and the case where it already was.
///
/// The window must be on screen for the page to count as visible, so it is
/// ordered in, small, at the screen's corner, without activating the app,
/// for the test's few seconds. Set `TRUECONVO_DESK_BUNDLE` to a built Desk
/// (`native-dist`) to run it; without it the proof is skipped, never faked.
///
/// It changes process-wide AppKit state: `finishLaunching`, an event pump
/// while it runs, and (when it was prohibited) the activation policy, which
/// it gives back at the end. Run it alone (its own `--filter`), as the
/// reported runs do, so no other WebKit or Desk test shares that state.
///
/// What it does not cover (Codex F34-5): the authenticator is a fake and the
/// statement continues at once, so no system panel takes the key window
/// during the confirmation. Whether the real LocalAuthentication request
/// changes which window is key, or the page's focus events, is first seen
/// in the owner's trial; a failure there is safe (Send stays blocked until the
/// page reads again), and the bounded native-to-page notification remains
/// the answer-14 fallback.
final class PaidUsageDeskRefreshTests: CoordinatorDeskTestCase {
    private var exchanges: [HostExchange] = []

    private func page(_ session: DeskSession, _ javaScript: String) async throws -> Any? {
        try await evaluate(try XCTUnwrap(session.host).webView, javaScript)
    }

    private func shown(_ session: DeskSession) async -> String {
        let text = (try? await page(session, "document.body ? document.body.innerText : ''")) as? String ?? "(no page)"
        return String(text.prefix(1_500))
    }

    private func pageBool(_ session: DeskSession, _ javaScript: String) async -> Bool {
        (try? await page(session, javaScript)) as? Bool == true
    }

    private func pageString(_ session: DeskSession, _ javaScript: String) async -> String? {
        (try? await page(session, javaScript)) as? String
    }

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

    private func replied(_ operation: String, on connection: HostConnection) -> Int {
        exchanges.filter { $0 == .replied(operation: operation, connectionId: connection.id, generation: connection.generation, outcome: .ok, reason: nil) }.count
    }

    private func sent(_ operation: String) -> Int {
        exchanges.filter {
            if case .replied(let name, _, _, _, _) = $0 { return name == operation }
            return false
        }.count
    }

    private static let sendEnabled = "(function () { var b = document.querySelector('button[aria-label=\"Send message\"]'); return !!b && !b.disabled; })()"
    private static let blockedReason = "(function () { var e = document.getElementById('send-blocked-reason'); return e ? e.textContent : ''; })()"

    func testAConfirmationRefreshesTheRealPageWithoutReloadPickerOrInjectedFocus() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment[DeskBundleLocation.environmentKey], !path.isEmpty else {
            throw XCTSkip("Set TRUECONVO_DESK_BUNDLE to a built Desk native-dist copy to run the answer-14 refresh proof.")
        }
        let bundle = try XCTUnwrap(DeskBundleLocation.developmentFolder(URL(fileURLWithPath: path, isDirectory: true)),
                                   "TRUECONVO_DESK_BUNDLE is set but does not name a built Desk folder")
        let application = NSApplication.shared
        let policy = application.activationPolicy()
        if policy == .prohibited { _ = application.setActivationPolicy(.accessory) }
        defer { if policy == .prohibited { _ = application.setActivationPolicy(.prohibited) } }
        let events = AppKitEventPump()
        events.start()
        defer { events.stop() }
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let world = CoordinatorDesk.world()
        let launcher = ScriptedLauncher(world: world, script: [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 0, .rateLimitOK)])
        let checks = ScriptedLocalChecks()
        let authentication = FakeOwnerAuthentication()
        let owner = PaidUsageConfirmationOwner(checks: checks, authentication: authentication)
        let coordinator = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
            hostConfiguration: ParticipantHostConfiguration(pin: CoordinatorDesk.pin), availability: owner,
            launchId: UUID().uuidString.lowercased(), clock: world.clock, executor: BackgroundMutationExecutor(),
            launcher: launcher, log: RecordingLog(), wakeups: VirtualWakeups(world: world), confirmation: owner))
        let pump = RealTimePump(world: world)
        pump.start()
        defer { pump.stop() }
        let lines = DeskLines()
        let session = DeskSession(paths: folder.paths, bundle: bundle, info: CoordinatorDesk.info, log: lines.log,
                                  makeParticipantLane: { coordinator })
        session.unsavedWorkCheck = { nil }
        let controls = PaidUsageDeskControls(owner: owner)
        let statement = ContinuingStatement()
        let controller = DeskWindowController(session: session, verifier: StubUnlockVerifier(.verified), paidUsage: controls,
                                              statement: statement)
        // After the window's own handlers: every document's exchanges,
        // identifiers only, from its first message.
        let windowStarted = session.onPageStarted
        session.onPageStarted = { [unowned session, unowned self] in
            windowStarted?()
            session.host?.messageHandler.observer = { [unowned self] exchange in self.exchanges.append(exchange) }
        }
        session.confirmLeavingUnsavedWork = { _, _ in true }
        let window = try XCTUnwrap(controller.window)
        defer {
            window.orderOut(nil)
            window.delegate = nil
        }
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        window.setFrame(NSRect(x: screen.minX, y: screen.minY, width: 980, height: 680), display: false)
        window.orderFrontRegardless()

        // 1. Open: the page reads availability once and caches "unavailable".
        try await bounded("the unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        XCTAssertEqual(session.state, .open)
        try await eventually("the Desk to render", timeout: 30, detail: { await self.shown(session) }) {
            await self.pageBool(session, "document.querySelector('.application-shell') !== null && document.querySelector('main.recovery-page') === null")
        }
        let connection = try XCTUnwrap(session.host?.currentConnection)
        try await eventually("the page's own availability read") { self.replied("participant.availability", on: connection) >= 1 }

        // 2. Setup before any confirmation: a session with the participant
        // chosen (the picker is used here only), and a draft.
        try await click(session, "button[aria-label=\"New session\"]", "New session")
        try await click(session, "button[aria-label^=\"Model and participant: \"]", "the participant picker")
        try await click(session, "button[aria-label=\"Choose participant: Claude Code, invented-pinned-model\"]", "the participant choice")
        try await click(session, "button.participant-picker-done", "Done")
        try await eventually("the choice to be saved", detail: { await self.shown(session) }) {
            await self.pageBool(session, "document.querySelector('button[aria-label=\"Model and participant: Claude Code, invented-pinned-model\"]') !== null && document.querySelector('.participant-picker') === null")
        }
        try await type(session, "Invented question for the refresh proof.")
        try await eventually("the cached unavailable answer to block Send", detail: { await self.shown(session) }) {
            let reason = await self.pageString(session, Self.blockedReason) ?? ""
            let enabled = await self.pageBool(session, Self.sendEnabled)
            return reason.contains("Confirm paid usage is off in the Mac app") && !enabled
        }

        // 3a. Confirm with the native button holding the focus, as a click on
        // it leaves the page unfocused.
        window.makeFirstResponder(nil)
        XCTAssertFalse(window.firstResponder === session.host?.webView, "the page is not first responder")
        try await Task.sleep(nanoseconds: 500_000_000)
        let readsBefore = replied("participant.availability", on: connection)
        let pickerOpenings = await pageString(session, "String(document.querySelectorAll('.participant-picker').length)")
        XCTAssertEqual(pickerOpenings, "0", "the picker is closed")
        let result = try await bounded("the confirmation") { await controller.confirmPaidUsage() }
        XCTAssertEqual(result, .confirmed)
        XCTAssertEqual(statement.asked, 1)
        XCTAssertEqual(authentication.requests, 1)
        XCTAssertTrue(window.firstResponder === session.host?.webView, "the page is first responder")
        try await eventually("the page to read availability again by itself", detail: { "\(self.exchanges)" }) {
            self.replied("participant.availability", on: connection) > readsBefore
        }
        try await eventually("Send and the confirmation message to update", detail: { await self.shown(session) }) {
            let reason = await self.pageString(session, Self.blockedReason) ?? "(none)"
            let enabled = await self.pageBool(session, Self.sendEnabled)
            return reason.isEmpty && enabled
        }
        XCTAssertEqual(session.host?.currentConnection, connection, "no reload: the same document")
        XCTAssertEqual(sent("participant.start"), 0, "no dispatch")
        XCTAssertEqual(launcher.runs.count, 0)
        let pickers = await pageString(session, "String(document.querySelectorAll('.participant-picker').length)")
        XCTAssertEqual(pickers, "0", "no picker was opened")
        XCTAssertTrue(controller.paidUsageLine.stringValue.hasPrefix("You confirmed paid usage was off at "))

        // 3b. The already-focused case: the confirmation ends (a sleep), and
        // the window's own refresh on an end (Codex F4-6; nothing called by
        // the test) makes the page read it ended; then a new confirmation
        // while the page is first responder refreshes it again.
        owner.end(.sleep)
        try await eventually("the ended confirmation to block Send again", detail: { await self.shown(session) }) {
            let reason = await self.pageString(session, Self.blockedReason) ?? ""
            let enabled = await self.pageBool(session, Self.sendEnabled)
            return !reason.isEmpty && !enabled
        }
        XCTAssertTrue(window.firstResponder === session.host?.webView, "already first responder")
        let readsBeforeSecond = replied("participant.availability", on: connection)
        let second = try await bounded("the second confirmation") { await controller.confirmPaidUsage() }
        XCTAssertEqual(second, .confirmed)
        try await eventually("the page to read availability again, already focused", detail: { "\(self.exchanges)" }) {
            self.replied("participant.availability", on: connection) > readsBeforeSecond
        }
        try await eventually("Send to be enabled again", detail: { await self.shown(session) }) {
            let reason = await self.pageString(session, Self.blockedReason) ?? "(none)"
            let enabled = await self.pageBool(session, Self.sendEnabled)
            return reason.isEmpty && enabled
        }
        XCTAssertEqual(session.host?.currentConnection, connection, "still the same document")
        XCTAssertEqual(sent("participant.start"), 0, "still no dispatch")
        XCTAssertEqual(launcher.runs.count, 0)
        XCTAssertEqual(pump.failures, [])
        try await bounded("the close") { await session.close() }
    }
}
