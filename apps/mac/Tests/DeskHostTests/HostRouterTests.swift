import Foundation
import Testing
@testable import DeskHost

/// A participant lane that answers every request `ok`, records what it was
/// handed and, while it answers, runs `probe`: what a lane may consult
/// without the store's lock.
final class RecordingLane: ParticipantLane, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [HostRequest] = []
    private var passes = 0
    private let probe: (@Sendable (HostRequest) -> Void)?
    private let pass: (@Sendable () -> Void)?

    /// `pass` runs inside `reconcileBeforeStoreWork()`.
    init(probe: (@Sendable (HostRequest) -> Void)? = nil, pass: (@Sendable () -> Void)? = nil) {
        self.probe = probe
        self.pass = pass
    }

    func handle(_ request: HostRequest) async -> HostResponse {
        record(request)
        probe?(request)
        return .ok(request.echo)
    }

    // The lane's lifecycle (S10), which the router never calls: nothing to
    // stop, write or wait for here.
    func lockNow() {}
    var lockEpoch: Int { 0 }
    var lifecycleEpoch: Int { 0 }
    func unlock(ifNoLockSince epoch: Int) async {}
    func beginShutdown(quitting: Bool) {}
    func finishShutdown(quitting: Bool) async -> ParticipantShutdownReport {
        ParticipantShutdownReport(reachedBound: false, remaining: ParticipantObligations())
    }
    func obligations() async -> ParticipantObligations { ParticipantObligations() }

    /// S9 ruling c's pass before workspace store work: counted, then `pass`.
    func reconcileBeforeStoreWork() async {
        lock.lock()
        passes += 1
        lock.unlock()
        pass?()
    }

    var reconcilePasses: Int {
        lock.lock()
        defer { lock.unlock() }
        return passes
    }

    var requests: [HostRequest] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    private func record(_ request: HostRequest) {
        lock.lock()
        defer { lock.unlock() }
        seen.append(request)
    }
}

/// Runs store work on a dedicated thread, never the shared pool, so a write
/// held inside the store's lock cannot starve the tasks under test.
struct DedicatedThreadExecutor: MutationExecutor {
    func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            Thread { continuation.resume(with: Result { try work() }) }.start()
        }
    }
}

/// Waits for `semaphore` on a dedicated thread, off the shared pool.
func waitOffPool(_ semaphore: DispatchSemaphore, seconds: Double) async -> Bool {
    await withCheckedContinuation { continuation in
        Thread { continuation.resume(returning: semaphore.wait(timeout: .now() + seconds) == .success) }.start()
    }
}

/// One value set from another thread.
final class Box<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value?

    var value: Value? {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}

@Suite("Host router")
struct HostRouterTests {
    private static func participantEnvelope(_ operation: HostOperation, connection: HostConnection, requestId: String = UUID().canonicalString,
                                            extra: [String: String] = [:]) -> Data {
        envelopeJSON(["requestId": "\"\(requestId)\"", "connectionId": "\"\(connection.id)\"", "generation": "\(connection.generation)",
                      "operation": "\"\(operation.rawValue)\""], extra: extra)
    }

    @Test("Without a lane the router is the v1 host (Codex Q1): participant names are unknown-operation on both paths, byte for byte; every other answer is the host's own")
    func nilLaneIsTheV1Host() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let router = HostRouter(hostProtocol: harness.host, lane: nil)
        #expect(!router.acceptsParticipant)

        for operation in DeskHostProtocolTests.participantOperations {
            let typed = harness.request(operation, payload: ["workspaceHandle": .string(harness.handle)])
            #expect(await router.handle(typed) == .refused(.unknownOperation, echo: typed.echo), "\(operation.rawValue)")
            let requestId = UUID().canonicalString
            let echo = HostEcho(requestId: requestId, connectionId: harness.connection.id, generation: 0, operation: operation.rawValue)
            let expected = HostResponse.refused(.unknownOperation, echo: echo).canonicalData()
            let bytes = Self.participantEnvelope(operation, connection: harness.connection, requestId: requestId)
            #expect(await router.handle(data: bytes).canonicalData() == expected)
            let extraKey = Self.participantEnvelope(operation, connection: harness.connection, requestId: requestId, extra: ["path": "\"/tmp\""])
            #expect(await router.handle(data: extraKey).canonicalData() == expected, "refused at the operation, before the envelope keys")
        }

        let malformed: [Data] = [
            Data("not json".utf8), envelopeJSON(dropping: ["requestId"]), envelopeJSON(["v": "2"]),
            envelopeJSON(["operation": "\"provider.run\""]), envelopeJSON(extra: ["path": "\"/\""]),
            Data(repeating: 0x20, count: ProofLimits.envelopeBytes + 1)
        ]
        for data in malformed {
            let routed = await router.handle(data: data).canonicalData()
            let direct = await harness.host.handle(data: data).canonicalData()
            #expect(routed == direct)
        }
        let capabilities = await router.handle(harness.request(.capabilities)).capabilities
        #expect(capabilities?["operations"] == .array(HostOperation.advertised.map { .string($0.rawValue) }), "seven operations")
        let commit = harness.commitRequest(expectedRevision: 0, record: inventedRecord("routed", revision: 1))
        #expect(await router.handle(commit).revision == 1)
        #expect(await router.handle(data: commit.canonicalData()).revision == 1, "the exact bytes replay their one result")
        #expect(try harness.store.read().revision == 1)
    }

    @Test("With a lane, exactly the participant requests that pass v1's preflight reach it, on both paths; every other operation is answered by the workspace host as it would answer alone")
    func laneGetsOnlyParticipantRequests() async throws {
        let configuration = ParticipantHostConfiguration(pin: IdentityInvented.pin)
        let harness = try HostHarness(participants: configuration)
        defer { harness.clean() }
        let lane = RecordingLane()
        let router = HostRouter(hostProtocol: harness.host, lane: lane)
        #expect(router.acceptsParticipant)

        var delivered: [UUID] = []
        for operation in HostOperation.allCases {
            let typed = harness.request(operation)
            let reply = await router.handle(typed)
            if operation.isParticipant {
                #expect(reply == .ok(typed.echo), "\(operation.rawValue) reached the lane")
                delivered.append(typed.requestId)
            } else {
                #expect(reply == (await harness.host.handle(typed)), "\(operation.rawValue) is the workspace host's")
            }
            let requestId = UUID()
            let bytes = Self.participantEnvelope(operation, connection: harness.connection, requestId: requestId.canonicalString)
            let byteReply = await router.handle(data: bytes)
            if operation.isParticipant {
                #expect(byteReply.outcome == .ok && byteReply.operation == operation.rawValue, "\(operation.rawValue) bytes reached the lane")
                delivered.append(requestId)
            } else {
                #expect(byteReply.canonicalData() == (await harness.host.handle(data: bytes)).canonicalData())
            }
        }

        // v1's preflight, in v1's order, before the lane.
        let stale = harness.request(.participantStatus, generation: harness.connection.generation + 1)
        #expect(await router.handle(stale) == .refused(.staleGeneration, echo: stale.echo))
        let guessed = harness.request(.participantStatus, connection: HostConnection(id: "guessed", generation: harness.connection.generation))
        #expect(await router.handle(guessed) == .refused(.unknownConnection, echo: guessed.echo))
        let long = harness.request(.participantStart, payload: ["inputChunks": .array([.string(String(repeating: "x", count: ProofLimits.textItemBytes + 1))])])
        #expect(await router.handle(long) == .refused(.textTooLarge, echo: long.echo))
        let extraKey = Self.participantEnvelope(.participantStop, connection: harness.connection, extra: ["path": "\"/tmp\""])
        #expect(await router.handle(data: extraKey).reason == .unknownField, "an accepted name reaches the envelope-key check")
        #expect(await router.handle(data: Data("not json".utf8)).reason == .malformedEnvelope)

        #expect(lane.requests.map(\.requestId) == delivered, "the lane saw exactly the participant requests, in order")
        #expect(lane.requests.allSatisfy { $0.operation.isParticipant })
        let capabilities = await router.handle(harness.request(.capabilities)).capabilities
        #expect(capabilities?["operations"] == .array(HostOperation.participantAdvertised.map { .string($0.rawValue) }), "twelve operations")
    }

    @Test("S9 ruling c at the router (plan S11): a workspace.commitProof that passes v1's preflight waits for the lane's one pass of owed participant writes before the workspace host sees it, on both paths; a commit refused at preflight, every other workspace operation and every participant request never ask for it; without a lane nothing is asked")
    func commitWaitsForTheLanesPass() async throws {
        let configuration = ParticipantHostConfiguration(pin: IdentityInvented.pin)
        let harness = try HostHarness(participants: configuration)
        defer { harness.clean() }
        let store = harness.store
        let seen = Box<[Int]>()
        let lane = RecordingLane(pass: {
            // The store as the pass finds it: the commit has not reached it.
            let revision = (try? store.read().revision) ?? -1
            seen.value = (seen.value ?? []) + [revision]
        })
        let router = HostRouter(hostProtocol: harness.host, lane: lane)

        let typed = harness.commitRequest(expectedRevision: 0, record: inventedRecord("first", revision: 1))
        #expect(await router.handle(typed).revision == 1)
        #expect(seen.value == [0], "the pass ran before the commit's store work")
        let bytes = harness.commitRequest(expectedRevision: 1, record: inventedRecord("second", revision: 2)).canonicalData()
        #expect(await router.handle(data: bytes).revision == 2)
        #expect(seen.value == [0, 1], "the byte path too")
        #expect(lane.reconcilePasses == 2)

        let stale = harness.commitRequest(expectedRevision: 2, record: inventedRecord("stale", revision: 3),
                                          connection: HostConnection(id: harness.connection.id, generation: harness.connection.generation + 1))
        #expect(await router.handle(stale).reason == .staleGeneration)
        let guessed = harness.commitRequest(expectedRevision: 2, record: inventedRecord("guessed", revision: 3),
                                            connection: HostConnection(id: "guessed", generation: harness.connection.generation))
        #expect(await router.handle(guessed).reason == .unknownConnection)
        #expect(lane.reconcilePasses == 2, "a commit refused at preflight reaches no store work and asks nothing")
        for operation in HostOperation.allCases where operation != .workspaceCommitProof {
            _ = await router.handle(harness.request(operation, payload: ["workspaceHandle": .string(harness.handle)]))
        }
        #expect(lane.reconcilePasses == 2, "no other operation asks for it")
        #expect(HostOperation.allCases.filter(\.waitsForOwedParticipantWrites) == [.workspaceCommitProof])
        #expect(try store.read().revision == 2)

        let plain = try HostHarness()
        defer { plain.clean() }
        let plainRouter = HostRouter(hostProtocol: plain.host, lane: nil)
        #expect(await plainRouter.handle(plain.commitRequest(expectedRevision: 0, record: inventedRecord("plain", revision: 1))).revision == 1,
                "without a lane the commit goes straight to the v1 host")
    }

    @Test("A participant request answers while a commit holds the barrier inside a blocked store write and a read waits behind it in the workspace actor: never mutation-outstanding, no wait (Codex Q20)")
    func participantLaneNeverWaits() async throws {
        let blocker = StoreWriteBlocker()
        let configuration = ParticipantHostConfiguration(pin: IdentityInvented.pin)
        let identities = configuration.identities
        let harness = try HostHarness(executor: DedicatedThreadExecutor(), faults: blocker, participants: configuration)
        defer { harness.clean() }
        let store = harness.store
        let commitId = UUID()
        let probed = Box<(claim: RequestIdentityIndex.StartClaim, durable: Bool, lockedOut: Bool)>()
        let lane = RecordingLane { _ in
            // The lane's own sources: the shared identity space and the published runs copy.
            let claim = identities.claimStarting(commitId, payloadHash: "probe")
            let runs = store.publishedRuns
            probed.value = (claim, runs.durable, blocker.releasedByTimeout)
        }
        let router = HostRouter(hostProtocol: harness.host, lane: lane)

        blocker.arm(.sync)
        defer { blocker.release.signal() }
        let commitRequest = harness.commitRequest(expectedRevision: 0, record: inventedRecord("held", revision: 1), requestId: commitId)
        let commit = Task { await router.handle(commitRequest) }
        try #require(await waitOffPool(blocker.entered, seconds: 30), "the commit's receipt write is inside the store lock")
        #expect(await harness.host.outstandingMutation == commitId, "the commit holds the barrier")
        let readRequest = harness.readRequest()
        let readDone = Box<Bool>()
        let read = Task {
            let reply = await router.handle(readRequest)
            readDone.value = true
            return reply
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        // The commit is suspended in its store work, so only the read,
        // waiting for the store lock inside the workspace actor, can keep
        // this probe out of the actor.
        let host = harness.host
        let actorAnswered = Box<Bool>()
        let actorProbe = Task {
            _ = await host.outstandingMutation
            actorAnswered.value = true
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        let actorBlockedBefore = actorAnswered.value != true

        let began = DispatchTime.now()
        let status = harness.request(.participantStatus, payload: ["workspaceHandle": .string(harness.handle)])
        let reply = await router.handle(status)
        let byteReply = await router.handle(data: Self.participantEnvelope(.participantStop, connection: harness.connection))
        let elapsed = DispatchTime.now().uptimeNanoseconds - began.uptimeNanoseconds
        let answeredWhileHeld = !blocker.releasedByTimeout
        let readStillWaiting = readDone.value != true
        let actorStillBlocked = actorAnswered.value != true
        blocker.release.signal()

        #expect(reply == .ok(status.echo), "answered by the lane, never mutation-outstanding")
        #expect(byteReply.outcome == .ok && byteReply.reason == nil)
        #expect(answeredWhileHeld, "both answered while the write still held the store lock")
        #expect(actorBlockedBefore, "the read was waiting inside the workspace actor before the participant requests were sent")
        #expect(readStillWaiting && actorStillBlocked, "and still was when both participant replies came back")
        #expect(elapsed < 5_000_000_000, "the lane waited \(elapsed / 1_000_000) ms")
        let seen = try #require(probed.value)
        #expect(seen.claim == .v1Identity, "the start lane sees the barrier holder through the shared index")
        #expect(seen.durable && !seen.lockedOut)

        let committed = await commit.value
        #expect(committed.outcome == .ok && committed.revision == 1)
        #expect((await read.value).outcome == .ok, "the read waited for the store, as v1 reads do")
        await actorProbe.value
        #expect(lane.requests.count == 2)
        #expect(identities.claimStarting(commitId, payloadHash: "probe") == .v1Identity, "the durable result keeps the id")
    }

    @Test("Inactive (Codex Q1): nothing in Sources builds a HostRouter, only the coordinator conforms to ParticipantLane, nothing makes an identity index beyond the configuration's default, and only a participant host wires a store to one")
    func inactiveInSources() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let files = try #require(FileManager.default.subpaths(atPath: sources.path)).filter { $0.hasSuffix(".swift") }
        #expect(files.count > 20, "the scan sees the package's sources")
        #expect(files.contains("DeskHost/ParticipantLane.swift") && files.contains("DeskHost/RequestIdentityIndex.swift"))
        var lines: [(file: String, line: String)] = []
        for relative in files {
            let text = try String(contentsOf: sources.appendingPathComponent(relative), encoding: .utf8)
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                let code = line.trimmingCharacters(in: .whitespaces)
                if !code.hasPrefix("//") { lines.append((relative, code)) }
            }
        }
        for construction in ["HostRouter(", "HostRouter.init", ": HostRouter = .init"] {
            #expect(lines.filter { $0.line.contains(construction) }.map(\.file) == [], "\(construction)")
        }
        let conformance = try NSRegularExpression(pattern: #"[:,]\s*ParticipantLane\b"#)
        let conforming = lines.filter { conformance.firstMatch(in: $0.line, range: NSRange($0.line.startIndex..., in: $0.line)) != nil }
        // S7: the coordinator is the one lane. Its target is a dependency of
        // the test target only, and ParticipantProcessTests' gates hold that
        // nothing in Sources constructs it.
        #expect(conforming.map(\.file) == ["ParticipantCoordinator/ParticipantCoordinator.swift"], "the coordinator is the only lane")
        #expect(lines.filter { $0.line.contains("RequestIdentityIndex()") || $0.line.contains("RequestIdentityIndex.init") }.map(\.file)
                == ["DeskHost/ParticipantWire.swift"], "only the configuration's default makes an index")
        #expect(lines.filter { $0.line.contains("setIdentityObserver(") }.map(\.file).sorted()
                == ["DeskHost/DeskHostProtocol.swift", "DeskHost/ProofStore.swift"], "the declaration and the participant host's wiring")
    }
}
