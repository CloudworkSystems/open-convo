import AppKit
import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
@testable import LocalModelRoute
import ParticipantAppWiring
import WebKit
import XCTest

/// Step 3 PR 4b's end-to-end check, opt-in: the lane True Convo Test builds
/// (`LocalConversationLane.factory(for: .test)`, with the real `OllamaClient`
/// at the fixed loopback base) behind the app's own `DeskSession`, the real
/// built Desk page in a real `WKWebView`, and the real Ollama on this Mac.
/// The page picks the default model by itself, sends three invented
/// messages, shows the second reply using the first turn as context, stops
/// the third partway, and the quit leaves no run alias in Ollama.
///
/// Runs only with `OPEN_CONVO_OLLAMA_E2E=1`, `TRUECONVO_DESK_BUNDLE` naming a
/// built Desk (`native-dist`), and Ollama answering on 127.0.0.1:11434 with
/// `qwen3:8b` installed; skipped otherwise. Invented text only. It prints
/// only counts and yes/no answers, never message or reply text, and writes
/// nothing outside a throwaway folder.
final class LocalAppEndToEndTests: CoordinatorDeskTestCase {
    private static let model = "qwen3:8b"
    private static let complete = "Reply complete · stayed on this Mac"
    private static let stopped = "Stopped. The reply so far is kept."
    /// The page's exchanges: operation, outcome and refusal reason only.
    private var exchanges: [String] = []
    private let lines = DeskLines()

    private func page(_ session: DeskSession, _ javaScript: String) async throws -> Any? {
        try await evaluate(try XCTUnwrap(session.host).webView, javaScript)
    }

    private func pageBool(_ session: DeskSession, _ javaScript: String) async -> Bool {
        (try? await page(session, javaScript)) as? Bool == true
    }

    /// Counts and states only, for a failure message: never page text.
    private func shape(_ session: DeskSession) async -> String {
        let phases = ((try? await page(session, "Array.from(document.querySelectorAll('.run-phase')).map(function (e) { return e.textContent; })")) as? [String]) ?? []
        let blocked = ((try? await page(session, "(document.querySelector('.composer-blocked, [data-send-blocked]') || {}).textContent || ''")) as? String) ?? ""
        let runs = session.store?.publishedRuns.runs.map { "start=\($0.start != nil) end=\($0.terminal?.type ?? "-")" } ?? []
        return "runs=\(runs) phases=\(phases) blocked=\(blocked.prefix(160)) exchanges=\(exchanges.suffix(16)) log=\(lines.all.suffix(20))"
    }

    private func click(_ session: DeskSession, _ selector: String, _ what: String) async throws {
        let quoted = String(data: try JSONSerialization.data(withJSONObject: [selector]), encoding: .utf8)!
        try await eventually("\(what) to be clickable", timeout: 30, detail: { await self.shape(session) }) {
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
        try await eventually("the message box", detail: { await self.shape(session) }) {
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

    private func send(_ session: DeskSession, _ text: String) async throws {
        try await type(session, text)
        try await eventually("Send to be enabled", timeout: 30, detail: { await self.shape(session) }) {
            await self.pageBool(session, "(function () { var b = document.querySelector('button[aria-label=\"Send message\"]'); return !!b && !b.disabled; })()")
        }
        try await click(session, "button[aria-label=\"Send message\"]", "Send")
    }

    private func phases(_ session: DeskSession) async -> [String] {
        ((try? await page(session, "Array.from(document.querySelectorAll('.run-phase')).map(function (e) { return e.textContent; })")) as? [String]) ?? []
    }

    private func outputs(_ session: DeskSession) async -> [String] {
        ((try? await page(session, "Array.from(document.querySelectorAll('.run-message[data-message-id]:not([aria-label=\"Your message\"])')).map(function (e) { var o = e.querySelector('.run-output'); return o ? o.textContent : ''; })")) as? [String]) ?? []
    }

    /// The local models Ollama lists right now, or nil when it isn't answering.
    private static func localModels() async -> [String]? {
        guard case .ready(let entries) = await OllamaClient().catalog() else { return nil }
        return entries.filter(\.isLocal).map(\.name)
    }

    /// How many names in Ollama's list are this app's run aliases.
    private static func runAliases() async -> Int? {
        guard let url = URL(string: "http://127.0.0.1:11434/api/tags"),
              let (data, _) = try? await URLSession(configuration: .ephemeral).data(from: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = root["models"] as? [[String: Any]] else { return nil }
        return models.compactMap { $0["name"] as? String }.filter(OllamaAlias.isAlias).count
    }

    func testTheTestCopysLaneTalksToThisMacsOllamaThroughTheRealPage() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["OPEN_CONVO_OLLAMA_E2E"] == "1" else {
            throw XCTSkip("Set OPEN_CONVO_OLLAMA_E2E=1 (and TRUECONVO_DESK_BUNDLE) to run against this Mac's Ollama.")
        }
        guard let path = environment[DeskBundleLocation.environmentKey], !path.isEmpty else {
            throw XCTSkip("Set TRUECONVO_DESK_BUNDLE to a built Desk native-dist copy.")
        }
        guard let models = await Self.localModels() else { throw XCTSkip("Ollama is not answering on 127.0.0.1:11434.") }
        guard models.contains(Self.model) else { throw XCTSkip("\(Self.model) is not installed as a local model.") }
        let bundle = try XCTUnwrap(DeskBundleLocation.developmentFolder(URL(fileURLWithPath: path, isDirectory: true)))
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        // The app's own factory, for the test copy: the real Ollama client.
        let factory = try XCTUnwrap(LocalConversationLane.factory(for: .test))
        let session = DeskSession(paths: folder.paths, bundle: bundle, info: CoordinatorDesk.info, log: lines.log, makeParticipantLane: factory)
        session.confirmLeavingUnsavedWork = { _, _ in true }
        session.onPageStarted = { [unowned session, unowned self] in
            session.host?.messageHandler.observer = { [unowned self] exchange in
                if case .replied(let operation, _, _, let outcome, let reason) = exchange {
                    self.exchanges.append("\(operation):\(outcome)\(reason.map { ":\($0)" } ?? "")")
                } else {
                    self.exchanges.append("\(exchange)")
                }
            }
        }
        try await bounded("the unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        XCTAssertEqual(session.state, .open)
        XCTAssertNotNil(session.participantLane, "the test copy has a lane")
        try await eventually("the Desk shell to render", timeout: 30) {
            await self.pageBool(session, "document.querySelector('.application-shell') !== null && document.querySelector('main.recovery-page') === null")
        }

        // 1. A new session starts with the default model, picked and saved
        // by the page; the picker offers no Claude entry.
        try await click(session, "button[aria-label=\"New session\"]", "New session")
        let defaultLabel = "Model and participant: Local · \(Self.model) · stays on this Mac"
        try await eventually("the default model to be chosen", timeout: 30, detail: { await self.shape(session) }) {
            await self.pageBool(session, "document.querySelector('button[aria-label=\"\(defaultLabel)\"]') !== null")
        }
        try await click(session, "button[aria-label=\"\(defaultLabel)\"]", "the model picker")
        try await eventually("the picker's choices", timeout: 30) {
            await self.pageBool(session, "document.querySelectorAll('.participant-picker-choice').length > 0")
        }
        let claudeOffered = await pageBool(session, "Array.from(document.querySelectorAll('.participant-picker-select')).some(function (b) { return /Claude/.test(b.getAttribute('aria-label') || ''); })")
        XCTAssertFalse(claudeOffered, "no Claude entry in the picker")
        try await click(session, "button.participant-picker-done", "Done")

        // 2. First turn.
        try await send(session, "I run an invented bakery called Maple Crumb. Suggest one name for a new muffin, in one sentence.")
        try await eventually("the first reply to complete", timeout: 180, detail: { await self.shape(session) }) {
            await self.phases(session).filter { $0 == Self.complete }.count == 1
        }

        // 3. Second turn: the reply uses the first as context.
        try await send(session, "What is my bakery called? Answer with only its name.")
        try await eventually("the second reply to complete", timeout: 180, detail: { await self.shape(session) }) {
            await self.phases(session).filter { $0 == Self.complete }.count == 2
        }
        let second = await outputs(session).dropFirst().first ?? ""
        let usesContext = second.lowercased().contains("maple crumb")

        // 4. Third turn, stopped partway: the text so far stays, no more arrives.
        try await send(session, "Write a long story, at least two thousand words, about a muffin that travels the world.")
        try await eventually("the third reply to start streaming", timeout: 180, detail: { await self.shape(session) }) {
            let shown = await self.outputs(session)
            return shown.count == 3 && (shown.last ?? "").count > 80
        }
        try await click(session, ".run-stop", "Stop")
        try await eventually("the stopped ending", timeout: 30, detail: { await self.shape(session) }) {
            await self.phases(session).last == Self.stopped
        }
        let keptAtStop = (await outputs(session).last ?? "").count
        try await Task.sleep(nanoseconds: 2_000_000_000)
        let keptLater = (await outputs(session).last ?? "").count

        // 5. Quit through the real termination reply, then Ollama's list.
        var replies: [Bool] = []
        let answer = DeskTermination.reply(for: session, pageAlreadyAsked: true, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater)
        try await eventually("the app's one yes", timeout: DeskTermination.participantTimeout + 5) { !replies.isEmpty }
        XCTAssertEqual(replies, [true])
        var aliases = await Self.runAliases()
        for _ in 0..<50 where aliases != 0 {
            try await Task.sleep(nanoseconds: 100_000_000)
            aliases = await Self.runAliases()
        }

        print("E2E model=\(Self.model) claudeOffered=\(claudeOffered) completed=2 usesContext=\(usesContext) "
              + "stopped=true keptCharsAtStop=\(keptAtStop) grewAfterStop=\(keptLater != keptAtStop) leftoverRunAliases=\(aliases.map(String.init) ?? "unknown")")
        XCTAssertTrue(usesContext, "the second reply named the bakery from the first turn")
        XCTAssertGreaterThan(keptAtStop, 0)
        XCTAssertEqual(keptLater, keptAtStop, "nothing arrived after Stop")
        XCTAssertEqual(aliases, 0, "no open-convo-run alias left in Ollama")
    }
}
