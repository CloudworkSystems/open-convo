import Darwin
@testable import DeskHost
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

// The run core, event and terminal JSON, the confirmation display and the
// availability report (coordinator slice S4; Codex Q12 and Q13). Invented
// data and an invented clock throughout; the live tests at the end start only
// the real supervisor and the fake CLI, never the real CLI.

/// Drives a `ParticipantRunCore` on an invented clock and keeps its effects.
struct CoreHarness {
    static let runId = "71abcdef-0000-4000-8abc-000000000001"
    static let sessionId = "52abcdef-0000-4000-8abc-000000000001"
    static let createdAt: Int64 = 1_791_590_400_000   // 2026-10-10T00:00:00.000Z

    var core: ParticipantRunCore
    var effects: [ParticipantRunCore.Effect] = []
    var now: UInt64 = 0
    var wall: Int64

    init(createdAt: Int64 = Self.createdAt, wall: Int64? = nil, inputBytes: Int = 20, preparedBytes: Int = 1_000,
         expectation: ParticipantInitExpectation = Invented.expectation) {
        core = ParticipantRunCore(
            identity: ParticipantRunIdentity(runId: Self.runId, sessionId: Self.sessionId, createdAtMillis: createdAt),
            configuration: .init(expectedInit: expectation, inputBytes: inputBytes, preparedBytes: preparedBytes))
        self.wall = wall ?? createdAt
    }

    mutating func send(_ event: ParticipantProcessEvent) { effects += core.process(event, monotonic: now, wall: wall) }
    mutating func control(_ message: SupervisorMessage) { send(.control(message)) }
    mutating func feed(_ lines: [String]) { send(.stdout(Data((lines.joined(separator: "\n") + "\n").utf8))) }
    mutating func stop(sent: Bool = true) { effects += core.stopRequested(stopSent: sent, monotonic: now, wall: wall) }
    mutating func tick() { effects += core.tick(monotonic: now, wall: wall) }

    /// Both clocks move forward together, then the timers run.
    mutating func advance(_ millis: UInt64) {
        now += millis
        wall += Int64(millis)
        tick()
    }

    /// The CLI exits with `status`, its pipes close and the group clears.
    mutating func ends(_ status: Int32 = 0) {
        control(.exit(status: status))
        send(.stdoutClosed(totalBytes: 0))
        send(.stderrClosed(totalBytes: 0))
        control(.cleared)
    }

    var updates: [ParticipantRunUpdate] {
        effects.compactMap { if case .update(let update) = $0 { return update } else { return nil } }
    }

    var events: [ParticipantEvent] {
        updates.compactMap { update in
            switch update {
            case .event(let event), .terminal(let event, _): return event
            default: return nil
            }
        }
    }

    var terminals: [(event: ParticipantEvent, groupCleared: Bool?)] {
        updates.compactMap { if case .terminal(let event, let cleared) = $0 { return (event, cleared) } else { return nil } }
    }

    var logs: [ParticipantLogEntry] {
        effects.compactMap { if case .log(let entry) = $0 { return entry } else { return nil } }
    }

    var retries: Int { updates.filter { $0 == .cleanupRetryUncleared }.count }
    var sendStops: Int { effects.filter { $0 == .sendStop }.count }
}

/// The real supervisor engine on a simulated group, its reports fed to a run
/// core as the control socket would deliver them, both on one invented clock.
struct EngineCoreBridge {
    let sim = EngineSimulation()
    var run = CoreHarness()
    private var delivered = 0

    init(memberSurvivesKill: Bool) {
        if memberSurvivesKill {
            sim.group.others = 1
            sim.group.othersDieOn = []
        }
    }

    var engine: SupervisorEngine { sim.engine }

    mutating func forward() {
        while delivered < sim.group.reports.count {
            run.control(sim.group.reports[delivered])
            delivered += 1
        }
    }

    mutating func spawn() {
        sim.spawn()
        forward()
    }

    /// User Stop or the cleanup retry: `stop` reaches the supervisor first,
    /// then the core hears of it.
    mutating func stop() {
        engine.stopRequested(now: sim.group.now)
        run.stop(sent: true)
        forward()
    }

    /// Advances in the driver's 50 ms steps for `millis`.
    mutating func advance(_ millis: UInt64) {
        let end = sim.group.now + millis
        while sim.group.now < end {
            sim.group.now += 50
            sim.deliverExit()
            engine.tick(now: sim.group.now)
            run.now = sim.group.now
            run.wall = CoreHarness.createdAt + Int64(sim.group.now)
            forward()
            run.tick()
        }
    }
}

@Suite("Run core: numbering, at, the one terminal and cleanup")
struct ParticipantRunCoreTests {
    @Test("Events number from 1 and carry the run's ids; the terminal and its groupCleared are one update")
    func numbering() {
        var run = CoreHarness()
        run.control(.spawned)
        run.feed(Invented.passingStream(["Invented", " reply"]))
        run.ends(0)
        #expect(run.events.map(\.type) == [.started, .text, .completed])
        #expect(run.events.map(\.sequence) == [1, 2, 3])
        #expect(run.events.allSatisfy { $0.runId == CoreHarness.runId && $0.sessionId == CoreHarness.sessionId })
        #expect(run.events[1].text == "Invented reply")
        #expect(run.terminals.count == 1)
        #expect(run.terminals.first?.groupCleared == true)
        #expect(!run.updates.contains { if case .event(let event) = $0 { return event.terminal != nil } else { return false } },
                "a terminal is never sent as a plain event")
        #expect(run.updates.last == .cleanupReleased)
        let snapshot = run.core.snapshot
        #expect(snapshot.lastSequence == 3 && snapshot.terminal == run.terminals.first?.event)
        #expect(snapshot.groupCleared == true && snapshot.cleanup == .released)
    }

    @Test("at is the latest of the wall clock, the previous at and createdAt, however the wall clock moves")
    func atRule() {
        let created = CoreHarness.createdAt
        var run = CoreHarness(wall: created - 5_000)
        run.control(.spawned)
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0)])
        #expect(run.events.last?.at == ParticipantTimestamp.format(millis: created), "a wall clock before createdAt")
        run.wall = created + 2_000
        run.feed([Invented.textDelta("first")])
        run.now += 250
        run.tick()
        #expect(run.events.last?.at == ParticipantTimestamp.format(millis: created + 2_000))
        run.wall = created + 1_000
        run.feed([Invented.textDelta("second")])
        run.now += 250
        run.tick()
        #expect(run.events.last?.at == ParticipantTimestamp.format(millis: created + 2_000), "a wall clock that went backwards")
        run.wall = created + 2_001
        run.feed([Invented.result()])
        run.ends(0)
        #expect(run.events.map(\.at) == [created, created + 2_000, created + 2_000, created + 2_001]
            .map { ParticipantTimestamp.format(millis: $0) })

        #expect(ParticipantEventTime.atMillis(wall: 5, previous: 9, createdAt: 7) == 9)
        #expect(ParticipantEventTime.atMillis(wall: 5, previous: 3, createdAt: 7) == 7)
        #expect(ParticipantEventTime.atMillis(wall: 11, previous: 9, createdAt: 7) == 11)
        #expect(ParticipantEventTime.atMillis(wall: -1, previous: -5, createdAt: -3) == -1)
    }

    @Test("groupCleared rides on the terminal: true after cleared, false after uncleared or a lost control socket, null after spawn-failed")
    func terminalGroupCleared() {
        var cleared = CoreHarness()
        cleared.control(.spawned)
        cleared.feed([Invented.initLine()])
        cleared.stop()
        cleared.control(.exit(status: SIGTERM))
        cleared.control(.cleared)
        #expect(cleared.terminals.map(\.groupCleared) == [true])
        #expect(cleared.terminals.first?.event.reason == "local-stop")

        var uncleared = CoreHarness()
        uncleared.control(.spawned)
        uncleared.feed([Invented.initLine()])
        uncleared.stop()
        uncleared.control(.exit(status: SIGTERM))
        uncleared.control(.uncleared)
        #expect(uncleared.terminals.map(\.groupCleared) == [false])
        #expect(uncleared.terminals.first?.event.reason == "stop-incomplete")
        #expect(uncleared.core.snapshot.groupCleared == false && uncleared.core.snapshot.cleanup == .owned)
        uncleared.control(.cleared)
        #expect(uncleared.updates.suffix(2) == [.groupCleared, .cleanupReleased])
        #expect(uncleared.core.snapshot.groupCleared == true, "set true later, with no new terminal")
        #expect(uncleared.terminals.count == 1)

        var lost = CoreHarness()
        lost.control(.spawned)
        lost.feed([Invented.initLine()])
        lost.send(.controlClosed)
        #expect(lost.terminals.map(\.groupCleared) == [false])
        #expect(lost.terminals.first?.event.reason == "process-error")
        #expect(lost.logs.contains { $0.kind == .supervisorLost })
        lost.control(.cleared)
        #expect(!lost.updates.contains(.groupCleared), "never later set true")
        lost.send(.stdoutClosed(totalBytes: 0))
        #expect(!lost.updates.contains(.cleanupReleased))
        lost.send(.stderrClosed(totalBytes: 0))
        #expect(lost.updates.last == .cleanupReleased)
        #expect(lost.core.snapshot.groupCleared == false)

        var spawnFailed = CoreHarness()
        spawnFailed.control(.spawnFailed)
        #expect(spawnFailed.terminals.map(\.groupCleared) == [nil])
        #expect(spawnFailed.terminals.first?.event.sequence == 1)
        #expect(spawnFailed.updates.last == .cleanupReleased)
    }

    @Test("Effects keep the old order: each log where it was, each yield where it was")
    func effectOrder() {
        let id = CoreHarness.runId
        var failed = CoreHarness()
        failed.control(.spawnFailed)
        let event = ParticipantEvent(runId: id, sessionId: CoreHarness.sessionId, sequence: 1,
                                     at: ParticipantTimestamp.format(millis: CoreHarness.createdAt),
                                     type: .failed, reason: "process-error")
        #expect(failed.effects == [
            .log(ParticipantLogEntry(runId: id, kind: .cliSpawnFailed)),
            .update(.terminal(event, groupCleared: nil)),
            .log(ParticipantLogEntry(runId: id, kind: .event, eventType: .failed, sequence: 1, reason: .failure(.processError))),
            .log(ParticipantLogEntry(runId: id, kind: .cleanupReleased)),
            .update(.cleanupReleased)
        ])

        var completed = CoreHarness()
        completed.control(.spawned)
        completed.feed(Invented.passingStream(["ok"]))
        completed.control(.exit(status: 0))
        completed.send(.stdoutClosed(totalBytes: 7))
        completed.effects.removeAll()
        completed.control(.cleared)
        let done = ParticipantEvent(runId: id, sessionId: CoreHarness.sessionId, sequence: 3,
                                    at: ParticipantTimestamp.format(millis: CoreHarness.createdAt), type: .completed)
        #expect(completed.effects == [
            .log(ParticipantLogEntry(runId: id, kind: .groupCleared)),
            .log(ParticipantLogEntry(runId: id, kind: .event, eventType: .completed, sequence: 3)),
            .update(.terminal(done, groupCleared: true)),
            .log(ParticipantLogEntry(runId: id, kind: .cleanupReleased)),
            .update(.cleanupReleased)
        ])

        var text = CoreHarness()
        text.control(.spawned)
        text.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0), Invented.textDelta("abc")])
        text.effects.removeAll()
        text.now += 250
        text.tick()
        #expect(text.effects.count == 2)
        #expect(text.effects.first == .log(ParticipantLogEntry(runId: id, kind: .event, eventType: .text, sequence: 2, byteCount: 3)))

        var quiet = CoreHarness()
        quiet.send(.stderr(Data("invented".utf8)))
        quiet.send(.stdinClosed(writtenBytes: 20, complete: true))
        quiet.send(.supervisorExited(status: 0))
        #expect(quiet.effects == [.log(ParticipantLogEntry(runId: id, kind: .stdinClosed, byteCount: 20)),
                                  .log(ParticipantLogEntry(runId: id, kind: .supervisorExited, exitCode: 0))])
        quiet.send(.stderrClosed(totalBytes: 8))
        #expect(quiet.effects.last == .log(ParticipantLogEntry(runId: id, kind: .stderrClosed, byteCount: 8,
                                                               reason: .stderr(.unrecognized))))
    }

    @Test("A Stop: the caller wrote stop first, so the core logs it and never asks again; native ends ask with .sendStop")
    func stopPath() {
        var sent = CoreHarness()
        sent.control(.spawned)
        sent.feed([Invented.initLine()])
        sent.effects.removeAll()
        sent.stop(sent: true)
        #expect(sent.effects.first == .log(ParticipantLogEntry(runId: CoreHarness.runId, kind: .stopSent)))
        #expect(sent.sendStops == 0, "the stop was already written")
        sent.control(.exit(status: SIGTERM))
        sent.control(.cleared)
        #expect(sent.terminals.first?.event.reason == "local-stop")
        #expect(sent.sendStops == 0)

        var unsent = CoreHarness()
        unsent.control(.spawned)
        unsent.feed([Invented.initLine()])
        unsent.stop(sent: false)
        #expect(!unsent.logs.contains { $0.kind == .stopSent }, "a write that did not go out is not logged as sent")
        #expect(unsent.sendStops == 0)

        var overflow = CoreHarness()
        overflow.control(.spawned)
        overflow.feed([Invented.initLine(), Invented.rateLimit(overageStatus: "allowed", isUsingOverage: true)])
        #expect(overflow.sendStops == 1, "native's own end writes stop")
        #expect(overflow.terminals.isEmpty, "the terminal waits for the group's end")
        overflow.ends(SIGTERM)
        #expect(overflow.terminals.first?.event.reason == "paid-overflow")

        var timeout = CoreHarness()
        timeout.control(.spawned)
        timeout.feed([Invented.initLine()])
        #expect(timeout.core.nextDeadline() == 120_000)
        timeout.advance(119_999)
        #expect(timeout.sendStops == 0)
        timeout.advance(1)
        #expect(timeout.sendStops == 1, "the quiet timeout, from tick")
        #expect(timeout.core.nextDeadline() == nil)
    }

    @Test("With the real supervisor engine: cleanupRetryUncleared once per retry, never from the periodic re-probe")
    func retryWithEngine() {
        var bridge = EngineCoreBridge(memberSurvivesKill: true)
        bridge.spawn()
        bridge.run.feed([Invented.initLine()])
        bridge.stop()
        bridge.advance(12_100)
        #expect(bridge.run.terminals.map(\.groupCleared) == [false])
        #expect(bridge.run.terminals.first?.event.reason == "stop-incomplete")
        #expect(bridge.engine.phase == .uncleared)

        let quiet = bridge.run.updates.count
        bridge.advance(30_000)
        #expect(bridge.run.updates.count == quiet, "six re-probes, each a SIGKILL, report nothing")
        #expect(bridge.sim.group.signals.filter { $0.signal == SIGKILL }.count >= 6)

        bridge.stop()
        bridge.advance(1_950)
        #expect(bridge.run.retries == 0, "the retry probes for 2 s first")
        bridge.advance(100)
        #expect(bridge.run.retries == 1)
        #expect(bridge.run.updates.last == .cleanupRetryUncleared)

        // Stop pressed twice: the second lands while the retry probes and is
        // ignored, so one retry, one answer.
        bridge.stop()
        bridge.advance(500)
        bridge.stop()
        bridge.advance(2_000)
        #expect(bridge.run.retries == 2)
        bridge.advance(20_000)
        #expect(bridge.run.retries == 2)
        #expect(bridge.run.core.snapshot.groupCleared == false && bridge.run.core.snapshot.cleanup == .owned)

        bridge.sim.group.others = 0
        bridge.advance(5_100)
        #expect(bridge.run.updates.suffix(2) == [.groupCleared, .cleanupReleased])
        #expect(bridge.run.retries == 2)
        #expect(bridge.run.terminals.count == 1)
        #expect(bridge.run.core.snapshot.groupCleared == true)
    }

    @Test("With the real supervisor engine: a supervisor lost during the retry's 2 s probe still answers; owned until both EOFs")
    func supervisorLostDuringRetry() {
        var bridge = EngineCoreBridge(memberSurvivesKill: true)
        bridge.spawn()
        bridge.run.feed([Invented.initLine()])
        bridge.stop()
        bridge.advance(12_100)
        #expect(bridge.run.terminals.map(\.groupCleared) == [false])

        bridge.stop()
        bridge.advance(500)
        #expect(bridge.engine.phase == .retrying)
        #expect(bridge.run.retries == 0)
        // The supervisor dies mid-probe; a surviving member holds stdout open.
        bridge.run.send(.stderrClosed(totalBytes: 0))
        let before = bridge.run.effects.count
        bridge.run.send(.controlClosed)
        let lost = Array(bridge.run.effects.dropFirst(before))
        #expect(lost == [.log(ParticipantLogEntry(runId: CoreHarness.runId, kind: .supervisorLost)),
                         .update(.cleanupRetryUncleared)])
        #expect(bridge.run.core.snapshot.groupCleared == false && bridge.run.core.snapshot.cleanup == .owned,
                "the waiting Stop answers cleanup-pending")

        bridge.run.send(.stdoutClosed(totalBytes: 0))
        #expect(bridge.run.updates.last == .cleanupReleased)
        #expect(bridge.run.retries == 1)
        #expect(bridge.run.terminals.count == 1)
        #expect(bridge.run.core.snapshot.groupCleared == false, "never later set true")
    }

    @Test("A group that clears at once never reports a retry")
    func noRetryWhenCleared() {
        var bridge = EngineCoreBridge(memberSurvivesKill: false)
        bridge.spawn()
        bridge.run.feed([Invented.initLine()])
        bridge.stop()
        bridge.advance(200)
        #expect(bridge.run.terminals.map(\.groupCleared) == [true])
        bridge.stop()
        bridge.advance(5_000)
        #expect(bridge.run.retries == 0)
        #expect(bridge.run.updates.last == .cleanupReleased)
    }
}

@Suite("Participant event and terminal JSON")
struct ParticipantEventJSONTests {
    static let runId = CoreHarness.runId
    static let sessionId = CoreHarness.sessionId
    static let at = "2026-10-09T00:01:02.500Z"

    static func event(_ type: ParticipantEventType, sequence: Int, text: String? = nil, reason: String? = nil) -> ParticipantEvent {
        ParticipantEvent(runId: runId, sessionId: sessionId, sequence: sequence, at: at, type: type, text: text, reason: reason)
    }

    static func canonical(_ value: JSONValue) -> String {
        String(decoding: value.canonicalData(), as: UTF8.self)
    }

    @Test("Exact keys for all five types: text only on text, reason only on stopped and failed")
    func exactKeys() throws {
        func expected(_ type: String, sequence: Int, text: String? = nil, reason: String? = nil) -> String {
            "{\"at\":\"\(Self.at)\"," + (reason.map { "\"reason\":\"\($0)\"," } ?? "")
                + "\"runId\":\"\(Self.runId)\",\"sequence\":\(sequence),\"sessionId\":\"\(Self.sessionId)\","
                + (text.map { "\"text\":\"\($0)\"," } ?? "") + "\"type\":\"\(type)\"}"
        }
        let cases: [(ParticipantEvent, String)] = [
            (Self.event(.started, sequence: 1), expected("started", sequence: 1)),
            (Self.event(.text, sequence: 2, text: "Invented."), expected("text", sequence: 2, text: "Invented.")),
            (Self.event(.completed, sequence: 3), expected("completed", sequence: 3)),
            (Self.event(.stopped, sequence: 3, reason: "local-stop"), expected("stopped", sequence: 3, reason: "local-stop")),
            (Self.event(.failed, sequence: 1, reason: "process-error"), expected("failed", sequence: 1, reason: "process-error"))
        ]
        for (event, wire) in cases {
            #expect(Self.canonical(event.jsonValue) == wire)
            let decoded = try #require(ParticipantEvent(jsonValue: event.jsonValue), "\(wire)")
            #expect(Self.canonical(decoded.jsonValue) == wire)
        }
        // A value its type needs but the event lacks is written as null, never left out.
        #expect(Self.canonical(Self.event(.failed, sequence: 1).jsonValue).contains("\"reason\":null"))
        #expect(ParticipantEvent(jsonValue: Self.event(.failed, sequence: 1).jsonValue) == nil)
        #expect(Set(Self.event(.started, sequence: 1, text: "x", reason: "local-stop").jsonValue.objectValue!.keys)
                == ["runId", "sessionId", "sequence", "at", "type"], "keys follow the type, not the stored values")
    }

    @Test("The strict reader refuses anything the page would")
    func strictRefusals() {
        let good = Self.event(.text, sequence: 2, text: "Invented.").jsonValue.objectValue!
        func with(_ changes: [String: JSONValue?]) -> JSONValue {
            var fields = good
            for (key, value) in changes { fields[key] = value }
            return .object(fields)
        }
        #expect(ParticipantEvent(jsonValue: .object(good)) != nil)
        let refused: [(String, JSONValue)] = [
            ("extra key", with(["extra": JSONValue.null])),
            ("missing text", with(["text": nil])),
            ("reason on text", with(["reason": .string("local-stop")])),
            ("empty text", with(["text": .string("")])),
            ("text over 16,384 bytes", with(["text": .string(String(repeating: "é", count: 8_193))])),
            ("text not a string", with(["text": .number(1)])),
            ("text at sequence 1", with(["sequence": .number(1)])),
            ("sequence 0", with(["sequence": .number(0)])),
            ("sequence 2.5", with(["sequence": .number(2.5)])),
            ("sequence as a string", with(["sequence": .string("2")])),
            ("uppercase runId", with(["runId": .string(Self.runId.uppercased())])),
            ("runId not version 4", with(["runId": .string("71abcdef-0000-1000-8abc-000000000001")])),
            ("sessionId not a record id", with(["sessionId": .string("invented-session-id")])),
            ("sessionId equal to runId ignoring case", with(["sessionId": .string(Self.runId.uppercased())])),
            ("at without milliseconds", with(["at": .string("2026-10-09T00:01:02Z")])),
            ("at on February 30", with(["at": .string("2023-02-30T00:00:00.000Z")])),
            ("unknown type", with(["type": .string("delta")])),
            ("not an object", .array([.object(good)]))
        ]
        for (name, value) in refused {
            #expect(ParticipantEvent(jsonValue: value) == nil, "\(name)")
        }
        #expect(ParticipantEvent(jsonValue: with(["text": .string(String(repeating: "é", count: 8_192))])) != nil, "exactly 16,384 bytes")

        func typed(_ type: String, sequence: Int, reason: JSONValue?) -> JSONValue {
            var fields = good
            fields["text"] = nil
            fields["type"] = .string(type)
            fields["sequence"] = .number(Double(sequence))
            fields["reason"] = reason
            return .object(fields)
        }
        #expect(ParticipantEvent(jsonValue: typed("started", sequence: 1, reason: nil)) != nil)
        #expect(ParticipantEvent(jsonValue: typed("started", sequence: 2, reason: nil)) == nil, "started is sequence 1")
        #expect(ParticipantEvent(jsonValue: typed("completed", sequence: 2, reason: nil)) != nil)
        #expect(ParticipantEvent(jsonValue: typed("completed", sequence: 1, reason: nil)) == nil, "completed follows started")
        #expect(ParticipantEvent(jsonValue: typed("completed", sequence: 2, reason: .null)) == nil, "no reason key on completed")
        #expect(ParticipantEvent(jsonValue: typed("stopped", sequence: 1, reason: .string("stop-incomplete"))) != nil)
        #expect(ParticipantEvent(jsonValue: typed("stopped", sequence: 1, reason: .string("timeout"))) == nil)
        #expect(ParticipantEvent(jsonValue: typed("stopped", sequence: 1, reason: nil)) == nil)
        #expect(ParticipantEvent(jsonValue: typed("failed", sequence: 4, reason: .string("reply-too-long"))) != nil)
        #expect(ParticipantEvent(jsonValue: typed("failed", sequence: 4, reason: .string("local-stop"))) == nil)
        #expect(ParticipantEvent(jsonValue: typed("failed", sequence: 4, reason: .null)) == nil)
    }

    @Test("Terminals map to and from DeskHost's run record, reason null for completed")
    func terminalRecords() throws {
        let all: [ParticipantTerminal] = [.completed] + ParticipantStopReason.allCases.map { .stopped($0) }
            + ParticipantFailureReason.allCases.map { .failed($0) }
        #expect(all.count == 7)
        for terminal in all {
            let record = try #require(terminal.record(sequence: 4, at: Self.at))
            #expect(record.type == terminal.type.rawValue && record.reason == terminal.reason && record.sequence == 4 && record.at == Self.at)
            #expect(ParticipantTerminal(record) == terminal)
            let event = try #require(ParticipantEvent(runId: Self.runId, sessionId: Self.sessionId, recorded: record))
            #expect(event.terminal == terminal)
            #expect(event.terminalRecord == record)
            #expect(ParticipantEvent(jsonValue: event.jsonValue) != nil)
        }
        #expect(Self.canonical(ParticipantTerminal.completed.record(sequence: 2, at: Self.at)!.jsonValue)
                == "{\"at\":\"\(Self.at)\",\"reason\":null,\"sequence\":2,\"type\":\"completed\"}")
        #expect(ParticipantTerminal.completed.record(sequence: 1, at: Self.at) == nil, "completed follows started")
        #expect(ParticipantTerminal.failed(.timeout).record(sequence: 3, at: "2026-10-09T00:01:02Z") == nil)
        #expect(ParticipantTerminal(type: "completed", reason: "local-stop") == nil)
        #expect(ParticipantTerminal(type: "stopped", reason: nil) == nil)
        #expect(ParticipantTerminal(type: "failed", reason: "stop-incomplete") == nil)
        #expect(ParticipantTerminal(type: "text", reason: nil) == nil)
        #expect(Self.event(.started, sequence: 1).terminal == nil && Self.event(.started, sequence: 1).terminalRecord == nil)
    }

    @Test("Every event and recorded terminal in the shared vectors reads and writes back byte for byte")
    func vectorEvents() throws {
        let vectors = try ParticipantVectors.load()
        let root = try JSONValue.decode(vectors.data).objectValue!
        var nativeEvents = 0, pageEvents = 0, pageRefused: [JSONValue] = [], records = 0
        func walk(_ value: JSONValue, page: Bool, key: String?) throws {
            switch value {
            case .object(let fields):
                if ["runId", "sessionId", "sequence", "at", "type"].allSatisfy({ fields[$0] != nil }) {
                    if let decoded = ParticipantEvent(jsonValue: value) {
                        #expect(decoded.jsonValue.canonicalData() == value.canonicalData())
                        if page { pageEvents += 1 } else { nativeEvents += 1 }
                    } else if page {
                        pageRefused.append(value)
                    } else {
                        Issue.record("a vector event was refused: \(String(decoding: value.canonicalData(), as: UTF8.self))")
                    }
                }
                if key == "terminal", Set(fields.keys) == ParticipantRunTerminal.keys {
                    let record = try #require(ParticipantRunTerminal(json: value))
                    let terminal = try #require(ParticipantTerminal(record))
                    #expect(terminal.record(sequence: record.sequence, at: record.at)?.jsonValue.canonicalData() == value.canonicalData())
                    records += 1
                }
                for (name, child) in fields { try walk(child, page: page, key: name) }
            case .array(let items):
                for item in items { try walk(item, page: page, key: key) }
            default:
                break
            }
        }
        try walk(root["cases"]!, page: false, key: nil)
        try walk(root["pageCases"]!, page: true, key: nil)
        #expect(nativeEvents == 137, "every event in the 107 wire cases")
        #expect(pageEvents == 31)
        #expect(pageRefused.count == 1, "the page cases' one deliberately malformed push: a text event with a reason")
        #expect(pageRefused.first?.objectValue?["reason"] != nil && pageRefused.first?.objectValue?["type"] == .string("text"))
        #expect(records == 65)
    }
}

@Suite("Availability confirmation display and report")
struct ParticipantConfirmationTests {
    static let confirmedAt = "2026-10-09T00:00:30.000Z"

    static func canonical(_ value: JSONValue) -> String {
        String(decoding: value.canonicalData(), as: UTF8.self)
    }

    @Test("Confirmation JSON: unconfirmed, active with 1-5 runs left, ended by each of seven causes; nothing else")
    func confirmationJSON() throws {
        #expect(Self.canonical(ParticipantConfirmationDisplay.unconfirmed.jsonValue) == "{\"state\":\"unconfirmed\"}")
        for runsLeft in 1...5 {
            let active = try #require(ParticipantConfirmationDisplay.active(confirmedAt: Self.confirmedAt, runsLeft: runsLeft))
            #expect(Self.canonical(active.jsonValue)
                    == "{\"confirmedAt\":\"\(Self.confirmedAt)\",\"runsLeft\":\(runsLeft),\"state\":\"active\"}")
            #expect(ParticipantConfirmationDisplay(jsonValue: active.jsonValue) == active)
            #expect(active.isActive)
        }
        #expect(ParticipantConfirmationEnd.allCases.map(\.rawValue)
                == ["lock", "sleep", "logout", "cli-changed", "login-changed", "run-limit", "paid-overflow"])
        for end in ParticipantConfirmationEnd.allCases {
            let ended = ParticipantConfirmationDisplay.ended(end)
            #expect(Self.canonical(ended.jsonValue) == "{\"endedBy\":\"\(end.rawValue)\",\"state\":\"ended\"}")
            #expect(ParticipantConfirmationDisplay(jsonValue: ended.jsonValue) == ended)
            #expect(!ended.isActive)
        }
        #expect(ParticipantConfirmationDisplay(jsonValue: ParticipantConfirmationDisplay.unconfirmed.jsonValue) == .unconfirmed)

        #expect(ParticipantConfirmationDisplay.active(confirmedAt: Self.confirmedAt, runsLeft: 0) == nil)
        #expect(ParticipantConfirmationDisplay.active(confirmedAt: Self.confirmedAt, runsLeft: 6) == nil)
        #expect(ParticipantConfirmationDisplay.active(confirmedAt: "2026-10-09T00:00:30Z", runsLeft: 5) == nil)
        func active(_ fields: [String: JSONValue]) -> JSONValue {
            .object(["state": .string("active"), "confirmedAt": .string(Self.confirmedAt), "runsLeft": .number(5)]
                .merging(fields) { $1 })
        }
        let refused: [(String, JSONValue)] = [
            ("runsLeft 0", active(["runsLeft": .number(0)])),
            ("runsLeft 6", active(["runsLeft": .number(6)])),
            ("runsLeft -1", active(["runsLeft": .number(-1)])),
            ("runsLeft 2.5", active(["runsLeft": .number(2.5)])),
            ("runsLeft as a string", active(["runsLeft": .string("5")])),
            ("confirmedAt on February 30", active(["confirmedAt": .string("2023-02-30T00:00:00.000Z")])),
            ("confirmedAt without milliseconds", active(["confirmedAt": .string("2026-10-09T00:00:30Z")])),
            ("active with an extra key", active(["account": .string("invented")])),
            ("active without runsLeft", .object(["state": .string("active"), "confirmedAt": .string(Self.confirmedAt)])),
            ("unknown endedBy", .object(["state": .string("ended"), "endedBy": .string("screen-lock")])),
            ("endedBy in capitals", .object(["state": .string("ended"), "endedBy": .string("Lock")])),
            ("empty endedBy", .object(["state": .string("ended"), "endedBy": .string("")])),
            ("ended without endedBy", .object(["state": .string("ended")])),
            ("unconfirmed with an extra key", .object(["state": .string("unconfirmed"), "runsLeft": .number(5)])),
            ("unknown state", .object(["state": .string("confirmed")])),
            ("state not a string", .object(["state": .bool(true)])),
            ("not an object", .string("unconfirmed"))
        ]
        for (name, value) in refused {
            #expect(ParticipantConfirmationDisplay(jsonValue: value) == nil, "\(name)")
        }
    }

    @Test("A present confirmation that is not active never goes with available; active never raises an unavailable answer")
    func reportNormalization() throws {
        let active = try #require(ParticipantConfirmationDisplay.active(confirmedAt: Self.confirmedAt, runsLeft: 2))
        let available = ParticipantAvailability.available

        let omitted = ParticipantAvailabilityReport(availability: available, confirmation: nil)
        #expect(omitted.availability == available, "omitted: the older and fake path keeps its answer")
        #expect(Self.canonical(.object(omitted.jsonFields)) == "{\"available\":true,\"reason\":null}")

        let confirmed = ParticipantAvailabilityReport(availability: available, confirmation: active)
        #expect(confirmed.availability == available)
        #expect(confirmed.confirmation == active)

        for confirmation in [ParticipantConfirmationDisplay.unconfirmed] + ParticipantConfirmationEnd.allCases.map(ParticipantConfirmationDisplay.ended) {
            let report = ParticipantAvailabilityReport(availability: available, confirmation: confirmation)
            #expect(report.availability == .unavailable(.overflowUnverified), "\(confirmation)")
            #expect(report.confirmation == confirmation, "still reported as it is")
            #expect(report.jsonFields["available"] == .bool(false) && report.jsonFields["reason"] == .string("overflow-unverified"))
        }

        for reason in ParticipantUnavailableReason.allCases {
            for confirmation in [nil, active, .unconfirmed, .ended(.runLimit)] as [ParticipantConfirmationDisplay?] {
                let report = ParticipantAvailabilityReport(availability: .unavailable(reason), confirmation: confirmation)
                #expect(report.availability == .unavailable(reason), "the first failing check wins: \(reason)")
                #expect(report.confirmation == confirmation)
            }
        }
        let overridden = ParticipantAvailabilityReport(availability: .unavailable(.providerOverride), confirmation: active)
        #expect(Self.canonical(.object(overridden.jsonFields)) == "{\"available\":false,\"confirmation\":{\"confirmedAt\":\""
                + Self.confirmedAt + "\",\"runsLeft\":2,\"state\":\"active\"},\"reason\":\"provider-override\"}")
    }

    @Test("CheckedAvailability gives the check's answer and no confirmation: shipping unavailable, the fake available")
    func checkedAvailability() async {
        let shipping = await CheckedAvailability(checker: ShippingAvailability()).report()
        #expect(shipping == ParticipantAvailabilityReport(availability: .unavailable(.overflowUnverified), confirmation: nil))
        #expect(shipping.confirmation == nil)
        #expect(shipping.jsonFields["confirmation"] == nil, "the key is omitted")
        let fake = await CheckedAvailability(checker: InventedAvailability()).report()
        #expect(fake.availability.available && fake.confirmation == nil)
    }

    @Test("The report reproduces the entry fields of all eight availability vectors, with and without confirmation")
    func availabilityVectors() throws {
        let vectors = try ParticipantVectors.load()
        let cases = vectors.cases.filter { $0.operation == "participant.availability" }
        #expect(cases.map(\.number) == [2, 3, 4, 5, 98, 99, 100, 101])
        for vector in cases {
            let seed = try #require(vector.seed["availability"]?.objectValue, "#\(vector.number)")
            let availability: ParticipantAvailability
            if seed["result"] == .string("available") {
                availability = .available
            } else {
                let reason = try #require(seed["reason"]?.stringValue.flatMap(ParticipantUnavailableReason.init(rawValue:)))
                availability = .unavailable(reason)
            }
            let confirmation = try seed["confirmation"].map { try #require(ParticipantConfirmationDisplay(jsonValue: $0)) }
            let report = ParticipantAvailabilityReport(availability: availability, confirmation: confirmation)
            guard case .array(let participants)? = vector.reply.objectValue?["participants"],
                  var expected = participants.first?.objectValue else {
                Issue.record("#\(vector.number) has no participant entry")
                continue
            }
            for key in ParticipantPin.keys { expected[key] = nil }
            #expect(JSONValue.object(report.jsonFields).canonicalData() == JSONValue.object(expected).canonicalData(),
                    "#\(vector.number) \(vector.name)")
        }
    }

    @Test("Release path: the report over the shipping check ignores the environment and defaults")
    func reportIgnoresInputs() async {
        let names = ["TRUECONVO_PARTICIPANT_AVAILABLE", "PARTICIPANT_OVERFLOW_CONFIRMED", "TRUECONVO_PARTICIPANT_CONFIRMATION"]
        for name in names { setenv(name, "1", 1) }
        defer { for name in names { unsetenv(name) } }
        UserDefaults.standard.register(defaults: ["TrueConvoParticipantAvailable": true,
                                                  "ParticipantConfirmationActive": true,
                                                  "participant.confirmation": "active"])
        let report = await CheckedAvailability(checker: ShippingAvailability()).report()
        #expect(report.availability == .unavailable(.overflowUnverified))
        #expect(report.confirmation == nil)
    }

    @Test("Release path in a separate process with invented environment, arguments, defaults and flag files: still unavailable")
    func reportProbeProcess() throws {
        try Products.require()
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("report-\(UUID().uuidString.prefix(8))")
        let home = root.appendingPathComponent("home")
        let temporary = root.appendingPathComponent("tmp")
        for folder in [home, temporary] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        defer { try? FileManager.default.removeItem(at: root) }
        for folder in [root, home, temporary] {
            for name in ["participant-available", "participant-confirmation", "overflow-off", "participant.json"] {
                try "{\"available\":true,\"confirmation\":{\"state\":\"active\",\"runsLeft\":5}}"
                    .write(to: folder.appendingPathComponent(name), atomically: false, encoding: .utf8)
            }
        }
        let link = root.appendingPathComponent("ParticipantAvailabilityReportProbe")
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: Products.availabilityProbe)
        let process = Process()
        process.executableURL = link
        process.arguments = ["--participant-available", "--confirmation=active", "-TrueConvoParticipantAvailable", "YES",
                             "-ParticipantConfirmationActive", "1", "--available=true"]
        process.environment = ["HOME": home.path, "TMPDIR": temporary.path + "/", "LANG": "en_US.UTF-8",
                               "PATH": "/usr/bin:/bin", "TRUECONVO_PARTICIPANT_AVAILABLE": "1",
                               "PARTICIPANT_OVERFLOW_CONFIRMED": "1", "TRUECONVO_PARTICIPANT_CONFIRMATION": "active"]
        process.currentDirectoryURL = root
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        #expect(String(decoding: data, as: UTF8.self) == "available=false reason=overflow-unverified confirmation=omitted\n")
    }

    @Test("The report source has no build-configuration branch, reads no input, and cannot make an available answer")
    func reportSource() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/ParticipantProcess/ParticipantConfirmation.swift")
        let code = try String(contentsOf: file, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") }
        #expect(code.count > 50)
        #expect(!code.contains { $0.hasPrefix("#if") || $0.hasPrefix("#elseif") }, "no build-configuration branch")
        for input in ["import Foundation", "ProcessInfo", "UserDefaults", "CommandLine", "getenv", "environ",
                      "FileManager", "fopen", "open(", "Bundle", "NSUserDefaults", "@_spi"] {
            #expect(!code.contains { $0.contains(input) }, "reads no input: \(input)")
        }
        #expect(!code.contains { $0.contains("available: true") }, "never builds an available answer")
        #expect(!code.contains { $0.contains("ParticipantAvailability.available") })
        let implicitAvailable = try NSRegularExpression(pattern: "(^|[^A-Za-z0-9_)\\]])\\.available\\b")
        for line in code {
            let range = NSRange(line.startIndex..., in: line)
            #expect(implicitAvailable.firstMatch(in: line, range: range) == nil, "no `.available` answer: \(line)")
        }
        #expect(code.contains("self.availability = .unavailable(.overflowUnverified)"), "the one change a report makes lowers it")
        #expect(code.contains("init?(jsonValue: JSONValue) {"))
        #expect(!code.contains { $0.contains("public init?(jsonValue") }, "the confirmation decoder is not public: native never reads one in")
    }

    @Test("Nothing in Sources answers available but section 17's owner, or reports one without its confirmation: .available used once, no @testable, CheckedAvailability over ShippingAvailability only")
    func noAvailableInSources() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        struct SourceLine: CustomStringConvertible {
            let file: String
            let line: String
            var description: String { "\(file): \(line)" }
        }
        /// Every Swift file's lines under `folder`, trimmed, comment lines left out.
        func code(under folder: URL) throws -> [SourceLine] {
            let files = (FileManager.default.enumerator(at: folder, includingPropertiesForKeys: nil)?.allObjects ?? [])
                .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
            return try files.flatMap { file in
                try String(contentsOf: file, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.hasPrefix("//") }
                    .map { SourceLine(file: file.lastPathComponent, line: $0) }
            }
        }

        // Only this module can reach the internal answer. Its ways are
        // `.available` as a value, named through its type or `Self`, and the
        // private initializer with `true`; only the definition may use one.
        let module = try code(under: sources.appendingPathComponent("ParticipantProcess"))
        #expect(Set(module.map { $0.file }).count >= 9, "every file in the module is scanned")
        let makesAvailable = try NSRegularExpression(
            pattern: "(^|[^A-Za-z0-9_)\\]?!])\\.available\\b|\\b(ParticipantAvailability|Self)\\s*\\.\\s*available\\b|available:\\s*true")
        let uses = module.filter {
            makesAvailable.firstMatch(in: $0.line, range: NSRange($0.line.startIndex..., in: $0.line)) != nil
        }
        #expect(uses.map { $0.description }.sorted()
                    == ["PaidUsageConfirmation.swift: availability = ParticipantAvailability.available",
                        "ParticipantAvailability.swift: static let available = ParticipantAvailability(available: true, reason: nil)"],
                "only the definition and section 17's owner (plan F4: local checks passing and matching an active confirmation)")

        let all = try code(under: sources)
        #expect(!all.contains { $0.line.contains("@testable") }, "no source reaches the internal answer through @testable")
        // A report without a confirmation is the older path only: a section 17
        // host must source its confirmation, never omit it to pass "available".
        let reporters = all.filter { $0.line.contains("CheckedAvailability(") }
        #expect(!reporters.isEmpty, "the probe's use is found, so the scan sees the other targets")
        for reporter in reporters {
            #expect(reporter.line.contains("CheckedAvailability(checker: ShippingAvailability())"), "\(reporter)")
        }
    }
}

extension ProcessSuites {
    @Suite("Run seams with the fake CLI")
    struct RunSeams {
        @Test("A cleanup retry that ends uncleared is reported once; stop() says only that stop was written")
        func retryUncleared() async throws {
            let live = try LiveRun(.lines([Invented.initLine()], then: ["hang": true]))
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "started") { $0.events.contains { $0.type == .started } }
            // A zombie member no signal removes until this test reaps it.
            let zombie = try #require(Processes.spawnZombieMember(of: cli))
            defer { Processes.reap(zombie) }

            #expect(live.run.stop(), "the supervisor is listening")
            try await live.collector.wait(seconds: 15, for: "terminal") { $0.terminal != nil }
            #expect(live.collector.terminal?.reason == "stop-incomplete")
            #expect(live.collector.terminalUpdate?.groupCleared == false, "carried on the terminal update itself")
            #expect(live.collector.retriesUncleared == 0)

            let retry = ContinuousClock.now
            #expect(live.run.stop(), "the cleanup retry is written")
            let answered = try await live.collector.wait(seconds: 6, for: "retry uncleared") { $0.retriesUncleared == 1 }
            let after = Processes.elapsed(since: retry)
            #expect(after >= 1.9, "one SIGKILL, then a 2 s probe")
            #expect(live.run.snapshot.groupCleared == false && live.run.snapshot.cleanup == .owned)
            #expect(live.collector.events.filter { $0.terminal != nil }.count == 1)
            #expect(Processes.members(cli).contains(zombie))

            Processes.reap(zombie)
            #expect(live.run.stop())
            try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(live.collector.updates.contains(.groupCleared))
            #expect(live.collector.retriesUncleared == 1)
            #expect(live.run.snapshot.groupCleared == true)
            measured("retry-uncleared", [("answered", answered), ("retry", after)])
            await live.finish(group: cli)
        }

        @Test("stop() is false once the control socket is closed: the supervisor is lost and nothing can be signalled")
        func stopAfterControlClosed() async throws {
            let live = try LiveRun(.lines([Invented.initLine(), Invented.rateLimit()], then: ["hang": true]))
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "started") { $0.events.contains { $0.type == .started } }

            _ = kill(live.process.supervisorProcessID, SIGKILL)
            try await live.collector.wait(seconds: 5, for: "terminal") { $0.terminal != nil }
            #expect(live.collector.terminal?.reason == "process-error")
            #expect(live.collector.terminalUpdate?.groupCleared == false)
            #expect(!live.run.stop(), "the write cannot reach a lost supervisor")
            try await Task.sleep(nanoseconds: 300_000_000)
            #expect(Processes.isRunning(cli), "and nothing signalled the CLI")
            #expect(live.collector.events.filter { $0.terminal != nil }.count == 1)

            // The test, not native, ends the fake by its recorded id.
            _ = kill(cli, SIGKILL)
            try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(live.run.snapshot.groupCleared == false, "never later set true")
            #expect(!live.log.entries.contains { $0.kind == .stopSent }, "a write that did not go out is never logged as sent")
            await live.finish(group: cli)
        }
    }
}
