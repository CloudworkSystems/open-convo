#if DEBUG
import AppKit
@testable import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
@testable import ParticipantAppWiring
@testable import ParticipantProcess
import TrueConvoIdentity

// The Claude Code adapter's PR 5: the real quit path (the contract's F0
// answer 22; docs/plans/claude-code-owner-trial.md, Part 1, item 2).
//
//   ClaudeConversationProofHost --real-quit <application-support> <keys-folder> <supervisor> <cli>
//
// A real AppKit app, composed as True Convo Test composes its Desk: the
// app's own `ClaudeConversation` (section 17's owner over an invented
// passing check, the production launcher with the real supervisor and the
// test's fake CLI), `LocalConversationLane.factory(for: .test, claude:)`,
// the app's `DeskSession` over a kept store and an invented one-page Desk in
// a real `WKWebView`, and the app's own quit: the menu's
// `DeskTermination.quitAfterAsking`, then `NSApp.terminate(nil)`, whose
// `applicationShouldTerminate` answers with `DeskTermination.reply(for:)`,
// so the quit runs inside `NSApp.terminate`'s own nested wait. Invented
// text only; the CLI is never the real one.
//
// Prints `store <folder>` and `ready` once the Desk is open and its page
// holds its connection, and every Desk log line as `log <event> <detail>`
// (identities only). Commands, one per line on stdin:
//   approve        approves Anthropic in the Desk's store: `approved <bool>`
//   confirm        the owner's paid-usage confirmation: `confirm <outcome>`
//   prepare        the turn as a prepared Claude run: `prepared <runId>`
//   start <runId>  `start <outcome> <reason|->`
//   quit           the app's Quit: `terminating` just before
//                  `NSApp.terminate(nil)`, `will-terminate` as AppKit ends
//                  the app, then the process exits

/// The Desk's owner check as an invented yes.
final class InventedUnlock: DeskUnlockVerifier {
    func verify(reason: String) async -> DeskUnlockVerdict { .verified }
}

@MainActor
final class RealQuitApp: NSObject, NSApplicationDelegate {
    let session: DeskSession
    let claude: ClaudeConversation
    let storeFolder: URL
    /// As the app's: set once the menu's Quit asked about the Desk.
    private var quitAskedAboutDesk = false
    private var connection: HostConnection?
    private var revision = 0
    private var runs: [JSONValue] = []

    init(session: DeskSession, claude: ClaudeConversation, storeFolder: URL) {
        self.session = session
        self.claude = claude
        self.storeFolder = storeFolder
    }

    // As the app's delegate answers.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        DeskTermination.reply(for: session, pageAlreadyAsked: quitAskedAboutDesk)
    }

    func applicationWillTerminate(_ notification: Notification) {
        claude.appWillQuit()
        say("will-terminate")
    }

    /// Opens the Desk as the owner's unlock does, waits for the invented
    /// page to hold its connection, then reads commands.
    func open() async {
        await session.unlock(verifier: InventedUnlock())
        guard session.state == .open, let host = session.host, let store = session.store else { fail("open: \(session.state)") }
        let deadline = Date().addingTimeInterval(30)
        while host.webView.isLoading || host.currentConnection == nil || host.documentConnection != host.currentConnection {
            guard Date() < deadline else { fail("the invented page never held its connection") }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        connection = host.currentConnection
        do {
            let committed = try store.read()
            revision = committed.revision
            if case .array(let saved)? = committed.record["conversationRuns"] { runs = saved }
        } catch {
            fail("read: \(error)")
        }
        say("store \(storeFolder.path)")
        say("ready")
        for await line in commandLines() {
            let words = line.split(separator: " ").map(String.init)
            switch (words.first, words.count) {
            case ("approve"?, 1):
                say("approved \((try? store.approveHost(HostApproval.anthropic)) != nil)")
            case ("confirm"?, 1):
                say("confirm \(await claude.owner.confirm())")
            case ("prepare"?, 1):
                do { say("prepared \(try await prepare(store))") } catch { fail("prepare: \(error)") }
            case ("start"?, 2):
                say(startLine(await start(words[1], store)))
            case ("quit"?, 1):
                quit()
            default:
                fail("unknown command \(line)")
            }
        }
    }

    /// The app's menu Quit with the Desk open, as `quit()` there does it.
    private func quit() {
        DeskTermination.quitAfterAsking(
            session: session,
            confirmLosingChanges: { _ in true },
            kept: { reason in say("kept \(reason.logName)") },
            quit: { [weak self] in
                self?.quitAskedAboutDesk = true
                say("terminating")
                NSApp.terminate(nil)
            })
    }

    /// As the app's WebKit handler routes a page request.
    private func ask(_ operation: HostOperation, _ payload: [String: JSONValue]) async -> HostResponse {
        guard let connection, let host = session.host, let lane = session.participantLane else { fail("no open Desk") }
        let request = HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation,
                                  operation: operation, payload: payload)
        if request.operation.isParticipant { return await lane.handle(request) }
        if request.operation.waitsForOwedParticipantWrites { await lane.reconcileBeforeStoreWork(ahead: request, host: host.hostProtocol) }
        return await host.hostProtocol.handle(request)
    }

    /// One prepared Claude run of the invented message, saved with its
    /// claim, as the page's Send saves it.
    private func prepare(_ store: ProofStore) async throws -> String {
        let run = Page.prepared(Invented.runId, user: "72abcdef-0000-4000-8abc-000000000a02",
                                assistant: "73abcdef-0000-4000-8abc-000000000a02", input: Invented.input,
                                context: [], at: Invented.createdAt)
        let next = runs + [.object(run)]
        var claim: [String: JSONValue] = ["participantId": .string(Invented.pin.id)]
        for key in ["runId", "sessionId", "userMessageId", "assistantMessageId", "createdAt"] { claim[key] = run[key] }
        let reply = await ask(.workspaceCommitProof, [
            "workspaceHandle": .string(store.workspaceHandle), "expectedRevision": .number(Double(revision)),
            "record": .object(["schemaVersion": .number(2), "revision": .number(Double(revision + 1)),
                               "conversationRuns": .array(next)]),
            "participantRun": .object(claim)])
        guard reply.outcome == .ok else { throw PageError.save(String(decoding: reply.canonicalData(), as: UTF8.self)) }
        revision += 1
        runs = next
        return Invented.runId
    }

    private func start(_ runId: String, _ store: ProofStore) async -> HostResponse? {
        guard let run = runs.first(where: { $0.objectValue?["runId"] == .string(runId) })?.objectValue else { return nil }
        var payload: [String: JSONValue] = ["workspaceHandle": .string(store.workspaceHandle)]
        for key in ["runId", "sessionId", "userMessageId", "assistantMessageId", "participant", "inputChunks"] {
            payload[key] = run[key]
        }
        return await ask(.participantStart, payload)
    }
}

@MainActor
enum RealQuit {
    /// Kept for the life of the app: `NSApplication.delegate` is weak.
    static var app: RealQuitApp?

    static func start(_ arguments: [String]) {
        let support = URL(fileURLWithPath: arguments[2], isDirectory: true)
        let keys = InventedFileKeys(folder: URL(fileURLWithPath: arguments[3], isDirectory: true))
        let paths = DeskPaths(applicationSupport: support, identity: .test)
        // The invented one-page Desk, as the tests' fixture writes it.
        let page = support.appendingPathComponent("invented-desk", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: page, withIntermediateDirectories: true)
            try Data("<!doctype html><title>invented</title><main>Invented one-page Desk</main>".utf8)
                .write(to: page.appendingPathComponent("index.html"))
        } catch {
            fail("page: \(error)")
        }
        guard let bundle = DeskBundleLocation.developmentFolder(page) else { fail("the invented page") }
        // As `ClaudeConversation.make` does: the participants folder under
        // the Desk's own invented-data folder.
        let parent: ParticipantsParent
        do { parent = try ParticipantsFolder.prepare(in: try paths.prepareBase()) } catch { fail("participants: \(error)") }
        let approvals = CurrentStoreApproval()
        let owner = PaidUsageConfirmationOwner(checks: InventedPassingChecks(), approval: approvals, authentication: InventedOwnerYes())
        let launcher = ProcessParticipantLauncher(supervisorPath: arguments[4], cliPath: arguments[5], workingParent: parent,
                                                  expectedInit: Invented.expectedInit)
        // End observers on private centers: a lock on the runner's Mac must
        // not end this proof's confirmation.
        let claude = ClaudeConversation(owner: owner, approvals: approvals, launcher: launcher,
                                        signals: PaidUsageEndSignals(owner: owner, distributedCenter: NotificationCenter(),
                                                                     workspaceCenter: NotificationCenter()))
        let session = DeskSession(paths: paths, bundle: bundle,
                                  info: HostInfo(appVersion: "invented-proof-version", hostBuild: "invented-proof-build"),
                                  storage: .kept(keys), log: { event, detail in say("log \(event) \(detail)") },
                                  makeParticipantLane: LocalConversationLane.factory(for: .test, claude: claude))
        claude.follow(session)
        let delegate = RealQuitApp(session: session, claude: claude,
                                   storeFolder: paths.base.appendingPathComponent(DeskPaths.keptStoreFolderName, isDirectory: true))
        app = delegate
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApplication.shared.delegate = delegate
        Task { @MainActor in await delegate.open() }
    }
}

/// The `--real-quit` mode: never returns (AppKit ends the process).
func runRealQuitProof(_ arguments: [String]) -> Never {
    guard arguments.count == 6 else { fail("usage: --real-quit <application-support> <keys-folder> <supervisor> <cli>") }
    MainActor.assumeIsolated { RealQuit.start(arguments) }
    NSApplication.shared.run()
    exit(0)
}
#endif
