import DeskHost
@testable import DeskHostWebKit
import Foundation
import WebKit
import XCTest

/// One ordered record shared by a fake lane, the host's lifecycle
/// checkpoints and the event sink's observer, so a test reads the order in
/// which they happened.
final class WiringJournal: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func note(_ entry: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.append(entry)
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }
}

/// Opened once by the test; every wait on it is bounded and runs off the
/// shared pool, and every wait after the opening returns at once.
final class WiringLatch: @unchecked Sendable {
    private let group = DispatchGroup()
    private let lock = NSLock()
    private var opened = false

    init() { group.enter() }

    func open() {
        lock.lock()
        defer { lock.unlock() }
        guard !opened else { return }
        opened = true
        group.leave()
    }

    /// True when opened within `seconds`.
    func wait(upTo seconds: Double) async -> Bool {
        let group = self.group
        return await withCheckedContinuation { continuation in
            Thread { continuation.resume(returning: group.wait(timeout: .now() + seconds) == .success) }.start()
        }
    }
}

/// Resumes a page script's continuation once: with WebKit's answer, or
/// with `TimedOut` after `seconds`, whichever comes first, so a page script
/// that never answers fails the test instead of stalling it.
final class BoundedPageAnswer: @unchecked Sendable {
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

/// A participant lane that answers every request `ok` and records, in the
/// shared journal, every call the WebKit glue makes on it. Invented: it
/// runs nothing and writes nothing.
final class WiringLane: ParticipantLane, @unchecked Sendable {
    let journal: WiringJournal
    private let lock = NSLock()
    private var epoch = 0
    private var lifecycle = 0
    private var lockNows = 0
    private var requests: [HostRequest] = []
    private var unlockEpochs: [Int] = []
    private var unlocksDone = 0
    private var stepHook: (@Sendable () -> Void)?
    private var unlockHook: (@Sendable () async -> Void)?
    private var finishHook: (@Sendable () -> Void)?
    private var passHook: (@Sendable () -> Void)?
    private var handleHook: (@Sendable (HostRequest) async -> Void)?
    private var passes = 0

    init(journal: WiringJournal) {
        self.journal = journal
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    /// Runs on the caller's thread inside `lockNow()` and
    /// `beginShutdown(quitting:)`, after the journal entry.
    var duringStep: (@Sendable () -> Void)? {
        get { locked { stepHook } }
        set { locked { stepHook = newValue } }
    }
    /// Runs inside `unlock(ifNoLockSince:)` before it ends.
    var duringUnlock: (@Sendable () async -> Void)? {
        get { locked { unlockHook } }
        set { locked { unlockHook = newValue } }
    }
    /// Runs inside `finishShutdown(quitting:)`.
    var duringFinish: (@Sendable () -> Void)? {
        get { locked { finishHook } }
        set { locked { finishHook = newValue } }
    }
    /// Runs inside `reconcileBeforeStoreWork()`.
    var duringPass: (@Sendable () -> Void)? {
        get { locked { passHook } }
        set { locked { passHook = newValue } }
    }
    var reconcilePasses: Int { locked { passes } }
    /// Runs inside `handle(_:)` before it answers (a test holds a call here).
    var duringHandle: (@Sendable (HostRequest) async -> Void)? {
        get { locked { handleHook } }
        set { locked { handleHook = newValue } }
    }

    var handled: [HostRequest] { locked { requests } }
    var lockNowCount: Int { locked { lockNows } }
    var unlockedFrom: [Int] { locked { unlockEpochs } }
    var unlocksEnded: Int { locked { unlocksDone } }

    func handle(_ request: HostRequest) async -> HostResponse {
        locked { requests.append(request) }
        journal.note("lane handle \(request.operation.rawValue)")
        await duringHandle?(request)
        return .ok(request.echo)
    }

    func lockNow() {
        locked {
            epoch += 1
            lifecycle += 1
            lockNows += 1
        }
        journal.note("lane lockNow")
        duringStep?()
    }

    var lockEpoch: Int { locked { epoch } }
    var lifecycleEpoch: Int { locked { lifecycle } }

    func unlock(ifNoLockSince epoch: Int) async {
        locked { unlockEpochs.append(epoch) }
        journal.note("lane unlock \(epoch)")
        await duringUnlock?()
        locked { unlocksDone += 1 }
    }

    func beginShutdown(quitting: Bool) {
        locked { lifecycle += 1 }
        journal.note("lane beginShutdown quitting=\(quitting)")
        duringStep?()
    }

    func finishShutdown(quitting: Bool) async -> ParticipantShutdownReport {
        journal.note("lane finishShutdown quitting=\(quitting)")
        duringFinish?()
        return ParticipantShutdownReport(reachedBound: false, remaining: ParticipantObligations())
    }

    func obligations() async -> ParticipantObligations { ParticipantObligations() }

    func reconcileBeforeStoreWork() async {
        locked { passes += 1 }
        journal.note("lane reconcileBeforeStoreWork")
        duringPass?()
    }
}

/// Plan S11's WebKit wiring, with a fake lane and the invented one-page
/// bundle: `participant.*` reaches a lane only when one is given (a v1 host
/// answers `unknown-operation` with its echo), and the lane's lifecycle
/// steps come before the host's own in lock and close and after it in
/// unlock (participant contract section 14, S10 reading 1), with no new
/// step or hop in lock or unlock. Invented data in a throwaway folder; no
/// coordinator, CLI or credential is involved.
@MainActor
final class ParticipantLaneWiringTests: XCTestCase {
    private static let pin = ParticipantPin(id: "claude-code", label: "Claude Code", model: "invented-pinned-model",
                                            executionHost: "this-mac")!

    private struct Stack {
        let host: DeskWebViewHost
        let store: ProofStore
        let registry: ConnectionRegistry
        let lane: WiringLane?
        let journal: WiringJournal
    }

    private var fixture: BundleFixture!
    private var hosts: [DeskWebViewHost] = []

    override func setUp() async throws {
        fixture = try BundleFixture()
    }

    override func tearDown() async throws {
        for host in hosts where !host.isClosed { await host.close() }
        hosts = []
        fixture?.clean()
    }

    /// A host over its own invented store: with a lane, a participant host
    /// (twelve operations) given that lane; without, the v1 host.
    private func makeStack(withLane: Bool, label: String) throws -> Stack {
        let manifest = try DeskBundleScanner.manifest(forBundleAt: fixture.bundle)
        let resolver = AssetResolver(manifest: manifest, bundleDirectory: fixture.bundle)
        let store = try ProofStore(directory: fixture.root.appendingPathComponent("proof-\(label)", isDirectory: true),
                                   keys: InventedInMemoryKeyProvider())
        let registry = ConnectionRegistry()
        let journal = WiringJournal()
        let sink = WebKitHostEventSink { event in
            switch event {
            case .hostConnection(_, _, let state, let reason):
                journal.note("event \(state.rawValue) \(reason.rawValue)")
            default:
                journal.note("event \(event.type) main=\(Thread.isMainThread)")
            }
        }
        let lane = withLane ? WiringLane(journal: journal) : nil
        let hostProtocol = DeskHostProtocol(store: store, connections: registry, drafts: DraftBindingRegistry(),
                                            info: HostInfo(appVersion: "0.0.0-proof", hostBuild: "lane-wiring"), events: sink,
                                            participants: withLane ? ParticipantHostConfiguration(pin: Self.pin) : nil)
        let host = DeskWebViewHost(hostProtocol: hostProtocol, resolver: resolver, eventSink: sink,
                                   frame: CGRect(x: 0, y: 0, width: 800, height: 600), participantLane: lane)
        hosts.append(host)
        return Stack(host: host, store: store, registry: registry, lane: lane, journal: journal)
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 10, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(what)")
        throw CancellationError()
    }

    /// Loads the invented page and waits until it committed holding the
    /// current connection.
    private func loadPage(_ host: DeskWebViewHost) async throws -> HostConnection {
        host.load()
        try await waitUntil("the invented page to commit holding the current connection", timeout: 15) {
            !host.webView.isLoading && host.documentConnection != nil && host.documentConnection == host.currentConnection
        }
        return try XCTUnwrap(host.currentConnection)
    }

    /// Posts one envelope from the page through `trueConvoHost` and returns
    /// the reply object. The page gives up after five seconds, so this never
    /// waits longer.
    private func post(_ host: DeskWebViewHost, on connection: HostConnection, operation: String, requestId: String,
                      payload: String = "{}", generation: Int? = nil) async throws -> [String: Any] {
        let body = """
        const envelope = { v: 1, requestId: "\(requestId)", connectionId: "\(connection.id)", generation: \(generation ?? connection.generation),
                           operation: "\(operation)", payload: \(payload) };
        const timeout = new Promise(function (resolve) { setTimeout(function () { resolve("timeout"); }, 5000); });
        try {
          const reply = await Promise.race([window.webkit.messageHandlers.trueConvoHost.postMessage(envelope), timeout]);
          return reply === "timeout" ? "timeout" : JSON.stringify(reply);
        } catch (error) {
          return "rejected:" + String(error && error.message ? error.message : error);
        }
        """
        let result: Any? = try await withCheckedThrowingContinuation { continuation in
            host.webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { continuation.resume(with: $0.map { $0 as Any? }) }
        }
        let text = try XCTUnwrap(result as? String)
        let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        return try XCTUnwrap(object, "a reply object, not \(text)")
    }

    private func operations(of reply: [String: Any]) -> [String]? {
        (reply["capabilities"] as? [String: Any])?["operations"] as? [String]
    }

    // MARK: Routing (contract sections 2 and 3)

    func testParticipantRequestsReachTheLaneOnlyWhenOneIsGiven() async throws {
        // With a lane: participant.* goes to it, everything else to the host.
        let wired = try makeStack(withLane: true, label: "lane")
        let lane = try XCTUnwrap(wired.lane)
        let connection = try await loadPage(wired.host)
        let statusId = UUID().uuidString.lowercased()
        let status = try await post(wired.host, on: connection, operation: "participant.status", requestId: statusId)
        XCTAssertEqual(status["outcome"] as? String, "ok")
        XCTAssertEqual(status["requestId"] as? String, statusId)
        XCTAssertEqual(lane.handled.map(\.operation), [.participantStatus])
        XCTAssertEqual(lane.handled.first?.connectionId, connection.id)
        XCTAssertEqual(lane.handled.first?.generation, connection.generation)
        let read = try await post(wired.host, on: connection, operation: "workspace.read", requestId: UUID().uuidString.lowercased(),
                                  payload: #"{ workspaceHandle: "\#(wired.store.workspaceHandle)" }"#)
        XCTAssertEqual(read["outcome"] as? String, "ok", "\(read)")
        let capabilities = try await post(wired.host, on: connection, operation: "host.capabilities", requestId: UUID().uuidString.lowercased())
        XCTAssertEqual(operations(of: capabilities), HostOperation.participantAdvertised.map(\.rawValue))
        XCTAssertEqual(lane.handled.map(\.operation), [.participantStatus], "only participant.* reached the lane")

        // Without one: the v1 host, seven operations, and participant.* is
        // unknown-operation with its echo, as on the byte path.
        let plain = try makeStack(withLane: false, label: "plain")
        XCTAssertNil(plain.host.participantLane)
        XCTAssertFalse(plain.host.hostProtocol.acceptsParticipant)
        let plainConnection = try await loadPage(plain.host)
        let refusedId = UUID().uuidString.lowercased()
        let refused = try await post(plain.host, on: plainConnection, operation: "participant.status", requestId: refusedId)
        XCTAssertEqual(refused["outcome"] as? String, "refused")
        XCTAssertEqual(refused["reason"] as? String, "unknown-operation")
        XCTAssertEqual(refused["requestId"] as? String, refusedId)
        XCTAssertEqual(refused["connectionId"] as? String, plainConnection.id)
        XCTAssertEqual(refused["generation"] as? Int, plainConnection.generation)
        XCTAssertEqual(refused["operation"] as? String, "participant.status")
        let plainCapabilities = try await post(plain.host, on: plainConnection, operation: "host.capabilities",
                                               requestId: UUID().uuidString.lowercased())
        XCTAssertEqual(operations(of: plainCapabilities), HostOperation.advertised.map(\.rawValue))
        XCTAssertEqual(HostOperation.advertised.count, 7)
    }

    // MARK: Commits after the lane's owed writes (S9 ruling c)

    /// A page's `workspace.commitProof` waits for the lane's one bounded
    /// pass of the participant writes it owes before the workspace host
    /// handles it; a commit refused at v1's preflight, and every other
    /// request, never asks for it.
    func testAPageCommitWaitsForTheLanesPassAndNothingElseAsks() async throws {
        let wired = try makeStack(withLane: true, label: "commit")
        let lane = try XCTUnwrap(wired.lane)
        let store = wired.store
        let journal = wired.journal
        lane.duringPass = { journal.note("pass at revision \((try? store.read().revision) ?? -1)") }
        let connection = try await loadPage(wired.host)
        let handle = store.workspaceHandle
        let read = try await post(wired.host, on: connection, operation: "workspace.read", requestId: UUID().uuidString.lowercased(),
                                  payload: #"{ workspaceHandle: "\#(handle)" }"#)
        XCTAssertEqual(read["outcome"] as? String, "ok", "\(read)")
        _ = try await post(wired.host, on: connection, operation: "host.capabilities", requestId: UUID().uuidString.lowercased())
        _ = try await post(wired.host, on: connection, operation: "participant.status", requestId: UUID().uuidString.lowercased())
        XCTAssertEqual(lane.reconcilePasses, 0, "no other request asks for the pass")

        let commit = try await post(wired.host, on: connection, operation: "workspace.commitProof", requestId: UUID().uuidString.lowercased(),
                                    payload: #"{ workspaceHandle: "\#(handle)", expectedRevision: 0, record: { revision: 1, label: "invented" } }"#)
        XCTAssertEqual(commit["outcome"] as? String, "ok", "\(commit)")
        XCTAssertEqual(commit["revision"] as? Int, 1)
        XCTAssertEqual(lane.reconcilePasses, 1)
        XCTAssertTrue(journal.all.contains("pass at revision 0"), "the pass ran before the commit reached the store: \(journal.all)")

        let refused = try await post(wired.host, on: connection, operation: "workspace.commitProof", requestId: UUID().uuidString.lowercased(),
                                     payload: #"{ workspaceHandle: "\#(handle)", expectedRevision: 1, record: { revision: 2, label: "invented" } }"#,
                                     generation: connection.generation + 1)
        XCTAssertEqual(refused["reason"] as? String, "stale-generation", "\(refused)")
        XCTAssertEqual(lane.reconcilePasses, 1, "refused at the preflight: no store work, so no pass")
        XCTAssertEqual(try store.read().revision, 1)
    }

    // MARK: Lock and unlock (section 14, S10 reading 1)

    /// The lane's `lockNow()` runs in `lock()`'s synchronous part: before
    /// the serialized lock step, and even while that step waits behind
    /// another, with exactly one step queued per lock as before.
    func testLockNowRunsBeforeTheSerializedLockStepEvenWhileTheQueueIsHeld() async throws {
        let stack = try makeStack(withLane: true, label: "lock")
        let host = stack.host
        let lane = try XCTUnwrap(stack.lane)
        let journal = stack.journal
        host.lifecycleCheckpoint = { point in journal.note("checkpoint \(point)") }
        var queued = host.lifecycleStepsQueued
        await host.lock()
        XCTAssertEqual(host.lifecycleStepsQueued, queued + 1, "one step per lock, as before")
        XCTAssertEqual(journal.all, ["lane lockNow", "checkpoint lockStepStarted", "checkpoint lockStepLocked"])

        // Hold the queue: an unlock step waits at its first checkpoint.
        let held = WiringLatch()
        defer { held.open() }
        host.lifecycleCheckpoint = { point in
            journal.note("checkpoint \(point)")
            if point == .unlockStepStarted { _ = await held.wait(upTo: 10) }
        }
        let unlock = Task { @MainActor in await host.unlock() }
        try await waitUntil("the unlock step to start") { journal.all.contains("checkpoint unlockStepStarted") }
        queued = host.lifecycleStepsQueued
        let lockNowsBefore = lane.lockNowCount
        let relock = Task { @MainActor in await host.lock() }
        for _ in 0..<200 where host.lifecycleStepsQueued == queued { await Task.yield() }
        XCTAssertEqual(host.lifecycleStepsQueued, queued + 1, "the second lock's step is queued behind the held unlock")
        XCTAssertEqual(lane.lockNowCount, lockNowsBefore + 1, "the lane was locked before that step could run")
        XCTAssertEqual(journal.all.filter { $0 == "checkpoint lockStepStarted" }.count, 1, "the second lock's step has not started")
        held.open()
        await unlock.value
        await relock.value
        host.lifecycleCheckpoint = nil
        XCTAssertTrue(host.isLocked, "the newer lock wins")
        XCTAssertTrue(stack.store.isLocked)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(lane.unlockedFrom, [], "a superseded unlock queues nothing for the lane")
    }

    /// Unlock reads the lane's epoch at its entry and, once its own step
    /// reopened the store, queues the lane's `unlock(ifNoLockSince:)`
    /// without waiting for it: one step, no new hop.
    func testUnlockQueuesTheLanesUnlockWithTheEpochReadAtEntryWithoutWaiting() async throws {
        let stack = try makeStack(withLane: true, label: "unlock")
        let host = stack.host
        let lane = try XCTUnwrap(stack.lane)
        let store = stack.store
        let journal = stack.journal
        await host.lock()
        let entryEpoch = lane.lockEpoch
        let release = WiringLatch()
        defer { release.open() }
        lane.duringUnlock = {
            journal.note("store locked at the lane's unlock: \(store.isLocked)")
            _ = await release.wait(upTo: 10)
        }
        // A lock the host never sees, after the unlock began: the lane must
        // judge the unlock by the epoch read at its entry.
        host.lifecycleCheckpoint = { point in if point == .unlockStepStarted { lane.lockNow() } }
        let queued = host.lifecycleStepsQueued
        let started = Date()
        await host.unlock()
        let returnedAfter = Date().timeIntervalSince(started)
        host.lifecycleCheckpoint = nil
        XCTAssertEqual(host.lifecycleStepsQueued, queued + 1, "one step per unlock, as before")
        XCTAssertFalse(host.isLocked)
        XCTAssertLessThan(returnedAfter, 5, "the host's unlock did not wait for the lane's")
        XCTAssertEqual(lane.unlocksEnded, 0, "the lane's unlock is still held: it was queued, never awaited")
        try await waitUntil("the lane's unlock to be called") { !lane.unlockedFrom.isEmpty }
        XCTAssertEqual(lane.unlockedFrom, [entryEpoch], "the epoch read at the unlock's entry")
        XCTAssertNotEqual(lane.lockEpoch, entryEpoch, "a lock came since, so a real lane stays locked")
        XCTAssertTrue(journal.all.contains("store locked at the lane's unlock: false"), "after the host's step reopened the store")
        release.open()
        try await waitUntil("the lane's unlock to end") { lane.unlocksEnded == 1 }
    }

    // MARK: Close (section 14, S10 reading 1)

    /// With a lane: its `beginShutdown(quitting:)` first, then the host's
    /// revocation, the lane's `finishShutdown(quitting:)` while the store is
    /// still open, and the store's close, in one step. Without: exactly
    /// `DeskHostProtocol.close()`.
    func testCloseRunsTheLaneAndHostStepsInOrder() async throws {
        for quitting in [false, true] {
            let stack = try makeStack(withLane: true, label: "close-\(quitting)")
            let host = stack.host
            let lane = try XCTUnwrap(stack.lane)
            let store = stack.store
            let registry = stack.registry
            let journal = stack.journal
            let connection = await host.beginDocument()
            XCTAssertNotNil(connection, "a live connection, so the revocation is seen")
            lane.duringFinish = {
                journal.note("at finish: store closed \(store.publishedRuns.closed), live connections \(registry.activeConnectionCount)")
            }
            let queued = host.lifecycleStepsQueued
            await host.close(quitting: quitting)
            XCTAssertEqual(host.lifecycleStepsQueued, queued + 1, "one step, as before")
            XCTAssertEqual(journal.all.filter { $0 != "event ready ready" }, [
                "lane beginShutdown quitting=\(quitting)",
                "event revoked shutdown",
                "lane finishShutdown quitting=\(quitting)",
                "at finish: store closed false, live connections 0"
            ])
            XCTAssertTrue(store.publishedRuns.closed, "then the store closed")
            XCTAssertTrue(store.isLocked)
        }

        let plain = try makeStack(withLane: false, label: "close-plain")
        _ = await plain.host.beginDocument()
        await plain.host.close()
        XCTAssertEqual(plain.journal.all.filter { $0 != "event ready ready" }, ["event revoked shutdown"])
        XCTAssertTrue(plain.store.publishedRuns.closed)
    }

    // MARK: Pushes never wait on the main thread (section 8, S10)

    /// The lane's `lockNow()` and `beginShutdown(quitting:)` run on the main
    /// thread and wait for a participant push already under way to return
    /// from the sink. The WebKit sink's `push` hands the event over to the
    /// main thread asynchronously and returns, so such a wait always ends:
    /// here each step blocks the main thread until a push from another
    /// thread, through the host's own sink, has returned.
    func testTheWebKitSinksPushReturnsWhileTheLanesStepHoldsTheMainThread() async throws {
        let stack = try makeStack(withLane: true, label: "push")
        let lane = try XCTUnwrap(stack.lane)
        let sink = stack.host.eventSink
        let waits = Locked<[String]>([])
        lane.duringStep = {
            let onMain = Thread.isMainThread
            let returned = DispatchSemaphore(value: 0)
            Thread {
                sink.push(.participantEvent(connectionId: "51000000-0000-4000-8000-000000000001", generation: 1,
                                            event: .object(["type": .string("text"), "text": .string("invented")])))
                returned.signal()
            }.start()
            let done = returned.wait(timeout: .now() + 2) == .success
            waits.mutate { $0.append("main=\(onMain) returned=\(done)") }
        }
        await stack.host.lock()
        await stack.host.unlock()
        await stack.host.close()
        XCTAssertEqual(waits.value, ["main=true returned=true", "main=true returned=true"], "lockNow, then beginShutdown")
        XCTAssertEqual(stack.journal.all.filter { $0.hasPrefix("event participant.event") },
                       ["event participant.event main=false", "event participant.event main=false"],
                       "the sink saw each push on the pushing thread, before any main-thread hop")
    }

    // MARK: Stale replies and pushes (Codex's S10 carried requirement 3)

    /// Starts one envelope from the page without waiting for its answer:
    /// the page records it in `window.__staleProbe` (`pending`, then the
    /// reply as JSON or `rejected:<message>`).
    private func postWithoutWaiting(_ host: DeskWebViewHost, on connection: HostConnection, operation: String,
                                    requestId: String) async throws {
        let body = """
        window.__staleProbe = "pending";
        const envelope = { v: 1, requestId: "\(requestId)", connectionId: "\(connection.id)", generation: \(connection.generation),
                           operation: "\(operation)", payload: {} };
        window.webkit.messageHandlers.trueConvoHost.postMessage(envelope).then(
          function (reply) { window.__staleProbe = JSON.stringify(reply); },
          function (error) { window.__staleProbe = "rejected:" + String(error && error.message ? error.message : error); });
        return "posted";
        """
        let posted: Any? = try await withCheckedThrowingContinuation { continuation in
            let answer = BoundedPageAnswer(continuation, seconds: 10)
            host.webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { answer.finish($0.map { $0 as Any? }) }
        }
        XCTAssertEqual(posted as? String, "posted")
    }

    private func evaluate(_ host: DeskWebViewHost, _ javaScript: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            let answer = BoundedPageAnswer(continuation, seconds: 10)
            host.webView.evaluateJavaScript(javaScript, in: nil, in: .page) { answer.finish($0.map { $0 as Any? }) }
        }
    }

    /// Reloads the view and waits for the next document to commit holding
    /// a newer connection than `previous`.
    private func reloadPage(_ host: DeskWebViewHost, after previous: HostConnection) async throws -> HostConnection {
        host.reload()
        try await waitUntil("a newer document to commit holding its connection", timeout: 15) {
            guard let current = host.currentConnection, current.generation > previous.generation else { return false }
            return !host.webView.isLoading && host.documentConnection == current
        }
        return try XCTUnwrap(host.currentConnection)
    }

    private static func isReply(_ exchange: HostExchange, to operation: String) -> Bool {
        if case .replied(let replied, _, _, _, _) = exchange { return replied == operation }
        return false
    }

    /// An answer the lane gives after the document that asked was replaced
    /// by a reload is dropped by native: the promise gets only the
    /// content-free transport failure, the observer sees `staleReply`, and
    /// the new document never gets the answer, even through the old
    /// document's callback, which WebKit may still run after the reload
    /// with `window` now the new document's (observed). A call from the new
    /// document is answered as usual. (On e4a748b native handed the answer
    /// to WebKit.)
    func testAnAnswerWhoseDocumentWasReloadedMeanwhileIsDroppedByNative() async throws {
        let stack = try makeStack(withLane: true, label: "stale-reload")
        let host = stack.host
        let lane = try XCTUnwrap(stack.lane)
        var exchanges: [HostExchange] = []
        host.messageHandler.observer = { exchanges.append($0) }
        let first = try await loadPage(host)
        let held = WiringLatch()
        defer { held.open() }
        lane.duringHandle = { request in
            if request.operation == .participantAvailability { _ = await held.wait(upTo: 10) }
        }
        try await postWithoutWaiting(host, on: first, operation: "participant.availability", requestId: UUID().uuidString.lowercased())
        try await waitUntil("the lane to hold the availability call") { lane.handled.contains { $0.operation == .participantAvailability } }
        let second = try await reloadPage(host, after: first)
        XCTAssertNotEqual(second.id, first.id)
        held.open()
        try await waitUntil("the held answer to be dropped") { exchanges.contains(.transportFailure(.staleReply)) }
        XCTAssertFalse(exchanges.contains { Self.isReply($0, to: "participant.availability") }, "no answer was handed to WebKit: \(exchanges)")
        // The old document's own callback can still run after the reload,
        // and its `window` (the WindowProxy) is now the new document's, so
        // it may write there. What it can write is only what native handed
        // over: the content-free transport failure, never the answer.
        let probe = try await evaluate(host, "typeof window.__staleProbe === 'undefined' ? 'none' : String(window.__staleProbe)") as? String
        XCTAssertTrue(["none", "rejected:\(HostMessageHandler.transportError)"].contains(probe ?? "missing"),
                      "the new document never saw the old call's answer: \(probe ?? "missing")")

        lane.duringHandle = nil
        let fresh = try await post(host, on: second, operation: "participant.availability", requestId: UUID().uuidString.lowercased())
        XCTAssertEqual(fresh["outcome"] as? String, "ok", "a call from the live document is answered: \(fresh)")
        XCTAssertEqual(fresh["connectionId"] as? String, second.id)
    }

    /// An availability call already waiting when the window closes (the
    /// lane's stack goes: the close revokes the connection, then the lane
    /// finishes, then the host lets go) is never answered with content: its
    /// answer arrives while the close is still under way and native drops
    /// it. (On e4a748b it was handed to WebKit for the revoked document.)
    func testAnAvailabilityAnswerWaitingAcrossACloseIsDroppedByNative() async throws {
        let stack = try makeStack(withLane: true, label: "stale-close")
        let host = stack.host
        let lane = try XCTUnwrap(stack.lane)
        var exchanges: [HostExchange] = []
        // Signalled once the held call's outcome, whichever it is, was seen.
        let outcomeSeen = DispatchSemaphore(value: 0)
        host.messageHandler.observer = { exchange in
            exchanges.append(exchange)
            if exchange == .transportFailure(.staleReply) || Self.isReply(exchange, to: "participant.availability") { outcomeSeen.signal() }
        }
        let connection = try await loadPage(host)
        let held = WiringLatch()
        defer { held.open() }
        lane.duringHandle = { request in
            if request.operation == .participantAvailability { _ = await held.wait(upTo: 10) }
        }
        try await postWithoutWaiting(host, on: connection, operation: "participant.availability", requestId: UUID().uuidString.lowercased())
        try await waitUntil("the lane to hold the availability call") { lane.handled.contains { $0.operation == .participantAvailability } }
        // Inside the close, after the revocation and before the handler
        // shuts down: the held call is let go, and its outcome comes on the
        // main thread (free: the close is waiting for this step) while the
        // lane's finish waits for it.
        let seenInsideTheClose = Locked<Bool?>(nil)
        lane.duringFinish = {
            held.open()
            seenInsideTheClose.mutate { $0 = outcomeSeen.wait(timeout: .now() + 5) == .success }
        }
        await host.close()
        XCTAssertEqual(seenInsideTheClose.value, true, "the held call's outcome came while the close was under way")
        XCTAssertTrue(exchanges.contains(.transportFailure(.staleReply)), "dropped by native: \(exchanges)")
        XCTAssertFalse(exchanges.contains { Self.isReply($0, to: "participant.availability") }, "no answer was handed to WebKit: \(exchanges)")
        XCTAssertEqual(stack.registry.check(connection.id, generation: connection.generation), .unknownConnection)
    }

    /// A participant push whose connection is gone by the time the sink
    /// delivers it (here, pushed for the document a reload replaced) is
    /// dropped on the main thread, never handed to the new document; a push
    /// for the live document's connection still reaches it, and once the
    /// host locks nothing more does. (On e4a748b the stale push reached the
    /// new document.)
    func testAParticipantPushForAGoneDocumentNeverReachesTheNewOne() async throws {
        let stack = try makeStack(withLane: true, label: "stale-push")
        let host = stack.host
        let sink = host.eventSink
        var dropped: [String] = []
        sink.onParticipantEventDropped = { connectionId, generation in dropped.append("\(connectionId)@\(generation)") }
        let first = try await loadPage(host)
        let second = try await reloadPage(host, after: first)
        _ = try await evaluate(host, """
        window.__pushes = [];
        window.addEventListener('trueconvo-host', function (event) {
          var detail = event.detail || {};
          if (detail.type === 'participant.event') window.__pushes.push(detail.connectionId + '@' + detail.generation + ':' + detail.event.text);
        });
        true
        """)
        func push(_ connection: HostConnection, _ text: String) {
            let pushed = DispatchSemaphore(value: 0)
            Thread {
                sink.push(.participantEvent(connectionId: connection.id, generation: connection.generation,
                                            event: .object(["type": .string("text"), "text": .string(text)])))
                pushed.signal()
            }.start()
            XCTAssertEqual(pushed.wait(timeout: .now() + 2), .success, "push returned without the main thread")
        }
        push(first, "invented stale text")
        push(second, "invented live text")
        try await waitUntil("the stale push to be dropped at delivery") { dropped.count == 1 }
        var seen: [String] = []
        for _ in 0..<100 {
            seen = (try await evaluate(host, "window.__pushes.slice()") as? [String]) ?? []
            if !seen.isEmpty { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(seen, ["\(second.id)@\(second.generation):invented live text"], "only the live document's own push")
        XCTAssertEqual(dropped, ["\(first.id)@\(first.generation)"], "the stale one was dropped at delivery")

        await host.lock()
        push(second, "invented text after the lock")
        try await waitUntil("the push after the lock to be dropped") { dropped.count == 2 }
        let after = (try await evaluate(host, "window.__pushes.slice()") as? [String]) ?? []
        XCTAssertEqual(after, seen, "nothing reached the locked page")
    }


    // MARK: Once a lock or close began (S11 follow-through review, F1 and F4)

    /// Reads `window.__staleProbe` until it is no longer `pending`, for at
    /// most two seconds.
    private func settledProbe(_ host: DeskWebViewHost) async throws -> String? {
        var probe: String?
        for _ in 0..<100 {
            probe = try await evaluate(host, "typeof window.__staleProbe === 'undefined' ? 'none' : String(window.__staleProbe)") as? String
            if probe != "pending" { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        return probe
    }

    /// The page records every participant push it receives in
    /// `window.__pushes`.
    private func installPushListener(_ host: DeskWebViewHost) async throws {
        _ = try await evaluate(host, """
        window.__pushes = [];
        window.addEventListener('trueconvo-host', function (event) {
          var detail = event.detail || {};
          if (detail.type === 'participant.event') window.__pushes.push(detail.connectionId + '@' + detail.generation);
        });
        true
        """)
    }

    private func pagePushes(_ host: DeskWebViewHost) async throws -> [String]? {
        try await evaluate(host, "window.__pushes.slice()") as? [String]
    }

    /// Pushes one invented participant text event for `connection` through
    /// `sink` from another thread; true when the push returned within two
    /// seconds (it never needs the main thread).
    private nonisolated static func pushFromAnotherThread(_ sink: WebKitHostEventSink, _ connection: HostConnection,
                                                          _ text: String) -> Bool {
        let pushed = DispatchSemaphore(value: 0)
        Thread {
            sink.push(.participantEvent(connectionId: connection.id, generation: connection.generation,
                                        event: .object(["type": .string("text"), "text": .string(text)])))
            pushed.signal()
        }.start()
        return pushed.wait(timeout: .now() + 2) == .success
    }

    /// An answer to a request admitted before a lock or a window close
    /// began at the lane, ready after that but before the host's own step
    /// (the Desk session's menu lock and its window close leave that step
    /// to a task), is dropped by native although its connection is still
    /// valid and the host is not yet marked locked or closed: the lane's
    /// `lifecycleEpoch` moved. The asking page gets only the content-free
    /// transport failure. A request admitted after the lane's step is
    /// answered. (On the follow-through's first candidate the answer
    /// reached the page.)
    func testAnAnswerReadyAfterTheLanesLockOrCloseBeganIsDroppedBeforeTheHostsStep() async throws {
        for step in ["lockNow", "beginShutdown"] {
            let stack = try makeStack(withLane: true, label: "lane-step-\(step)")
            let host = stack.host
            let lane = try XCTUnwrap(stack.lane)
            var exchanges: [HostExchange] = []
            host.messageHandler.observer = { exchanges.append($0) }
            let connection = try await loadPage(host)
            let held = WiringLatch()
            defer { held.open() }
            lane.duringHandle = { request in
                if request.operation == .participantStatus { _ = await held.wait(upTo: 10) }
            }
            try await postWithoutWaiting(host, on: connection, operation: "participant.status", requestId: UUID().uuidString.lowercased())
            try await waitUntil("\(step): the lane to hold the call") { lane.handled.contains { $0.operation == .participantStatus } }
            // What the Desk session does first, synchronously; the host's
            // own step comes later, in a task.
            if step == "lockNow" { lane.lockNow() } else { lane.beginShutdown(quitting: false) }
            XCTAssertFalse(host.isLocked || host.isClosed, "\(step): the host's own step has not begun")
            XCTAssertEqual(stack.registry.check(connection.id, generation: connection.generation), .valid,
                           "\(step): the connection is still valid")
            held.open()
            try await waitUntil("\(step): the held answer to be dropped") { exchanges.contains(.transportFailure(.staleReply)) }
            XCTAssertFalse(exchanges.contains { Self.isReply($0, to: "participant.status") },
                           "\(step): no answer was handed to WebKit: \(exchanges)")
            let probe = try await settledProbe(host)
            XCTAssertEqual(probe, "rejected:\(HostMessageHandler.transportError)", "\(step): the asking page got the fixed failure only")

            lane.duringHandle = nil
            let after = try await post(host, on: connection, operation: "participant.status", requestId: UUID().uuidString.lowercased())
            XCTAssertEqual(after["outcome"] as? String, "ok", "\(step): a request admitted after the lane's step is answered: \(after)")
        }
    }

    /// The host's own flag, alone: its lock step is held before it revokes
    /// anything, and the lane's epoch does not move (the caller is taken to
    /// have locked the lane already). An answer ready then is dropped
    /// because the host is locked, and a participant push for the live,
    /// still valid connection is dropped at delivery for the same reason;
    /// nothing reaches the page. (Before the fix the answer reached the
    /// page; without the sink's flag check the push would.)
    func testWhileTheHostsLockStepIsHeldNoAnswerOrPushReachesThePage() async throws {
        let stack = try makeStack(withLane: true, label: "host-flag")
        let host = stack.host
        let lane = try XCTUnwrap(stack.lane)
        let sink = host.eventSink
        var exchanges: [HostExchange] = []
        host.messageHandler.observer = { exchanges.append($0) }
        var dropped: [ConnectionCheck] = []
        sink.onParticipantEventDropped = { connectionId, generation in
            dropped.append(stack.registry.check(connectionId, generation: generation))
        }
        let connection = try await loadPage(host)
        try await installPushListener(host)
        let held = WiringLatch()
        defer { held.open() }
        lane.duringHandle = { request in
            if request.operation == .participantStatus { _ = await held.wait(upTo: 10) }
        }
        try await postWithoutWaiting(host, on: connection, operation: "participant.status", requestId: UUID().uuidString.lowercased())
        try await waitUntil("the lane to hold the call") { lane.handled.contains { $0.operation == .participantStatus } }

        let stepHeld = WiringLatch()
        defer { stepHeld.open() }
        var reachedStep = false
        host.lifecycleCheckpoint = { point in
            guard point == .lockStepStarted else { return }
            reachedStep = true
            _ = await stepHeld.wait(upTo: 10)
        }
        let epochBefore = lane.lifecycleEpoch
        let lockDone = Locked(false)
        Task {
            await host.lock(laneLockedByCaller: true)
            lockDone.mutate { $0 = true }
        }
        try await waitUntil("the host's lock step to be held") { reachedStep }
        XCTAssertTrue(host.isLocked)
        XCTAssertEqual(lane.lifecycleEpoch, epochBefore, "the lane's epoch did not move")
        XCTAssertEqual(stack.registry.check(connection.id, generation: connection.generation), .valid, "nothing revoked yet")

        held.open()
        try await waitUntil("the held answer to be dropped") { exchanges.contains(.transportFailure(.staleReply)) }
        XCTAssertFalse(exchanges.contains { Self.isReply($0, to: "participant.status") }, "no answer was handed to WebKit: \(exchanges)")
        XCTAssertTrue(Self.pushFromAnotherThread(sink, connection, "invented text while the host locks"))
        try await waitUntil("the push to be dropped at delivery") { dropped.count == 1 }
        XCTAssertEqual(dropped, [.valid], "dropped by the host's flag while the connection was still valid")

        stepHeld.open()
        try await waitUntil("the lock step to finish") { lockDone.value }
        host.lifecycleCheckpoint = nil
        let seen = try await pagePushes(host)
        XCTAssertEqual(seen, [], "nothing reached the page")
    }

    /// A participant push handed to the sink once the host's lock or close
    /// has begun but before its step revoked anything (here from inside the
    /// lane's own step, on the main thread) is dropped at delivery by the
    /// host's flag: the connection is still valid when it is dropped.
    /// (Without the flag check in `deliversParticipantEvent` it reached the
    /// page.)
    func testAPushQueuedAsTheHostLocksOrClosesIsDroppedByTheHostsFlag() async throws {
        for step in ["lock", "close"] {
            let stack = try makeStack(withLane: true, label: "push-\(step)")
            let host = stack.host
            let lane = try XCTUnwrap(stack.lane)
            let sink = host.eventSink
            var dropped: [ConnectionCheck] = []
            sink.onParticipantEventDropped = { connectionId, generation in
                dropped.append(stack.registry.check(connectionId, generation: generation))
            }
            let connection = try await loadPage(host)
            try await installPushListener(host)
            let returned = Locked<Bool?>(nil)
            lane.duringStep = { returned.mutate { $0 = Self.pushFromAnotherThread(sink, connection, "invented text at the \(step)") } }
            if step == "lock" { await host.lock() } else { await host.close() }
            lane.duringStep = nil
            XCTAssertEqual(returned.value, true, "\(step): the push returned without the main thread")
            try await waitUntil("\(step): the push to be dropped at delivery") { dropped.count == 1 }
            XCTAssertEqual(dropped, [.valid], "\(step): dropped by the host's flag, before its step revoked the connection")
            if step == "lock" {
                let seen = try await pagePushes(host)
                XCTAssertEqual(seen, [], "lock: nothing reached the page")
            }
        }
    }
}
