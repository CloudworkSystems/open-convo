import AppKit
import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
import XCTest

/// Opened once by the test; every wait on it is bounded and runs off the
/// shared pool, and every wait after the opening returns at once.
final class FakeLaneLatch: @unchecked Sendable {
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

    func wait(upTo seconds: Double) async -> Bool {
        let group = self.group
        return await withCheckedContinuation { continuation in
            Thread { continuation.resume(returning: group.wait(timeout: .now() + seconds) == .success) }.start()
        }
    }
}

/// A launch-scoped participant lane for the Desk session, invented: it
/// builds each stack's participant host, checks an attach the way the
/// coordinator does (`isParticipantHost`), records every call in order, and
/// runs, writes and spends nothing.
final class FakeDeskLane: ParticipantLane, ParticipantStackAttaching, @unchecked Sendable {
    struct Attachment {
        let host: DeskHostProtocol
        let store: ProofStore
        let connections: ConnectionRegistry
        let sink: HostEventSink
    }

    struct Refused: Error {}

    static let pin = ParticipantPin(id: "claude-code", label: "Claude Code", model: "invented-pinned-model", executionHost: "this-mac")!

    let configuration = ParticipantHostConfiguration(pin: FakeDeskLane.pin)
    private let lock = NSLock()
    private var entries: [String] = []
    private var epoch = 0
    private var lifecycle = 0
    private var lockNows = 0
    private var quitBegan = false
    private var made: [(host: DeskHostProtocol, events: HostEventSink)] = []
    private var attachments: [Attachment] = []
    private var refuses = false
    private var owes = ParticipantObligations()
    private var finishLatch: FakeLaneLatch?
    private var attachLatch: FakeLaneLatch?
    private var lockNowHook: (@Sendable () -> Void)?
    private var finishHook: (@Sendable () -> Void)?
    private var detachHook: (@Sendable () -> Void)?
    private var passHook: (@Sendable () -> Void)?
    private var unlockLatch: FakeLaneLatch?
    private var obligationsLatch: FakeLaneLatch?
    private var refusesInShutdown = false

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func note(_ entry: String) { locked { entries.append(entry) } }
    var journal: [String] { locked { entries } }
    var lockNowCount: Int { locked { lockNows } }
    var builtHosts: [(host: DeskHostProtocol, events: HostEventSink)] { locked { made } }
    var attached: [Attachment] { locked { attachments } }

    /// The next attaches throw.
    var refusesAttach: Bool {
        get { locked { refuses } }
        set { locked { refuses = newValue } }
    }
    /// What `obligations()` answers once the quit began; before it, nothing,
    /// so a quit that read it first would take the plain path.
    var owedOnceQuitBegan: ParticipantObligations {
        get { locked { owes } }
        set { locked { owes = newValue } }
    }
    /// `attach` waits (bounded) until this opens, before it decides.
    var attachHold: FakeLaneLatch? {
        get { locked { attachLatch } }
        set { locked { attachLatch = newValue } }
    }
    /// `finishShutdown(quitting:)` waits (bounded) until this opens.
    var finishHold: FakeLaneLatch? {
        get { locked { finishLatch } }
        set { locked { finishLatch = newValue } }
    }
    var duringLockNow: (@Sendable () -> Void)? {
        get { locked { lockNowHook } }
        set { locked { lockNowHook = newValue } }
    }
    var duringFinish: (@Sendable () -> Void)? {
        get { locked { finishHook } }
        set { locked { finishHook = newValue } }
    }
    var duringDetach: (@Sendable () -> Void)? {
        get { locked { detachHook } }
        set { locked { detachHook = newValue } }
    }
    /// Runs inside `reconcileBeforeStoreWork()`, after its journal entry.
    var duringPass: (@Sendable () -> Void)? {
        get { locked { passHook } }
        set { locked { passHook = newValue } }
    }
    /// `unlock(ifNoLockSince:)` waits (bounded) until this opens, after its
    /// journal entry, and notes `unlock ended` once it does.
    var unlockHold: FakeLaneLatch? {
        get { locked { unlockLatch } }
        set { locked { unlockLatch = newValue } }
    }
    /// `obligations()` waits (bounded) until this opens.
    var obligationsHold: FakeLaneLatch? {
        get { locked { obligationsLatch } }
        set { locked { obligationsLatch = newValue } }
    }
    /// As the coordinator does (`AttachError.shuttingDown`): an attach that
    /// decides after a `beginShutdown` with no detach since refuses.
    var refusesAttachDuringShutdown: Bool {
        get { locked { refusesInShutdown } }
        set { locked { refusesInShutdown = newValue } }
    }
    private var shuttingDown = false

    func makeHost(store: ProofStore, connections: ConnectionRegistry, drafts: DraftBindingRegistry, info: HostInfo,
                  events: HostEventSink) -> DeskHostProtocol {
        note("makeHost")
        let host = DeskHostProtocol(store: store, connections: connections, drafts: drafts, info: info, events: events,
                                    participants: configuration)
        locked { made.append((host, events)) }
        return host
    }

    func attach(host: DeskHostProtocol, store: ProofStore, connections: ConnectionRegistry, sink: HostEventSink) async throws {
        note("attach")
        if let attachHold { _ = await attachHold.wait(upTo: 10) }
        guard !refusesAttach, !(refusesAttachDuringShutdown && locked({ shuttingDown })),
              host.isParticipantHost(store: store, connections: connections, configuration: configuration) else {
            throw Refused()
        }
        locked { attachments.append(Attachment(host: host, store: store, connections: connections, sink: sink)) }
    }

    func detach() async {
        locked { shuttingDown = false }
        note("detach")
        duringDetach?()
    }

    func handle(_ request: HostRequest) async -> HostResponse {
        note("handle \(request.operation.rawValue)")
        return .ok(request.echo)
    }

    func lockNow() {
        locked {
            epoch += 1
            lifecycle += 1
            lockNows += 1
        }
        note("lockNow")
        duringLockNow?()
    }

    var lockEpoch: Int { locked { epoch } }
    var lifecycleEpoch: Int { locked { lifecycle } }

    func unlock(ifNoLockSince epoch: Int) async {
        note("unlock \(epoch)")
        if let unlockHold {
            _ = await unlockHold.wait(upTo: 10)
            note("unlock ended")
        }
    }

    func beginShutdown(quitting: Bool) {
        locked {
            lifecycle += 1
            shuttingDown = true
            if quitting { quitBegan = true }
        }
        note("beginShutdown quitting=\(quitting)")
    }

    func finishShutdown(quitting: Bool) async -> ParticipantShutdownReport {
        note("finishShutdown quitting=\(quitting)")
        duringFinish?()
        if let finishHold { _ = await finishHold.wait(upTo: 10) }
        return ParticipantShutdownReport(reachedBound: false, remaining: ParticipantObligations())
    }

    func obligations() async -> ParticipantObligations {
        note("obligations")
        if let obligationsHold { _ = await obligationsHold.wait(upTo: 10) }
        return locked { quitBegan ? owes : ParticipantObligations() }
    }

    func reconcileBeforeStoreWork() async {
        note("reconcileBeforeStoreWork")
        duringPass?()
    }
}

/// Plan S11's Desk-session wiring with a fake lane and the invented
/// one-page Desk: one lane for the whole run (Codex Q21), each stack built
/// by it and attached with its own sink (Codex S7), the lane locked first
/// in every state, attached then unlocked after a verified unlock (S10
/// reading 1, S9 ruling c), closed in the lane's order, and the quit's one
/// participant bound (Codex Q33). The app's session has no lane and
/// advertises seven operations. Invented data in throwaway folders.
@MainActor
final class DeskSessionParticipantTests: XCTestCase {
    private func makeLaneSession(_ folder: DeskTestFolder, lane: FakeDeskLane, logs: DeskLogCollector = DeskLogCollector(),
                                 made: @escaping @MainActor () -> Void = {}) throws -> DeskSession {
        DeskSession(paths: folder.paths, bundle: try folder.fixtureBundle(), info: HostInfo(appVersion: "0.0.0-test", hostBuild: "unit-desk-lane"),
                    log: logs.log, makeParticipantLane: { made(); return lane })
    }

    private func sameLane(_ session: DeskSession, _ lane: FakeDeskLane) -> Bool {
        (session.participantLane as? FakeDeskLane) === lane
    }

    /// The operations the host advertises to its current page.
    private func advertisedOperations(_ host: DeskWebViewHost) async throws -> [String] {
        try await waitUntil("the invented page to commit holding the current connection", timeout: 15) {
            !host.webView.isLoading && host.currentConnection != nil && host.documentConnection == host.currentConnection
        }
        let connection = try XCTUnwrap(host.currentConnection)
        let envelope = #"{"v":1,"requestId":"\#(UUID().uuidString.lowercased())","connectionId":"\#(connection.id)","generation":\#(connection.generation),"operation":"host.capabilities","payload":{}}"#
        let reply = await host.hostProtocol.handle(data: Data(envelope.utf8))
        XCTAssertEqual(reply.outcome, .ok)
        guard case .array(let operations) = reply.fields["capabilities"]?.objectValue?["operations"] else {
            XCTFail("no operations in \(reply.jsonValue)")
            return []
        }
        return operations.compactMap(\.stringValue)
    }

    // MARK: Inactive by default (contract section 2)

    func testTheDefaultSessionHasNoLaneAndAdvertisesSevenOperations() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let session = makeSession(folder, bundle: try folder.fixtureBundle())
        XCTAssertNil(session.participantLane)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        XCTAssertNil(session.participantLane, "no factory, no lane")
        let host = try XCTUnwrap(session.host)
        XCTAssertNil(host.participantLane)
        XCTAssertFalse(host.hostProtocol.acceptsParticipant)
        let operations = try await advertisedOperations(host)
        XCTAssertEqual(operations, HostOperation.advertised.map(\.rawValue))
        XCTAssertEqual(operations.count, 7)
        await session.close()
    }

    /// The app makes its one session without a lane, and the only thing in
    /// Sources that conforms to the stack attachment a lane needs is the
    /// coordinator (Codex's S10 carried requirement 1), which nothing in
    /// the app constructs (ProcessLauncherTests' gates; comments aside).
    func testTheAppGivesItsSessionNoLane() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let files = try XCTUnwrap(FileManager.default.subpaths(atPath: sources.path)).filter { $0.hasSuffix(".swift") }
        XCTAssertGreaterThan(files.count, 20, "the scan sees the package's sources")
        var lines: [(file: String, line: String)] = []
        for relative in files {
            let text = try String(contentsOf: sources.appendingPathComponent(relative), encoding: .utf8)
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                let code = line.trimmingCharacters(in: .whitespaces)
                if !code.hasPrefix("//") { lines.append((relative, code)) }
            }
        }
        let sessions = lines.filter { $0.line.contains("DeskSession(") }
        XCTAssertEqual(sessions.map(\.file), ["VoiceCursorMac/main.swift"], "the app's one session")
        XCTAssertFalse(sessions.contains { $0.line.contains("makeParticipantLane") }, "made without a lane")
        XCTAssertEqual(Set(lines.filter { $0.line.contains("makeParticipantLane") }.map(\.file)), ["DeskWindowKit/DeskSession.swift"],
                       "only the session names its factory")
        let conformance = try NSRegularExpression(pattern: #"[:,]\s*(ParticipantStackAttaching|DeskParticipantLane)\b"#)
        let conforming = lines.filter { conformance.firstMatch(in: $0.line, range: NSRange($0.line.startIndex..., in: $0.line)) != nil }
        XCTAssertEqual(conforming.map(\.file), ["ParticipantCoordinator/ParticipantCoordinator.swift"],
                       "only the coordinator can be attached to a Desk stack")
        XCTAssertEqual(conforming.map(\.line), ["public actor ParticipantCoordinator: ParticipantLane, ParticipantStackAttaching {"])
    }

    // MARK: One lane per run (Codex Q21)

    func testAReopenInTheSameLaunchKeepsTheSameLane() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        var made = 0
        let session = try makeLaneSession(folder, lane: lane, made: { made += 1 })
        XCTAssertNil(session.participantLane, "made with the first stack, not before")
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        XCTAssertTrue(sameLane(session, lane))
        let first = try XCTUnwrap(session.host)
        XCTAssertTrue((first.participantLane as? FakeDeskLane) === lane)

        await session.close()
        XCTAssertEqual(session.state, .closed)
        XCTAssertTrue(sameLane(session, lane), "kept with no window")
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        let second = try XCTUnwrap(session.host)
        XCTAssertFalse(second === first, "a new stack")
        XCTAssertTrue((second.participantLane as? FakeDeskLane) === lane, "the same lane")

        await session.lock(reason: .menu)
        await session.close()
        XCTAssertEqual(session.state, .lockedNoStack)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        XCTAssertTrue((session.host?.participantLane as? FakeDeskLane) === lane)
        XCTAssertEqual(made, 1, "one lane for the run")
        XCTAssertEqual(lane.attached.count, 3)
        XCTAssertEqual(Set(lane.attached.map { ObjectIdentifier($0.store) }).count, 3, "a new store each time")
        XCTAssertEqual(Set(lane.attached.map(\.store.directory)).count, 1, "over the same folder")
        XCTAssertEqual(lane.journal.filter { $0 == "detach" }.count, 2, "each closed stack let go")
        await session.close()
    }

    /// Codex S7: the lane is attached with the stack's own host, store,
    /// registry and sink, and the host was built pushing through that sink.
    func testTheStacksOwnSinkIsTheOneAttached() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let session = try makeLaneSession(folder, lane: lane)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let host = try XCTUnwrap(session.host)
        let attachment = try XCTUnwrap(lane.attached.last)
        XCTAssertTrue((attachment.sink as? WebKitHostEventSink) === host.eventSink, "the stack's own sink")
        XCTAssertTrue(attachment.host === host.hostProtocol)
        XCTAssertTrue(attachment.store === session.store)
        XCTAssertTrue(attachment.host.isParticipantHost(store: attachment.store, connections: attachment.connections,
                                                        configuration: lane.configuration))
        let built = try XCTUnwrap(lane.builtHosts.last)
        XCTAssertTrue(built.host === host.hostProtocol)
        XCTAssertTrue((built.events as? WebKitHostEventSink) === host.eventSink, "built pushing through the same sink")
        let operations = try await advertisedOperations(host)
        XCTAssertEqual(operations, HostOperation.participantAdvertised.map(\.rawValue))
        await session.close()
    }

    // MARK: Lock (section 14, S10 reading 1)

    /// `beginLock` locks the lane synchronously in every state, before the
    /// host's own lock step (which `lockNow(reason:)` leaves to a task), and
    /// that step does not lock it again: one lane lock per lock request
    /// (S11 reading 3, as changed for Codex's S10 carried requirement 4).
    func testBeginLockLocksTheLaneFirstInEveryState() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try makeLaneSession(folder, lane: lane, logs: logs)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let host = try XCTUnwrap(session.host)
        host.lifecycleCheckpoint = { point in lane.note("checkpoint \(point)") }

        // Open.
        var count = lane.lockNowCount
        session.lockNow(reason: .menu)
        XCTAssertEqual(lane.lockNowCount, count + 1, "before lockNow(reason:) returned, while the host's step waits in a task")
        XCTAssertEqual(session.state, .locked)
        try await waitUntil("the host's lock step") { host.isLocked && lane.journal.contains("checkpoint lockStepLocked") }
        let journal = lane.journal
        let started = try XCTUnwrap(journal.firstIndex(of: "checkpoint lockStepStarted"))
        XCTAssertEqual(journal.filter { $0 == "lockNow" }.count, 1, "the session's lockNow only; the host's step does not repeat it")
        XCTAssertEqual(journal[..<started].filter { $0 == "lockNow" }.count, 1, "and it came before the host's step")
        host.lifecycleCheckpoint = nil

        // Locked, with nothing unlocking.
        count = lane.lockNowCount
        session.lockNow(reason: .screenLocked)
        XCTAssertEqual(lane.lockNowCount, count + 1)

        // Locked, with an unlock asking the owner: the lock wins.
        let held = HeldVerifier()
        let unlocking = Task { await session.unlock(verifier: held) }
        try await waitUntil("the owner check") { held.isWaiting }
        count = lane.lockNowCount
        session.lockNow(reason: .screenLocked)
        XCTAssertEqual(lane.lockNowCount, count + 1)
        held.answer(.verified)
        await unlocking.value
        XCTAssertEqual(session.state, .locked)

        // Closed.
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        await session.close()
        XCTAssertEqual(session.state, .closed)
        count = lane.lockNowCount
        session.lockNow(reason: .willSleep)
        XCTAssertEqual(lane.lockNowCount, count + 1)
        XCTAssertEqual(session.state, .lockedNoStack)

        // Locked with no stack.
        count = lane.lockNowCount
        session.lockNow(reason: .screensSlept)
        XCTAssertEqual(lane.lockNowCount, count + 1)

        // Unavailable: the lane refused the next stack, which never showed
        // and whose store let its writer lock go.
        lane.refusesAttach = true
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        guard case .unavailable = session.state else { return XCTFail("\(session.state)") }
        XCTAssertNil(session.host)
        XCTAssertTrue(logs.all.contains("desk.open.failed reason=participants-attach"), "\(logs.all)")
        let runFolder = try XCTUnwrap(session.runFolder)
        let writer = WriterLockHolder(folder: runFolder)
        XCTAssertNotNil(writer, "the refused stack's store is closed")
        writer?.release()
        count = lane.lockNowCount
        XCTAssertTrue(session.respondsToLockSignals, "with a lane, every state takes the Mac's lock signals")
        session.lockNow(reason: .sessionResigned)
        XCTAssertEqual(lane.lockNowCount, count + 1)
    }

    /// Codex S10: the lane's `lockNow()` runs on the main thread and may wait
    /// there for a push already under way through the attached sink. The
    /// session's own sink returns from `push` without the main thread.
    func testTheLanesLockMayHoldTheMainThreadWhileAPushThroughTheSessionsSinkReturns() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try makeLaneSession(folder, lane: lane, logs: logs)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let sink = try XCTUnwrap(lane.attached.last?.sink)
        let waits = FakeLaneWaits()
        lane.duringLockNow = {
            let onMain = Thread.isMainThread
            let returned = DispatchSemaphore(value: 0)
            Thread {
                sink.push(.participantEvent(connectionId: "51000000-0000-4000-8000-000000000001", generation: 1,
                                            event: .object(["type": .string("text"), "text": .string("invented")])))
                returned.signal()
            }.start()
            waits.add("main=\(onMain) returned=\(returned.wait(timeout: .now() + 2) == .success)")
        }
        await session.lock(reason: .menu)
        XCTAssertEqual(waits.all, ["main=true returned=true"], "the session's lockNow, the one lane lock for this request")
        XCTAssertEqual(logs.all.filter { $0 == "desk.host.event type=participant.event generation=1" }.count, 1,
                       "the session's own sink saw the push (identifiers only)")
        await session.close()
    }

    // MARK: Unlock (section 14, S10 reading 1; S9 ruling c)

    func testAVerifiedUnlockAttachesThenUnlocksTheLane() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let session = try makeLaneSession(folder, lane: lane)

        // First open: built, attached, then the new lane's unlock at its
        // own first epoch.
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(lane.journal, ["makeHost", "attach", "unlock 0", "reconcileBeforeStoreWork"],
                       "the lane's unlock and its pass, both done before the open returned")

        // Reopen after a lock and a close: the epoch is read when the owner
        // check begins, so a lock that lands while the owner is asked keeps
        // a real lane locked.
        await session.lock(reason: .menu)
        await session.close()
        XCTAssertEqual(session.state, .lockedNoStack)
        let held = HeldVerifier()
        let unlocking = Task { await session.unlock(verifier: held) }
        try await waitUntil("the owner check") { held.isWaiting }
        let atStart = lane.lockEpoch
        lane.lockNow()
        let attachesBefore = lane.attached.count
        held.answer(.verified)
        await unlocking.value
        XCTAssertEqual(session.state, .open)
        XCTAssertEqual(lane.attached.count, attachesBefore + 1)
        try await waitUntil("the lane's unlock") { lane.journal.contains("unlock \(atStart)") }
        let journal = lane.journal
        XCTAssertLessThan(try XCTUnwrap(journal.lastIndex(of: "attach")), try XCTUnwrap(journal.lastIndex(of: "unlock \(atStart)")),
                          "attached first, then unlocked")
        XCTAssertNotEqual(lane.lockEpoch, atStart, "a lock came since that epoch")

        // A kept locked stack: the host's unlock step, then the lane's, with
        // the epoch read when the owner check began (S11 reading 4, as
        // replaced by the follow-through).
        await session.lock(reason: .lockButton)
        let beforeUnlock = lane.lockEpoch
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        try await waitUntil("the lane's unlock") { lane.journal.contains("unlock \(beforeUnlock)") }

        // Reopening a closed Desk asks nobody, so it unlocks nothing.
        await session.close()
        XCTAssertEqual(session.state, .closed)
        let unlocks = lane.journal.filter { $0.hasPrefix("unlock ") }.count
        await session.unlock(verifier: StubUnlockVerifier())
        XCTAssertEqual(session.state, .open)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(lane.journal.filter { $0.hasPrefix("unlock ") }.count, unlocks)
        XCTAssertEqual(Array(lane.journal.suffix(2)), ["attach", "reconcileBeforeStoreWork"])
        await session.close()
    }

    /// A window close that lands while the stack is being attached: the
    /// attached stack is let go in the close order and never shown. A lock
    /// that lands there keeps the new stack locked, and the lane's unlock
    /// carries the epoch from before that lock.
    func testACloseOrLockDuringTheAttachIsHonoured() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try makeLaneSession(folder, lane: lane, logs: logs)

        let closing = FakeLaneLatch()
        defer { closing.open() }
        lane.attachHold = closing
        let abandoned = Task { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        try await waitUntil("the attach") { lane.journal.contains("attach") }
        await session.close()
        closing.open()
        await abandoned.value
        XCTAssertNil(session.host, "nothing shown")
        XCTAssertEqual(session.state, .lockedNoStack)
        XCTAssertEqual(lane.journal, ["makeHost", "attach", "beginShutdown quitting=false", "finishShutdown quitting=false", "detach"])
        XCTAssertTrue(logs.all.contains("desk.open.abandoned reason=window-closed"), "\(logs.all)")
        let writer = WriterLockHolder(folder: try XCTUnwrap(session.runFolder))
        XCTAssertNotNil(writer, "the abandoned stack's store is closed")
        writer?.release()

        let locking = FakeLaneLatch()
        defer { locking.open() }
        lane.attachHold = locking
        let atStart = lane.lockEpoch
        let opening = Task { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        try await waitUntil("the second attach") { lane.journal.filter { $0 == "attach" }.count == 2 }
        session.lockNow(reason: .screenLocked)
        locking.open()
        await opening.value
        XCTAssertEqual(session.state, .locked, "opened, but locked")
        let host = try XCTUnwrap(session.host)
        try await waitUntil("the host's lock") { host.isLocked }
        try await waitUntil("the lane's unlock") { lane.journal.contains("unlock \(atStart)") }
        XCTAssertGreaterThan(lane.lockEpoch, atStart, "a lock came since that epoch, so a real lane stays locked")
        await session.close()
    }

    // MARK: Close (section 14, S10 reading 1)

    /// The lane's `beginShutdown` first, the host's revocation, the lane's
    /// `finishShutdown` while the store is open, the store's close, then
    /// the lane's detach. A second close while the first runs waits for it.
    func testCloseRunsTheLaneStepsThenDetachesOnce() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try makeLaneSession(folder, lane: lane, logs: logs)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let store = try XCTUnwrap(session.store)
        lane.duringFinish = { lane.note("at finish: store closed \(store.publishedRuns.closed)") }
        lane.duringDetach = { lane.note("at detach: store closed \(store.publishedRuns.closed)") }
        let hold = FakeLaneLatch()
        defer { hold.open() }
        lane.finishHold = hold
        let before = lane.journal.count
        let first = Task { await session.close() }
        try await waitUntil("the lane's finish") { lane.journal.contains("finishShutdown quitting=false") }
        let second = Task { await session.close() }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(session.state, .open, "both closes wait for the lane's finish")
        hold.open()
        await first.value
        await second.value
        XCTAssertEqual(session.state, .closed)
        XCTAssertEqual(Array(lane.journal[before...]), [
            "beginShutdown quitting=false", "beginShutdown quitting=false", "finishShutdown quitting=false",
            "at finish: store closed false", "detach", "at detach: store closed true"
        ], "the session's step, the host's repeat, the finish, then the detach once the store closed")
        XCTAssertEqual(logs.all.filter { $0.hasPrefix("desk.closed") }, ["desk.closed locked=false"])
    }

    // MARK: Quit (Codex Q33)

    private func open(_ folder: DeskTestFolder, lane: FakeDeskLane, logs: DeskLogCollector) async throws -> DeskSession {
        let session = try makeLaneSession(folder, lane: lane, logs: logs)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        session.unsavedWorkCheck = { nil }
        return session
    }

    private static var oneLiveRun: ParticipantObligations {
        var owed = ParticipantObligations()
        owed.live = 1
        return owed
    }

    func testTheQuitBoundsAreSeventeenAndThreeSeconds() {
        XCTAssertEqual(DeskTermination.participantTimeout, 17)
        XCTAssertEqual(DeskTermination.participantTimeout, TimeInterval(ParticipantLimits.shutdownMillis) / 1000)
        XCTAssertEqual(DeskTermination.closeTimeout, 3)
    }

    /// Owed work (read after the quit's own synchronous begin) takes the
    /// participant bound, not the plain one: the reply comes at it.
    func testAQuitWithParticipantWorkOwedTakesTheParticipantBound() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try await open(folder, lane: lane, logs: logs)
        lane.owedOnceQuitBegan = Self.oneLiveRun
        let hold = FakeLaneLatch()
        defer { hold.open() }
        lane.finishHold = hold
        var replies: [Bool] = []
        let started = Date()
        let answer = DeskTermination.reply(for: session, timeout: 1.0, participantTimeout: 1.2, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater)
        // Only the synchronous call can have made this entry yet: the main
        // actor has not been given up since the reply.
        XCTAssertTrue(lane.journal.contains("beginShutdown quitting=true"), "synchronously, before the reply was returned")
        try await waitUntil("the participant bound's reply", timeout: 6) { !replies.isEmpty }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertGreaterThanOrEqual(elapsed, 1.2, "not the plain path's 1 s")
        XCTAssertLessThan(elapsed, 2.1, "one limit, never the two added (2.2 s)")
        XCTAssertEqual(replies, [true])
        let journal = lane.journal
        XCTAssertLessThan(try XCTUnwrap(journal.firstIndex(of: "beginShutdown quitting=true")), try XCTUnwrap(journal.firstIndex(of: "obligations")))
        XCTAssertTrue(journal.contains("finishShutdown quitting=true"), "the stack closed as a quit")
        XCTAssertTrue(logs.all.contains("desk.terminate.participants owed=true limit=1.2s"), "\(logs.all)")
        XCTAssertTrue(logs.all.contains("desk.terminate.cap-reached limit=1.2s page=nothing-unsaved"), "\(logs.all)")
        hold.open()
        try await waitUntil("the close to finish") { session.state == .closed }
        XCTAssertEqual(replies, [true], "exactly one yes")
    }

    /// The same with no Desk window: a lane that still owes work keeps the
    /// participant bound, and the quit waits on the lane itself.
    func testAQuitWithNoWindowStillTakesTheParticipantBoundWhenWorkIsOwed() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try await open(folder, lane: lane, logs: logs)
        await session.close()
        XCTAssertFalse(session.hasStack)
        lane.owedOnceQuitBegan = Self.oneLiveRun
        let hold = FakeLaneLatch()
        defer { hold.open() }
        lane.finishHold = hold
        var replies: [Bool] = []
        let started = Date()
        let answer = DeskTermination.reply(for: session, timeout: 0.3, participantTimeout: 1.2, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater, "no window, but work is owed")
        XCTAssertTrue(lane.journal.contains("beginShutdown quitting=true"), "synchronously")
        try await waitUntil("the participant bound's reply", timeout: 6) { !replies.isEmpty }
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 1.2)
        XCTAssertTrue(lane.journal.contains("finishShutdown quitting=true"), "the quit's own wait on the lane")
        XCTAssertTrue(logs.all.contains("desk.terminate.participants owed=true limit=1.2s"), "\(logs.all)")
        XCTAssertTrue(logs.all.contains("desk.terminate.cap-reached limit=1.2s page=nothing-unsaved"), "\(logs.all)")
        XCTAssertEqual(replies, [true])
    }

    /// Nothing owed: the plain path's limit, even while the close is stuck.
    func testAQuitWithNothingOwedTakesThePlainBound() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try await open(folder, lane: lane, logs: logs)
        let hold = FakeLaneLatch()
        defer { hold.open() }
        lane.finishHold = hold
        var replies: [Bool] = []
        let started = Date()
        let answer = DeskTermination.reply(for: session, timeout: 0.3, participantTimeout: 5, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater)
        try await waitUntil("the plain bound's reply", timeout: 6) { !replies.isEmpty }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertGreaterThanOrEqual(elapsed, 0.3)
        XCTAssertLessThan(elapsed, 2, "not the participant bound")
        XCTAssertTrue(logs.all.contains("desk.terminate.participants owed=false limit=0.3s"), "\(logs.all)")
        XCTAssertTrue(logs.all.contains("desk.terminate.cap-reached limit=0.3s page=nothing-unsaved"), "\(logs.all)")
        hold.open()
        try await waitUntil("the close to finish") { session.state == .closed }
        XCTAssertEqual(replies, [true])
    }

    /// Nothing owed and no window: the quit replies as soon as the lane's
    /// wait ends, well inside the plain limit.
    func testAQuitWithNothingOwedAndNoWindowRepliesPromptly() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try await open(folder, lane: lane, logs: logs)
        await session.close()
        var replies: [Bool] = []
        let started = Date()
        let answer = DeskTermination.reply(for: session, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater)
        try await waitUntil("the reply", timeout: 5) { !replies.isEmpty }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        XCTAssertEqual(replies, [true])
        XCTAssertFalse(logs.all.contains { $0.hasPrefix("desk.terminate.cap-reached") }, "\(logs.all)")
        try await waitUntil("the lane's answer to be logged") { logs.all.contains("desk.terminate.participants owed=false limit=3s") }
    }

    /// With the default limits: owed work is not cut at three seconds (the
    /// participant bound, 17 s, is chosen); once the lane's wait ends the
    /// app gets its yes without reaching any limit.
    func testWithDefaultLimitsOwedWorkOutlastsThePlainThreeSeconds() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try await open(folder, lane: lane, logs: logs)
        lane.owedOnceQuitBegan = Self.oneLiveRun
        let hold = FakeLaneLatch()
        defer { hold.open() }
        lane.finishHold = hold
        var replies: [Bool] = []
        let answer = DeskTermination.reply(for: session, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater)
        try await waitUntil("the lane's answer to be logged") { logs.all.contains("desk.terminate.participants owed=true limit=17s") }
        try await Task.sleep(nanoseconds: 3_500_000_000)
        XCTAssertEqual(replies, [], "still waiting past the plain three seconds")
        hold.open()
        try await waitUntil("the reply once the lane's wait ends", timeout: 5) { !replies.isEmpty }
        XCTAssertEqual(replies, [true])
        XCTAssertFalse(logs.all.contains { $0.hasPrefix("desk.terminate.cap-reached") }, "\(logs.all)")
        XCTAssertEqual(session.state, .closed)
    }

    /// Codex Q33 and review finding LC-1: inside a busy main-queue job no
    /// main-actor task runs, yet the lane was told synchronously, its answer
    /// comes off the main actor, and the chosen limit fires in terminate's
    /// nested wait.
    func testTheChosenLimitFiresInsideABusyMainQueueJob() async throws {
        for owed in [true, false] {
            let folder = try DeskTestFolder()
            defer { folder.clean() }
            let lane = FakeDeskLane()
            let logs = DeskLogCollector()
            let session = try await open(folder, lane: lane, logs: logs)
            if owed { lane.owedOnceQuitBegan = Self.oneLiveRun }
            let hold = FakeLaneLatch()
            defer { hold.open() }
            lane.finishHold = hold
            var replies: [Bool] = []
            var elapsedInsideTheJob: TimeInterval?
            var toldSynchronously = false
            let done = expectation(description: "the main-queue job ended")
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    let started = Date()
                    let answer = DeskTermination.reply(for: session, timeout: 0.2, participantTimeout: 0.8,
                                                       replyToApplication: { replies.append($0) })
                    XCTAssertEqual(answer, .terminateLater)
                    toldSynchronously = lane.journal.contains("beginShutdown quitting=true")
                    spinNestedRunLoop(upTo: 4) { !replies.isEmpty }
                    if !replies.isEmpty { elapsedInsideTheJob = Date().timeIntervalSince(started) }
                    done.fulfill()
                }
            }
            await fulfillment(of: [done], timeout: 10)
            XCTAssertTrue(toldSynchronously, "owed=\(owed)")
            let elapsed = try XCTUnwrap(elapsedInsideTheJob, "owed=\(owed): the limit fired inside terminate's wait")
            if owed {
                XCTAssertGreaterThanOrEqual(elapsed, 0.8, "the participant bound")
            } else {
                XCTAssertGreaterThanOrEqual(elapsed, 0.2)
                XCTAssertLessThan(elapsed, 0.8, "the plain bound")
            }
            XCTAssertEqual(replies, [true])
            hold.open()
            try await waitUntil("the close to finish") { session.state == .closed }
            XCTAssertEqual(replies, [true], "exactly one yes")
        }
    }

    // MARK: Plan S11 review fixes

    /// S11 reading 4 at the session, as amended (Codex's S10 carried
    /// requirement 4): a menu lock's own host step runs in a task, here
    /// while the owner is asked, and does not lock the lane a second time.
    /// The kept stack's lane unlock carries the epoch read when the owner
    /// check began, which no lock request overtook; and the session waits
    /// for the lane's unlock before it loads the fresh document.
    func testAKeptStacksLaneUnlockCarriesTheOwnerChecksEpochAndLandsBeforeTheReload() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let session = try makeLaneSession(folder, lane: lane)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let host = try XCTUnwrap(session.host)
        let atLock = lane.lockEpoch
        session.lockNow(reason: .menu)
        XCTAssertEqual(lane.lockEpoch, atLock + 1, "the session's own lockNow, at once")
        let held = HeldVerifier()
        let unlocking = Task { await session.unlock(verifier: held) }
        try await waitUntil("the owner check, and the host's deferred lock") { held.isWaiting && host.isLocked }
        XCTAssertEqual(lane.lockEpoch, atLock + 1, "the host's deferred step did not move the lane's epoch")
        let release = FakeLaneLatch()
        defer { release.open() }
        lane.unlockHold = release
        held.answer(.verified)
        try await waitUntil("the lane's unlock") { lane.journal.contains("unlock \(atLock + 1)") }
        XCTAssertEqual(lane.journal.filter { $0.hasPrefix("unlock ") && $0 != "unlock ended" }.suffix(1), ["unlock \(atLock + 1)"],
                       "the epoch read when the owner check began")
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(session.state, .locked, "no fresh document while the lane's unlock is still under way")
        XCTAssertFalse(host.isLocked, "the host's own step is done")
        release.open()
        await unlocking.value
        XCTAssertEqual(session.state, .open)
        XCTAssertTrue(lane.journal.contains("unlock ended"))
        await session.close()
    }

    /// S9 ruling (c) at the open: attached, the lane's unlock (awaited, so
    /// the page's first request finds it unlocked), then its one bounded
    /// pass of the writes it owes, and only then the dispatch recovery's
    /// store work. Here an earlier commit left a receipt with no result, so
    /// the reopened store holds a barrier the recovery withdraws.
    func testTheOpenPassesOwedWritesBeforeTheDispatchRecovery() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try makeLaneSession(folder, lane: lane, logs: logs)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        await session.lock(reason: .menu)
        await session.close()
        XCTAssertEqual(session.state, .lockedNoStack)
        let stuck = try await plantUnresolvedDispatch(in: try XCTUnwrap(session.runFolder), keys: session.keys)

        lane.duringPass = { lane.note("pass: unresolved \(lane.attached.last?.store.unresolvedDispatch == stuck)") }
        let release = FakeLaneLatch()
        defer { release.open() }
        lane.unlockHold = release
        let before = lane.journal.count
        let opening = Task { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        try await waitUntil("the lane's unlock") { lane.journal[before...].contains { $0.hasPrefix("unlock ") } }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(session.state, .lockedNoStack, "nothing shown while the lane's unlock is under way")
        XCTAssertFalse(lane.journal[before...].contains("reconcileBeforeStoreWork"))
        XCTAssertFalse(logs.all.contains { $0.hasPrefix("desk.store.recovery") }, "no recovery before the lane's pass")
        release.open()
        await opening.value
        XCTAssertEqual(session.state, .open)
        let journal = Array(lane.journal[before...])
        XCTAssertEqual(journal.filter { $0 != "lockNow" }.dropFirst(2).map { $0.hasPrefix("unlock ") && $0 != "unlock ended" ? "unlock" : $0 },
                       ["unlock", "unlock ended", "reconcileBeforeStoreWork", "pass: unresolved true"],
                       "built and attached, then unlocked, then the pass while the barrier still stood: \(journal)")
        XCTAssertEqual(Array(journal.prefix(2)), ["makeHost", "attach"])
        XCTAssertTrue(logs.all.contains("desk.store.recovery kind=withdrawn"), "then the recovery: \(logs.all)")
        XCTAssertNil(session.store?.unresolvedDispatch)
        await session.close()
    }

    /// A quit that begins while the stack is being attached: the lane
    /// refuses the attach (as the coordinator does, `shuttingDown`), and the
    /// open is abandoned for the quit, not shown as a failure.
    func testAQuitDuringTheAttachAbandonsTheOpen() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        lane.refusesAttachDuringShutdown = true
        let logs = DeskLogCollector()
        let session = try makeLaneSession(folder, lane: lane, logs: logs)
        let hold = FakeLaneLatch()
        defer { hold.open() }
        lane.attachHold = hold
        let opening = Task { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        try await waitUntil("the attach") { lane.journal.contains("attach") }
        // The quit's two steps on the app's thread (DeskTermination's).
        lane.beginShutdown(quitting: true)
        await session.close(quitting: true)
        hold.open()
        await opening.value
        XCTAssertEqual(session.state, .lockedNoStack, "not unavailable")
        XCTAssertNil(session.host)
        XCTAssertTrue(logs.all.contains("desk.open.abandoned reason=quit"), "\(logs.all)")
        XCTAssertFalse(logs.all.contains { $0.hasPrefix("desk.open.failed") }, "\(logs.all)")
        let writer = WriterLockHolder(folder: try XCTUnwrap(session.runFolder))
        XCTAssertNotNil(writer, "the refused stack's store is closed")
        writer?.release()
    }

    /// A quit that begins after the attach, while the open still runs: the
    /// attached stack is let go as a quit (`quitting` true), never as a
    /// window close, and nothing is shown.
    func testAQuitAfterTheAttachLetsTheStackGoAsAQuit() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try makeLaneSession(folder, lane: lane, logs: logs)
        let hold = FakeLaneLatch()
        defer { hold.open() }
        lane.unlockHold = hold
        let opening = Task { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        try await waitUntil("the lane's unlock") { lane.journal.contains("unlock 0") }
        lane.beginShutdown(quitting: true)
        await session.close(quitting: true)
        hold.open()
        await opening.value
        XCTAssertNil(session.host, "nothing shown")
        XCTAssertEqual(Array(lane.journal.suffix(3)), ["beginShutdown quitting=true", "finishShutdown quitting=true", "detach"],
                       "let go as a quit: \(lane.journal)")
        XCTAssertFalse(lane.journal.contains("finishShutdown quitting=false"))
        XCTAssertTrue(logs.all.contains("desk.open.abandoned reason=quit"), "\(logs.all)")
        let writer = WriterLockHolder(folder: try XCTUnwrap(session.runFolder))
        XCTAssertNotNil(writer, "its store is closed")
        writer?.release()
    }

    /// The lane's "nothing owed" that comes only after the plain limit has
    /// passed still takes the plain path, as soon as it comes, not the
    /// participant bound.
    func testALateNothingOwedAnswerStillTakesThePlainPath() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try await open(folder, lane: lane, logs: logs)
        let closeHold = FakeLaneLatch()
        defer { closeHold.open() }
        lane.finishHold = closeHold
        let answerHold = FakeLaneLatch()
        defer { answerHold.open() }
        lane.obligationsHold = answerHold
        var replies: [Bool] = []
        let started = Date()
        _ = DeskTermination.reply(for: session, timeout: 0.2, participantTimeout: 8, replyToApplication: { replies.append($0) })
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(replies, [], "no answer yet: the plain limit passed, but it does not apply until the lane says")
        answerHold.open()
        try await waitUntil("the reply once the lane said nothing is owed", timeout: 6) { !replies.isEmpty }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertLessThan(elapsed, 3, "as soon as the answer came, not the participant bound")
        XCTAssertTrue(logs.all.contains("desk.terminate.cap-reached limit=0.2s page=nothing-unsaved"), "\(logs.all)")
        XCTAssertEqual(replies, [true])
        closeHold.open()
        try await waitUntil("the close to finish") { session.state == .closed }
        XCTAssertEqual(replies, [true], "exactly one yes")
    }

    /// A quit that begins while a window close runs: it waits for that
    /// close (the same stack, never let go under it), then its own wait on
    /// the lane, within its one bound, and answers once.
    func testAQuitDuringAWindowCloseWaitsForItThenTheLane() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let lane = FakeDeskLane()
        let logs = DeskLogCollector()
        let session = try await open(folder, lane: lane, logs: logs)
        lane.owedOnceQuitBegan = Self.oneLiveRun
        let hold = FakeLaneLatch()
        defer { hold.open() }
        lane.finishHold = hold
        let closing = Task { await session.close() }
        try await waitUntil("the window close's finish") { lane.journal.contains("finishShutdown quitting=false") }
        var replies: [Bool] = []
        let answer = DeskTermination.reply(for: session, timeout: 0.3, participantTimeout: 8, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(replies, [], "owed work: not the plain limit")
        hold.open()
        await closing.value
        try await waitUntil("the quit's reply", timeout: 6) { !replies.isEmpty }
        XCTAssertEqual(replies, [true])
        let journal = lane.journal
        XCTAssertEqual(journal.filter { $0 == "detach" }.count, 1, "the stack let go once")
        XCTAssertLessThan(try XCTUnwrap(journal.firstIndex(of: "detach")), try XCTUnwrap(journal.firstIndex(of: "finishShutdown quitting=true")),
                          "the quit's own wait on the lane after the close it waited for: \(journal)")
        XCTAssertFalse(logs.all.contains { $0.hasPrefix("desk.terminate.cap-reached") }, "\(logs.all)")
        XCTAssertEqual(session.state, .closed)
    }

    /// Leaves a dispatch receipt with no result in the store at `folder`,
    /// as a commit whose write and withdrawal both failed does, so the next
    /// store opened there restores that barrier.
    private func plantUnresolvedDispatch(in folder: URL, keys: KeyProvider) async throws -> UUID {
        let files = FailingCreates()
        let store = try ProofStore(directory: folder, keys: keys, fileManager: files)
        defer { store.close() }
        let host = DeskHostProtocol(store: store, connections: ConnectionRegistry(), drafts: DraftBindingRegistry(),
                                    info: HostInfo(appVersion: "0.0.0-test", hostBuild: "unit-desk-plant"))
        let connection = await host.issueConnection()
        let revision = try store.read().revision
        let requestId = UUID()
        files.failing = [1, 2]
        let reply = await host.handle(HostRequest(requestId: requestId, connectionId: connection.id, generation: connection.generation,
                                                  operation: .workspaceCommitProof, payload: [
                                                      "workspaceHandle": .string(store.workspaceHandle),
                                                      "expectedRevision": .number(Double(revision)),
                                                      "record": .object(["revision": .number(Double(revision + 1)), "label": .string("invented stuck")])
                                                  ]))
        files.failing = []
        XCTAssertEqual(reply.outcome, .unknown, "\(reply.jsonValue)")
        XCTAssertEqual(store.unresolvedDispatch, requestId, "a receipt with no result")
        return requestId
    }
}

/// Lines recorded from any thread.
final class FakeLaneWaits: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func add(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        lines.append(line)
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}

/// Fails the file creations with the given indexes, counted from when they
/// are set: how a store write fails partway, with invented data only.
final class FailingCreates: FileManager, @unchecked Sendable {
    private let lock = NSLock()
    private var indexes: Set<Int> = []
    private var count = 0

    var failing: Set<Int> {
        get { lock.lock(); defer { lock.unlock() }; return indexes }
        set { lock.lock(); defer { lock.unlock() }; indexes = newValue; count = 0 }
    }

    override func createFile(atPath path: String, contents data: Data?, attributes attr: [FileAttributeKey: Any]? = nil) -> Bool {
        lock.lock()
        let index = count
        count += 1
        let fails = indexes.contains(index)
        lock.unlock()
        return fails ? false : super.createFile(atPath: path, contents: data, attributes: attr)
    }
}
