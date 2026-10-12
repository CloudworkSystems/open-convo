import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// The coordinator's read side (plan S7; contract sections 3-5, 9, 10 and
// 12): request shapes and their order, run-mismatch and unknown-run,
// bounded events pages, reads that never wait for the store's writer lock,
// the never-dispatched Stop's write outcomes, availability, identities,
// pushes and the attached Desk stack. Invented data only; nothing here
// starts a process.

/// Blocks the next atomic write before `stage`, inside the store's lock,
/// until released (at most 10 s, so a broken test cannot hang); or fails
/// chosen stages with `EIO`, the later folder-flush retries included while
/// `failFlushRetries` is set.
final class CoordinatorWriteFaults: AtomicWriteFaults, @unchecked Sendable {
    private let lock = NSLock()
    private var blockStage: AtomicWriteStage?
    private var failStage: AtomicWriteStage?
    private var retriesFail = false
    private var holding = false
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)

    func block(before stage: AtomicWriteStage) {
        lock.lock(); defer { lock.unlock() }
        blockStage = stage
    }

    func fail(before stage: AtomicWriteStage?) {
        lock.lock(); defer { lock.unlock() }
        failStage = stage
    }

    var failFlushRetries: Bool {
        get { lock.lock(); defer { lock.unlock() }; return retriesFail }
        set { lock.lock(); defer { lock.unlock() }; retriesFail = newValue }
    }

    /// True while a blocked write is still inside the store.
    var isHolding: Bool {
        lock.lock(); defer { lock.unlock() }
        return holding
    }

    func fault(before stage: AtomicWriteStage, target: URL) -> Int32? {
        lock.lock()
        let blocks = blockStage == stage
        if blocks {
            blockStage = nil
            holding = true
        }
        let fails = failStage == stage
        if fails { failStage = nil }
        lock.unlock()
        if blocks {
            entered.signal()
            _ = release.wait(timeout: .now() + 10)
            lock.lock(); holding = false; lock.unlock()
        }
        return fails ? EIO : nil
    }

    func flushRetryFault(target: URL) -> Int32? {
        failFlushRetries ? EIO : nil
    }
}

@Suite("Participant coordinator: read side")
struct ParticipantCoordinatorReadTests {
    static let runId = "71abcdef-0000-4000-8abc-000000000001"
    static let sessionId = "52abcdef-0000-4000-8abc-000000000001"
    static let handle = "invented-workspace-handle"

    /// A world over a vector case's record and runs (nothing else of it).
    static func world(runsOf name: String, extra: [String: JSONValue] = [:], faults: AtomicWriteFaults? = nil,
                      clock: String = "2026-10-09T00:01:05.000Z") async throws -> VectorWorld {
        let vectors = try ParticipantVectors.load()
        let source = try vectors.named(name)
        var seed: [String: JSONValue] = ["record": source.seed["record"] ?? .null, "runs": source.seed["runs"] ?? .array([])]
        for (key, value) in extra { seed[key] = value }
        return try await VectorWorld(seed: seed, number: source.number, operation: "participant.status", vectors: vectors,
                                     clock: clock, faults: faults)
    }

    static func runs(of name: String) throws -> [JSONValue] {
        guard case .array(let runs)? = try ParticipantVectors.load().named(name).seed["runs"] else { return [] }
        return runs
    }

    static func request(_ operation: HostOperation, _ payload: [String: JSONValue], world: VectorWorld,
                        id: String = UUID().uuidString.lowercased()) -> JSONValue {
        .object([
            "v": .number(1), "requestId": .string(id), "connectionId": .string(world.connectionId),
            "generation": .number(Double(world.connections.currentGeneration)), "operation": .string(operation.rawValue),
            "payload": .object(payload)
        ])
    }

    static func run(runId: String = runId, sessionId: String = sessionId) -> [String: JSONValue] {
        ["workspaceHandle": .string(handle), "runId": .string(runId), "sessionId": .string(sessionId)]
    }

    static func events(after: Double, max: Double, runId: String = runId) -> [String: JSONValue] {
        var payload = run(runId: runId)
        payload["afterSequence"] = .number(after)
        payload["maxEvents"] = .number(max)
        return payload
    }

    // MARK: Shapes

    @Test("Shape refusals in order for every read operation: unknown-field, then invalid-identity, then malformed-envelope, then distinct ids; the handle after the shape")
    func shapeRefusalsInOrder() async throws {
        // A never-dispatched run: a Stop that got past its shape would write.
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart")
        defer { world.clean() }
        let folder = try world.folderSnapshot()
        let upper = Self.runId.uppercased()
        let base = Self.run()
        func with(_ changes: [String: JSONValue?], _ payload: [String: JSONValue] = base) -> [String: JSONValue] {
            var result = payload
            for (key, value) in changes { result[key] = value }
            return result
        }
        let runShapes: [([String: JSONValue], HostRefusal)] = [
            (with(["extra": .number(1), "runId": .string("BAD")]), .unknownField),
            (with(["workspaceHandle": nil]), .invalidIdentity),
            (with(["workspaceHandle": .string("")]), .invalidIdentity),
            (with(["workspaceHandle": .number(1)]), .invalidIdentity),
            (with(["runId": .string(upper)]), .invalidIdentity),
            (with(["runId": .string("71abcdef-0000-1000-8abc-000000000001")]), .invalidIdentity),
            (with(["runId": nil]), .invalidIdentity),
            (with(["sessionId": .string("invented-session")]), .invalidIdentity),
            (with(["sessionId": nil]), .invalidIdentity),
            (with(["sessionId": .string(upper)]), .invalidIdentity),
            (with(["workspaceHandle": .string("invented-other-handle"), "runId": .string("BAD")]), .invalidIdentity),
            (with(["workspaceHandle": .string("invented-other-handle")]), .unknownHandle)
        ]
        for operation in [HostOperation.participantStatus, .participantStop] {
            for (payload, reason) in runShapes {
                let reply = await world.send(Self.request(operation, payload, world: world))
                #expect(reply.outcome == .refused && reply.reason == reason, "\(operation.rawValue) \(payload): \(reply.jsonValue)")
            }
        }

        let good = Self.events(after: 0, max: 64)
        let eventShapes: [([String: JSONValue], HostRefusal)] = [
            (with(["extra": .number(1), "runId": .string("BAD"), "maxEvents": .number(0)], good), .unknownField),
            (with(["runId": .string(upper), "maxEvents": .number(0)], good), .invalidIdentity),
            (with(["sessionId": nil, "afterSequence": .number(-1)], good), .invalidIdentity),
            (with(["maxEvents": .number(0)], good), .malformedEnvelope),
            (with(["maxEvents": .number(65)], good), .malformedEnvelope),
            (with(["maxEvents": .number(1.5)], good), .malformedEnvelope),
            (with(["maxEvents": .string("2")], good), .malformedEnvelope),
            (with(["maxEvents": nil], good), .malformedEnvelope),
            (with(["afterSequence": .number(-1)], good), .malformedEnvelope),
            (with(["afterSequence": .number(9_007_199_254_740_992)], good), .malformedEnvelope),
            (with(["afterSequence": .number(0.5)], good), .malformedEnvelope),
            (with(["afterSequence": .string("0")], good), .malformedEnvelope),
            (with(["afterSequence": nil], good), .malformedEnvelope),
            (with(["sessionId": .string(upper), "maxEvents": .number(0)], good), .malformedEnvelope),
            (with(["sessionId": .string(upper)], good), .invalidIdentity),
            (with(["workspaceHandle": .string("invented-other-handle"), "maxEvents": .number(0)], good), .malformedEnvelope),
            (with(["workspaceHandle": .string("invented-other-handle")], good), .unknownHandle)
        ]
        for (payload, reason) in eventShapes {
            let reply = await world.send(Self.request(.participantEvents, payload, world: world))
            #expect(reply.outcome == .refused && reply.reason == reason, "events \(payload): \(reply.jsonValue)")
        }
        for (after, max) in [(9_007_199_254_740_991.0, 64.0), (0, 1)] {
            let reply = await world.send(Self.request(.participantEvents, Self.events(after: after, max: max), world: world))
            #expect(reply.outcome == .ok && reply.fields["lastSequence"] == .number(0), "the largest safe integer and 1 are accepted")
        }

        let extra = await world.send(Self.request(.participantAvailability, ["workspaceHandle": .string(Self.handle)], world: world))
        #expect(extra.outcome == .refused && extra.reason == .unknownField)
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "no refusal wrote anything")
        #expect(world.sink.take().isEmpty && world.executor.runs == 0)
    }

    // MARK: Run identity

    @Test("run-mismatch on another or differently cased sessionId, unknown-run for a run the durable store lacks, for status, stop and events")
    func runMismatchAndUnknownRun() async throws {
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart")
        defer { world.clean() }
        let folder = try world.folderSnapshot()
        let other = "52abcdef-0000-4000-8abc-000000000002"
        let cased = Self.sessionId.uppercased()
        let unknown = "71abcdef-0000-4000-8abc-000000000009"
        for operation in [HostOperation.participantStatus, .participantStop, .participantEvents] {
            func payload(runId: String = Self.runId, sessionId: String) -> [String: JSONValue] {
                var payload = Self.run(runId: runId, sessionId: sessionId)
                if operation == .participantEvents {
                    payload["afterSequence"] = .number(0)
                    payload["maxEvents"] = .number(8)
                }
                return payload
            }
            for sessionId in [other, cased] {
                let reply = await world.send(Self.request(operation, payload(sessionId: sessionId), world: world))
                #expect(reply.outcome == .refused && reply.reason == .runMismatch, "\(operation.rawValue) \(sessionId)")
            }
            let missing = await world.send(Self.request(operation, payload(runId: unknown, sessionId: Self.sessionId), world: world))
            #expect(missing.outcome == .refused && missing.reason == .unknownRun, "\(operation.rawValue)")
        }
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "a mismatched Stop cancels nothing")
        #expect(world.sink.take().isEmpty && world.executor.runs == 0)
    }

    // MARK: Events

    @Test("An events reply that would pass 1 MiB stops early, always with at least one event; paging returns every event exactly once")
    func eventsReplyIsBounded() async throws {
        // One finished run of this launch with 16 escape-heavy text events:
        // each `\u{1}` is six bytes of canonical JSON, so the 256 KiB of
        // text is about 1.5 MiB as JSON.
        var entry = try #require(try Self.runs(of: "participant.events first page").first?.objectValue)
        let terminalAt = "2026-10-09T00:01:02.000Z"
        entry["terminal"] = .object(["type": .string("completed"), "sequence": .number(18), "at": .string(terminalAt), "reason": .null])
        let world = try await VectorWorld(seed: ["record": .string("prepared-r5"), "runs": .array([.object(entry)])], number: 0,
                                          operation: "participant.events", vectors: try ParticipantVectors.load())
        defer { world.clean() }
        let text = String(repeating: "\u{1}", count: ParticipantLimits.chunkBytes)
        var events = [ParticipantEvent(runId: Self.runId, sessionId: Self.sessionId, sequence: 1, at: "2026-10-09T00:01:01.000Z", type: .started)]
        for sequence in 2...17 {
            events.append(ParticipantEvent(runId: Self.runId, sessionId: Self.sessionId, sequence: sequence, at: "2026-10-09T00:01:01.500Z",
                                           type: .text, text: text))
        }
        events.append(ParticipantEvent(runId: Self.runId, sessionId: Self.sessionId, sequence: 18, at: terminalAt, type: .completed))
        try await world.coordinator.seedRetained(runId: Self.runId, sessionId: Self.sessionId, events: events, lastSequence: 18, lost: nil)
        #expect(events[1].jsonValue.canonicalData().count > 6 * ParticipantLimits.chunkBytes, "control characters escape to six bytes")

        var after = 0
        var received: [JSONValue] = []
        var pages = 0
        while true {
            pages += 1
            let reply = await world.send(Self.request(.participantEvents, Self.events(after: Double(after), max: 64), world: world))
            guard reply.outcome == .ok, case .array(let page)? = reply.fields["events"] else {
                Issue.record("page \(pages): \(reply.outcome)")
                return
            }
            let size = reply.canonicalData().count
            #expect(!page.isEmpty, "at least one event on every page")
            #expect(size <= ParticipantLimits.eventsReplyBytes, "page \(pages) is \(size) bytes")
            #expect(reply.fields["lost"] == .null && reply.fields["terminal"] == .null && reply.fields["lastSequence"] == .number(18))
            received += page
            after += page.count
            let more = reply.fields["more"] == .bool(true)
            #expect(more == (after < 18), "more exactly while events remain")
            if more {
                // One more event would have passed the bound.
                var fields = reply.fields
                fields["events"] = .array(page + [events[after].jsonValue])
                fields["more"] = .bool(after + 1 < 18)
                #expect(HostResponse(echo: reply.echo, outcome: .ok, fields: fields).canonicalData().count > ParticipantLimits.eventsReplyBytes)
            } else {
                break
            }
            guard pages < 30 else { break }
        }
        #expect(pages > 1, "the run did not fit one page")
        #expect(VectorReplay.difference(.array(received), .array(events.map(\.jsonValue))) == nil, "every event once, in order")
        #expect(world.sink.take().isEmpty && world.executor.runs == 0)
    }

    @Test("Codex Q24: a terminal right after afterSequence is the one event, with no zero-length loss; before it, a loss through the terminal minus one")
    func terminalRightAfter() async throws {
        let world = try await Self.world(runsOf: "restart after a pin change: status of a completed run while unavailable")
        defer { world.clean() }
        let terminal: JSONValue = .object(["runId": .string(Self.runId), "sessionId": .string(Self.sessionId), "sequence": .number(3),
                                           "at": .string("2026-10-09T00:01:01.310Z"), "type": .string("completed")])
        let right = await world.send(Self.request(.participantEvents, Self.events(after: 2, max: 64), world: world))
        #expect(right.outcome == .ok)
        #expect(right.fields["events"] == .array([terminal]) && right.fields["lost"] == .null && right.fields["terminal"] == .null)
        #expect(right.fields["more"] == .bool(false) && right.fields["lastSequence"] == .number(3))
        let past = await world.send(Self.request(.participantEvents, Self.events(after: 3, max: 64), world: world))
        #expect(past.fields["events"] == .array([]) && past.fields["lost"] == .null && past.fields["lastSequence"] == .number(3))
        let before = await world.send(Self.request(.participantEvents, Self.events(after: 0, max: 64), world: world))
        #expect(before.fields["events"] == .array([]) && before.fields["terminal"] == terminal)
        #expect(before.fields["lost"] == .object(["fromSequence": .number(1), "throughSequence": .number(2), "reason": .string("restarted")]))
    }

    @Test("Events of this launch's run whose memory another run replaced are lost `replaced`; a never-dispatched run has none")
    func lostReplaced() async throws {
        let world = try await Self.world(runsOf: "participant.events first page")
        defer { world.clean() }
        let other = "71abcdef-0000-4000-8abc-000000000002"
        let otherSession = "52abcdef-0000-4000-8abc-000000000002"
        try await world.coordinator.seedRetained(
            runId: other, sessionId: otherSession,
            events: [ParticipantEvent(runId: other, sessionId: otherSession, sequence: 1, at: "2026-10-09T00:01:03.000Z", type: .started)],
            lastSequence: 1, lost: nil)
        let reply = await world.send(Self.request(.participantEvents, Self.events(after: 1, max: 64), world: world))
        #expect(reply.fields["lost"] == .object(["fromSequence": .number(2), "throughSequence": .number(4), "reason": .string("replaced")]))
        #expect(reply.fields["lastSequence"] == .number(5) && reply.fields["terminal"]?.objectValue?["sequence"] == .number(5))

        let fresh = try await Self.world(runsOf: "participant.status not dispatched after restart")
        defer { fresh.clean() }
        let none = await fresh.send(Self.request(.participantEvents, Self.events(after: 0, max: 64), world: fresh))
        #expect(none.fields["events"] == .array([]) && none.fields["lost"] == .null && none.fields["lastSequence"] == .number(0))
    }

    @Test("The retained-events seed refuses events that are not one contiguous run within the text bound")
    func retainedSeedIsChecked() async throws {
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart")
        defer { world.clean() }
        func event(_ sequence: Int, runId: String = Self.runId, text: String? = nil) -> ParticipantEvent {
            ParticipantEvent(runId: runId, sessionId: Self.sessionId, sequence: sequence, at: "2026-10-09T00:01:01.000Z",
                             type: sequence == 1 ? .started : .text, text: sequence == 1 ? nil : text ?? "invented")
        }
        let big = String(repeating: "x", count: ParticipantLimits.chunkBytes)
        let refused: [([ParticipantEvent], Int)] = [
            ([event(1), event(3)], 3),
            ([event(1), event(2, runId: "71abcdef-0000-4000-8abc-000000000002")], 2),
            ([event(1), event(2)], 1),
            ((1...18).map { event($0, text: big) }, 18)
        ]
        for (events, last) in refused {
            await #expect(throws: ParticipantCoordinator.SeedError.self) {
                try await world.coordinator.seedRetained(runId: Self.runId, sessionId: Self.sessionId, events: events, lastSequence: last, lost: nil)
            }
        }
    }

    // MARK: The store's writer lock

    @Test("Status, events, Stop of an ended run and availability answer while a write holds ProofStore's lock through its flush")
    func readsNeverWaitForTheStoreLock() async throws {
        let faults = CoordinatorWriteFaults()
        let world = try await Self.world(runsOf: "participant.stop after restart: an earlier incomplete stop is not owned", faults: faults)
        defer { world.clean() }
        faults.block(before: .rename)
        let store = world.store
        let finished = DispatchSemaphore(value: 0)
        Thread {
            _ = try? store.markGroupCleared(runId: Self.runId)
            finished.signal()
        }.start()
        #expect(await waitOffPool(faults.entered, seconds: 10), "the write is inside the store's lock")

        let status = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        let events = await world.send(Self.request(.participantEvents, Self.events(after: 0, max: 64), world: world))
        let stop = await world.send(Self.request(.participantStop, Self.run(), world: world))
        let availability = await world.send(Self.request(.participantAvailability, [:], world: world))
        #expect(faults.isHolding, "every answer came while the write still held the lock")
        #expect(status.outcome == .ok && status.fields["state"] == .string("exited") && status.fields["groupCleared"] == .bool(false))
        #expect(events.outcome == .ok && events.fields["lost"]?.objectValue?["reason"] == .string("restarted"))
        #expect(stop.outcome == .ok && stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(false))
        #expect(availability.outcome == .ok)
        #expect(world.executor.runs == 0, "no answer wrote")
        faults.release.signal()
        #expect(await waitOffPool(finished, seconds: 10))
        let cleared = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        #expect(cleared.fields["groupCleared"] == .bool(true), "the published copy follows the durable write")
    }

    // MARK: Never-dispatched Stop

    @Test("A never-dispatched Stop writes through the executor, pushes once to every valid connection and replies exited; a repeat writes and pushes nothing")
    func neverDispatchedStop() async throws {
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart")
        defer { world.clean() }
        let second = "51000000-0000-4000-8000-0000000000b2"
        _ = world.connections.adopt(id: second)
        let id = "62abcdef-0000-4000-8abc-00000000c001"
        let reply = await world.send(Self.request(.participantStop, Self.run(), world: world, id: id))
        let event: JSONValue = .object(["runId": .string(Self.runId), "sessionId": .string(Self.sessionId), "sequence": .number(1),
                                        "at": .string("2026-10-09T00:01:05.000Z"), "type": .string("stopped"), "reason": .string("local-stop")])
        #expect(reply.outcome == .ok && reply.fields == ["runId": .string(Self.runId), "state": .string("exited"), "terminal": event,
                                                         "groupCleared": .null, "providerCancelConfirmed": .bool(false)])
        let pushed = world.sink.take()
        #expect(pushed.count == 2)
        #expect(Set(pushed.compactMap { $0.objectValue?["connectionId"]?.stringValue }) == [world.connectionId, second])
        #expect(pushed.allSatisfy { $0.objectValue?["event"] == event && $0.objectValue?["type"] == .string("participant.event") })
        #expect(world.executor.runs == 1, "the one write went through the executor")
        #expect(world.log.entries.map(\.line) == ["run=\(Self.runId) kind=event event=stopped sequence=1 reason=local-stop"])

        world.virtual.clock.skewWall(by: 60_000)
        let again = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(again.fields == reply.fields, "the one recorded terminal, unchanged")
        #expect(world.sink.take().isEmpty && world.executor.runs == 1)
        let status = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        #expect(status.fields["state"] == .string("exited") && status.fields["lastSequence"] == .number(1)
                && status.fields["groupCleared"] == .null && status.fields["terminal"] == event)
        let events = await world.send(Self.request(.participantEvents, Self.events(after: 0, max: 64), world: world))
        #expect(events.fields["events"] == .array([event]) && events.fields["lost"] == .null)
        #expect(world.hostConfiguration.identities.claimStarting(try #require(UUID(uuidString: id)), payloadHash: "invented") == .claimed,
                "a Stop leaves no identity")
    }

    @Test("Concurrent never-dispatched Stops share one write and one terminal")
    func concurrentStopsShareOneTerminal() async throws {
        let faults = CoordinatorWriteFaults()
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart", faults: faults)
        defer { world.clean() }
        faults.block(before: .rename)
        let first = Task { await world.send(Self.request(.participantStop, Self.run(), world: world)) }
        #expect(await waitOffPool(faults.entered, seconds: 10))
        // A Stop that wrote its own terminal now would name another time.
        world.virtual.clock.skewWall(by: 60_000)
        let second = Task { await world.send(Self.request(.participantStop, Self.run(), world: world)) }
        try await Task.sleep(nanoseconds: 200_000_000)
        faults.release.signal()
        let replies = [await first.value, await second.value]
        #expect(replies.allSatisfy { $0.outcome == .ok && $0.fields["state"] == .string("exited") })
        #expect(replies[0].fields == replies[1].fields)
        #expect(replies[0].fields["terminal"]?.objectValue?["at"] == .string("2026-10-09T00:01:05.000Z"))
        #expect(world.sink.take().count == 1, "pushed once")
        #expect(world.executor.runs == 1, "written once")
    }

    @Test("A never-dispatched Stop whose write fails before its rename is store-corrupt with nothing written; the run stays not-dispatched")
    func stopWriteFailsDefinitely() async throws {
        let faults = CoordinatorWriteFaults()
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart", faults: faults)
        defer { world.clean() }
        let folder = try world.folderSnapshot()
        faults.fail(before: .rename)
        let reply = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(reply.outcome == .refused && reply.reason == .storeCorrupt)
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)
        #expect(world.sink.take().isEmpty && world.executor.runs == 1)
        let status = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        #expect(status.fields["state"] == .string("not-dispatched"))
    }

    @Test("A never-dispatched Stop whose folder flush fails is unknown; the run then reads start-uncertain with no events, never not-dispatched, and a retry keeps the same terminal until it is durable")
    func stopWriteUndetermined() async throws {
        let faults = CoordinatorWriteFaults()
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart", faults: faults)
        defer { world.clean() }
        faults.fail(before: .directoryFlush)
        faults.failFlushRetries = true
        let reply = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(reply.outcome == .unknown && reply.fields.isEmpty)
        #expect(world.sink.take().isEmpty, "nothing pushed before it is durable")
        let visible = try #require(try world.runsOnDisk()?.first?.objectValue)
        #expect(visible["terminal"]?.objectValue?["at"] == .string("2026-10-09T00:01:05.000Z"), "the replacement is visible")

        let status = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        #expect(status.outcome == .ok && status.fields["state"] == .string("unknown")
                && status.fields["unknownReason"] == .string("start-uncertain") && status.fields["lastSequence"] == .number(0))
        // Section 9: native can read the entry and holds the pending
        // terminal, so events is `ok`, agreeing with status: nothing yet.
        for after in [0.0, 1, 5] {
            let events = await world.send(Self.request(.participantEvents, Self.events(after: after, max: 64), world: world))
            #expect(events.outcome == .ok && events.fields == ["runId": .string(Self.runId), "events": .array([]), "more": .bool(false),
                                                               "lastSequence": .number(0), "lost": .null, "terminal": .null],
                    "after \(after): \(events.jsonValue)")
        }

        // A store that refuses the retry before writing: the first attempt
        // may still prove durable, so this is unknown, not a definite
        // store-locked, and the same terminal stays pending.
        world.store.lockStore()
        let locked = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(locked.outcome == .unknown, "\(locked.jsonValue)")
        world.store.unlockStore()
        let stillPending = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        #expect(stillPending.fields["unknownReason"] == .string("start-uncertain"))

        world.virtual.clock.skewWall(by: 60_000)
        let retry = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(retry.outcome == .unknown, "the flush still fails")
        faults.failFlushRetries = false
        let settled = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(settled.outcome == .ok && settled.fields["state"] == .string("exited"))
        #expect(settled.fields["terminal"]?.objectValue?["at"] == .string("2026-10-09T00:01:05.000Z"), "the first attempt's terminal, kept")
        #expect(world.sink.take().count == 1, "pushed once, when durable")
        #expect(world.executor.runs == 4)
        let after = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        #expect(after.fields["state"] == .string("exited"))
        #expect(world.sink.take().isEmpty && world.log.entries.count == 1, "settled once")
    }

    @Test("A never-dispatched Stop on a locked store, with nothing pending, is a definite store-locked that writes nothing; the run stays not-dispatched")
    func stopOnLockedStore() async throws {
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart")
        defer { world.clean() }
        let folder = try world.folderSnapshot()
        world.store.lockStore()
        let reply = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(reply.outcome == .refused && reply.reason == .storeLocked)
        world.store.unlockStore()
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)
        let status = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        #expect(status.fields["state"] == .string("not-dispatched"))
        #expect(world.sink.take().isEmpty)
    }

    @Test("A pending cancellation that another path's folder flush makes durable is pushed and logged once, when a read first sees it, and is then an ordinary ended run")
    func pendingMadeDurableElsewhere() async throws {
        let faults = CoordinatorWriteFaults()
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart", faults: faults)
        defer { world.clean() }
        faults.fail(before: .directoryFlush)
        faults.failFlushRetries = true
        let first = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(first.outcome == .unknown)
        faults.failFlushRetries = false
        // v1's confirmed read retries the flush and publishes what it shows.
        _ = try world.store.read()
        #expect(world.sink.take().isEmpty, "the store's own flush pushes nothing")

        let event: JSONValue = .object(["runId": .string(Self.runId), "sessionId": .string(Self.sessionId), "sequence": .number(1),
                                        "at": .string("2026-10-09T00:01:05.000Z"), "type": .string("stopped"), "reason": .string("local-stop")])
        let status = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        #expect(status.fields["state"] == .string("exited") && status.fields["terminal"] == event && status.fields["lastSequence"] == .number(1))
        let pushed = world.sink.take()
        #expect(pushed.count == 1 && pushed.first?.objectValue?["event"] == event, "pushed once, when first seen durable")
        #expect(world.log.entries.map(\.line) == ["run=\(Self.runId) kind=event event=stopped sequence=1 reason=local-stop"])

        let events = await world.send(Self.request(.participantEvents, Self.events(after: 0, max: 64), world: world))
        #expect(events.fields["events"] == .array([event]))
        let stop = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(stop.outcome == .ok && stop.fields["terminal"] == event)
        #expect(world.sink.take().isEmpty && world.log.entries.count == 1, "never again")
        #expect(world.executor.runs == 1, "only the first attempt wrote")
    }

    // MARK: Status table

    @Test("Status with no live memory: exited for a never-spawned cancellation, exit-unrecorded for a dispatched run without an exit, store-unreadable for a missing store")
    func statusTable() async throws {
        var entry = try #require(try Self.runs(of: "participant.events first page").first?.objectValue)
        entry["terminal"] = .null
        entry["groupCleared"] = .null
        let world = try await VectorWorld(seed: ["record": .string("prepared-r5"), "runs": .array([.object(entry)])], number: 0,
                                          operation: "participant.status", vectors: try ParticipantVectors.load())
        defer { world.clean() }
        // This launch's start, no terminal, nothing in memory: no process to
        // report on, so the durable evidence decides.
        let dispatched = await world.send(Self.request(.participantStatus, Self.run(), world: world))
        #expect(dispatched.fields["state"] == .string("unknown") && dispatched.fields["unknownReason"] == .string("exit-unrecorded")
                && dispatched.fields["lastSequence"] == .null)
        let notOwned = await world.send(Self.request(.participantStop, Self.run(), world: world))
        #expect(notOwned.fields["state"] == .string("not-owned") && notOwned.fields["terminal"] == .null)

        // The same folder reopened with no state.json: a missing store.
        await world.coordinator.detach()
        world.store.close()
        try FileManager.default.removeItem(at: world.store.stateURL)
        let missing = try ProofStore(directory: world.storeDirectory, keys: world.keys, seed: WorkspaceSeed(record: ["revision": .number(0)]))
        defer { missing.close() }
        #expect(missing.status == .missing)
        // The reopened stack: a new host over the reopened store, with the
        // same configuration.
        let reopened = DeskHostProtocol(store: missing, connections: world.connections, drafts: DraftBindingRegistry(), info: VectorWorld.info,
                                        events: world.sink, participants: world.hostConfiguration)
        try await world.coordinator.attach(host: reopened, store: missing, connections: world.connections, sink: world.sink)
        func direct(_ operation: HostOperation, _ payload: [String: JSONValue]) async throws -> HostResponse {
            try await world.coordinator.handle(HostRequest(validating: Self.request(operation, payload, world: world), acceptsParticipant: true))
        }
        let status = try await direct(.participantStatus, Self.run())
        #expect(status.outcome == .ok && status.fields == ["runId": .string(Self.runId), "state": .string("unknown"), "lastSequence": .null,
                                                           "terminal": .null, "groupCleared": .null, "unknownReason": .string("store-unreadable")])
        #expect(try await direct(.participantStop, Self.run()).outcome == .unknown)
        #expect(try await direct(.participantEvents, Self.events(after: 0, max: 64)).outcome == .unknown)
    }

    // MARK: Availability (section 5, Codex Q13)

    @Test("Availability over CheckedAvailability(ShippingAvailability()) is overflow-unverified with no confirmation key and the configured pin")
    func shippingAvailability() async throws {
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart")
        defer { world.clean() }
        let reply = await world.send(Self.request(.participantAvailability, [:], world: world))
        #expect(reply.outcome == .ok)
        let expected: JSONValue = .array([.object([
            "id": .string("claude-code"), "label": .string("Claude Code"), "model": .string("invented-pinned-model"),
            "executionHost": .string("this-mac"), "available": .bool(false), "reason": .string("overflow-unverified")
        ])])
        #expect(VectorReplay.difference(reply.fields["participants"] ?? .null, expected) == nil)
        #expect(reply.fields["participants"]?.arrayValue?.first?.objectValue?["confirmation"] == nil, "the key is omitted")
    }

    @Test("Codex Q13: the report type lowers a present confirmation that is not active to overflow-unverified, and a coordinator with a section 17 owner passes the report through as it is; without an owner (S8) an available answer with a confirmation is lowered to overflow-unverified, the display kept; active never raises an unavailable answer")
    func confirmationDowngrade() async throws {
        let vectors = try ParticipantVectors.load()
        let active = try #require(ParticipantConfirmationDisplay.active(confirmedAt: "2026-10-09T00:00:30.000Z", runsLeft: 3))
        let cases: [(ParticipantAvailability, ParticipantConfirmationDisplay?, Bool, String?)] = [
            (.available, .unconfirmed, false, "overflow-unverified"),
            (.available, .ended(.runLimit), false, "overflow-unverified"),
            (.available, active, true, nil),
            (.available, nil, true, nil),
            (.unavailable(.signedOut), active, false, "signed-out")
        ]
        for (availability, confirmation, available, reason) in cases {
            // The rule's one home: the report's only initializer.
            let report = ParticipantAvailabilityReport(availability: availability, confirmation: confirmation)
            #expect(report.availability.available == available && report.availability.reason?.rawValue == reason)
            let world = try await VectorWorld(seed: [:], number: 0, operation: "participant.availability", vectors: vectors)
            defer { world.clean() }
            for withOwner in [true, false] {
                // A coordinator over a reporter that hands back this report,
                // with a confirmation owner (internal) or without (public).
                let configuration = withOwner
                    ? ParticipantCoordinator.Configuration(
                        hostConfiguration: world.hostConfiguration, availability: SeededAvailability(seeded: report),
                        launchId: vectors.context.launchId, clock: world.virtual.clock, executor: world.executor,
                        launcher: world.launcher, log: world.log, wakeups: VirtualWakeups(world: world.virtual),
                        confirmation: RecordingConfirmationOwner())
                    : ParticipantCoordinator.Configuration(
                        hostConfiguration: world.hostConfiguration, availability: SeededAvailability(seeded: report),
                        launchId: vectors.context.launchId, clock: world.virtual.clock, executor: world.executor,
                        launcher: world.launcher, log: world.log)
                let coordinator = ParticipantCoordinator(configuration: configuration)
                try await coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
                let reply = await coordinator.handle(try HostRequest(validating: Self.request(.participantAvailability, [:], world: world),
                                                                     acceptsParticipant: true))
                let entry = try #require(reply.fields["participants"]?.arrayValue?.first?.objectValue)
                let lowered = !withOwner && available && confirmation != nil
                let expectedReason = lowered ? "overflow-unverified" : reason
                #expect(entry["available"] == .bool(available && !lowered)
                        && entry["reason"] == (expectedReason.map(JSONValue.string) ?? .null), "owner \(withOwner): \(entry)")
                #expect(entry["confirmation"] == confirmation?.jsonValue, "the confirmation is reported as it is")
            }
        }
    }

    // MARK: Identities, start, stack

    @Test("Availability, status, events and Stop claim no request identity; a refused start (here duplicate-run: an earlier launch started the run) leaves none and touches nothing")
    func noIdentityAndNoStart() async throws {
        let world = try await Self.world(runsOf: "restart after a pin change: status of a completed run while unavailable")
        defer { world.clean() }
        let folder = try world.folderSnapshot()
        let reads: [(HostOperation, [String: JSONValue])] = [
            (.participantAvailability, [:]), (.participantStatus, Self.run()), (.participantEvents, Self.events(after: 0, max: 8)),
            (.participantStop, Self.run())
        ]
        for (index, (operation, payload)) in reads.enumerated() {
            let id = String(format: "62abcdef-0000-4000-8abc-0000000d%04d", index)
            let reply = await world.send(Self.request(operation, payload, world: world, id: id))
            #expect(reply.outcome == .ok, "\(operation.rawValue)")
            let requestId = try #require(UUID(uuidString: id))
            #expect(!world.hostConfiguration.identities.isStartId(requestId))
            #expect(world.hostConfiguration.identities.claimStarting(requestId, payloadHash: "invented") == .claimed, "\(operation.rawValue) left no identity")
            world.hostConfiguration.identities.releaseStarting(requestId)
        }
        var start = Self.run()
        start["userMessageId"] = .string("72abcdef-0000-4000-8abc-000000000001")
        start["assistantMessageId"] = .string("73abcdef-0000-4000-8abc-000000000001")
        start["participant"] = world.hostConfiguration.pin.jsonValue
        start["inputChunks"] = .array([.string("Invented question.")])
        let startId = "62abcdef-0000-4000-8abc-0000000e0001"
        let refused = await world.send(Self.request(.participantStart, start, world: world, id: startId))
        #expect(refused.outcome == .refused && refused.reason == .duplicateRun, "\(refused.jsonValue)")
        #expect(world.launcher.requests.isEmpty)
        #expect(!world.hostConfiguration.identities.isStartId(try #require(UUID(uuidString: startId))))
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)
        #expect(world.sink.take().isEmpty && world.executor.runs == 0)
    }

    @Test("Codex Q21: detached, the coordinator answers and pushes nothing; it re-attaches only the same workspace, through a host built over that stack with its configuration, keeping its memory")
    func attachAndDetach() async throws {
        let world = try await Self.world(runsOf: "participant.events first page")
        defer { world.clean() }
        let memory = try ParticipantVectors.load().named("participant.events first page").seed["memory"]
        let seeded = try VectorWorld.retained(try #require(memory), runs: try Self.runs(of: "participant.events first page"), number: 49)
        try await world.coordinator.seedRetained(runId: seeded.runId, sessionId: seeded.sessionId, events: seeded.events,
                                                 lastSequence: seeded.lastSequence, lost: seeded.lost)
        let page = Self.events(after: 1, max: 2)
        let before = await world.send(Self.request(.participantEvents, page, world: world))
        #expect(before.outcome == .ok && before.fields["more"] == .bool(true))

        await world.coordinator.detach()
        let detached = await world.send(Self.request(.participantEvents, page, world: world))
        #expect(detached.outcome == .refused && detached.reason == .unknownConnection, "a request from a detached stack's router")
        #expect(world.coordinator.pushGate.push(seeded.events[0]) == 0 && world.sink.take().isEmpty, "nothing reaches a detached stack")

        // The host must be a participant host over exactly this store and
        // registry, built with this configuration: its identity space (===),
        // pin and input bound.
        let elsewhere = try await Self.world(runsOf: "participant.events first page")
        defer { elsewhere.clean() }
        let otherPin = try #require(ParticipantPin(json: .object([
            "id": .string("claude-code"), "label": .string("Claude Code"), "model": .string("invented-other-model"),
            "executionHost": .string("this-mac")
        ])))
        let mismatched: [(DeskHostProtocol, ProofStore, ConnectionRegistry)] = [
            (elsewhere.host, world.store, world.connections),
            (world.host, world.store, elsewhere.connections),
            (DeskHostProtocol(store: world.store, connections: world.connections, drafts: DraftBindingRegistry(), info: VectorWorld.info),
             world.store, world.connections)
        ]
        for (host, store, connections) in mismatched {
            await #expect(throws: ParticipantCoordinator.AttachError.differentHost) {
                try await world.coordinator.attach(host: host, store: store, connections: connections, sink: world.sink)
            }
        }
        // Another identity space, or another pin, with this stack's host.
        for configuration in [ParticipantHostConfiguration(pin: world.hostConfiguration.pin),
                              ParticipantHostConfiguration(pin: otherPin, identities: world.hostConfiguration.identities),
                              ParticipantHostConfiguration(pin: world.hostConfiguration.pin, inputBound: 4_096,
                                                           identities: world.hostConfiguration.identities)] {
            let other = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
                hostConfiguration: configuration, availability: CheckedAvailability(checker: ShippingAvailability()),
                launchId: world.coordinator.configuration.launchId, clock: world.virtual.clock, executor: world.executor,
                launcher: world.launcher, log: world.log))
            await #expect(throws: ParticipantCoordinator.AttachError.differentHost) {
                try await other.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
            }
        }
        // A host over another folder's store, wired with this configuration.
        let elsewhereHost = DeskHostProtocol(store: elsewhere.store, connections: world.connections, drafts: DraftBindingRegistry(),
                                             info: VectorWorld.info, events: world.sink, participants: world.hostConfiguration)
        await #expect(throws: ParticipantCoordinator.AttachError.differentWorkspace) {
            try await world.coordinator.attach(host: elsewhereHost, store: elsewhere.store, connections: world.connections, sink: world.sink)
        }
        try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        await #expect(throws: ParticipantCoordinator.AttachError.alreadyAttached) {
            try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        }
        // Detach itself keeps the text: the app's close and lock steps drop it
        // first, with `closed` or `locked` (S10; the lifecycle tests), and
        // this bare detach is a test-only path.
        let after = await world.send(Self.request(.participantEvents, page, world: world))
        #expect(after.fields == before.fields, "memory survived the detach")

        // A new document: pushes go to the connections valid now, never a revoked one.
        await world.host.beginGeneration()
        _ = world.sink.take()
        #expect(world.coordinator.pushGate.push(seeded.events[0]) == 0, "no valid connection: retained only")
        let fresh = "51000000-0000-4000-8000-0000000000c3"
        _ = world.connections.adopt(id: fresh)
        #expect(world.coordinator.pushGate.push(seeded.events[0]) == 1)
        #expect(world.sink.take().map { $0.objectValue?["connectionId"] } == [.string(fresh)])
    }

    /// A second coordinator over `world`'s configuration whose store work
    /// runs on `executor`; requests reach it directly.
    static func gatedCoordinator(_ world: VectorWorld, executor: GatedExecutor) throws -> ParticipantCoordinator {
        ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
            hostConfiguration: world.hostConfiguration, availability: CheckedAvailability(checker: ShippingAvailability()),
            launchId: try ParticipantVectors.load().context.launchId, clock: world.virtual.clock, executor: executor,
            launcher: world.launcher, log: world.log))
    }

    @Test("Codex Q21: a detach while attach refreshes the store attaches nothing; a later attach works")
    func detachDuringAttach() async throws {
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart")
        defer { world.clean() }
        let executor = GatedExecutor()
        let coordinator = try Self.gatedCoordinator(world, executor: executor)
        executor.arm()
        let attaching = Task {
            try await coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        }
        #expect(await waitOffPool(executor.entered, seconds: 10), "the attach is refreshing the store")
        await coordinator.detach()
        executor.release.signal()
        await #expect(throws: ParticipantCoordinator.AttachError.detached) { try await attaching.value }
        #expect(!coordinator.pushGate.isOpen, "no stack, so nothing can be pushed")
        let request = try HostRequest(validating: Self.request(.participantStatus, Self.run(), world: world), acceptsParticipant: true)
        let refused = await coordinator.handle(request)
        #expect(refused.outcome == .refused && refused.reason == .unknownConnection)

        try await coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        let status = await coordinator.handle(request)
        #expect(status.outcome == .ok && status.fields["state"] == .string("not-dispatched"))
    }

    @Test("Codex Q21: a Stop on a reopened stack never joins a cancellation still in flight on the earlier stack's store; it waits for it, then decides from its own store")
    func cancellationInFlightAcrossStacks() async throws {
        let world = try await Self.world(runsOf: "participant.status not dispatched after restart")
        defer { world.clean() }
        let executor = GatedExecutor()
        let coordinator = try Self.gatedCoordinator(world, executor: executor)
        try await coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        let stop = try HostRequest(validating: Self.request(.participantStop, Self.run(), world: world), acceptsParticipant: true)

        // The earlier stack's Stop: its write waits on the executor, before
        // the store is touched.
        executor.arm()
        let earlier = Task { await coordinator.handle(stop) }
        #expect(await waitOffPool(executor.entered, seconds: 10))
        // That stack closes and the same folder opens again.
        await coordinator.detach()
        world.store.close()
        let reopened = try ProofStore(directory: world.storeDirectory, keys: world.keys, seed: WorkspaceSeed(record: ["revision": .number(0)]))
        defer { reopened.close() }
        let host = DeskHostProtocol(store: reopened, connections: world.connections, drafts: DraftBindingRegistry(), info: VectorWorld.info,
                                    events: world.sink, participants: world.hostConfiguration)
        try await coordinator.attach(host: host, store: reopened, connections: world.connections, sink: world.sink)
        let later = Task { await coordinator.handle(stop) }
        try await Task.sleep(nanoseconds: 200_000_000)
        executor.release.signal()

        let first = await earlier.value
        #expect(first.outcome == .refused && first.reason == .storeLocked, "the closed store applied nothing: \(first.jsonValue)")
        let second = await later.value
        #expect(second.outcome == .ok && second.fields["state"] == .string("exited"), "decided from the reopened store: \(second.jsonValue)")
        #expect(second.fields["terminal"]?.objectValue?["sequence"] == .number(1))
        #expect(world.sink.take().count == 1, "pushed once, by the write that landed")
        let recorded = try #require(try world.runsOnDisk()?.first?.objectValue?["terminal"]?.objectValue)
        #expect(recorded["at"] == second.fields["terminal"]?.objectValue?["at"] && recorded["sequence"] == .number(1),
                "the reopened store recorded it")
    }
}

/// Runs each piece of store work on its own thread, like `CountingExecutor`;
/// after `arm()`, the next piece waits, before it runs, until `release` is
/// signalled (at most 10 s), signalling `entered` first.
final class GatedExecutor: MutationExecutor, @unchecked Sendable {
    private let lock = NSLock()
    private var armed = false
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)

    func arm() {
        lock.lock(); defer { lock.unlock() }
        armed = true
    }

    /// Whether this piece waits; it disarms the gate.
    private func takeArmed() -> Bool {
        lock.lock(); defer { lock.unlock() }
        let waits = armed
        armed = false
        return waits
    }

    func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        let waits = takeArmed()
        return try await withCheckedThrowingContinuation { continuation in
            Thread {
                if waits {
                    self.entered.signal()
                    _ = self.release.wait(timeout: .now() + 10)
                }
                continuation.resume(with: Result { try work() })
            }.start()
        }
    }
}

// `waitOffPool(_:seconds:)` moved to VectorFaults.swift (S8), unchanged,
// for the start tests and the harness to share.

private extension JSONValue {
    var arrayValue: [JSONValue]? {
        if case .array(let values) = self { return values }
        return nil
    }
}
