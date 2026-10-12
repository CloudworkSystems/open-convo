import DeskHost
@testable import DeskHostWebKit
import Foundation
import WebKit
import XCTest

/// Lifecycle invariants of the privileged view without loading a page: the
/// generation, issuance and bootstrap for one document are one step that
/// cannot interleave with another document's, nor with lock, unlock or
/// close. Invented bundle and store in a throwaway folder.
@MainActor
final class DeskWebViewHostLifecycleTests: XCTestCase {
    private var fixture: BundleFixture!
    private var store: ProofStore!
    private var registry: ConnectionRegistry!
    private var host: DeskWebViewHost!
    private let events = Locked<[HostEvent]>([])

    override func setUp() async throws {
        fixture = try BundleFixture()
        let manifest = try DeskBundleScanner.manifest(forBundleAt: fixture.bundle)
        let resolver = AssetResolver(manifest: manifest, bundleDirectory: fixture.bundle)
        store = try ProofStore(directory: fixture.root.appendingPathComponent("proof", isDirectory: true), keys: InventedInMemoryKeyProvider())
        registry = ConnectionRegistry()
        let events = self.events
        let sink = WebKitHostEventSink { event in events.mutate { $0.append(event) } }
        let hostProtocol = DeskHostProtocol(store: store, connections: registry, drafts: DraftBindingRegistry(),
                                            info: HostInfo(appVersion: "0.0.0-proof", hostBuild: "unit"), events: sink)
        host = DeskWebViewHost(hostProtocol: hostProtocol, resolver: resolver, eventSink: sink)
        // No page here: the test says when WebKit has caught up (`settle()`).
        host.webKitCatchUp = { [unowned self] then in pendingCatchUps.append(then) }
    }

    override func tearDown() async throws {
        if let host, !host.isClosed { await host.close() }
        fixture.clean()
    }

    private func revokedEvents() -> [HostEvent] {
        events.value.filter { if case .hostConnection(_, _, let state, _) = $0 { return state == .revoked } else { return false } }
    }

    /// Two navigations decided while the first is still between its
    /// generation and its issuance (WebKit asks about a second navigation
    /// while the first decision is pending). Whatever the schedule, exactly
    /// one connection is live afterwards, it is the current one, and the
    /// other was revoked.
    func testTwoDocumentBeginsNeverLeaveTwoLiveConnections() async throws {
        for round in 1...10 {
            async let first = host.beginDocument()
            async let second = host.beginDocument()
            let issued = await [first, second].compactMap { $0 }
            let current = try XCTUnwrap(host.currentConnection, "round \(round)")
            XCTAssertEqual(registry.activeConnectionCount, 1, "round \(round): one live connection, generation \(registry.currentGeneration), issued \(issued)")
            XCTAssertEqual(registry.check(current.id, generation: current.generation), .valid, "round \(round)")
            XCTAssertEqual(current.generation, registry.currentGeneration, "round \(round)")
            for connection in issued where connection != current {
                XCTAssertNotEqual(registry.check(connection.id, generation: connection.generation), .valid, "round \(round): the superseded connection is revoked")
                XCTAssertTrue(events.value.contains(.hostConnection(connectionId: connection.id, generation: connection.generation, state: .revoked, reason: .navigation)),
                              "round \(round): the superseded document was told")
            }
        }
    }

    /// A lock that arrives while a document begin is between its generation
    /// and its issuance must not leave that connection live.
    func testLockDuringADocumentBeginLeavesNoLiveConnection() async throws {
        for round in 1...10 {
            async let begun = host.beginDocument()
            await host.lock()
            _ = await begun
            XCTAssertEqual(registry.activeConnectionCount, 0, "round \(round): nothing live after lock")
            await host.unlock()
        }
    }

    // MARK: Lock and unlock interleavings (round 2 of the review, F1)

    private enum Call: String { case lock, unlock }

    /// A host with its own store and registry, for one schedule.
    private func makeHost(_ label: String) throws -> (DeskWebViewHost, ProofStore, ConnectionRegistry) {
        let manifest = try DeskBundleScanner.manifest(forBundleAt: fixture.bundle)
        let resolver = AssetResolver(manifest: manifest, bundleDirectory: fixture.bundle)
        let store = try ProofStore(directory: fixture.root.appendingPathComponent("proof-\(label)", isDirectory: true), keys: InventedInMemoryKeyProvider())
        let registry = ConnectionRegistry()
        let hostProtocol = DeskHostProtocol(store: store, connections: registry, drafts: DraftBindingRegistry(),
                                            info: HostInfo(appVersion: "0.0.0-proof", hostBuild: "unit"), events: nil)
        return (DeskWebViewHost(hostProtocol: hostProtocol, resolver: resolver, eventSink: WebKitHostEventSink()), store, registry)
    }

    /// Every interleaving of two `lock()` calls and one `unlock()`, driven
    /// deterministically through the serialized lifecycle queue. A lifecycle
    /// step can be overtaken only where it suspends: while queued behind an
    /// earlier step, or on a protocol hop. The host's checkpoints mark
    /// exactly those points, and the test lands each later call at each of
    /// them in turn (or after everything settled), for each order of the
    /// three calls. Whatever the schedule, the newest request wins, host and
    /// store agree, nothing is issued while locked, and an unlock afterwards
    /// is never a no-op. Before the fix the unlock step cleared the host's
    /// flag after a lock had landed on one of its hops: host unlocked over a
    /// locked store, a document then began against it, and `unlock()`
    /// refused to run again.
    func testEveryInterleavingOfTwoLocksAndOneUnlockKeepsHostAndStoreTogether() async throws {
        let orders: [[Call]] = [[.lock, .lock, .unlock], [.lock, .unlock, .lock], [.unlock, .lock, .lock]]
        // A later call lands when the n-th checkpoint of the run is reached;
        // `idle` (or a checkpoint never reached) lands it once every step
        // queued so far has finished.
        let idle = Int.max
        let slots = Array(1...9) + [idle]
        var seen = Set<String>()
        var ran = 0
        for order in orders {
            for second in slots {
                for third in slots where third >= second {
                    let label = "\(order.map(\.rawValue).joined(separator: "-"))@\(second == idle ? "idle" : "\(second)")-\(third == idle ? "idle" : "\(third)")"
                    let (host, store, registry) = try makeHost("\(ran)")
                    var reached: [DeskWebViewHost.LifecycleCheckpoint] = []
                    var landings: [(Call, Int)] = [(order[1], second), (order[2], third)]
                    var fired: [String] = []
                    var tasks: [Task<Void, Never>] = []

                    func fire(_ call: Call, at point: String) async {
                        let queued = host.lifecycleStepsQueued
                        tasks.append(Task { @MainActor in
                            switch call {
                            case .lock: await host.lock()
                            case .unlock: await host.unlock()
                            }
                        })
                        fired.append("\(call.rawValue)@\(point)")
                        // Let the call run up to its own suspension: its flag
                        // and epoch are set and its step is queued.
                        for _ in 0..<200 where host.lifecycleStepsQueued == queued { await Task.yield() }
                    }

                    host.lifecycleCheckpoint = { point in
                        reached.append(point)
                        while let next = landings.first, next.1 == reached.count {
                            landings.removeFirst()
                            await fire(next.0, at: "\(reached.count):\(point)")
                        }
                    }
                    await fire(order[0], at: "start")
                    while !tasks.isEmpty || !landings.isEmpty {
                        while !tasks.isEmpty { await tasks.removeFirst().value }
                        if let next = landings.first {
                            landings.removeFirst()
                            await fire(next.0, at: "idle")
                        }
                    }
                    host.lifecycleCheckpoint = nil
                    let signature = fired.joined(separator: " ")
                    ran += 1
                    seen.insert(signature)

                    let expectLocked = order.last == .lock
                    XCTAssertEqual(host.isLocked, expectLocked, "\(label) [\(signature)]: the newest request wins (host)")
                    XCTAssertEqual(store.isLocked, expectLocked, "\(label) [\(signature)]: the newest request wins (store)")
                    XCTAssertEqual(host.isLocked, store.isLocked, "\(label) [\(signature)]: host and store disagree")
                    if host.isLocked {
                        let refused = await host.beginDocument()
                        XCTAssertNil(refused, "\(label) [\(signature)]: no document begins while locked")
                        XCTAssertEqual(registry.activeConnectionCount, 0, "\(label) [\(signature)]: nothing issued while locked")
                        await host.unlock()
                        XCTAssertFalse(host.isLocked, "\(label) [\(signature)]: unlock afterwards is not a no-op")
                        XCTAssertFalse(store.isLocked, "\(label) [\(signature)]: unlock afterwards reopens the store")
                    }
                    let fresh = await host.beginDocument()
                    XCTAssertNotNil(fresh, "\(label) [\(signature)]: a fresh document gets a connection")
                    XCTAssertEqual(registry.activeConnectionCount, 1, "\(label) [\(signature)]")
                    await host.close()
                }
            }
        }
        print("F1 interleavings: \(ran) schedules run, \(seen.count) distinct landings")
        // Exhaustive over the checkpoints: lock-lock-unlock has 12 distinct
        // landings (the second lock at either point of the first lock's step
        // or after it, the unlock at that point or any later one before its
        // own step), lock-unlock-lock 15 (the unlock that acts has three
        // points, a superseded one only its first), unlock-lock-lock 7.
        XCTAssertEqual(seen.count, 12 + 15 + 7, "\(seen.sorted())")
    }

    /// The exact ordering that broke on real WebKit (round 2 probe 1), at
    /// the unit level: lock; unlock requested; a second lock while that
    /// unlock's step is queued; then each hop of the step in turn.
    func testLockLandingOnEachHopOfAnUnlockStepWins() async throws {
        for landing in [DeskWebViewHost.LifecycleCheckpoint.unlockStepStarted, .unlockStepRevoked, .unlockStepReopened] {
            let (host, store, registry) = try makeHost("hop-\(landing)")
            await host.lock()
            var relock: Task<Void, Never>?
            host.lifecycleCheckpoint = { point in
                guard point == landing, relock == nil else { return }
                let queued = host.lifecycleStepsQueued
                relock = Task { @MainActor in await host.lock() }
                for _ in 0..<200 where host.lifecycleStepsQueued == queued { await Task.yield() }
            }
            await host.unlock()
            await relock?.value
            host.lifecycleCheckpoint = nil
            XCTAssertNotNil(relock, "\(landing): the second lock landed")
            XCTAssertTrue(host.isLocked, "\(landing): the later lock wins over the unlock in flight")
            XCTAssertTrue(store.isLocked, "\(landing): host and store agree")
            let refused = await host.beginDocument()
            XCTAssertNil(refused, "\(landing): no document begins while locked")
            XCTAssertEqual(registry.activeConnectionCount, 0, "\(landing)")
            await host.unlock()
            XCTAssertFalse(host.isLocked, "\(landing): unlock is not a no-op afterwards")
            XCTAssertFalse(store.isLocked, "\(landing)")
            let fresh = await host.beginDocument()
            XCTAssertNotNil(fresh, "\(landing)")
            await host.close()
        }
    }

    /// Unlock is idempotent: with nothing locked it changes nothing, and a
    /// second unlock queued behind the first neither begins another
    /// generation nor revokes the document that began in between.
    func testUnlockIsIdempotent() async throws {
        let before = registry.currentGeneration
        await host.unlock()
        XCTAssertEqual(registry.currentGeneration, before, "an unlock with nothing locked begins no generation")
        XCTAssertFalse(host.isLocked)
        let begun = await host.beginDocument()
        let live = try XCTUnwrap(begun)

        await host.lock()
        async let first: Void = host.unlock()
        async let second: Void = host.unlock()
        _ = await (first, second)
        XCTAssertFalse(host.isLocked)
        XCTAssertFalse(store.isLocked)
        XCTAssertEqual(registry.currentGeneration, live.generation + 1, "one unlock step acted, one did nothing")
        let reopened = await host.beginDocument()
        let fresh = try XCTUnwrap(reopened)
        await host.unlock()
        XCTAssertEqual(registry.check(fresh.id, generation: fresh.generation), .valid, "a redundant unlock revokes nothing")
        XCTAssertEqual(host.currentConnection, fresh)
    }

    /// The other order: an `unlock()` requested after that later `lock()`
    /// reopens the store, while the earlier unlock in flight does not.
    func testUnlockRequestedAfterTheLaterLockReopens() async throws {
        await host.lock()
        let stale = Task { @MainActor in await host.unlock() }
        await Task.yield()
        await host.lock()
        let fresh = Task { @MainActor in await host.unlock() }
        await stale.value
        await fresh.value
        XCTAssertFalse(host.isLocked)
        XCTAssertFalse(store.isLocked)
        let begun = await host.beginDocument()
        XCTAssertNotNil(begun)
        XCTAssertEqual(registry.activeConnectionCount, 1)
    }

    // MARK: Navigations WebKit drops (round 3 of the review)

    private let entry = "trueconvo-desk://desk/index.html"
    private var pendingCatchUps: [@MainActor () -> Void] = []
    private var answers: [Int: WKNavigationActionPolicy] = [:]
    private var asked = 0
    private var recoveryReloads = 0

    private func connectionEvents() -> [String] {
        events.value.compactMap { event in
            guard case .hostConnection(let id, let generation, let state, _) = event else { return nil }
            return "\(state)/\(generation)/\(id.prefix(4))"
        }
    }

    /// Asks the host one navigation question the way the delegate does and
    /// returns its number; the answer lands in `answers`.
    @discardableResult
    private func ask(_ url: String, _ type: WKNavigationType = .other, target: DeskWebViewHost.NavigationQuestion.Target = .mainFrame,
                     cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy) -> Int {
        asked += 1
        let number = asked
        host.decideNavigation(.init(url: URL(string: url), navigationType: type, target: target, cachePolicy: cachePolicy)) { [unowned self] policy in
            answers[number] = policy
        }
        return number
    }

    private func answer(_ number: Int) async throws -> WKNavigationActionPolicy {
        for _ in 0..<2000 {
            if let policy = answers[number] { return policy }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("question \(number) was never answered")
        return .cancel
    }

    /// WebKit has handled everything asked of it so far.
    private func catchUp() {
        let pending = pendingCatchUps
        pendingCatchUps.removeAll()
        pending.forEach { $0() }
    }

    /// Lets every queued lifecycle step and recovery run, WebKit catching
    /// up in between (so an allowed navigation not started by then counts
    /// as never started).
    private func settle() async throws {
        for _ in 0..<20 {
            await Task.yield()
            try await Task.sleep(nanoseconds: 2_000_000)
            catchUp()
        }
    }

    /// A document load the way WebKit reports a healthy one: allowed,
    /// started, a main-frame response, committed.
    private func loadDocument(_ url: String, _ type: WKNavigationType = .other) async throws -> HostConnection {
        let question = ask(url, type)
        let policy = try await answer(question)
        XCTAssertEqual(policy, .allow)
        let navigation = NSObject()
        host.documentNavigationStarted(navigation)
        XCTAssertEqual(host.decideResponse(url: URL(string: url), isForMainFrame: true, canShowMIMEType: true), .allow)
        host.documentCommitted(navigation, viewURL: URL(string: url))
        let connection = try XCTUnwrap(host.currentConnection)
        XCTAssertEqual(host.documentConnection, connection)
        XCTAssertFalse(host.hasOrphanedConnection)
        return connection
    }

    private func prepareDropTests() async throws -> HostConnection {
        host.recoveryReload = { [unowned self] in recoveryReloads += 1 }
        let live = try await loadDocument(entry)
        XCTAssertEqual(registry.activeConnectionCount, 1)
        return live
    }

    /// The live document kept its connection and nothing else happened.
    private func assertKept(_ live: HostConnection, generation: Int, _ step: String) {
        XCTAssertEqual(host.currentConnection, live, step)
        XCTAssertEqual(host.documentConnection, live, step)
        XCTAssertEqual(registry.check(live.id, generation: live.generation), .valid, step)
        XCTAssertEqual(registry.activeConnectionCount, 1, step)
        XCTAssertEqual(registry.currentGeneration, generation, "\(step): no generation was spent")
        XCTAssertEqual(recoveryReloads, 0, step)
    }

    /// Reviewer probes B, D and test11a/11b, as WebKit orders them: a
    /// document question, then before the host's step runs another
    /// main-frame question (a fragment navigation, a navigation the policy
    /// cancels), a main-frame response question, or a new-window question.
    /// WebKit dropped the first; the host begins nothing for it and answers
    /// it `cancel`, and the live document keeps its connection. A subframe
    /// question has its own policy question and drops nothing.
    func testDocumentQuestionDroppedBeforeItsStepBeginsNothing() async throws {
        let live = try await prepareDropTests()
        let generation = registry.currentGeneration
        let later: [(String, () -> Void)] = [
            ("the skip link", { [unowned self] in ask(entry + "#desk-main", .linkActivated) }),
            ("a stray link the policy cancels", { [unowned self] in ask("trueconvo-desk://desk/nope.txt") }),
            ("a main-frame response question", { [unowned self] in _ = host.decideResponse(url: URL(string: entry), isForMainFrame: true, canShowMIMEType: true) }),
            ("a new-window question", { [unowned self] in ask(entry, .linkActivated, target: .newWindow) })
        ]
        var dropped: [URL?] = []
        host.onNavigationDropped = { dropped.append($0) }
        for (step, second) in later {
            let reload = ask(entry, .reload)
            second()
            let policy = try await answer(reload)
            try await settle()
            XCTAssertEqual(policy, .cancel, "\(step): the dropped question is answered cancel")
            XCTAssertEqual(dropped.last??.absoluteString, entry, "\(step): reported as dropped")
            assertKept(live, generation: generation, step)
        }
        XCTAssertEqual(dropped.count, later.count)
        let reload = ask(entry, .reload)
        ask(entry + "#frame", .other, target: .subframe)
        let policy = try await answer(reload)
        XCTAssertEqual(policy, .allow, "a subframe question drops nothing")
        XCTAssertEqual(registry.currentGeneration, generation + 1)
    }

    /// The same drop landing after the dropped question's step began its
    /// generation (the live document's connection is already revoked): the
    /// host answers it `cancel`, revokes the connection it issued (no
    /// document will ever hold it) and reloads once.
    func testDocumentQuestionDroppedAfterItsGenerationBeganIsRecovered() async throws {
        let live = try await prepareDropTests()
        let generation = registry.currentGeneration
        var dropped = false
        host.lifecycleCheckpoint = { [unowned self] point in
            guard point == .documentStepRevoked, !dropped else { return }
            dropped = true
            ask(entry + "#desk-main", .linkActivated)
        }
        let reload = ask(entry, .reload)
        let policy = try await answer(reload)
        host.lifecycleCheckpoint = nil
        try await settle()
        XCTAssertTrue(dropped)
        XCTAssertEqual(policy, .cancel)
        XCTAssertEqual(registry.check(live.id, generation: live.generation), .staleGeneration, "the step had revoked the live document")
        XCTAssertNil(host.currentConnection)
        XCTAssertEqual(registry.activeConnectionCount, 0, "no connection is left live without a document: \(connectionEvents())")
        XCTAssertEqual(registry.currentGeneration, generation + 2, "the dropped question's generation, then the recovery's")
        XCTAssertEqual(recoveryReloads, 1, "the view is reloaded once to get a fresh document")
        XCTAssertFalse(host.hasOrphanedConnection)

        // The reload WebKit then asks about is an ordinary document load.
        let fresh = try await loadDocument(entry, .reload)
        XCTAssertEqual(registry.activeConnectionCount, 1)
        XCTAssertEqual(host.documentConnection, fresh)
    }

    /// Reviewer probe K's wider window: the host already answered `allow`,
    /// and a main-frame question arrives before WebKit reports the provisional
    /// start (WebKit would have reported it first had it started). The
    /// allowed navigation was stopped; the host recovers. Started first, the
    /// same question changes nothing and the document commits as usual.
    func testAllowedDocumentStoppedBeforeItStartedIsRecovered() async throws {
        _ = try await prepareDropTests()
        let generation = registry.currentGeneration
        let reload = ask(entry, .reload)
        let policy = try await answer(reload)
        XCTAssertEqual(policy, .allow)
        let issued = try XCTUnwrap(host.currentConnection)
        ask(entry + "#desk-main", .linkActivated)
        try await settle()
        XCTAssertEqual(registry.check(issued.id, generation: issued.generation), .staleGeneration, "the orphan was revoked")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertEqual(registry.currentGeneration, generation + 2)
        XCTAssertEqual(recoveryReloads, 1)

        let next = try await loadDocument(entry, .reload)
        let another = ask(entry, .reload)
        let allowed = try await answer(another)
        XCTAssertEqual(allowed, .allow)
        let navigation = NSObject()
        host.documentNavigationStarted(navigation)
        ask(entry + "#desk-main", .linkActivated)
        try await settle()
        XCTAssertEqual(recoveryReloads, 1, "a started navigation is not stopped by a fragment question")
        XCTAssertEqual(host.decideResponse(url: URL(string: entry), isForMainFrame: true, canShowMIMEType: true), .allow)
        host.documentCommitted(navigation, viewURL: URL(string: entry))
        try await settle()
        XCTAssertNotEqual(host.currentConnection, next)
        XCTAssertEqual(host.documentConnection, host.currentConnection)
        XCTAssertEqual(registry.activeConnectionCount, 1)
        XCTAssertEqual(recoveryReloads, 1)
    }

    /// A provisional document load that fails (WebKit reports it) leaves the
    /// live document revoked: recovered. A failure reported for an older
    /// navigation than the one in flight is not.
    func testFailedProvisionalDocumentIsRecovered() async throws {
        _ = try await prepareDropTests()
        let reload = ask(entry, .reload)
        let policy = try await answer(reload)
        XCTAssertEqual(policy, .allow)
        let navigation = NSObject()
        host.documentNavigationStarted(navigation)
        host.documentNavigationFailed(NSObject())
        try await settle()
        XCTAssertEqual(recoveryReloads, 0, "someone else's failure")
        XCTAssertEqual(registry.activeConnectionCount, 1)
        host.documentNavigationFailed(navigation)
        try await settle()
        XCTAssertEqual(recoveryReloads, 1)
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
    }

    /// A document WebKit restores from its back/forward cache commits
    /// without a response and runs the bootstrap it had, which was revoked
    /// when it was left: the connection issued for the history load holds no
    /// document. Recovered; the live URL is the history item's.
    func testCommitWithoutAResponseIsARestoredDocumentAndIsRecovered() async throws {
        _ = try await loadDocument(entry)
        host.recoveryReload = { [unowned self] in recoveryReloads += 1 }
        _ = try await loadDocument("trueconvo-desk://desk/")
        let back = ask(entry, .backForward)
        let policy = try await answer(back)
        XCTAssertEqual(policy, .allow)
        let issued = try XCTUnwrap(host.currentConnection)
        let navigation = NSObject()
        host.documentNavigationStarted(navigation)
        host.documentCommitted(navigation, viewURL: URL(string: "trueconvo-desk://desk/index.html#pending-native-load"))
        XCTAssertEqual(host.committedDocumentURL?.absoluteString, entry, "the history item's URL, not the view's")
        XCTAssertNil(host.documentConnection)
        try await settle()
        XCTAssertEqual(registry.check(issued.id, generation: issued.generation), .staleGeneration)
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertEqual(recoveryReloads, 1)
    }

    /// Reviewer's commit-window probe at the unit level: the view already
    /// names a native fragment load the app requested when WebKit reports
    /// the previous navigation's commit. The live document is the one that
    /// committed (its response URL), so that native load is a new document.
    func testCommittedURLComesFromTheNavigationNotTheView() async throws {
        _ = try await prepareDropTests()
        let root = "trueconvo-desk://desk/"
        let toRoot = ask(root)
        let policy = try await answer(toRoot)
        XCTAssertEqual(policy, .allow)
        let navigation = NSObject()
        host.documentNavigationStarted(navigation)
        XCTAssertEqual(host.decideResponse(url: URL(string: root), isForMainFrame: true, canShowMIMEType: true), .allow)
        host.documentCommitted(navigation, viewURL: URL(string: entry + "#desk-main"))
        XCTAssertEqual(host.committedDocumentURL?.absoluteString, root)
        var decided: [DeskNavigationPolicy.Decision] = []
        host.onNavigationDecided = { decided.append($0.decision) }
        let native = ask(entry + "#desk-main")
        let allowed = try await answer(native)
        XCTAssertEqual(allowed, .allow)
        XCTAssertEqual(decided, [.allowNewDocument])
        host.documentNavigationStarted(NSObject())
        try await settle()
        XCTAssertEqual(recoveryReloads, 0)
    }

    /// A provisional load the host never allowed as a document (WebKit
    /// loading what the policy took for a fragment navigation) runs on
    /// whatever bootstrap was installed: it holds no connection of its own.
    /// Recovered rather than left on the replaced document's connection.
    func testDocumentLoadedWithoutTheHostsAllowIsRecovered() async throws {
        let live = try await prepareDropTests()
        let navigation = NSObject()
        host.documentNavigationStarted(navigation)
        XCTAssertEqual(host.decideResponse(url: URL(string: entry), isForMainFrame: true, canShowMIMEType: true), .allow)
        host.documentCommitted(navigation, viewURL: URL(string: entry))
        XCTAssertNil(host.documentConnection)
        try await settle()
        XCTAssertEqual(registry.check(live.id, generation: live.generation), .staleGeneration)
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertEqual(recoveryReloads, 1)
    }

    /// One recovery reload per healthy commit: a second orphan before the
    /// reload brought a working document is only revoked, so a page that
    /// keeps racing cannot keep the view reloading. A healthy commit
    /// re-arms it.
    func testRecoveryReloadsAtMostOncePerHealthyCommit() async throws {
        _ = try await prepareDropTests()
        for round in 1...2 {
            let reload = ask(entry, .reload)
            _ = try await answer(reload)
            ask(entry + "#desk-main", .linkActivated)
            try await settle()
            XCTAssertEqual(registry.activeConnectionCount, 0, "round \(round)")
        }
        XCTAssertEqual(recoveryReloads, 1)
        _ = try await loadDocument(entry, .reload)
        let reload = ask(entry, .reload)
        _ = try await answer(reload)
        ask(entry + "#desk-main", .linkActivated)
        try await settle()
        XCTAssertEqual(recoveryReloads, 2)
    }

    /// Locked or closed, a dropped navigation is left to the lock and close
    /// steps: no recovery reload.
    func testNoRecoveryWhileLockedOrClosed() async throws {
        _ = try await prepareDropTests()
        let reload = ask(entry, .reload)
        _ = try await answer(reload)
        await host.lock()
        ask(entry + "#desk-main", .linkActivated)
        try await settle()
        XCTAssertEqual(recoveryReloads, 0)
        XCTAssertEqual(registry.activeConnectionCount, 0)
        await host.unlock()
        _ = try await loadDocument(entry, .reload)
        let again = ask(entry, .reload)
        _ = try await answer(again)
        await host.close()
        ask(entry + "#desk-main", .linkActivated)
        try await settle()
        XCTAssertEqual(recoveryReloads, 0)
    }

    // MARK: Round 4 of the review

    /// R4-LT-1 without a page: a lock or close requested in the one
    /// main-actor turn between the document step's return and the
    /// decision's answer (here from `onDocumentBegan`) wins: the answer is
    /// `cancel`, and the connection the step issued is revoked by the lock
    /// or close step queued behind it. Before the fix the answer was
    /// `allow` with the host already locked or closed.
    func testLockOrCloseRequestedRightAfterTheDocumentStepCancelsTheNavigation() async throws {
        for call in ["lock", "close"] {
            let (host, store, registry) = try makeHost("lt1-\(call)")
            var answered: [(WKNavigationActionPolicy, Bool)] = []
            var refused: [URL?] = []
            var requested: Task<Void, Never>?
            host.onNavigationRefused = { refused.append($0) }
            host.onDocumentBegan = { _ in
                requested = Task { @MainActor in if call == "lock" { await host.lock() } else { await host.close() } }
            }
            host.decideNavigation(.init(url: URL(string: entry), navigationType: .reload, target: .mainFrame)) { policy in
                answered.append((policy, call == "lock" ? host.isLocked : host.isClosed))
            }
            for _ in 0..<2000 where answered.isEmpty || requested == nil {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            // Wait for the whole lock or close, not only its revocation:
            // close() clears the current connection after a main-queue hop.
            await requested?.value
            XCTAssertTrue(call == "lock" ? store.isLocked : host.isClosed, call)
            XCTAssertEqual(answered.map(\.0), [.cancel], "\(call): no document navigation is allowed once \(call) was requested")
            XCTAssertEqual(answered.map(\.1), [true], "\(call) had been requested when the answer was given")
            XCTAssertEqual(refused.map { $0?.absoluteString }, [entry], call)
            XCTAssertEqual(registry.activeConnectionCount, 0, "\(call): the step's connection was revoked")
            XCTAssertNil(host.currentConnection, call)
            if !host.isClosed { await host.close() }
        }
    }

    /// R4-LT-2 without a page: a main-frame response arriving while locked
    /// (a document navigation allowed before the lock) is refused, so WebKit
    /// fails that load and the locked page keeps its document; its failure
    /// recovers nothing while locked.
    func testMainFrameResponseIsRefusedWhileLocked() async throws {
        _ = try await prepareDropTests()
        let reload = ask(entry, .reload)
        let allowed = try await answer(reload)
        XCTAssertEqual(allowed, .allow)
        let navigation = NSObject()
        host.documentNavigationStarted(navigation)
        await host.lock()
        XCTAssertEqual(host.decideResponse(url: URL(string: entry), isForMainFrame: true, canShowMIMEType: true), .cancel)
        host.documentNavigationFailed(navigation)
        try await settle()
        XCTAssertEqual(recoveryReloads, 0)
        XCTAssertEqual(registry.activeConnectionCount, 0)
        await host.unlock()
        XCTAssertEqual(host.decideResponse(url: URL(string: entry), isForMainFrame: true, canShowMIMEType: true), .allow, "unlocked, responses are allowed again")
    }

    /// R4-H1 without a page: an allowed document navigation WebKit has not
    /// started once it caught up was dropped (WebKit scrolled, or the app or
    /// page stopped it): reported, its connection revoked, and the view
    /// reloaded once. Started in time, nothing happens.
    func testAllowedDocumentNeverStartedIsDroppedAndRecovered() async throws {
        let live = try await prepareDropTests()
        let generation = registry.currentGeneration
        var dropped: [URL?] = []
        host.onNavigationDropped = { dropped.append($0) }
        let reload = ask(entry, .reload)
        let allowed = try await answer(reload)
        XCTAssertEqual(allowed, .allow)
        let issued = try XCTUnwrap(host.currentConnection)
        XCTAssertNotEqual(issued, live)
        try await settle()
        XCTAssertEqual(dropped.map { $0?.absoluteString }, [entry], "reported as dropped")
        XCTAssertEqual(registry.check(issued.id, generation: issued.generation), .staleGeneration, "the orphan was revoked")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertEqual(registry.currentGeneration, generation + 2)
        XCTAssertEqual(recoveryReloads, 1)
        XCTAssertFalse(host.hasOrphanedConnection)

        let fresh = try await loadDocument(entry, .reload)
        try await settle()
        XCTAssertEqual(dropped.count, 1, "a navigation that started is not dropped")
        XCTAssertEqual(host.currentConnection, fresh)
        XCTAssertEqual(recoveryReloads, 1)
    }

    /// R4-LT-4 without a page: the recovery after a restored commit waits
    /// for WebKit to catch up. A document navigation asked about meanwhile
    /// (the app's load in the same instant) gets no reload on top of it; one
    /// the policy cancels does not stop the reload.
    func testRecoveryWaitsForANavigationRequestedInTheSameInstant() async throws {
        let root = "trueconvo-desk://desk/"
        for (step, allowedTarget) in [("the app's load of the bundle root", true), ("a foreign load the policy cancels", false)] {
            let (host, _, registry) = try makeHost("lt4-\(allowedTarget)")
            var catchUps: [@MainActor () -> Void] = []
            var reloads = 0
            var dropped: [URL?] = []
            host.webKitCatchUp = { catchUps.append($0) }
            host.recoveryReload = { reloads += 1 }
            host.onNavigationDropped = { dropped.append($0) }
            var answers: [WKNavigationActionPolicy] = []
            func load(_ url: String, _ type: WKNavigationType, response: Bool) async throws {
                answers.removeAll()
                host.decideNavigation(.init(url: URL(string: url), navigationType: type, target: .mainFrame)) { answers.append($0) }
                for _ in 0..<2000 where answers.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
                XCTAssertEqual(answers, [.allow], "\(step): \(url)")
                let navigation = NSObject()
                host.documentNavigationStarted(navigation)
                if response { _ = host.decideResponse(url: URL(string: url), isForMainFrame: true, canShowMIMEType: true) }
                host.documentCommitted(navigation, viewURL: URL(string: url))
                // WebKit caught up after each start: nothing was dropped.
                while !catchUps.isEmpty { catchUps.removeFirst()() }
            }
            try await load(entry, .other, response: true)
            try await load(root, .other, response: true)
            // Back to index.html, restored from the back/forward cache: no response.
            try await load(entry, .backForward, response: false)
            for _ in 0..<200 where catchUps.isEmpty { await Task.yield() }
            XCTAssertNil(host.currentConnection, "\(step): the orphan was revoked")
            // In the same instant, a navigation reaches the policy before WebKit caught up.
            if allowedTarget {
                host.decideNavigation(.init(url: URL(string: root), navigationType: .other, target: .mainFrame)) { _ in }
            } else {
                host.decideNavigation(.init(url: URL(string: "https://example.invalid/"), navigationType: .other, target: .mainFrame)) { _ in }
            }
            while !catchUps.isEmpty { catchUps.removeFirst()() }
            for _ in 0..<20 { await Task.yield(); try await Task.sleep(nanoseconds: 1_000_000) }
            XCTAssertEqual(reloads, allowedTarget ? 0 : 1, step)
            XCTAssertTrue(dropped.isEmpty, "\(step): nothing the app asked for was replaced: \(dropped)")
            if allowedTarget {
                XCTAssertNotNil(host.currentConnection, "\(step): the app's load began its own document")
                XCTAssertEqual(registry.activeConnectionCount, 1)
            }
            await host.close()
        }
    }

    /// R5-NAV-2 without a page (`unsavedWorkCheck` stands in for the page's
    /// `beforeunload` answer): a document navigation away from the live
    /// page that holds the current connection asks the page first. If it
    /// holds unsaved work the navigation is cancelled and nothing is spent,
    /// unless the app confirms leaving; unset means keep. A page with
    /// nothing unsaved, or no live page at all, goes on without asking the
    /// app. A navigation WebKit drops, or a lock (W4: even one undone by an
    /// unlock before the answer), while the app is being asked begins
    /// nothing whatever the answer.
    func testUnsavedWorkOnTheLivePageIsKeptUnlessTheAppConfirms() async throws {
        var live = try await prepareDropTests()
        var checks = 0
        var cancels = true
        host.unsavedWorkCheck = { checks += 1; return cancels }
        var refused: [URL?] = []
        var dropped: [URL?] = []
        host.onNavigationRefused = { refused.append($0) }
        host.onNavigationDropped = { dropped.append($0) }

        // Unset: the page is kept.
        let unset = ask(entry, .reload)
        let unsetAnswer = try await answer(unset)
        XCTAssertEqual(unsetAnswer, .cancel)
        XCTAssertEqual(checks, 1)
        XCTAssertEqual(refused.map { $0?.absoluteString }, [entry])
        assertKept(live, generation: registry.currentGeneration, "unset")
        XCTAssertEqual(registry.currentGeneration, live.generation)

        // The app's no: kept, and the app was asked with the URL.
        var asked: [URL?] = []
        var leave = false
        host.confirmLeavingUnsavedWork = { url, _ in asked.append(url); return leave }
        let no = ask(entry, .reload)
        let noAnswer = try await answer(no)
        XCTAssertEqual(noAnswer, .cancel)
        XCTAssertEqual(asked.map { $0?.absoluteString }, [entry])
        assertKept(live, generation: live.generation, "the app's no")

        // Nothing unsaved: on without asking the app.
        cancels = false
        asked.removeAll()
        live = try await loadDocument(entry, .reload)
        XCTAssertTrue(asked.isEmpty)
        XCTAssertEqual(checks, 3)

        // The app's yes: on.
        cancels = true
        leave = true
        let yes = try await loadDocument(entry, .reload)
        XCTAssertEqual(asked.map { $0?.absoluteString }, [entry])
        XCTAssertGreaterThan(yes.generation, live.generation)
        live = yes

        // WebKit drops the navigation while the app is asked (a fragment
        // navigation came first): nothing begun, whatever the answer.
        var pending: CheckedContinuation<Bool, Never>?
        host.confirmLeavingUnsavedWork = { _, _ in await withCheckedContinuation { pending = $0 } }
        dropped.removeAll()
        let droppedQuestion = ask(entry, .reload)
        for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        ask(entry + "#desk-main", .linkActivated)
        pending?.resume(returning: true)
        let droppedAnswer = try await answer(droppedQuestion)
        XCTAssertEqual(droppedAnswer, .cancel)
        XCTAssertEqual(dropped.map { $0?.absoluteString }, [entry])
        assertKept(live, generation: live.generation, "dropped while the app was asked")

        // A lock while the app is asked: nothing issued, whatever the answer.
        pending = nil
        let lockedQuestion = ask(entry, .reload)
        for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        await host.lock()
        pending?.resume(returning: true)
        let lockedAnswer = try await answer(lockedQuestion)
        XCTAssertEqual(lockedAnswer, .cancel)
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
        await host.unlock()

        // No live page holding the current connection (after the unlock):
        // the page is not asked.
        let checksBefore = checks
        host.confirmLeavingUnsavedWork = { _, _ in XCTFail("not asked"); return false }
        _ = try await loadDocument(entry, .reload)
        XCTAssertEqual(checks, checksBefore, "nothing to ask: the page holds no live connection")

        // A lock undone by an unlock while the app is asked (W4): before the
        // fix the late yes began a new document after the unlock.
        pending = nil
        host.confirmLeavingUnsavedWork = { _, _ in await withCheckedContinuation { pending = $0 } }
        let relockedQuestion = ask(entry, .reload)
        for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertNotNil(pending, "the app was asked")
        await host.lock()
        await host.unlock()
        let generationAfterUnlock = registry.currentGeneration
        pending?.resume(returning: true)
        let relockedAnswer = try await answer(relockedQuestion)
        try await settle()
        XCTAssertEqual(relockedAnswer, .cancel)
        XCTAssertEqual(registry.currentGeneration, generationAfterUnlock, "the late yes began nothing")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
    }

    /// W4 without a page (`unsavedWorkCheck` answering nil stands in for a
    /// page that gives no answer: a script error, a listener that threw, an
    /// unexpected value, a hang past `unsavedWorkCheckTimeout`). Before the
    /// fix no answer counted as nothing unsaved, and the navigation went on
    /// unasked. Now such a page is kept unless the app confirms leaving it,
    /// asked with `.noAnswer`: unset, a no or a thrown error keeps it, a yes
    /// begins a new generation. A yes given after a lock (even one undone
    /// by an unlock before the answer) or a close begins nothing; one given
    /// after another connection was issued (an older document step under
    /// way) still counts, and the newer reload replaces it (P3R-1).
    func testNoAnswerFromTheLivePageKeepsItUnlessTheAppConfirms() async throws {
        var live = try await prepareDropTests()
        var checks = 0
        host.unsavedWorkCheck = { checks += 1; return nil }
        var refused: [URL?] = []
        host.onNavigationRefused = { refused.append($0) }

        // Unset: kept.
        let unset = try await answer(ask(entry, .reload))
        XCTAssertEqual(unset, .cancel)
        XCTAssertEqual(checks, 1)
        assertKept(live, generation: live.generation, "no answer, unset")

        // The app's no, then a thrown error: kept, asked with the reason.
        var asked: [String] = []
        host.confirmLeavingUnsavedWork = { url, reason in asked.append("\(url?.absoluteString ?? "nil") \(reason)"); return false }
        let no = try await answer(ask(entry, .reload))
        XCTAssertEqual(no, .cancel)
        host.confirmLeavingUnsavedWork = { url, reason in asked.append("\(url?.absoluteString ?? "nil") \(reason)"); throw InventedConfirmationFailure() }
        let failed = try await answer(ask(entry, .reload))
        XCTAssertEqual(failed, .cancel)
        XCTAssertEqual(asked, ["\(entry) noAnswer", "\(entry) noAnswer"])
        XCTAssertEqual(refused.map { $0?.absoluteString }, [entry, entry, entry])
        assertKept(live, generation: live.generation, "no answer, the app's no or failure")

        // The app's yes: a new generation, the page's connection revoked.
        asked.removeAll()
        host.confirmLeavingUnsavedWork = { url, reason in asked.append("\(url?.absoluteString ?? "nil") \(reason)"); return true }
        let forced = try await loadDocument(entry, .reload)
        XCTAssertEqual(asked, ["\(entry) noAnswer"])
        XCTAssertGreaterThan(forced.generation, live.generation)
        XCTAssertEqual(registry.check(live.id, generation: live.generation), .staleGeneration)
        live = forced

        // A lock and an unlock while the app is asked: the yes begins nothing.
        var pending: CheckedContinuation<Bool, Never>?
        host.confirmLeavingUnsavedWork = { _, _ in await withCheckedContinuation { pending = $0 } }
        refused.removeAll()
        let relocked = ask(entry, .reload)
        for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertNotNil(pending, "the app was asked")
        await host.lock()
        await host.unlock()
        let generationAfterUnlock = registry.currentGeneration
        pending?.resume(returning: true)
        let relockedAnswer = try await answer(relocked)
        try await settle()
        XCTAssertEqual(relockedAnswer, .cancel)
        XCTAssertEqual(refused.map { $0?.absoluteString }, [entry])
        XCTAssertEqual(registry.currentGeneration, generationAfterUnlock, "the late yes began nothing")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)

        // Another connection issued while the app is asked (here by a
        // direct document step; in the app only an older navigation's step
        // can, as a newer question drops this one): the yes still counts,
        // and the newer reload replaces that connection (P3R-1).
        _ = try await loadDocument(entry, .reload)
        pending = nil
        refused.removeAll()
        let replaced = ask(entry, .reload)
        for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertNotNil(pending, "the app was asked")
        let begun = await host.beginDocument()
        let other = try XCTUnwrap(begun)
        pending?.resume(returning: true)
        let replacedAnswer = try await answer(replaced)
        XCTAssertEqual(replacedAnswer, .allow)
        XCTAssertTrue(refused.isEmpty, "\(refused)")
        let replacing = try XCTUnwrap(host.currentConnection)
        XCTAssertGreaterThan(replacing.generation, other.generation)
        XCTAssertEqual(registry.check(other.id, generation: other.generation), .staleGeneration, "the connection issued meanwhile was revoked")
        XCTAssertEqual(registry.activeConnectionCount, 1)

        // A close while the app is asked: the yes begins nothing.
        _ = try await loadDocument(entry, .reload)
        pending = nil
        let closing = ask(entry, .reload)
        for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertNotNil(pending, "the app was asked")
        await host.close()
        let generationAfterClose = registry.currentGeneration
        pending?.resume(returning: true)
        let closingAnswer = try await answer(closing)
        try await settle()
        XCTAssertEqual(closingAnswer, .cancel)
        XCTAssertEqual(registry.currentGeneration, generationAfterClose, "the late yes began nothing")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
    }

    /// Codex P3 of eedc29f without a page: a clean answer from the live
    /// page (the `unsavedWorkCheck` seam, held back) counts only for the
    /// state WebKit asked in, as the app's yes does. Before the fix a clean
    /// answer skipped that check and the document step compared only the
    /// question number, so a lock undone by an unlock before the answer let
    /// the older reload begin a new generation after the unlock. Now it
    /// begins nothing, nor after a close meanwhile; after another connection
    /// was issued meanwhile (an older document step under way) the newer
    /// reload replaces it (P3R-1). With nothing changed the held-back clean
    /// answer still goes on without asking the app, and the app's reload
    /// after the unlock, with no live page holding the current connection,
    /// is not even checked.
    func testACleanAnswerCountsOnlyWhileTheDecisionIsUnchanged() async throws {
        var live = try await prepareDropTests()
        var pending: CheckedContinuation<Bool?, Never>?
        var checks = 0
        host.unsavedWorkCheck = { checks += 1; return await withCheckedContinuation { pending = $0 } }
        host.confirmLeavingUnsavedWork = { _, _ in XCTFail("a clean page is left without asking the app"); return false }
        var refused: [URL?] = []
        var dropped: [URL?] = []
        var begunDocuments: [HostConnection] = []
        host.onNavigationRefused = { refused.append($0) }
        host.onNavigationDropped = { dropped.append($0) }
        host.onDocumentBegan = { begunDocuments.append($0) }
        func pageAsked(_ step: String) async throws {
            for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
            XCTAssertNotNil(pending, "\(step): the page was asked")
        }
        func pageAnswersClean() {
            pending?.resume(returning: false)
            pending = nil
        }

        // Nothing changed while the answer was on its way: on, unasked.
        let unchanged = ask(entry, .reload)
        try await pageAsked("unchanged")
        pageAnswersClean()
        let unchangedAnswer = try await answer(unchanged)
        XCTAssertEqual(unchangedAnswer, .allow)
        let navigation = NSObject()
        host.documentNavigationStarted(navigation)
        _ = host.decideResponse(url: URL(string: entry), isForMainFrame: true, canShowMIMEType: true)
        host.documentCommitted(navigation, viewURL: URL(string: entry))
        let reloaded = try XCTUnwrap(host.currentConnection)
        XCTAssertGreaterThan(reloaded.generation, live.generation)
        XCTAssertEqual(host.documentConnection, reloaded)
        XCTAssertEqual(begunDocuments, [reloaded])
        live = reloaded

        // A lock undone by an unlock while the answer is on its way: the
        // older reload begins nothing (before the fix, a new generation
        // after the unlock).
        begunDocuments.removeAll()
        let relocked = ask(entry, .reload)
        try await pageAsked("relocked")
        await host.lock()
        await host.unlock()
        let generationAfterUnlock = registry.currentGeneration
        pageAnswersClean()
        let relockedAnswer = try await answer(relocked)
        try await settle()
        XCTAssertEqual(relockedAnswer, .cancel)
        XCTAssertEqual(refused.map { $0?.absoluteString }, [entry])
        XCTAssertTrue(dropped.isEmpty, "\(dropped)")
        XCTAssertTrue(begunDocuments.isEmpty, "the older reload began no generation: \(begunDocuments)")
        XCTAssertEqual(registry.currentGeneration, generationAfterUnlock, "the late clean answer began nothing")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
        XCTAssertEqual(recoveryReloads, 0)

        // The app's reload after the unlock works, and with no live page
        // holding the current connection the page is not asked.
        let checksBefore = checks
        let fresh = try await loadDocument(entry, .reload)
        XCTAssertEqual(checks, checksBefore, "nothing to ask: the page holds no live connection")
        XCTAssertEqual(begunDocuments, [fresh])
        XCTAssertGreaterThan(fresh.generation, generationAfterUnlock)

        // Another connection issued while the answer is on its way (here
        // by a direct document step; in the app only an older navigation's
        // step can, as a newer question drops this one): the newer reload
        // replaces it (P3R-1). Before that fix it began nothing, and the
        // connection stayed live with no document holding it.
        refused.removeAll()
        let replaced = ask(entry, .reload)
        try await pageAsked("replaced")
        let begun = await host.beginDocument()
        let other = try XCTUnwrap(begun)
        pageAnswersClean()
        let replacedAnswer = try await answer(replaced)
        XCTAssertEqual(replacedAnswer, .allow)
        XCTAssertTrue(refused.isEmpty, "\(refused)")
        let replacing = try XCTUnwrap(host.currentConnection)
        XCTAssertGreaterThan(replacing.generation, other.generation)
        XCTAssertEqual(registry.check(other.id, generation: other.generation), .staleGeneration, "the connection issued meanwhile was revoked")
        XCTAssertEqual(registry.activeConnectionCount, 1)

        // A close while the answer is on its way: nothing begins.
        _ = try await loadDocument(entry, .reload)
        let closing = ask(entry, .reload)
        try await pageAsked("closing")
        await host.close()
        let generationAfterClose = registry.currentGeneration
        pageAnswersClean()
        let closingAnswer = try await answer(closing)
        try await settle()
        XCTAssertEqual(closingAnswer, .cancel)
        XCTAssertEqual(registry.currentGeneration, generationAfterClose, "the late clean answer began nothing")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
    }

    /// P3R-1 (review of 1193f35) without a page: WebKit asks about a second
    /// reload while the first reload's document step is under way (held
    /// after its generation began, before its connection is issued), and
    /// drops the first. The second still counts as leaving the live page
    /// (the step sets the current connection only when it ends), so the page
    /// is asked again. Before the fix the connection the first step issued
    /// meanwhile counted as a changed decision: the second's clean answer,
    /// at once or held back until that step ended, or the app's yes, began
    /// nothing, both reloads were cancelled, and that connection stayed live
    /// with no document holding it and no recovery. Now the newer reload
    /// replaces the older step, as the type's comment says. A second reload
    /// that keeps the page (unsaved, no app answer set) leaves that
    /// connection to the recovery: revoked, and the view reloaded once.
    func testANewerNavigationReplacesAnOlderDocumentStepUnderWay() async throws {
        var live = try await prepareDropTests()
        var dropped: [URL?] = []
        var refused: [URL?] = []
        var begun: [HostConnection] = []
        host.onNavigationDropped = { dropped.append($0) }
        host.onNavigationRefused = { refused.append($0) }
        host.onDocumentBegan = { begun.append($0) }
        enum App { case notAsked, yes, yesHeldBack, unset }
        let runs: [(step: String, unsaved: Bool, pageHeldBack: Bool, app: App)] = [
            ("clean at once", false, false, .notAsked),
            ("clean held back until the older step ended", false, true, .notAsked),
            ("unsaved, the app's yes at once", true, false, .yes),
            ("unsaved, the app's yes held back until the older step ended", true, false, .yesHeldBack),
            ("unsaved held back until the older step ended, no app answer set", true, true, .unset),
        ]
        for run in runs {
            let step = run.step
            dropped.removeAll()
            refused.removeAll()
            begun.removeAll()
            let reloadsBefore = recoveryReloads
            var checks = 0
            var pendingPage: CheckedContinuation<Bool?, Never>?
            host.unsavedWorkCheck = {
                checks += 1
                if checks == 1 { return false }
                if run.pageHeldBack { return await withCheckedContinuation { pendingPage = $0 } }
                return run.unsaved
            }
            var appAsked = 0
            var pendingYes: CheckedContinuation<Bool, Never>?
            switch run.app {
            case .notAsked: host.confirmLeavingUnsavedWork = { _, _ in XCTFail("\(step): a clean page is left without asking the app"); return false }
            case .yes: host.confirmLeavingUnsavedWork = { _, _ in appAsked += 1; return true }
            case .yesHeldBack: host.confirmLeavingUnsavedWork = { _, _ in appAsked += 1; return await withCheckedContinuation { pendingYes = $0 } }
            case .unset: host.confirmLeavingUnsavedWork = nil
            }
            var release: CheckedContinuation<Void, Never>?
            var held = false
            host.lifecycleCheckpoint = { point in
                guard point == .documentStepRevoked, !held else { return }
                held = true
                await withCheckedContinuation { release = $0 }
            }

            let first = ask(entry, .reload)
            for _ in 0..<2000 where release == nil { try await Task.sleep(nanoseconds: 1_000_000) }
            XCTAssertNotNil(release, "\(step): the older step is held after its generation began")
            let second = ask(entry, .reload)
            for _ in 0..<20 { await Task.yield() }
            host.lifecycleCheckpoint = nil
            release?.resume()
            if run.pageHeldBack || run.app == .yesHeldBack {
                for _ in 0..<2000 where pendingPage == nil && pendingYes == nil { try await Task.sleep(nanoseconds: 1_000_000) }
                XCTAssertTrue(pendingPage != nil || pendingYes != nil, "\(step): the answer is held back")
                // The older step ends (and its reload is answered) first.
                let firstEnded = try await answer(first)
                XCTAssertEqual(firstEnded, .cancel, step)
                XCTAssertNotNil(host.currentConnection, "\(step): the older step issued its connection")
                pendingPage?.resume(returning: run.unsaved)
                pendingPage = nil
                pendingYes?.resume(returning: true)
                pendingYes = nil
            }
            let firstAnswer = try await answer(first)
            let secondAnswer = try await answer(second)
            let state = "first=\(firstAnswer.rawValue) second=\(secondAnswer.rawValue) dropped=\(dropped.count) refused=\(refused.count) begun=\(begun.map(\.generation)) current=\(host.currentConnection.map { "\($0.generation)" } ?? "nil") document=\(host.documentConnection.map { "\($0.generation)" } ?? "nil") active=\(registry.activeConnectionCount)"
            print("P3R-1 \(step): \(state)")
            XCTAssertEqual(firstAnswer, .cancel, "\(step): the older reload was dropped: \(state)")
            XCTAssertEqual(dropped.map { $0?.absoluteString }, [entry], "\(step): \(state)")
            XCTAssertEqual(checks, 2, "\(step): the page was asked for each reload")
            XCTAssertEqual(appAsked, run.app == .yes || run.app == .yesHeldBack ? 1 : 0, step)
            XCTAssertEqual(registry.check(live.id, generation: live.generation), .staleGeneration, "\(step): the older step revoked the page")

            if run.app == .unset {
                // The page is kept, and the older step's connection, which
                // no document holds, is recovered.
                try await settle()
                XCTAssertEqual(secondAnswer, .cancel, "\(step): \(state)")
                XCTAssertEqual(refused.map { $0?.absoluteString }, [entry], step)
                XCTAssertEqual(begun.count, 1, "\(step): only the older step began a generation: \(state)")
                if let orphan = begun.first {
                    XCTAssertEqual(registry.check(orphan.id, generation: orphan.generation), .staleGeneration, "\(step): the orphan was revoked")
                }
                XCTAssertNil(host.currentConnection, step)
                XCTAssertEqual(registry.activeConnectionCount, 0, "\(step): no connection is left live without a document: \(connectionEvents())")
                XCTAssertFalse(host.hasOrphanedConnection, step)
                XCTAssertEqual(recoveryReloads, reloadsBefore + 1, "\(step): the view is reloaded once")
                // The recovery reload WebKit then asks about is an ordinary load.
                live = try await loadDocument(entry, .reload)
                XCTAssertEqual(registry.activeConnectionCount, 1)
                continue
            }

            // The newer reload replaced the older step: one more generation,
            // the older step's connection revoked, one live connection.
            XCTAssertEqual(secondAnswer, .allow, "\(step): the newer reload replaces the older step under way: \(state)")
            XCTAssertTrue(refused.isEmpty, "\(step): \(refused)")
            XCTAssertEqual(begun.count, 2, "\(step): \(state)")
            guard secondAnswer == .allow, begun.count == 2 else {
                // Already failed above; start the next run from a healthy document.
                try await settle()
                live = try await loadDocument(entry, .reload)
                continue
            }
            let (older, newer) = (begun[0], begun[1])
            XCTAssertGreaterThan(newer.generation, older.generation, step)
            XCTAssertEqual(registry.check(older.id, generation: older.generation), .staleGeneration, "\(step): the older step's connection was revoked")
            XCTAssertEqual(host.currentConnection, newer, step)
            XCTAssertEqual(registry.activeConnectionCount, 1, "\(step): \(connectionEvents())")
            let navigation = NSObject()
            host.documentNavigationStarted(navigation)
            XCTAssertEqual(host.decideResponse(url: URL(string: entry), isForMainFrame: true, canShowMIMEType: true), .allow, step)
            host.documentCommitted(navigation, viewURL: URL(string: entry))
            try await settle()
            XCTAssertEqual(host.documentConnection, newer, step)
            XCTAssertEqual(host.currentConnection, newer, step)
            XCTAssertFalse(host.hasOrphanedConnection, step)
            XCTAssertEqual(registry.activeConnectionCount, 1, step)
            XCTAssertEqual(recoveryReloads, reloadsBefore, "\(step): no recovery needed")
            live = newer
        }
    }

    /// W4: only a JavaScript boolean from the page is an answer. A script
    /// error, the check's string for a listener that threw, a number (which
    /// WebKit would also turn into a Bool), null or anything else is none.
    func testUnsavedWorkAnswerReadsOnlyAJavaScriptBoolean() {
        XCTAssertEqual(DeskWebViewHost.unsavedWorkAnswer(from: .success(NSNumber(value: true))), .unsaved)
        XCTAssertEqual(DeskWebViewHost.unsavedWorkAnswer(from: .success(NSNumber(value: false))), .clean)
        XCTAssertEqual(DeskWebViewHost.unsavedWorkAnswer(from: .success(NSNumber(value: 1))), .unknown)
        XCTAssertEqual(DeskWebViewHost.unsavedWorkAnswer(from: .success(NSNumber(value: 0))), .unknown)
        XCTAssertEqual(DeskWebViewHost.unsavedWorkAnswer(from: .success("no answer")), .unknown)
        XCTAssertEqual(DeskWebViewHost.unsavedWorkAnswer(from: .success(NSNull())), .unknown)
        XCTAssertEqual(DeskWebViewHost.unsavedWorkAnswer(from: .success(Optional<Any>.none as Any)), .unknown)
        XCTAssertEqual(DeskWebViewHost.unsavedWorkAnswer(from: .failure(InventedConfirmationFailure())), .unknown)
    }

    /// The app's close and quit question (`pageHoldsUnsavedWork`) answers
    /// from the page, here the `unsavedWorkCheck` seam, for the live page
    /// that holds the current connection: `.unsaved` when it cancels,
    /// `.noAnswer` when it gives no answer (never "nothing unsaved"), nil
    /// only when it answered clean. It asks the app nothing and spends
    /// nothing.
    func testPageHoldsUnsavedWorkFollowsSeam() async throws {
        let live = try await prepareDropTests()
        var checks = 0
        var answer: Bool? = true
        host.unsavedWorkCheck = { checks += 1; return answer }
        host.confirmLeavingUnsavedWork = { _, _ in XCTFail("the app is not asked"); return false }
        let holds = await host.pageHoldsUnsavedWork()
        XCTAssertEqual(holds, .unsaved)
        answer = nil
        let noAnswer = await host.pageHoldsUnsavedWork()
        XCTAssertEqual(noAnswer, .noAnswer, "a page that cannot answer may hold work")
        answer = false
        let clean = await host.pageHoldsUnsavedWork()
        XCTAssertNil(clean, "only a clean answer holds nothing")
        XCTAssertEqual(checks, 3)
        assertKept(live, generation: live.generation, "asking spends nothing")
    }

    /// Closed, locked, or no live page holding the current connection:
    /// nothing unsaved, and the page is not even asked. A lock (even one
    /// undone before the answer) or close landing while the page is asked
    /// took the page's work: nothing unsaved, whatever the page said.
    func testPageHoldsUnsavedWorkIsNilWhenLockedClosedOrNoConnection() async throws {
        var checks = 0
        host.unsavedWorkCheck = { checks += 1; return true }
        let beforeAnyPage = await host.pageHoldsUnsavedWork()
        XCTAssertNil(beforeAnyPage, "no connection yet")
        XCTAssertEqual(checks, 0)

        _ = try await loadDocument(entry)
        let open = await host.pageHoldsUnsavedWork()
        XCTAssertEqual(open, .unsaved)
        XCTAssertEqual(checks, 1)

        await host.lock()
        let locked = await host.pageHoldsUnsavedWork()
        XCTAssertNil(locked, "locked")
        await host.unlock()
        let unlockedBeforeAFreshDocument = await host.pageHoldsUnsavedWork()
        XCTAssertNil(unlockedBeforeAFreshDocument, "no page holds a connection until a fresh document")
        XCTAssertEqual(checks, 1)

        _ = try await loadDocument(entry, .reload)
        let reloaded = await host.pageHoldsUnsavedWork()
        XCTAssertEqual(reloaded, .unsaved)
        XCTAssertEqual(checks, 2)

        // A lock landing while the page is asked, whether the page then
        // says unsaved or gives no answer: nothing unsaved.
        var pending: CheckedContinuation<Bool?, Never>?
        host.unsavedWorkCheck = { await withCheckedContinuation { pending = $0 } }
        for late in [true, nil] as [Bool?] {
            pending = nil
            async let lockedWhileAsked = host.pageHoldsUnsavedWork()
            for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
            await host.lock()
            pending?.resume(returning: late)
            let answer = await lockedWhileAsked
            XCTAssertNil(answer, "locked while the page was asked (it answered \(String(describing: late)))")
            await host.unlock()
            _ = try await loadDocument(entry, .reload)
        }

        // A lock and its unlock both landing while the page is asked.
        pending = nil
        async let lockedAndUnlockedWhileAsked = host.pageHoldsUnsavedWork()
        for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        await host.lock()
        await host.unlock()
        pending?.resume(returning: true)
        let afterUndoneLock = await lockedAndUnlockedWhileAsked
        XCTAssertNil(afterUndoneLock, "a lock undone before the answer still took the page's work")

        await host.close()
        host.unsavedWorkCheck = { checks += 1; return true }
        let closed = await host.pageHoldsUnsavedWork()
        XCTAssertNil(closed, "closed")
        XCTAssertEqual(checks, 2)
    }

    /// R5-LT-A and R5-NAV-1 without a page: the content process ends while
    /// a document decision is still being answered. WebKit drops that
    /// question with the process. Before the fix the decision answered
    /// `allow` (to a page that no longer existed), the termination's reload
    /// stood aside for it, and nothing reloaded once WebKit never started
    /// it: an empty view for good. Now the end of the process drops the
    /// decision (answered `cancel`, nothing begun or the connection issued
    /// for it revoked) and the host reloads once it is answered; a document
    /// navigation asked of the new process meanwhile gets no reload on top.
    func testContentProcessEndingWhileADocumentDecisionIsPendingStillReloads() async throws {
        let live = try await prepareDropTests()
        var terminated = 0
        var dropped: [URL?] = []
        host.onContentProcessTerminated = { terminated += 1 }
        host.onNavigationDropped = { dropped.append($0) }
        host.terminationReloadInterval = 0

        // The process ends before the decision's step runs.
        let first = ask(entry, .reload)
        host.webViewWebContentProcessDidTerminate(host.webView)
        try await settle()
        XCTAssertEqual(answers[first], .cancel, "WebKit dropped it with the process")
        XCTAssertEqual(dropped.map { $0?.absoluteString }, [entry])
        XCTAssertEqual(terminated, 1)
        XCTAssertEqual(recoveryReloads, 1, "the host reloads the view")
        XCTAssertEqual(registry.check(live.id, generation: live.generation), .staleGeneration)
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)

        // The process ends while the step is between its generation and its
        // issuance: a connection is issued for the ended page.
        var release: CheckedContinuation<Void, Never>?
        var held = false
        func holdNextDocumentStep() {
            held = false
            release = nil
            host.lifecycleCheckpoint = { point in
                guard point == .documentStepRevoked, !held else { return }
                held = true
                await withCheckedContinuation { release = $0 }
            }
        }
        _ = try await loadDocument(entry, .reload)
        dropped.removeAll()
        holdNextDocumentStep()
        let second = ask(entry, .reload)
        for _ in 0..<2000 where release == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        host.webViewWebContentProcessDidTerminate(host.webView)
        for _ in 0..<20 { await Task.yield() }
        host.lifecycleCheckpoint = nil
        release?.resume()
        try await settle()
        XCTAssertEqual(answers[second], .cancel)
        XCTAssertEqual(dropped.map { $0?.absoluteString }, [entry])
        XCTAssertEqual(terminated, 2)
        XCTAssertEqual(recoveryReloads, 2, "the host reloads the view")
        XCTAssertEqual(registry.activeConnectionCount, 0, "the connection issued for the ended page was revoked")
        XCTAssertNil(host.currentConnection)

        // The same, and the app's own load reaches the new process before
        // the dropped decision is answered: that load brings the document.
        _ = try await loadDocument(entry, .reload)
        holdNextDocumentStep()
        let third = ask(entry, .reload)
        for _ in 0..<2000 where release == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        host.webViewWebContentProcessDidTerminate(host.webView)
        for _ in 0..<20 { await Task.yield() }
        let apps = ask(entry)
        host.lifecycleCheckpoint = nil
        release?.resume()
        let appsAnswer = try await answer(apps)
        XCTAssertEqual(appsAnswer, .allow)
        let navigation = NSObject()
        host.documentNavigationStarted(navigation)
        _ = host.decideResponse(url: URL(string: entry), isForMainFrame: true, canShowMIMEType: true)
        host.documentCommitted(navigation, viewURL: URL(string: entry))
        try await settle()
        XCTAssertEqual(answers[third], .cancel)
        XCTAssertEqual(terminated, 3)
        XCTAssertEqual(recoveryReloads, 2, "no reload on top of the app's load")
        let current = try XCTUnwrap(host.currentConnection)
        XCTAssertEqual(host.documentConnection, current)
        XCTAssertEqual(registry.activeConnectionCount, 1)

        // The process ends while the app is still being asked about unsaved
        // work on that page: the reload does not wait for the answer, and
        // the late answer, yes or no, begins nothing.
        for leave in [true, false] {
            let reloadsBefore = recoveryReloads
            let healthy = try await loadDocument(entry, .reload)
            var pending: CheckedContinuation<Bool, Never>?
            host.unsavedWorkCheck = { true }
            host.confirmLeavingUnsavedWork = { _, _ in await withCheckedContinuation { pending = $0 } }
            dropped.removeAll()
            let asking = ask(entry, .reload)
            for _ in 0..<2000 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
            host.webViewWebContentProcessDidTerminate(host.webView)
            try await settle()
            XCTAssertEqual(recoveryReloads, reloadsBefore + 1, "answer \(leave): reloaded without waiting for the app")
            XCTAssertNil(answers[asking], "answer \(leave): still asking the app")
            XCTAssertEqual(registry.check(healthy.id, generation: healthy.generation), .staleGeneration)
            // The reload's own load, asked of the new process, brings the document.
            let reloaded = try await loadDocument(entry)
            pending?.resume(returning: leave)
            let late = try await answer(asking)
            try await settle()
            XCTAssertEqual(late, .cancel, "answer \(leave)")
            XCTAssertEqual(dropped.map { $0?.absoluteString }, [entry], "answer \(leave)")
            XCTAssertEqual(host.currentConnection, reloaded, "answer \(leave): the late answer begins nothing")
            XCTAssertEqual(registry.activeConnectionCount, 1, "answer \(leave)")
            XCTAssertEqual(recoveryReloads, reloadsBefore + 1, "answer \(leave): no second reload")
            host.unsavedWorkCheck = nil
            host.confirmLeavingUnsavedWork = nil
        }
    }

    /// R4-LT-3 without a page: after a content-process termination the host
    /// revokes, tells the app, and reloads once; a second termination within
    /// `terminationReloadInterval` leaves the view to the app; while locked
    /// there is no reload.
    func testContentProcessTerminationReloadsOncePerIntervalAndNotWhileLocked() async throws {
        let live = try await prepareDropTests()
        var terminated = 0
        host.onContentProcessTerminated = { terminated += 1 }
        host.webViewWebContentProcessDidTerminate(host.webView)
        try await settle()
        XCTAssertEqual(terminated, 1)
        XCTAssertEqual(recoveryReloads, 1, "the view is reloaded")
        XCTAssertEqual(registry.check(live.id, generation: live.generation), .staleGeneration)
        XCTAssertNil(host.currentConnection)
        XCTAssertNil(host.committedDocumentURL)

        _ = try await loadDocument(entry, .reload)
        host.webViewWebContentProcessDidTerminate(host.webView)
        try await settle()
        XCTAssertEqual(terminated, 2)
        XCTAssertEqual(recoveryReloads, 1, "a second termination within the interval is left to the app")
        XCTAssertEqual(registry.activeConnectionCount, 0)

        host.terminationReloadInterval = 0
        _ = try await loadDocument(entry, .reload)
        await host.lock()
        host.webViewWebContentProcessDidTerminate(host.webView)
        try await settle()
        XCTAssertEqual(terminated, 3)
        XCTAssertEqual(recoveryReloads, 1, "no reload while locked")
        await host.unlock()
        _ = try await loadDocument(entry, .reload)
        host.webViewWebContentProcessDidTerminate(host.webView)
        try await settle()
        XCTAssertEqual(recoveryReloads, 2, "once the interval has passed, the host reloads again")
        await host.close()
        host.webViewWebContentProcessDidTerminate(host.webView)
        try await settle()
        XCTAssertEqual(terminated, 4, "closed: nothing more")
        XCTAssertEqual(recoveryReloads, 2)
    }
}
