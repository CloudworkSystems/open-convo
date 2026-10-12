@testable import DeskHost
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

// The deterministic tier (plan S5; Codex Q14 and Q15): scripted runs on the
// virtual clock, with the real stream reader and the real supervisor engine,
// and no coordinator. Vector cases are reproduced at run level from the
// shared fixture itself: the same script, process mode, clock, identity and
// sizes, compared with the case's pushed events and recorded terminal byte
// for byte. Invented data only; no process starts here.

/// One run of a vector case, built from the fixture.
struct VectorRunSetup {
    let vector: ParticipantVectors.Case
    let identity: ParticipantRunIdentity
    let configuration: StreamJSONReader.Configuration
    /// The run's entry: from `afterRuns`, else the seed's `runs`.
    let entry: [String: JSONValue]

    init(_ number: Int, _ name: String, in vectors: ParticipantVectors) throws {
        let vector = vectors.cases[number - 1]
        guard vector.name == name else { throw VectorHarnessError.fixture("#\(number) is now \(vector.name)") }
        guard let payload = vector.request.objectValue?["payload"]?.objectValue,
              let runId = payload["runId"]?.stringValue, let sessionId = payload["sessionId"]?.stringValue else {
            throw VectorHarnessError.fixture("#\(number) names no run")
        }
        var entries = vector.afterRuns ?? []
        if case .array(let seeded)? = vector.seed["runs"] { entries += seeded }
        guard let entry = entries.compactMap(\.objectValue).first(where: { $0["runId"]?.stringValue == runId }),
              let createdAt = entry["createdAt"]?.stringValue.flatMap(ParticipantTimestamp.parse),
              let inputBytes = entry["inputBytes"]?.safeIntegerValue,
              let preparedBytes = entry["preparedBytes"]?.safeIntegerValue else {
            throw VectorHarnessError.fixture("#\(number) has no entry for \(runId)")
        }
        self.vector = vector
        self.entry = entry
        identity = ParticipantRunIdentity(runId: runId, sessionId: sessionId, createdAtMillis: createdAt)
        configuration = StreamJSONReader.Configuration(expectedInit: Invented.expectation, inputBytes: inputBytes,
                                                       preparedBytes: preparedBytes)
    }

    var clock: String { vector.seed["clock"]?.stringValue ?? "" }

    var script: [ScriptStep] {
        get throws {
            guard case .array(let steps)? = vector.seed["script"] else { return [] }
            return try steps.map(ScriptStep.init(vector:))
        }
    }

    var memory: [String: JSONValue]? { vector.seed["memory"]?.objectValue }

    /// The seeded memory's retained events.
    var retained: [ParticipantEvent] {
        get throws {
            guard case .array(let events)? = memory?["retained"] else { throw VectorHarnessError.fixture("no retained events") }
            return try events.map { value in
                guard let event = ParticipantEvent(jsonValue: value) else { throw VectorHarnessError.fixture("retained \(value)") }
                return event
            }
        }
    }

    /// Every pushed `participant.event`'s inner event, in order.
    var pushedEvents: [JSONValue] {
        (vector.pushed ?? []).compactMap { push in
            guard push.objectValue?["type"]?.stringValue == "participant.event" else { return nil }
            return push.objectValue?["event"]
        }
    }

    var request: ParticipantLaunchRequest {
        let payload = vector.request.objectValue?["payload"]?.objectValue
        let chunks: [String]
        if case .array(let values)? = payload?["inputChunks"] { chunks = values.compactMap(\.stringValue) } else { chunks = [] }
        return ParticipantLaunchRequest(identity: identity, model: Invented.model, inputChunks: chunks,
                                        inputBytes: configuration.inputBytes, preparedBytes: configuration.preparedBytes)
    }
}

/// Compares events with expected wire events as canonical bytes.
func expectEvents(_ made: [ParticipantEvent], equal expected: [JSONValue], _ label: String,
                  sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(made.count == expected.count, "\(label): \(made.count) events, \(expected.count) expected",
            sourceLocation: sourceLocation)
    for (event, wanted) in zip(made, expected) {
        let difference = VectorReplay.difference(event.jsonValue, wanted)
        #expect(difference == nil, "\(label) sequence \(event.sequence): \(difference ?? "")", sourceLocation: sourceLocation)
    }
}

/// The recorded terminal and `groupCleared` a run's terminal update writes,
/// against the entry's.
func expectTerminal(_ run: ScriptedParticipantRun, recordedAs entry: [String: JSONValue], _ label: String,
                    sourceLocation: SourceLocation = #_sourceLocation) {
    guard let terminal = run.terminalUpdate, let record = terminal.event.terminalRecord,
          let wanted = entry["terminal"] else {
        Issue.record("\(label): no terminal", sourceLocation: sourceLocation)
        return
    }
    let difference = VectorReplay.difference(record.jsonValue, wanted)
    #expect(difference == nil, "\(label) terminal: \(difference ?? "")", sourceLocation: sourceLocation)
    let cleared: JSONValue = terminal.groupCleared.map(JSONValue.bool) ?? .null
    #expect(VectorReplay.difference(cleared, entry["groupCleared"] ?? .string("absent")) == nil,
            "\(label) groupCleared", sourceLocation: sourceLocation)
}

/// Every run's updates, live or virtual, keep these.
func checkRunInvariants(_ updates: [ParticipantRunUpdate], _ label: String,
                        sourceLocation: SourceLocation = #_sourceLocation) {
    func isTerminal(_ update: ParticipantRunUpdate) -> Bool {
        if case .terminal = update { return true }
        return false
    }
    func isEvent(_ update: ParticipantRunUpdate) -> Bool {
        if case .event = update { return true }
        return false
    }
    let events = updates.events
    #expect(events.map(\.sequence) == Array(0..<events.count).map { $0 + 1 },
            "\(label): sequences contiguous from 1", sourceLocation: sourceLocation)
    #expect(updates.filter(isTerminal).count <= 1, "\(label): at most one terminal", sourceLocation: sourceLocation)
    if let terminalIndex = updates.firstIndex(where: isTerminal) {
        #expect(!updates[(terminalIndex + 1)...].contains(where: isEvent),
                "\(label): nothing after the terminal", sourceLocation: sourceLocation)
    }
    #expect(updates.filter { $0 == .cleanupReleased }.count <= 1, "\(label): released once", sourceLocation: sourceLocation)
    #expect(updates.filter { $0 == .overflowObserved }.count <= 1, "\(label): overflow observed at most once",
            sourceLocation: sourceLocation)
    if updates.contains(.groupCleared) {
        #expect(updates.terminalUpdate?.groupCleared == false, "\(label): groupCleared follows a false terminal",
                sourceLocation: sourceLocation)
    }
    if let started = events.firstIndex(where: { $0.type == .started }) {
        #expect(started == 0, "\(label): started first", sourceLocation: sourceLocation)
    }
    for event in events where event.type == .text {
        #expect((1...16_384).contains(event.text?.utf8.count ?? 0), "\(label): text size", sourceLocation: sourceLocation)
    }
    let times = events.compactMap { ParticipantTimestamp.parse($0.at) }
    #expect(times.count == events.count && times == times.sorted(), "\(label): at never goes back",
            sourceLocation: sourceLocation)
}

@Suite("Scripted runs on the virtual clock (plan S5, Codex Q14 and Q15)")
struct ScriptedRunTimingTests {
    static let runId = "71abcdef-0000-4000-8abc-000000000001"
    static let sessionId = "52abcdef-0000-4000-8abc-000000000001"
    static let clock = "2026-10-09T00:01:01.000Z"
    static let createdAt = ParticipantTimestamp.parse("2026-10-09T00:01:00.000Z")!

    static func identity(createdAt: Int64 = createdAt) -> ParticipantRunIdentity {
        ParticipantRunIdentity(runId: runId, sessionId: sessionId, createdAtMillis: createdAt)
    }

    static func configuration(inputBytes: Int = 58, preparedBytes: Int = 554,
                              limits: StreamJSONReaderLimits = .contract) -> StreamJSONReader.Configuration {
        StreamJSONReader.Configuration(expectedInit: Invented.expectation, inputBytes: inputBytes, preparedBytes: preparedBytes,
                                       limits: limits)
    }

    static let opening = [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 50, .rateLimitOK)]

    /// (number, name, where settling ends): the start cases whose timings
    /// the plan reproduces at run level.
    static let startCases: [(Int, String, String)] = [
        (27, "participant.start accepted", "2026-10-09T00:01:01.310Z"),
        (45, "participant.start init mismatch fails at sequence 1", "2026-10-09T00:01:01.000Z"),
        // The script's delta at +100 is still a pending step after the
        // terminal at +50; the dead CLI writes nothing then.
        (46, "participant.start paid overflow in the stream", "2026-10-09T00:01:01.100Z"),
        (47, "participant.start idle timeout", "2026-10-09T00:03:01.100Z"),
        (48, "participant.start reply too long ends after the longest fitting prefix", "2026-10-09T00:01:01.100Z"),
        (77, "participant.start idle timeout whose group survives SIGKILL records groupCleared false",
         "2026-10-09T00:03:13.100Z")
    ]

    @Test("Vector start cases at run level: every pushed event, the recorded terminal and groupCleared, exactly",
          arguments: startCases)
    func vectorStartCase(_ number: Int, _ name: String, _ settledAt: String) throws {
        let vectors = try ParticipantVectors.load()
        let setup = try VectorRunSetup(number, name, in: vectors)
        let world = try VirtualWorld(clock: setup.clock)
        let launcher = ScriptedLauncher(world: world, script: try setup.script,
                                        mode: try SimulatedProcessMode(vector: setup.vector.seed["process"]?.stringValue))
        let handle = try launcher.launch(setup.request)
        let run = try #require(handle as? ScriptedParticipantRun)
        try world.settle()

        #expect(!setup.pushedEvents.isEmpty && setup.entry["terminal"] != .null)
        expectEvents(run.events, equal: setup.pushedEvents, "#\(number)")
        expectTerminal(run, recordedAs: setup.entry, "#\(number)")
        checkRunInvariants(run.recordedUpdates, "#\(number)")
        #expect(world.wallNow == settledAt, "#\(number) settles at \(settledAt), not \(world.wallNow)")
        #expect(launcher.requests.count == 1)
        #expect(launcher.requests.first?.stdin.count == setup.configuration.inputBytes)
        let cleared = run.terminalUpdate?.groupCleared
        #expect(run.snapshot.cleanup == (cleared == true ? .released : .owned))
        #expect(run.snapshot.groupCleared == cleared)
        #expect(run.isFinished == (cleared == true), "the process ends with the group cleared")
        #expect(!run.system.signalledAfterReap && !run.system.reapedWhileAlive)
    }

    @Test("The plan's readings of those cases: text +300 then completed +310; text +350 then timeout +120,100; +132,100 uncleared; paid-overflow +50; process-error at 1; text ending caf then reply-too-long +100")
    func planReadings() throws {
        let vectors = try ParticipantVectors.load()
        func run(_ wanted: Int) throws -> (ScriptedParticipantRun, VirtualWorld) {
            let (number, name, _) = try #require(Self.startCases.first { $0.0 == wanted })
            let setup = try VectorRunSetup(number, name, in: vectors)
            let world = try VirtualWorld(clock: setup.clock)
            let run = world.launch(identity: setup.identity, configuration: setup.configuration,
                                   mode: try SimulatedProcessMode(vector: setup.vector.seed["process"]?.stringValue),
                                   script: try setup.script)
            try world.settle()
            return (run, world)
        }
        func offsets(_ run: ScriptedParticipantRun) -> [Int64] {
            run.events.map { ParticipantTimestamp.parse($0.at)! - ParticipantTimestamp.parse(Self.clock)! }
        }
        let (accepted, _) = try run(27)
        #expect(accepted.events.map(\.type) == [.started, .text, .completed])
        #expect(offsets(accepted) == [0, 300, 310])

        let (idle, _) = try run(47)
        #expect(offsets(idle) == [0, 350, 120_100])
        #expect(idle.events.last?.reason == "timeout" && idle.terminalUpdate?.groupCleared == true)

        let (surviving, survivingWorld) = try run(77)
        #expect(offsets(surviving) == [0, 350, 132_100])
        #expect(surviving.terminalUpdate?.groupCleared == false)
        #expect(surviving.system.signalNames == ["TERM@120100", "KILL@130100"], "SIGTERM, 10 s, one SIGKILL, 2 s probe")
        #expect(surviving.enginePhase == .uncleared, "stable cleanup-pending: its 5 s re-probes are not advanced")
        #expect(surviving.snapshot.cleanup == .owned)
        #expect(survivingWorld.obligation() == nil)

        let (overflow, _) = try run(46)
        #expect(overflow.events.map(\.type) == [.started, .failed] && overflow.events.last?.reason == "paid-overflow")
        #expect(offsets(overflow) == [0, 50])

        let (mismatch, _) = try run(45)
        #expect(mismatch.events.count == 1 && mismatch.events[0].sequence == 1 && mismatch.events[0].reason == "process-error")
        #expect(mismatch.terminalUpdate?.groupCleared == true)

        let (long, _) = try run(48)
        #expect(long.events.map(\.type) == [.started, .text, .failed])
        #expect(long.events[1].text?.hasSuffix("caf") == true && long.events[1].text?.utf8.count == 40, "41 bytes of room; é takes 2")
        #expect(offsets(long) == [0, 100, 100], "decided when the delta that cannot fit arrives")
    }

    @Test("Every ok start in the vectors: its stdin (the chunks joined, no separator) is exactly the entry's inputBytes (Codex Q17)")
    func vectorStdinBytes() throws {
        let vectors = try ParticipantVectors.load()
        var checked = 0
        for vector in vectors.cases where vector.operation == "participant.start"
            && vector.reply.objectValue?["outcome"]?.stringValue == "ok" {
            guard let setup = try? VectorRunSetup(vector.number, vector.name, in: vectors) else { continue }
            #expect(setup.request.stdin.count == setup.configuration.inputBytes, "#\(vector.number)")
            checked += 1
        }
        #expect(checked == 11, "\(checked) ok starts checked")
    }

    // MARK: Stop, cleanup and supervisor loss (seeded memory replayed)

    /// A seeded running run, replayed to the case clock.
    static func replayed(_ setup: VectorRunSetup) throws -> (VirtualWorld, ScriptedParticipantRun) {
        let retained = try setup.retained
        let world = try VirtualWorld(clock: retained[0].at)
        let mode = try SimulatedProcessMode(vector: setup.memory?["process"]?.stringValue)
        let run = try world.replayRunning(identity: setup.identity, configuration: setup.configuration, mode: mode,
                                          retained: retained.filter { $0.type == .started || $0.type == .text })
        try world.advance(toWall: setup.clock)
        return (world, run)
    }

    @Test("Stop on exits-on-sigterm ends at the same millisecond (#66); on survives-sigkill at +12 s, cleanup-pending (#68)",
          arguments: [(66, "participant.stop running", "2026-10-09T00:01:02.000Z"),
                      (68, "participant.stop incomplete: the group survives SIGKILL", "2026-10-09T00:01:14.000Z")])
    func stopTimings(_ number: Int, _ name: String, _ settledAt: String) throws {
        let vectors = try ParticipantVectors.load()
        let setup = try VectorRunSetup(number, name, in: vectors)
        let (world, run) = try Self.replayed(setup)
        #expect(world.obligation() == nil, "a seeded running run is settled as it is")

        #expect(run.stop(), "the stop reached the supervisor")
        try world.settle()
        #expect(setup.pushedEvents.count == 1)
        expectEvents(Array(run.events.dropFirst(2)), equal: setup.pushedEvents, "#\(number)")
        expectTerminal(run, recordedAs: setup.entry, "#\(number)")
        let reply = try #require(setup.vector.reply.objectValue)
        let terminal = try #require(run.terminalUpdate)
        #expect(VectorReplay.difference(terminal.event.jsonValue, reply["terminal"] ?? .null) == nil)
        #expect(VectorReplay.difference(terminal.groupCleared.map(JSONValue.bool) ?? .null, reply["groupCleared"] ?? .null) == nil)
        let state = reply["state"]?.stringValue
        #expect(run.snapshot.cleanup == (state == "exited" ? .released : .owned), "reply state \(state ?? "nil")")
        #expect(world.wallNow == settledAt)
        #expect(run.stopCalls.map(\.sent) == [true])
        #expect(run.system.signals.first.map { ParticipantTimestamp.format(millis: world.clock.wallAtStart + Int64($0.at)) }
                == setup.clock && run.system.signals.first?.signal == SIGTERM, "SIGTERM at the stop's own millisecond")
        checkRunInvariants(run.recordedUpdates, "#\(number)")
    }

    @Test("Cleanup retry (#68, #69, #70): status unchanged at 01:20; a second Stop sends one SIGKILL, probes 2 s, reports uncleared once and records nothing")
    func cleanupRetry() throws {
        let vectors = try ParticipantVectors.load()
        let setup = try VectorRunSetup(68, "participant.stop incomplete: the group survives SIGKILL", in: vectors)
        let (world, run) = try Self.replayed(setup)
        run.stop()
        try world.settle()
        let before = run.recordedUpdates
        try world.advance(toWall: "2026-10-09T00:01:20.000Z")
        #expect(run.recordedUpdates == before, "#69: nothing changes while it waits")
        #expect(run.snapshot.cleanup == .owned && run.snapshot.groupCleared == false)

        #expect(run.stop(), "#70: the retry reaches the supervisor")
        try world.settle()
        #expect(world.wallNow == "2026-10-09T00:01:22.000Z", "one SIGKILL and a 2 s probe")
        #expect(Array(run.recordedUpdates.dropFirst(before.count)) == [.cleanupRetryUncleared])
        #expect(run.events.count == 3, "no new event")
        #expect(run.snapshot.groupCleared == false)
        #expect(run.system.signalNames == ["TERM@1000", "KILL@11000", "KILL@18000", "KILL@19000"],
                "stop, the stop's SIGKILL, the 5 s re-probe's SIGKILL, the retry's SIGKILL")
    }

    @Test("group-clears (#71): settling advances through the next actual probe (01:29), then groupCleared and cleanup released")
    func groupClears() throws {
        let vectors = try ParticipantVectors.load()
        let setup = try VectorRunSetup(68, "participant.stop incomplete: the group survives SIGKILL", in: vectors)
        let (world, run) = try Self.replayed(setup)
        run.stop()
        try world.settle()
        try world.advance(toWall: "2026-10-09T00:01:25.000Z")
        let before = run.recordedUpdates.count
        world.groupClears(run)
        #expect(world.obligation() != nil, "the next probe is still ahead")
        try world.settle()
        #expect(world.wallNow == "2026-10-09T00:01:29.000Z", "re-probes at 01:19, 01:24, 01:29")
        #expect(Array(run.recordedUpdates.dropFirst(before)) == [.groupCleared, .cleanupReleased])
        #expect(run.snapshot.groupCleared == true && run.snapshot.cleanup == .released)
        #expect(run.terminalUpdate?.groupCleared == false, "the terminal itself is never rewritten")
        #expect(run.isFinished)
        #expect(!run.system.signalledAfterReap)
    }

    @Test("Supervisor lost (#80, #82, #83): failed process-error with groupCleared false at once; Stop signals nothing; released only after pipes-close")
    func supervisorLoss() throws {
        let vectors = try ParticipantVectors.load()
        let setup = try VectorRunSetup(80, "supervisor lost mid-run: the run fails process-error and cleanup stays pending",
                                       in: vectors)
        let (world, run) = try Self.replayed(setup)
        world.supervisorDies(run)
        try world.settle()
        #expect(world.wallNow == setup.clock, "a lost supervisor with open pipes is settled; nothing is invented")
        expectEvents(Array(run.events.dropFirst(2)), equal: setup.pushedEvents, "#80")
        expectTerminal(run, recordedAs: setup.entry, "#80")
        #expect(run.snapshot.cleanup == .owned, "#80: cleanup-pending")
        #expect(!run.isFinished)

        let signals = run.system.signals.count
        #expect(!run.stop(), "#82: the control socket is gone; nothing can be signalled")
        #expect(run.system.signals.count == signals)
        #expect(run.recordedUpdates.last == .terminal(run.events.last!, groupCleared: false), "#82: nothing new")

        try world.advance(toWall: "2026-10-09T00:01:20.000Z")
        #expect(run.snapshot.cleanup == .owned, "no EOF is invented")
        world.pipesClose(run)
        try world.settle()
        #expect(run.recordedUpdates.last == .cleanupReleased, "#83: exited")
        #expect(run.snapshot.groupCleared == false, "never later true")
        #expect(run.isFinished)
        checkRunInvariants(run.recordedUpdates, "#80")
    }

    @Test("Seeded running runs stay running when settled (#55, #56); run-script continues them exactly (#57)")
    func seededRunning() throws {
        let vectors = try ParticipantVectors.load()
        let setup = try VectorRunSetup(56, "participant.events while running", in: vectors)
        let (world, run) = try Self.replayed(setup)
        let at = world.now
        try world.settle()
        #expect(world.now == at, "not advanced")
        #expect(run.snapshot.lastSequence == 2 && run.snapshot.terminal == nil)
        #expect(run.enginePhase == .running)

        let next = try VectorRunSetup(57, "participant.events continues after lastSequence grows", in: vectors)
        world.play(try next.script, on: run, untilTerminal: true)
        try world.settle()
        expectEvents(Array(run.events.dropFirst(2)), equal: next.pushedEvents, "#57")
        expectTerminal(run, recordedAs: next.entry, "#57")
        checkRunInvariants(run.recordedUpdates, "#57")
    }

    // MARK: Coalescing, the at rule and bounds

    static func text(_ run: ScriptedParticipantRun) -> [(offset: Int64, text: String)] {
        run.events.filter { $0.type == .text }.map {
            (ParticipantTimestamp.parse($0.at)! - ParticipantTimestamp.parse(clock)!, $0.text!)
        }
    }

    @Test("250 ms: text goes out 250 ms after its first unemitted byte; in this harness a byte arriving at that millisecond joins it (a harness convention, not a run guarantee)")
    func coalescing() throws {
        let world = try VirtualWorld(clock: Self.clock)
        let run = world.launch(identity: Self.identity(), configuration: Self.configuration(), script: Self.opening + [
            ScriptStep(atMs: 100, .textDelta("a")), ScriptStep(atMs: 200, .textDelta("b")), ScriptStep(atMs: 349, .textDelta("c")),
            ScriptStep(atMs: 400, .textDelta("d")), ScriptStep(atMs: 650, .textDelta("e")),
            ScriptStep(atMs: 1_000, .resultSuccess), ScriptStep(atMs: 1_010, .exit(0))
        ])
        try world.settle()
        #expect(Self.text(run).map(\.offset) == [350, 650], "\(Self.text(run))")
        // "e" at 650 meets the 650 flush: the harness fires script steps
        // before timers within a millisecond. The real run's timer and reads
        // race; no vector depends on this order.
        #expect(Self.text(run).map(\.text) == ["abc", "de"], "harness: inputs before timers at one millisecond")
        #expect(run.events.last?.type == .completed && run.events.last?.at == "2026-10-09T00:01:02.010Z")
        checkRunInvariants(run.recordedUpdates, "coalescing")
    }

    @Test("16,384 bytes: a buffer about to pass it goes out at once, cut between scalars; the rest waits its 250 ms")
    func eventSizeBound() throws {
        let world = try VirtualWorld(clock: Self.clock)
        let big = String(repeating: "x", count: 20_000)
        let edge = String(repeating: "y", count: 16_383) + "\u{E9}z"
        let run = world.launch(identity: Self.identity(), configuration: Self.configuration(), script: Self.opening + [
            ScriptStep(atMs: 100, .textDelta(big)), ScriptStep(atMs: 1_000, .textDelta(edge)),
            ScriptStep(atMs: 2_000, .resultSuccess), ScriptStep(atMs: 2_010, .exit(0))
        ])
        try world.settle()
        let texts = Self.text(run)
        #expect(texts.map(\.offset) == [100, 350, 1_000, 1_250])
        #expect(texts.map(\.text.utf8.count) == [16_384, 3_616, 16_383, 3], "é (2 bytes) would pass 16,384, so it starts the next")
        #expect(texts[3].text == "\u{E9}z")
        checkRunInvariants(run.recordedUpdates, "event size")
    }

    @Test("at is the latest of the wall clock, the previous at and createdAt: a createdAt ahead of the clock, and a wall clock that goes back")
    func atClamping() throws {
        // createdAt five seconds ahead of the wall clock.
        let ahead = try VirtualWorld(clock: Self.clock)
        let createdAhead = ParticipantTimestamp.parse("2026-10-09T00:01:06.000Z")!
        let early = ahead.launch(identity: Self.identity(createdAt: createdAhead), configuration: Self.configuration(),
                                 script: Self.opening + [ScriptStep(atMs: 100, .textDelta("early")),
                                                         ScriptStep(atMs: 6_000, .resultSuccess), ScriptStep(atMs: 6_010, .exit(0))])
        try ahead.settle()
        #expect(early.events.map(\.at) == ["2026-10-09T00:01:06.000Z", "2026-10-09T00:01:06.000Z", "2026-10-09T00:01:07.010Z"])

        // The wall clock goes back two seconds at +100, then forward five at +500.
        let back = try VirtualWorld(clock: Self.clock)
        let run = back.launch(identity: Self.identity(), configuration: Self.configuration(),
                              script: Self.opening + [ScriptStep(atMs: 200, .textDelta("late")),
                                                      ScriptStep(atMs: 600, .resultSuccess), ScriptStep(atMs: 610, .exit(0))])
        try back.at(ms: 100) { back.clock.skewWall(by: -2_000) }
        try back.at(ms: 500) { back.clock.skewWall(by: 5_000) }
        try back.settle()
        #expect(run.events.map(\.at) == ["2026-10-09T00:01:01.000Z", "2026-10-09T00:01:01.000Z", "2026-10-09T00:01:04.610Z"],
                "the text's wall time (00:00:59.450) is clamped to the previous at")
        #expect(run.events.map(\.sequence) == [1, 2, 3])
    }

    @Test("Timeouts: init 30 s, no output 120 s, total 15 min, each with the stop sequence on the same millisecond")
    func timeouts() throws {
        let initOnly = try VirtualWorld(clock: Self.clock)
        let noInit = initOnly.launch(identity: Self.identity(), configuration: Self.configuration())
        try initOnly.settle()
        #expect(noInit.events.map(\.sequence) == [1] && noInit.events[0].reason == "timeout")
        #expect(noInit.events[0].at == "2026-10-09T00:01:31.000Z")

        let quietWorld = try VirtualWorld(clock: Self.clock)
        let quiet = quietWorld.launch(identity: Self.identity(), configuration: Self.configuration(), script: Self.opening)
        try quietWorld.settle()
        #expect(quiet.events.map(\.type) == [.started, .failed])
        #expect(quiet.events.last?.at == "2026-10-09T00:03:01.050Z", "120 s after the last output, at +50")

        let totalWorld = try VirtualWorld(clock: Self.clock)
        let deltas = (1...8).map { ScriptStep(atMs: UInt64($0) * 100_000, .textDelta("chunk \($0) ")) }
        let total = totalWorld.launch(identity: Self.identity(), configuration: Self.configuration(), script: Self.opening + deltas)
        try totalWorld.settle()
        #expect(Self.text(total).map(\.offset) == (1...8).map { Int64($0) * 100_000 + 250 })
        #expect(total.events.last?.reason == "timeout" && total.events.last?.at == "2026-10-09T00:16:01.000Z", "15 min after spawn")
        checkRunInvariants(total.recordedUpdates, "total")
    }

    @Test("Bounds end the run when the text that cannot fit arrives: input plus output, the projected run, a line over 1 MiB")
    func bounds() throws {
        let bytesWorld = try VirtualWorld(clock: Self.clock)
        let bytes = bytesWorld.launch(identity: Self.identity(), configuration: Self.configuration(inputBytes: 262_144 - 5),
                                      script: Self.opening + [ScriptStep(atMs: 100, .textDelta("a\u{E9}\u{20AC} more"))])
        try bytesWorld.settle()
        #expect(Self.text(bytes).map(\.text) == ["a\u{E9}"] && Self.text(bytes).map(\.offset) == [100])
        #expect(bytes.events.last?.reason == "reply-too-long" && bytes.events.last?.at == "2026-10-09T00:01:01.100Z")

        let projectedWorld = try VirtualWorld(clock: Self.clock)
        let prepared = 785_408 - 3 - 64 - 3 - 6
        let projected = projectedWorld.launch(identity: Self.identity(), configuration: Self.configuration(preparedBytes: prepared),
                                              script: Self.opening + [ScriptStep(atMs: 100, .textDelta("a\"bc"))])
        try projectedWorld.settle()
        #expect(Self.text(projected).map(\.text) == ["a\"b"], "quotes 2 + a 1 + \\\" 2 + b 1 = 6")
        #expect(projected.events.last?.reason == "reply-too-long" && projected.events.last?.at == "2026-10-09T00:01:01.100Z")

        let lineWorld = try VirtualWorld(clock: Self.clock)
        let longLine = String(repeating: "x", count: 1_048_577)
        let line = lineWorld.launch(identity: Self.identity(), configuration: Self.configuration(),
                                    script: Self.opening + [ScriptStep(atMs: 100, .textDelta("kept")),
                                                            ScriptStep(atMs: 200, .line(longLine))])
        try lineWorld.settle()
        #expect(Self.text(line).map(\.text) == ["kept"] && Self.text(line).map(\.offset) == [200],
                "accepted text goes out before the terminal")
        #expect(line.events.last?.reason == "process-error" && line.events.last?.at == "2026-10-09T00:01:01.200Z")
    }

    /// The bytes the opening, then a first delta of "kept" at 100, write to stdout.
    static let keptOpening = Self.opening + [ScriptStep(atMs: 100, .textDelta("kept"))]
    static var keptOpeningBytes: Int {
        var bytes = 0
        var first = true
        for step in keptOpening {
            for line in step.lines(firstDelta: step.isTextDelta && first) { bytes += line.utf8.count + 1 }
            if step.isTextDelta { first = false }
        }
        return bytes
    }

    @Test("Total stdout bounds: past the reader's bound, or at the spawner's stdoutLimitReached, accepted text goes out, then failed process-error at that millisecond")
    func stdoutBounds() throws {
        let padding = ScriptStep(atMs: 200, .line(String(repeating: "x", count: 100)))
        // The reader's bound (32 MiB in the contract), set just past the opening.
        var limits = StreamJSONReaderLimits.contract
        limits.maxStdoutBytes = Self.keptOpeningBytes + 50
        let readerWorld = try VirtualWorld(clock: Self.clock)
        let reader = readerWorld.launch(identity: Self.identity(), configuration: Self.configuration(limits: limits),
                                        script: Self.keptOpening + [padding])
        try readerWorld.settle()

        // The spawner's bound (also 32 MiB): it keeps what fits, drops the
        // rest and reports the overrun once.
        var processLimits = ParticipantProcessLimits()
        processLimits.stdoutBytes = Self.keptOpeningBytes + 50
        let log = RecordingLog()
        let spawnerWorld = try VirtualWorld(clock: Self.clock)
        let spawner = spawnerWorld.launch(identity: Self.identity(), configuration: Self.configuration(),
                                          script: Self.keptOpening + [padding], processLimits: processLimits, log: log)
        try spawnerWorld.settle()

        for (label, run) in [("reader", reader), ("spawner", spawner)] {
            #expect(Self.text(run).map(\.text) == ["kept"] && Self.text(run).map(\.offset) == [200], "\(label)")
            #expect(run.events.map(\.type) == [.started, .text, .failed], "\(label)")
            #expect(run.events.last?.reason == "process-error" && run.events.last?.at == "2026-10-09T00:01:01.200Z", "\(label)")
            #expect(run.terminalUpdate?.groupCleared == true && run.isFinished, "\(label)")
            checkRunInvariants(run.recordedUpdates, label)
        }
        #expect(log.entries.first { $0.kind == .stdoutClosed }?.byteCount == Self.keptOpeningBytes + 101,
                "the log counts every byte read, kept or dropped")
    }

    @Test("stderr: kept to 65,536 bytes, logged only as a byte count and a fixed reason read from the kept bytes, never an event")
    func stderrBound() throws {
        func run(_ text: String) throws -> (ScriptedParticipantRun, ParticipantLogEntry?) {
            let log = RecordingLog()
            let world = try VirtualWorld(clock: Self.clock)
            let run = world.launch(identity: Self.identity(), configuration: Self.configuration(),
                                   script: Self.opening + [ScriptStep(atMs: 100, .stderr(text)), ScriptStep(atMs: 200, .exit(1))],
                                   log: log)
            try world.settle()
            return (run, log.entries.first { $0.kind == .stderrClosed })
        }
        let signedOut = "Error: Not logged in. Please run /login\n"
        let (plain, plainLog) = try run(signedOut)
        #expect(plain.events.map(\.type) == [.started, .failed] && plain.events.last?.reason == "process-error")
        #expect(plain.events.last?.at == "2026-10-09T00:01:01.200Z")
        #expect(plainLog?.reason == .stderr(.signedOut) && plainLog?.byteCount == signedOut.utf8.count)
        #expect(plainLog.map { !$0.line.contains("logged") } == true, "the text itself is never logged")

        // Past the bound, the reason reads only the kept bytes; the count is every byte.
        let padded = String(repeating: "x", count: 65_536) + signedOut
        let (long, longLog) = try run(padded)
        #expect(longLog?.reason == .stderr(.unrecognized) && longLog?.byteCount == padded.utf8.count)
        #expect(long.events.map(\.type) == [.started, .failed])
        checkRunInvariants(long.recordedUpdates, "stderr")
    }

    @Test("Exit-decision grace: with stdout EOF late, a cleared group waits 1 s, then decides from the exit; an EOF within it decides at once")
    func exitDecisionGrace() throws {
        func run(_ script: [ScriptStep], eofAt: UInt64) throws -> (ScriptedParticipantRun, VirtualWorld) {
            let world = try VirtualWorld(clock: Self.clock)
            let run = world.launch(identity: Self.identity(), configuration: Self.configuration(), script: script)
            try world.delayPipeEOF(run, until: eofAt)
            try world.settle()
            return (run, world)
        }
        let completing = Self.opening + [ScriptStep(atMs: 100, .textDelta("reply")), ScriptStep(atMs: 300, .resultSuccess),
                                          ScriptStep(atMs: 310, .exit(0))]
        let (late, lateWorld) = try run(completing, eofAt: 5_000)
        #expect(late.events.map(\.type) == [.started, .text, .completed])
        #expect(late.events.last?.at == "2026-10-09T00:01:02.310Z", "cleared at +310, decided at +1,310")
        #expect(lateWorld.wallNow == "2026-10-09T00:01:06.000Z" && late.isFinished, "the held EOF still arrives")
        checkRunInvariants(late.recordedUpdates, "late EOF")

        let (early, _) = try run(completing, eofAt: 800)
        #expect(early.events.last?.type == .completed && early.events.last?.at == "2026-10-09T00:01:01.800Z")

        let resultless = Self.opening + [ScriptStep(atMs: 100, .textDelta("reply")), ScriptStep(atMs: 310, .exit(0))]
        let (failed, _) = try run(resultless, eofAt: 5_000)
        #expect(failed.events.map(\.type) == [.started, .text, .failed] && failed.events.last?.reason == "process-error")
        #expect(Self.text(failed).map(\.offset) == [350])
        #expect(failed.events.last?.at == "2026-10-09T00:01:02.310Z", "exit 0 without a result, decided when the grace ends")
    }

    @Test("A supervisor that cannot spawn the CLI: failed process-error at sequence 1, groupCleared null, released at once, nothing signalled")
    func spawnFails() throws {
        let world = try VirtualWorld(clock: Self.clock)
        let run = world.launch(identity: Self.identity(), configuration: Self.configuration(), mode: .spawnFails,
                               script: Self.opening)
        try world.settle()
        #expect(run.events.map(\.sequence) == [1] && run.events[0].reason == "process-error")
        #expect(run.events[0].at == Self.clock)
        #expect(run.terminalUpdate.map { $0.groupCleared == nil } == true)
        #expect(run.snapshot.cleanup == .released && run.isFinished)
        #expect(run.system.signals.isEmpty)
        #expect(!run.stop())
    }

    @Test("A Stop on the virtual run: accepted text, then stopped local-stop with SIGTERM at the same millisecond (timing and shape; the live stop test shows the order)")
    func stopOrdering() throws {
        let world = try VirtualWorld(clock: Self.clock)
        let run = world.launch(identity: Self.identity(), configuration: Self.configuration(),
                               script: Self.opening + [ScriptStep(atMs: 100, .textDelta("partial"))], untilTerminal: false)
        try world.advance(to: 200)
        #expect(run.stop())
        #expect(run.events.map(\.type) == [.started, .text, .stopped], "accepted text first, then the terminal")
        #expect(run.events.map(\.at).last == "2026-10-09T00:01:01.200Z")
        #expect(run.events.last?.reason == "local-stop")
        #expect(run.system.signalNames == ["TERM@200"])
        #expect(run.isFinished)
        try world.settle()
        #expect(world.now == 200)
    }

    // MARK: The harness itself

    @Test("Settling has a bound: a case that never settles fails instead of hanging")
    func settleBound() throws {
        let world = try VirtualWorld(clock: Self.clock)
        func again() { _ = try? world.at(ms: world.now + 1_000, again) }
        try world.at(ms: 0, again)
        #expect(throws: VirtualWorldError.self) { try world.settle(maxAdvances: 50) }

        let slow = try VirtualWorld(clock: Self.clock)
        slow.launch(identity: Self.identity(), configuration: Self.configuration(), script: Self.opening)
        #expect(throws: VirtualWorldError.self) { try slow.settle(maxAdvances: 3) }
        try slow.settle()
        #expect(slow.wallNow == "2026-10-09T00:03:01.050Z", "the same run settles within the default bound")
    }

    final class Count: @unchecked Sendable { var value = 0 }

    /// A world whose one timeline entry, at 0, adds itself again at `now`
    /// every time it runs (Codex S5 review, R2).
    static func zeroTimeLoop(bound: Int?) throws -> (VirtualWorld, Count) {
        let world = try VirtualWorld(clock: Self.clock)
        if let bound { world.sameTimeWorkBound = bound }
        let count = Count()
        func again() {
            count.value += 1
            _ = try? world.at(ms: world.now, again)
        }
        try world.at(ms: 0, again)
        return (world, count)
    }

    @Test("Work within one millisecond has a bound: an entry that keeps adding itself at now fails notSettled through settle, advance and the draining settle, after exactly the bound, instead of hanging")
    func sameTimeBound() async throws {
        let (settling, settled) = try Self.zeroTimeLoop(bound: 500)
        #expect(throws: VirtualWorldError.self) { try settling.settle(maxAdvances: 1) }
        #expect(settled.value == 500 && settling.now == 0, "the budget, then the throw, at the same millisecond")

        let (advancing, advanced) = try Self.zeroTimeLoop(bound: 500)
        #expect(throws: VirtualWorldError.self) { try advancing.advance(to: 10) }
        #expect(advanced.value == 500)

        let (draining, drained) = try Self.zeroTimeLoop(bound: 500)
        let drains = Count()
        await #expect(throws: VirtualWorldError.self) {
            try await draining.settle(maxAdvances: 1, draining: { drains.value += 1 })
        }
        #expect(drained.value == 500 && drains.value == 1, "the first step throws; no drain after it")

        // The default bound and default advance bounds fail finitely too.
        let (defaulted, count) = try Self.zeroTimeLoop(bound: nil)
        #expect(throws: VirtualWorldError.self) { try defaulted.settle() }
        #expect(count.value == defaulted.sameTimeWorkBound && count.value == 10_000)
        let (defaultAdvance, advanceCount) = try Self.zeroTimeLoop(bound: nil)
        #expect(throws: VirtualWorldError.self) { try defaultAdvance.advance(to: 0) }
        #expect(advanceCount.value == 10_000)

        // Work a draining coordinator adds at now between steps is one
        // advance each: the advance bound ends it when it is the lower one.
        let world = try VirtualWorld(clock: Self.clock)
        try world.at(ms: 0) {}
        let added = Count()
        await #expect(throws: VirtualWorldError.self) {
            try await world.settle(maxAdvances: 50, draining: {
                added.value += 1
                _ = try? world.at(ms: world.now) {}
            })
        }
        #expect(added.value == 51, "the first drain, then one after each of 50 advances")

        // The budget holds across those steps while the millisecond stays the
        // same, so it ends the same loop under the default advance bound:
        // twenty entries, one per step, then the twenty-first throws.
        let tight = try VirtualWorld(clock: Self.clock)
        tight.sameTimeWorkBound = 20
        let tightAdded = Count()
        await #expect(throws: VirtualWorldError.self) {
            try await tight.settle(draining: {
                tightAdded.value += 1
                _ = try? tight.at(ms: tight.now) {}
            })
        }
        #expect(tightAdded.value == 21 && tight.now == 0, "the first drain, then one after each of 20 steps")

        // A new call, or a later millisecond, starts afresh.
        let fresh = try VirtualWorld(clock: Self.clock)
        fresh.sameTimeWorkBound = 3
        for _ in 0..<3 { try fresh.at(ms: 0) {} }
        try fresh.advance(to: 0)
        for _ in 0..<3 { try fresh.at(ms: 0) {} }
        try fresh.settle()
        for _ in 0..<3 { try fresh.at(ms: 5) {} }
        try fresh.at(ms: 6) {}
        try fresh.settle()
        #expect(fresh.now == 6)
    }

    @Test("Timer rounds at one millisecond spend the same budget: a supervisor wake that keeps asking for now again fails notSettled at that millisecond")
    func sameTimeTimerBound() throws {
        var timing = SupervisorTiming.contract
        timing.probeInterval = 0   // a stop sequence then wakes at now after every wake
        let world = try VirtualWorld(clock: Self.clock)
        world.sameTimeWorkBound = 40
        let run = world.launch(identity: Self.identity(), configuration: Self.configuration(), mode: .survivesSigkill,
                               script: Self.opening + [ScriptStep(atMs: 100, .textDelta("partial"))],
                               untilTerminal: false, supervisorTiming: timing)
        try world.advance(to: 200)
        try world.at(ms: 300) { _ = run.stop() }
        do {
            try world.settle()
            Issue.record("a wake at now forever settled")
        } catch let error as VirtualWorldError {
            #expect(error.description == "did not settle: timers keep coming at 300: 40 units of work")
        }
        #expect(world.now == 300)
        #expect(run.system.signalNames == ["TERM@300"], "the stop sequence began; its wakes never left 300")
    }

    @Test("Same-millisecond order is kept under the bound: timeline entries in insertion order (an entry added at now runs after those already there), then reader deadlines and supervisor wakes")
    func sameTimeOrder() throws {
        let world = try VirtualWorld(clock: Self.clock)
        let run = world.launch(identity: Self.identity(), configuration: Self.configuration(), script: Self.opening + [
            ScriptStep(atMs: 100, .textDelta("a")), ScriptStep(atMs: 1_000, .resultSuccess), ScriptStep(atMs: 1_010, .exit(0))
        ])
        // The coalescing deadline of "a" is 350; the delta "b" arrives at 350 from an entry added at 350.
        var order: [String] = []
        var textsSeen: [Int] = []
        func note(_ name: String) {
            order.append(name)
            textsSeen.append(run.events.filter { $0.type == .text }.count)
        }
        try world.at(ms: 350) {
            note("first")
            _ = try? world.at(ms: 350) {
                note("added")
                world.runs[0].deliver(ScriptStep(atMs: 0, .textDelta("b")))
            }
        }
        try world.at(ms: 350) { note("second") }
        try world.advance(to: 350)
        #expect(order == ["first", "second", "added"])
        #expect(textsSeen == [0, 0, 0], "every entry runs before the 350 deadline fires")
        #expect(Self.text(run).map(\.text) == ["ab"] && Self.text(run).map(\.offset) == [350], "b joins the batch at the deadline")

        try world.settle()
        #expect(run.events.last?.type == .completed)
        checkRunInvariants(run.recordedUpdates, "same-time order")

        // A supervisor wake at an entry's millisecond: the stop sequence's
        // SIGKILL, 10 s after the stop, comes after the entry.
        let waking = try VirtualWorld(clock: Self.clock)
        let surviving = waking.launch(identity: Self.identity(), configuration: Self.configuration(),
                                      mode: .survivesSigkill, script: Self.opening, untilTerminal: false)
        try waking.at(ms: 1_000) { _ = surviving.stop() }
        var seenByEntry: [String] = []
        try waking.at(ms: 11_000) { seenByEntry = surviving.system.signalNames }
        try waking.advance(to: 11_000)
        #expect(seenByEntry == ["TERM@1000"], "the entry at 11,000 runs before the wake at 11,000")
        #expect(surviving.system.signalNames == ["TERM@1000", "KILL@11000"])
    }

    @Test("Times that have passed are refused, never run late")
    func pastTimes() throws {
        let world = try VirtualWorld(clock: Self.clock)
        try world.advance(to: 500)
        #expect(throws: VirtualWorldError.self) { try world.advance(to: 499) }
        #expect(throws: VirtualWorldError.self) { try world.advance(toWall: "2026-10-09T00:01:01.400Z") }
        #expect(throws: VirtualWorldError.self) { try world.at(ms: 499) {} }
        try world.advance(to: 500)
        var ran = false
        try world.at(ms: 500) { ran = true }
        try world.settle()
        #expect(ran && world.now == 500, "now itself is not in the past")
    }

    @Test("The updates stream carries what the run recorded and finishes when the process ends")
    func updatesStream() async throws {
        let world = try VirtualWorld(clock: Self.clock)
        let run = world.launch(identity: Self.identity(), configuration: Self.configuration(),
                               script: Self.opening + [ScriptStep(atMs: 100, .textDelta("streamed")),
                                                       ScriptStep(atMs: 300, .resultSuccess), ScriptStep(atMs: 310, .exit(0))])
        let collector = UpdateCollector(run)
        try world.settle()
        try await collector.wait(seconds: 5, for: "stream end") { $0.isFinished }
        #expect(collector.updates == run.recordedUpdates)
        #expect(collector.terminal?.type == .completed && collector.released)
    }

    @Test("The scripted launcher records every request, throws on demand, applies the stdin rule, and names the injected cliVersion")
    func scriptedLauncher() throws {
        let world = try VirtualWorld(clock: Self.clock)
        let launcher = ScriptedLauncher(world: world, script: Self.opening)
        #expect(launcher.cliVersion == "invented-cli-version")
        let request = ParticipantLaunchRequest(identity: Self.identity(), model: Invented.model,
                                               inputChunks: ["Invented ", "question"], inputBytes: 17, preparedBytes: 554)
        launcher.failLaunches(with: ParticipantSpawnError.spawn(EACCES))
        #expect(throws: ParticipantSpawnError.spawn(EACCES)) { try launcher.launch(request) }
        #expect(launcher.requests.count == 1 && launcher.runs.isEmpty, "recorded, nothing started")

        launcher.failLaunches(with: nil)
        var wrong = request
        wrong.inputBytes = 18
        #expect(throws: ParticipantLaunchError.inputBytesMismatch(expected: 18, actual: 17)) { try launcher.launch(wrong) }
        #expect(launcher.runs.isEmpty)

        _ = try launcher.launch(request)
        #expect(launcher.requests.count == 3 && launcher.runs.count == 1)
        try world.settle()
        #expect(launcher.runs[0].events.last?.reason == "timeout")
    }

    @Test("stdin is the chunks joined as they are (Codex Q17): no separator, newline or normalization; the chunk array alone keeps the hash apart")
    func stdinBytes() throws {
        let split = ["Invented caf", "e\u{301} ", "\u{1F600}"]
        let joined = ["Invented cafe\u{301} \u{1F600}"]
        let first = ParticipantLaunchRequest(identity: Self.identity(), model: Invented.model, inputChunks: split,
                                             inputBytes: 0, preparedBytes: 0)
        let second = ParticipantLaunchRequest(identity: Self.identity(), model: Invented.model, inputChunks: joined,
                                              inputBytes: 0, preparedBytes: 0)
        let expected: [UInt8] = Array("Invented caf".utf8) + [0x65, 0xCC, 0x81, 0x20, 0xF0, 0x9F, 0x98, 0x80]
        #expect(Array(first.stdin) == expected, "the combining accent stays decomposed; nothing between chunks")
        #expect(first.stdin == second.stdin)
        #expect(PayloadHash.hex(of: .array(split.map(JSONValue.string))) != PayloadHash.hex(of: .array(joined.map(JSONValue.string))),
                "the same stdin, a different inputHash")
    }
}
