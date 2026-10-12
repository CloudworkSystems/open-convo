import AppKit
import DeskHost

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
///
/// A session with a participant lane (plan S11; inactive: the app's has
/// none) quits by Codex Q33 instead, with or without a Desk window: see
/// `reply(for:)`.
@MainActor
public enum DeskTermination {
    nonisolated public static let closeTimeout: TimeInterval = 3
    /// A quit's one overall maximum while any participant obligation exists
    /// (Codex Q33): `ParticipantLimits.shutdownMillis`, 17 s, from the
    /// quit's own `beginShutdown(quitting: true)`.
    nonisolated public static let participantTimeout: TimeInterval = TimeInterval(ParticipantLimits.shutdownMillis) / 1000

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
        once.limits = [limit]
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
    ///
    /// With a participant lane, before anything else and before returning
    /// `.terminateLater`, the lane's `beginShutdown(quitting: true)` runs
    /// here, synchronously (Codex Q33: main-actor tasks may not run inside
    /// `NSApp.terminate`'s nested loop): every run is sent `stop`, and no
    /// start is admitted from here. Then the lane's `obligations()` decide
    /// the one limit: `participantTimeout` from now whenever anything is
    /// owed (starting, live, stopping, cleanup-pending or writes pending),
    /// with or without a Desk window; `timeout`, the plain path, only once
    /// the lane said nothing is (when that answer comes after `timeout`, as
    /// soon as it comes). Never both added, never one per step.
    /// The Desk closes as a quit (`DeskSession.close(quitting: true)`),
    /// then the lane's own quit wait runs within the same bound, and the
    /// app gets its one yes when that ends or at the limit, whatever is
    /// unfinished.
    public static func reply(for session: DeskSession?,
                             pageAlreadyAsked: Bool = false,
                             timeout: TimeInterval = closeTimeout,
                             participantTimeout: TimeInterval = DeskTermination.participantTimeout,
                             replyToApplication: @escaping @MainActor (Bool) -> Void = { NSApplication.shared.reply(toApplicationShouldTerminate: $0) })
        -> NSApplication.TerminateReply {
        guard let session else { return .terminateNow }
        if let lane = session.participantLane {
            return replyWithParticipants(session: session, lane: lane, pageAlreadyAsked: pageAlreadyAsked, timeout: timeout,
                                         participantTimeout: participantTimeout, replyToApplication: replyToApplication)
        }
        guard session.hasStack else { return .terminateNow }
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

    /// The quit of a session with a participant lane (Codex Q33).
    private static func replyWithParticipants(session: DeskSession, lane: any DeskParticipantLane, pageAlreadyAsked: Bool,
                                              timeout: TimeInterval, participantTimeout: TimeInterval,
                                              replyToApplication: @escaping @MainActor (Bool) -> Void) -> NSApplication.TerminateReply {
        lane.beginShutdown(quitting: true)
        let log = session.log
        let page = PageAnswer(pageAlreadyAsked ? "asked-before-quit" : "no-answer")
        let owed = OwedAnswer()
        let once = ReplyOnce(replyToApplication)
        func capReached(_ seconds: TimeInterval) -> @MainActor () -> Void {
            { log("desk.terminate.cap-reached", "limit=\(String(format: "%g", seconds))s page=\(page.name)") }
        }
        // From the quit's begin, just above: the limit whenever something is
        // owed, and until the lane says whether it is.
        let participantLimit = Timer(timeInterval: max(0, participantTimeout), repeats: false) { _ in
            MainActor.assumeIsolated { once.reply(capReached: capReached(participantTimeout)) }
        }
        // The plain path, only once the lane said nothing is owed: at
        // `timeout`, or as soon as that answer comes after it (looked at
        // again every 50 ms until it comes); never once it said something
        // is. A run-loop timer, so it fires in terminate's nested wait too.
        let plainLimit = Timer(fire: Date(timeIntervalSinceNow: max(0, timeout)), interval: 0.05, repeats: true) { timer in
            MainActor.assumeIsolated {
                switch owed.isEmpty {
                case true?: once.reply(capReached: capReached(timeout))
                case false?: timer.invalidate()
                case nil: break
                }
            }
        }
        for timer in [participantLimit, plainLimit] {
            RunLoop.main.add(timer, forMode: .common)
            RunLoop.main.add(timer, forMode: .modalPanel)
        }
        once.limits = [participantLimit, plainLimit]
        // Off the main actor, so the answer comes even while terminate's wait
        // runs no main-actor task. Read after the quit's begin: no start is
        // admitted from there, so none can begin after this choice.
        Task.detached {
            let obligations = await lane.obligations()
            owed.set(isEmpty: obligations.isEmpty)
            let chosen = obligations.isEmpty ? timeout : participantTimeout
            log("desk.terminate.participants", "owed=\(!obligations.isEmpty) limit=\(String(format: "%g", chosen))s")
        }
        Task { @MainActor in
            if !pageAlreadyAsked {
                let answer = await session.holdsUnsavedWork()
                page.name = answer?.logName ?? "nothing-unsaved"
                if let answer { session.log("desk.terminate.not-asked", "page=\(answer.logName)") }
            }
            await session.close(quitting: true)
            // The lane's own quit wait: with no window, or after a window
            // close under way, too. Within the same bound; calling again
            // never extends it.
            _ = await lane.finishShutdown(quitting: true)
            once.reply()
        }
        return .terminateLater
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

    /// Whether the participant lane owes nothing, once it said; set off the
    /// main actor.
    private final class OwedAnswer: @unchecked Sendable {
        private let lock = NSLock()
        private var answer: Bool?
        /// Nil until `obligations()` answered.
        var isEmpty: Bool? {
            lock.lock()
            defer { lock.unlock() }
            return answer
        }
        func set(isEmpty: Bool) {
            lock.lock()
            defer { lock.unlock() }
            answer = isEmpty
        }
    }

    @MainActor
    private final class ReplyOnce {
        private var replied = false
        private let action: @MainActor (Bool) -> Void
        var limits: [Timer] = []
        init(_ action: @escaping @MainActor (Bool) -> Void) { self.action = action }
        func reply(capReached: (@MainActor () -> Void)? = nil) {
            guard !replied else { return }
            replied = true
            capReached?()
            limits.forEach { $0.invalidate() }
            limits = []
            action(true)
        }
    }
}
