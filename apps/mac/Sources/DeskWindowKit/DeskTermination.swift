import AppKit

/// The app's answer to `applicationShouldTerminate`. With no Desk stack
/// built it is `.terminateNow`, exactly as before the Desk existed. With
/// one, the app waits (`.terminateLater`) while the Desk closes (the page
/// is told, the store releases its writer lock), at most `closeTimeout`
/// seconds, then replies yes. It never asks the person anything, so a
/// logout or restart is never held up by the Desk; whether the page could
/// say its work was saved is only logged (see `reply(for:)`).
///
/// While it waits, `NSApp.terminate` runs a nested run loop in the
/// modal-panel mode inside its caller. The time limit is a run-loop timer
/// in that mode, so it fires even if the caller was a main-queue job,
/// where no main-actor task (the close included) can run until the reply.
@MainActor
public enum DeskTermination {
    nonisolated public static let closeTimeout: TimeInterval = 3

    /// `capReached` runs once, just before the reply, only when the time
    /// limit replies before `close` has finished.
    public static func reply(sessionIsOpen: Bool,
                             close: @escaping @MainActor () async -> Void,
                             timeout: TimeInterval = closeTimeout,
                             capReached: @escaping @MainActor () -> Void = {},
                             replyToApplication: @escaping @MainActor (Bool) -> Void) -> NSApplication.TerminateReply {
        guard sessionIsOpen else { return .terminateNow }
        let once = ReplyOnce(replyToApplication)
        let limit = Timer(timeInterval: max(0, timeout), repeats: false) { _ in
            MainActor.assumeIsolated { once.reply(capReached: capReached) }
        }
        RunLoop.main.add(limit, forMode: .common)
        RunLoop.main.add(limit, forMode: .modalPanel)
        once.limit = limit
        Task { @MainActor in
            await close()
            once.reply()
        }
        return .terminateLater
    }

    /// For the app: closes `session` if it has a stack, then replies to
    /// `NSApp`, within the same time limit. Nobody is asked: a logout,
    /// restart or other quit the person did not start from the menu is
    /// never held up by a question. Unless the menu's Quit already asked
    /// (`pageAlreadyAsked`), the open page is asked first, and only its
    /// answer is logged: `desk.terminate.not-asked page=unsaved-work` or
    /// `page=no-answer` (nothing for a clean page). If the limit comes
    /// first, the app still quits and `desk.terminate.cap-reached` logs
    /// where the page stood: `page=no-answer` when it had not answered.
    public static func reply(for session: DeskSession?,
                             pageAlreadyAsked: Bool = false,
                             timeout: TimeInterval = closeTimeout,
                             replyToApplication: @escaping @MainActor (Bool) -> Void = { NSApplication.shared.reply(toApplicationShouldTerminate: $0) })
        -> NSApplication.TerminateReply {
        guard let session, session.hasStack else { return .terminateNow }
        let page = PageAnswer(pageAlreadyAsked ? "asked-before-quit" : "no-answer")
        return reply(sessionIsOpen: true,
                     close: {
                         if !pageAlreadyAsked {
                             let answer = await session.holdsUnsavedWork()
                             page.name = answer?.logName ?? "nothing-unsaved"
                             if let answer { session.log("desk.terminate.not-asked", "page=\(answer.logName)") }
                         }
                         await session.close()
                     },
                     timeout: timeout,
                     capReached: { session.log("desk.terminate.cap-reached", "limit=\(String(format: "%g", timeout))s page=\(page.name)") },
                     replyToApplication: replyToApplication)
    }

    /// The app's Quit while the Desk is open. Asks the page whether it may
    /// hold unsaved work; then, outside any task, asks `confirmLosingChanges`
    /// with the reason (only when the page holds unsaved work or could not
    /// answer: true means quit and lose them) and runs `quit`, or `kept`
    /// when the answer was Keep. Only a clean page quits without asking.
    ///
    /// Leaving the task matters. An alert's `runModal`, and `NSApp.terminate`
    /// waiting for the `.terminateLater` reply above, run nested run loops
    /// inside their caller. Inside a main-actor task (a main-queue job) such
    /// a loop runs no other main-actor task, so the Desk's close, its lock
    /// and the time limit all waited: Quit with the Desk open hung. A
    /// run-loop block is not a main-queue job, so loops nested in it keep
    /// running main-actor tasks.
    public static func quitAfterAsking(session: DeskSession,
                                       confirmLosingChanges: @escaping @MainActor (DeskUnsavedWork) -> Bool,
                                       kept: @escaping @MainActor (DeskUnsavedWork) -> Void,
                                       quit: @escaping @MainActor () -> Void) {
        Task { @MainActor in
            let unsaved = await session.holdsUnsavedWork()
            RunLoop.main.perform(inModes: [.default]) {
                MainActor.assumeIsolated {
                    if let reason = unsaved, !confirmLosingChanges(reason) {
                        kept(reason)
                        return
                    }
                    quit()
                }
            }
        }
    }

    /// Where the page stood, for the time limit's log line.
    @MainActor
    private final class PageAnswer {
        var name: String
        init(_ name: String) { self.name = name }
    }

    @MainActor
    private final class ReplyOnce {
        private var replied = false
        private let action: @MainActor (Bool) -> Void
        var limit: Timer?
        init(_ action: @escaping @MainActor (Bool) -> Void) { self.action = action }
        func reply(capReached: (@MainActor () -> Void)? = nil) {
            guard !replied else { return }
            replied = true
            capReached?()
            limit?.invalidate()
            limit = nil
            action(true)
        }
    }
}
