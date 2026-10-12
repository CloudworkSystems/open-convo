import AppKit
import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
@testable import ParticipantCoordinator
@testable import ParticipantProcess
import WebKit
import XCTest

// Plan S11's follow-through (Codex's S10 carried requirements 1-5): the
// real `ParticipantCoordinator` driven through the WebKit glue and the Desk
// session, with scripted runs on the virtual clock (never the real CLI),
// invented data in throwaway folders, and every wait bounded.

/// A throwaway folder for one test: an invented Application Support folder
/// for the Desk session, and a one-page invented Desk bundle (no handshake)
/// for tests that need a web view but not the real page.
struct InventedDeskFolder {
    let root: URL

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("CoordinatorDesk-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    var paths: DeskPaths { DeskPaths(applicationSupport: root.appendingPathComponent("Application Support", isDirectory: true)) }

    private var fixtureFolder: URL { root.appendingPathComponent("fixture-desk", isDirectory: true) }

    private func writeFixture() throws {
        try FileManager.default.createDirectory(at: fixtureFolder, withIntermediateDirectories: true)
        try Data("<!doctype html><title>invented</title><main>Invented fixture Desk</main>".utf8)
            .write(to: fixtureFolder.appendingPathComponent("index.html"))
    }

    /// The one-page invented Desk, as the session finds a bundle.
    func fixtureBundle() throws -> DeskBundleLocation {
        try writeFixture()
        return try XCTUnwrap(DeskBundleLocation.developmentFolder(fixtureFolder))
    }

    /// The one-page invented Desk, as a `DeskWebViewHost` serves it.
    func fixtureResolver() throws -> AssetResolver {
        try writeFixture()
        return AssetResolver(manifest: try DeskBundleScanner.manifest(forBundleAt: fixtureFolder), bundleDirectory: fixtureFolder)
    }

    func clean() { try? FileManager.default.removeItem(at: root) }
}

/// Moves a virtual world's clock along with real time (from `start()`, at
/// `rate` virtual milliseconds per real one), on its own thread, so scripted
/// runs, their 250 ms text emission, their supervisors' stop sequences and
/// the coordinator's wake-ups all happen while a real web view and the app's
/// own timers run. The only caller of `advance` while it runs. `stop()`
/// waits at most five seconds for the thread to end.
final class RealTimePump: @unchecked Sendable {
    private let world: VirtualWorld
    private let rate: UInt64
    private let lock = NSLock()
    private var running = false
    private var errors: [String] = []
    private let ended = DispatchSemaphore(value: 0)

    init(world: VirtualWorld, rate: UInt64 = 1) {
        self.world = world
        self.rate = rate
    }

    private var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return running
    }

    /// What the world refused while pumping (a test fails on any).
    var failures: [String] {
        lock.lock(); defer { lock.unlock() }
        return errors
    }

    func start() {
        lock.lock()
        running = true
        lock.unlock()
        let began = DispatchTime.now().uptimeNanoseconds
        let base = world.now
        let world = self.world
        let rate = self.rate
        Thread { [self] in
            while isRunning {
                let elapsed = (DispatchTime.now().uptimeNanoseconds - began) / 1_000_000 * rate
                do {
                    try world.advance(to: max(world.now, base + elapsed))
                } catch {
                    lock.lock(); errors.append("\(error)"); lock.unlock()
                }
                Thread.sleep(forTimeInterval: 0.01)
            }
            ended.signal()
        }.start()
    }

    func stop() {
        lock.lock()
        let wasRunning = running
        running = false
        lock.unlock()
        if wasRunning { _ = ended.wait(timeout: .now() + 5) }
    }
}

/// Holds the next participant push inside the sink's observer (on the
/// pushing thread, with the coordinator's push gate held), until released
/// or ten seconds pass, and records, in order, what happened around it.
final class PushHold: @unchecked Sendable {
    private let lock = NSLock()
    private var armed = false
    private var held = 0
    private var lines: [String] = []
    private let releaseSignal = DispatchSemaphore(value: 0)

    func arm() {
        lock.lock(); defer { lock.unlock() }
        armed = true
    }

    /// Pushes held so far.
    var heldCount: Int {
        lock.lock(); defer { lock.unlock() }
        return held
    }

    var entered: Bool { heldCount > 0 }

    var journal: [String] {
        lock.lock(); defer { lock.unlock() }
        return lines
    }

    func note(_ line: String) {
        lock.lock(); defer { lock.unlock() }
        lines.append(line)
    }

    /// Releases the held push after `seconds`, from its own thread.
    func release(after seconds: Double) {
        let signal = releaseSignal
        Thread {
            Thread.sleep(forTimeInterval: seconds)
            signal.signal()
        }.start()
    }

    /// Called by a sink's observer for every pushed participant event.
    func pushing() {
        lock.lock()
        let holds = armed
        armed = false
        if holds {
            held += 1
            lines.append("push held main=\(Thread.isMainThread)")
        }
        lock.unlock()
        guard holds else { return }
        let released = releaseSignal.wait(timeout: .now() + 10) == .success
        note("push returned released=\(released)")
    }
}

/// The Desk session's log, collected from any thread. With a `hold`, the
/// sink's own observer line for a participant event (`desk.host.event
/// type=participant.event`) is where a push under way is held.
final class DeskLines: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    let hold = PushHold()

    var log: DeskSession.Log {
        { [self] event, detail in
            lock.lock()
            lines.append(detail.isEmpty ? event : "\(event) \(detail)")
            lock.unlock()
            if event == "desk.host.event", detail.hasPrefix("type=participant.event") { hold.pushing() }
        }
    }

    var all: [String] {
        lock.lock(); defer { lock.unlock() }
        return lines
    }

    /// Participant pushes the session's sink saw for a document generation.
    func participantPushes(generation: Int) -> Int {
        all.filter { $0 == "desk.host.event type=participant.event generation=\(generation)" }.count
    }

    var participantPushes: Int { all.filter { $0.hasPrefix("desk.host.event type=participant.event") }.count }
}

enum CoordinatorDesk {
    static let pin = ParticipantPin(id: "claude-code", label: "Claude Code", model: "invented-pinned-model", executionHost: "this-mac")!
    static let info = HostInfo(appVersion: "0.0.0-test", hostBuild: "coordinator-desk")

    /// Availability that says available, with no confirmation: built here,
    /// through `@testable import`, the only way to that answer.
    static var available: any AvailabilityReporting {
        SeededAvailability(seeded: ParticipantAvailabilityReport(availability: .available, confirmation: nil))
    }

    /// A real coordinator for one invented launch: the pin the page's
    /// vectors use, writes on the background executor, runs from
    /// `launcher`, time and wake-ups from `world`.
    static func coordinator(world: VirtualWorld, launcher: any ParticipantLaunching,
                            availability: any AvailabilityReporting = available) -> ParticipantCoordinator {
        ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
            hostConfiguration: ParticipantHostConfiguration(pin: pin), availability: availability,
            launchId: UUID().uuidString.lowercased(), clock: world.clock, executor: BackgroundMutationExecutor(),
            launcher: launcher, log: RecordingLog(), wakeups: VirtualWakeups(world: world), confirmation: nil))
    }

    /// A world whose wall clock starts now, so the times a run records
    /// follow the page's own.
    static func world() -> VirtualWorld {
        VirtualWorld(wallAtStart: Int64(Date().timeIntervalSince1970 * 1000))
    }

    /// A participant request from `connection`, as the page sends it.
    static func request(_ operation: HostOperation, _ payload: [String: JSONValue], on connection: HostConnection) -> HostRequest {
        HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation, operation: operation,
                    payload: payload)
    }
}

/// Bounded waits and page access for the coordinator's WebKit and session
/// tests.
@MainActor
class CoordinatorDeskTestCase: XCTestCase {
    /// Polls `condition` every 20 ms until it holds or `timeout` passes,
    /// then fails with `what` (and `detail`, when given).
    func eventually(_ what: String, timeout: TimeInterval = 15, detail: (() async -> String)? = nil,
                    _ condition: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try await condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        if try await condition() { return }
        let extra = await detail?() ?? ""
        XCTFail("timed out waiting for \(what)\(extra.isEmpty ? "" : ": \(extra)")")
        throw CancellationError()
    }

    /// Runs a page script; fails with `PageScriptAnswer.TimedOut` if WebKit
    /// gives no answer within `timeout`.
    func evaluate(_ webView: WKWebView, _ javaScript: String, timeout: TimeInterval = 10) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            let answer = PageScriptAnswer(continuation, seconds: timeout)
            webView.evaluateJavaScript(javaScript, in: nil, in: .page) { answer.finish($0.map { $0 as Any? }) }
        }
    }

    /// The same, for an async function body with arguments.
    func call(_ webView: WKWebView, _ body: String, _ arguments: [String: Any] = [:], timeout: TimeInterval = 10) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            let answer = PageScriptAnswer(continuation, seconds: timeout)
            webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { answer.finish($0.map { $0 as Any? }) }
        }
    }

    /// Runs `operation` (a session, host or termination step) in a
    /// main-actor task and waits at most `timeout` for it to end, so a step
    /// that never ends fails the test instead of hanging the runner.
    @discardableResult
    func bounded<T>(_ what: String, timeout: TimeInterval = 25, _ operation: @escaping @MainActor () async -> T) async throws -> T {
        let outcome = StepOutcome<T>()
        Task { @MainActor in outcome.value = await operation() }
        try await eventually(what, timeout: timeout) { outcome.value != nil }
        return try XCTUnwrap(outcome.value)
    }
}

/// What a bounded step returned, once it ended.
@MainActor
final class StepOutcome<T> {
    var value: T?
}

/// Resumes a page script's continuation once: with WebKit's answer, or
/// with `TimedOut` after `seconds`, whichever comes first.
final class PageScriptAnswer: @unchecked Sendable {
    struct TimedOut: Error, CustomStringConvertible {
        let seconds: TimeInterval
        var description: String { "the page script gave no answer within \(seconds) s" }
    }

    private let lock = NSLock()
    private var continuation: CheckedContinuation<Any?, Error>?

    init(_ continuation: CheckedContinuation<Any?, Error>, seconds: TimeInterval) {
        self.continuation = continuation
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [self] in finish(.failure(TimedOut(seconds: seconds))) }
    }

    func finish(_ result: Result<Any?, Error>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(with: result)
    }
}

/// Holds the owner check open until the test answers it, standing in for
/// the password or Touch ID prompt being on screen.
@MainActor
final class HeldOwnerCheck: DeskUnlockVerifier {
    private var pending: CheckedContinuation<DeskUnlockVerdict, Never>?
    private var asked = 0
    var isWaiting: Bool { pending != nil }

    /// Answers `.refused` by itself after twenty seconds if the test has
    /// not answered that check, so a test that never answers cannot hang.
    func verify(reason: String) async -> DeskUnlockVerdict {
        asked += 1
        let check = asked
        return await withCheckedContinuation { continuation in
            pending = continuation
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.asked == check else { return }
                    self.answer(.refused)
                }
            }
        }
    }

    func answer(_ verdict: DeskUnlockVerdict) {
        pending?.resume(returning: verdict)
        pending = nil
    }
}
