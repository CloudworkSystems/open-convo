import CryptoKit
import Foundation
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// The harness for the shared participant vectors
// (`apps/desk/tests/fixtures/native-participant-v1.json`, contract section
// 19), grown slice by slice. It replays a case through a real `HostRouter`
// over the real `DeskHostProtocol` and the real `ParticipantCoordinator`
// lane, against a real `ProofStore` seeded as the case says, and compares
// the exact reply, the pushes and the runs list on disk, byte for byte, and
// that a refusal left every file in the store folder as it was (except that
// a start refused `participant-busy` at section 7 step 12 may make durable
// exactly the writes this launch already owed for other runs: Codex S9
// ruling b, `busyReconciliation`). Everything
// is invented data in a throwaway folder; nothing here starts a process,
// reads a login or touches the Keychain.
//
// What it can seed (anything else is refused as unsupported, so a case is
// never run against a world it does not describe):
// - root seeds: `record` (a `records` name), `runs` (each entry implies its
//   preparing `ok` identity, with an invented payload hash: Codex Q11),
//   `memory` (ignored for a commit, which never reads participant memory;
//   `state: exited` with `process: null` is seeded as retained events; a
//   `running` or `cleanup-pending` run of this launch is replayed: see
//   below), `pin`, `inputBound`, `store: corrupt`, `availability` (the test
//   fake, `confirmation` included), `connection`, `clock`, `script` (the
//   fake CLI steps for a run the case starts, or for `run-script`),
//   `process` (how the group of a run the case starts takes signals) and
//   `faults`;
// - `afterCase` with `clock`, `availability`, `script`, `process`, `faults`,
//   and `runs` either beside `faults` that disarm
//   `start-record-undetermined` (the runs `state.json` then holds: plan S8)
//   or, with `record`, as an override that keeps every entry the chain
//   wrote and only adds prepared ones (plan S9; the store re-reads it
//   authoritatively): the chain is replayed from its root in one world, and
//   each earlier case must reproduce its own reply, in-flight reply, pushes
//   and runs.
// Memory seeds by replay (plan S9). A `running` run is replayed from its
// first retained event's `at`: `init-clean` and `rate-limit-ok` there, and
// each retained text's delta 250 ms before its `at`, through the real reader
// and supervisor engine; the coordinator owns the run as a start of this
// launch would (`adoptSpawned`). A `cleanup-pending` one goes on: with
// `survives-sigkill`, a Stop through the router 12 s before its terminal;
// with `supervisor-lost`, `supervisor-dies` at its terminal. Its entry is
// written without terminal and `groupCleared`, which the replay writes. The
// replayed events must equal `retained` and the folder the seed's `runs`,
// byte for byte, or the case fails; the replay's pushes are then dropped.
// Faults (section 19, plan S8): `hold-commit-write` holds the commit's
// result write before its rename until the case's reply is compared;
// `hold-start-record-write` holds the next store write, and
// `hold-availability-recheck` the next availability report, until the case
// request is admitted (a Stop waits on the start, or the reply came);
// `start-record-undetermined` makes every folder flush fail while armed.
// `pushes-fail` (plan S9) makes the sink drop every push while armed; a
// step that ends with it armed and dropped nothing fails (the fault never
// engaged).
// They carry through `afterCase` until `faults: []`. `inFlight` is sent
// first and held there; its reply is compared after the world settles.
// `actions` run in order, the world settled after each, before the
// request: plan S9's `run-script`, `group-clears`, `supervisor-dies` and
// `pipes-close` act on the one scripted run they fit; plan S10's `lock`
// (the lane's `lockNow()`, then the host's `lock()`), `unlock` (the host's
// `unlock()`, then the lane's `unlock(ifNoLockSince:)` with the epoch read
// as the verification begins), `begin-generation` (the host's) and
// `issue-connection` (the host's `ready` for the case request's own
// connection id) act on the stack. Any other action is refused as
// unsupported, in the target and every ancestor (Codex Q26). A request waiting on a
// run's process (a Stop waiting for a terminal or a cleanup retry) has
// virtual time settled under it. Every case then settles: virtual time runs
// on (Codex Q15) while the coordinator consumes its runs' updates and makes
// their writes, and pushes and runs are compared after.

/// The shared vectors, parsed once.
struct ParticipantVectors {
    struct Context {
        let connectionId: String
        let documentGeneration: Int
        let workspaceHandle: String
        let participant: ParticipantPin
        /// This launch's id; a start record naming another is an earlier launch's.
        let launchId: String
        let cliVersion: String
    }

    struct Case {
        /// 1-based position in `cases`, as the contract and plans number them.
        let number: Int
        let name: String
        let seed: [String: JSONValue]
        let request: JSONValue
        let reply: JSONValue
        /// Present only when the case states its pushes; an empty list
        /// requires none (Codex Q26).
        let pushed: [JSONValue]?
        /// Present only when the case states the runs list after it.
        let afterRuns: [JSONValue]?
        let keys: Set<String>
        /// `inFlight`: sent before `request`, undecided when it arrives;
        /// `reply` is its own exact later reply.
        var inFlight: InFlight? = nil
        /// `actions`, in order, before the request.
        var actions: [String] = []

        struct InFlight {
            let request: JSONValue
            let reply: JSONValue
        }

        var afterCase: String? { seed["afterCase"]?.stringValue }
        var operation: String? { request.objectValue?["operation"]?.stringValue }
        var requestId: String? { request.objectValue?["requestId"]?.stringValue }
    }

    struct HashVector {
        let inputChunks: [String]
        let canonicalJson: String
        let sha256: String
    }

    static let resourceName = "native-participant-v1"

    let data: Data
    let context: Context
    /// `var` so the local file's host cases can name their own records.
    var records: [String: [String: JSONValue]]
    let cases: [Case]
    let hashVectors: [HashVector]
    let pageCaseCount: Int

    static func load() throws -> ParticipantVectors {
        guard let url = Bundle.module.url(forResource: resourceName, withExtension: "json") else {
            throw VectorHarnessError.fixture("the bundled vectors are missing")
        }
        return try ParticipantVectors(data: Data(contentsOf: url))
    }

    init(data: Data) throws {
        self.data = data
        guard let root = try JSONValue.decode(data).objectValue,
              let context = root["context"]?.objectValue,
              let connectionId = context["connectionId"]?.stringValue,
              let generation = context["documentGeneration"]?.safeIntegerValue,
              let handle = context["workspaceHandle"]?.stringValue,
              let pin = context["participant"].flatMap(ParticipantPin.init(json:)),
              let launchId = context["launchId"]?.stringValue, let cliVersion = context["cliVersion"]?.stringValue,
              let records = root["records"]?.objectValue,
              case .array(let cases)? = root["cases"],
              case .array(let hashVectors)? = root["hashVectors"],
              case .array(let pageCases)? = root["pageCases"] else {
            throw VectorHarnessError.fixture("the vectors' top level is not the section 19 shape")
        }
        self.context = Context(connectionId: connectionId, documentGeneration: generation, workspaceHandle: handle, participant: pin,
                               launchId: launchId, cliVersion: cliVersion)
        self.records = try records.mapValues { value in
            guard let record = value.objectValue else { throw VectorHarnessError.fixture("a record is not an object") }
            return record
        }
        self.cases = try cases.enumerated().map { offset, value in
            guard let fields = value.objectValue, let name = fields["name"]?.stringValue, let request = fields["request"],
                  let reply = fields["reply"] else { throw VectorHarnessError.fixture("case #\(offset + 1) lacks name, request or reply") }
            func list(_ key: String) throws -> [JSONValue]? {
                guard let present = fields[key] else { return nil }
                guard case .array(let values) = present else { throw VectorHarnessError.fixture("#\(offset + 1) \(key) is not a list") }
                return values
            }
            var inFlight: Case.InFlight?
            if let value = fields["inFlight"] {
                guard let held = value.objectValue, Set(held.keys) == ["request", "reply"], let heldRequest = held["request"],
                      let heldReply = held["reply"] else { throw VectorHarnessError.fixture("#\(offset + 1) inFlight is not {request, reply}") }
                inFlight = Case.InFlight(request: heldRequest, reply: heldReply)
            }
            let actions = try (list("actions") ?? []).map { value in
                guard let action = value.stringValue else { throw VectorHarnessError.fixture("#\(offset + 1) an action is not a string") }
                return action
            }
            return Case(number: offset + 1, name: name, seed: fields["seed"]?.objectValue ?? [:], request: request, reply: reply,
                        pushed: try list("pushed"), afterRuns: try list("afterRuns"), keys: Set(fields.keys), inFlight: inFlight,
                        actions: actions)
        }
        self.hashVectors = try hashVectors.map { value in
            guard let fields = value.objectValue, case .array(let chunks)? = fields["inputChunks"],
                  let canonical = fields["canonicalJson"]?.stringValue, let sha = fields["sha256"]?.stringValue else {
                throw VectorHarnessError.fixture("a hash vector is not {inputChunks, canonicalJson, sha256}")
            }
            let strings = chunks.compactMap(\.stringValue)
            guard strings.count == chunks.count else { throw VectorHarnessError.fixture("a hash vector chunk is not a string") }
            return HashVector(inputChunks: strings, canonicalJson: canonical, sha256: sha)
        }
        pageCaseCount = pageCases.count
    }

    func named(_ name: String) throws -> Case {
        guard let found = cases.first(where: { $0.name == name }) else { throw VectorHarnessError.fixture("no case named \(name)") }
        return found
    }

    /// The case and every `afterCase` ancestor, root first.
    func chain(to target: Case) throws -> [Case] {
        var chain = [target]
        var seen: Set<String> = [target.name]
        while let parent = chain[0].afterCase {
            guard seen.insert(parent).inserted else { throw VectorHarnessError.fixture("#\(target.number) has an afterCase loop") }
            chain.insert(try named(parent), at: 0)
        }
        return chain
    }
}

enum VectorHarnessError: Error, CustomStringConvertible {
    case fixture(String)
    /// The case needs a seed, fault or action this slice does not drive yet.
    case unsupported(String)
    case mismatch(String)

    var description: String {
        switch self {
        case .fixture(let text): return "fixture: \(text)"
        case .unsupported(let text): return "unsupported: \(text)"
        case .mismatch(let text): return text
        }
    }
}

/// Every pushed host event, in order; while `failing` (section 19's
/// `pushes-fail`), every push is dropped, as a page that never receives it.
final class VectorEventSink: HostEventSink, @unchecked Sendable {
    private let lock = NSLock()
    private var events: [HostEvent] = []
    private var dropping = false
    private var dropped = 0

    var failing: Bool {
        get { lock.lock(); defer { lock.unlock() }; return dropping }
        set { lock.lock(); defer { lock.unlock() }; dropping = newValue }
    }

    /// Pushes dropped while `failing`.
    var droppedCount: Int {
        lock.lock(); defer { lock.unlock() }
        return dropped
    }

    func push(_ event: HostEvent) {
        lock.lock()
        defer { lock.unlock() }
        if dropping {
            dropped += 1
            return
        }
        events.append(event)
    }

    /// Each pushed event's detail, as the page receives it.
    func take() -> [JSONValue] {
        lock.lock()
        defer { lock.unlock() }
        let taken = events.map(\.jsonDetail)
        events = []
        return taken
    }
}

/// A `running` or `cleanup-pending` memory seed (section 19), as the harness
/// replays it (plan S9): a run of this launch (its entry's start names this
/// launch), with no loss, whose `lastSequence` is its last retained event.
/// `cleanup-pending` with `survives-sigkill` ends `stopped` `stop-incomplete`
/// (a Stop's); with `supervisor-lost`, `failed` `process-error` (the loss's).
struct ReplaySeed {
    let runId: String
    let sessionId: String
    /// The seed's `process`.
    let process: String
    /// The simulated group: a lost supervisor's CLI exits on SIGTERM.
    let mode: SimulatedProcessMode
    /// Every retained event, the terminal included.
    let retained: [ParticipantEvent]
    /// The retained events before the terminal.
    let running: [ParticipantEvent]
    let terminal: ParticipantEvent?
    let lastSequence: Int
    let identity: ParticipantRunIdentity
    let inputBytes: Int
    let preparedBytes: Int

    init(_ value: JSONValue, runs: [JSONValue], launchId: String, number: Int) throws {
        guard let fields = value.objectValue,
              Set(fields.keys) == ["runId", "state", "lastSequence", "retained", "lost", "process"],
              let runId = fields["runId"]?.stringValue, let state = fields["state"]?.stringValue,
              let lastSequence = fields["lastSequence"]?.safeIntegerValue,
              case .array(let values)? = fields["retained"], let process = fields["process"]?.stringValue else {
            throw VectorHarnessError.fixture("#\(number) seed memory")
        }
        guard fields["lost"] == .null else { throw VectorHarnessError.unsupported("#\(number) a replayed memory seed with a loss") }
        let events = try values.map { value in
            guard let event = ParticipantEvent(jsonValue: value) else { throw VectorHarnessError.fixture("#\(number) retained event") }
            return event
        }
        guard let last = events.last, last.sequence == lastSequence else {
            throw VectorHarnessError.unsupported("#\(number) a replayed memory seed whose lastSequence is not its last retained event")
        }
        guard let entry = runs.compactMap(\.objectValue).first(where: { $0["runId"]?.stringValue == runId }),
              let sessionId = entry["sessionId"]?.stringValue, let createdAt = entry["createdAt"]?.stringValue,
              let created = ParticipantTimestamp.parse(createdAt), let inputBytes = entry["inputBytes"]?.safeIntegerValue,
              let preparedBytes = entry["preparedBytes"]?.safeIntegerValue,
              entry["start"]?.objectValue?["launchId"]?.stringValue == launchId else {
            throw VectorHarnessError.unsupported("#\(number) memory names no run this launch started")
        }
        switch (state, process) {
        case ("running", "exits-on-sigterm"), ("running", "survives-sigkill"):
            guard last.terminal == nil else { throw VectorHarnessError.fixture("#\(number) a running seed with a terminal") }
            terminal = nil
            mode = try SimulatedProcessMode(vector: process)
        case ("cleanup-pending", "survives-sigkill"):
            guard last.terminal == .stopped(.stopIncomplete) else {
                throw VectorHarnessError.unsupported("#\(number) cleanup-pending with survives-sigkill ending \(last.type.rawValue)")
            }
            terminal = last
            mode = .survivesSigkill
        case ("cleanup-pending", "supervisor-lost"):
            guard last.terminal == .failed(.processError) else {
                throw VectorHarnessError.unsupported("#\(number) cleanup-pending with supervisor-lost ending \(last.type.rawValue)")
            }
            terminal = last
            mode = .exitsOnSigterm
        default:
            throw VectorHarnessError.unsupported("#\(number) memory state \(state) with process \(process)")
        }
        self.runId = runId
        self.sessionId = sessionId
        self.process = process
        self.retained = events
        running = terminal == nil ? events : Array(events.dropLast())
        self.lastSequence = lastSequence
        identity = ParticipantRunIdentity(runId: runId, sessionId: sessionId, createdAtMillis: created)
        self.inputBytes = inputBytes
        self.preparedBytes = preparedBytes
    }
}

/// One store, host, coordinator and connection seeded from a root case.
final class VectorWorld {
    /// The build strings case #1's reply names.
    static let info = HostInfo(appVersion: "invented-proof-version", hostBuild: "invented-proof-build")
    /// Root seed keys this harness can build a world from.
    static let rootSeedKeys: Set<String> = ["record", "runs", "memory", "pin", "inputBound", "store", "availability", "connection", "clock",
                                            "script", "process", "faults"]
    /// Seed keys an `afterCase` step may add.
    static let laterSeedKeys: Set<String> = ["afterCase", "clock", "availability", "script", "process", "faults", "runs", "record"]
    /// The fault names this harness drives (section 19).
    static let faultNames: Set<String> = ["hold-commit-write", "hold-start-record-write", "hold-availability-recheck",
                                          "start-record-undetermined", "pushes-fail"]
    /// The actions this harness drives (section 19): S9's on a run, S10's
    /// on the stack.
    static let actionNames: Set<String> = ["run-script", "group-clears", "supervisor-dies", "pipes-close", "lock", "unlock",
                                           "begin-generation", "issue-connection"]
    /// The wall clock a world starts at when no case in its chain names one.
    static let defaultClock = "2026-10-09T00:00:00.000Z"

    let folder: URL
    let vectors: ParticipantVectors
    let keys = InventedInMemoryKeyProvider()
    let connections = ConnectionRegistry()
    let sink = VectorEventSink()
    let store: ProofStore
    let hostConfiguration: ParticipantHostConfiguration
    let host: DeskHostProtocol
    /// The virtual clock the coordinator reads (contract section 19's `clock`).
    let virtual: VirtualWorld
    /// Records every launch; only a start may make one.
    let launcher: ScriptedLauncher
    /// Every coordinator store write runs here.
    let executor = CountingExecutor()
    let log = RecordingLog()
    /// The world's store faults; nil when a test gave the store its own.
    let faults: VectorFaults?
    /// The availability fake the coordinator asks.
    let availability: VectorAvailability
    /// Section 17's confirmation owner, as a fake.
    let confirmation = RecordingConfirmationOwner()
    let coordinator: ParticipantCoordinator
    let router: HostRouter
    /// The connection the case's requests come from (an `issue-connection`
    /// action moves it to the one it issues).
    private(set) var connectionId: String
    /// Prepare request ids the seed implied with an invented hash; a case
    /// that sends one would replay a hash no request ever had (Codex Q11).
    private(set) var seededPrepareIds: Set<String>
    /// `start-record-undetermined` was armed in this world: a status may
    /// then make the authoritative re-read on the executor (section 7).
    private(set) var undeterminedArmed = false
    /// The held fault the next in-flight request waits at.
    private var held: String?
    private var availabilityGate: AsyncGate?
    /// Runs a memory seed replayed, owned by the coordinator as spawned by
    /// this launch (plan S9).
    private(set) var replayed: [ScriptedParticipantRun] = []
    /// The script a case's `run-script` action plays on the live run.
    private var actionScript: [ScriptStep]?

    /// The local host cases' own drain (step 3 PR 4c): every local run's
    /// updates consumed. Nil for the section 19 vectors.
    var localDrain: (() async -> Bool)?

    /// Every scripted run the coordinator owns: launched by a start, or
    /// replayed from a memory seed.
    var ownedRuns: [ScriptedParticipantRun] { replayed + launcher.runs }

    var storeDirectory: URL { folder.appendingPathComponent("proof", isDirectory: true) }

    convenience init(root: ParticipantVectors.Case, vectors: ParticipantVectors, clock: String? = nil) async throws {
        try await self.init(seed: root.seed, number: root.number, operation: root.operation, vectors: vectors,
                            clock: clock ?? root.seed["clock"]?.stringValue, actions: root.actions)
    }

    /// `faults` (tests of the coordinator itself) replace the world's own
    /// store faults. `beforeHost` runs on the opened store before the host
    /// (and so the shared identity index) is built over it.
    init(seed: [String: JSONValue], number: Int, operation: String?, vectors: ParticipantVectors, clock: String? = nil,
         actions: [String] = [], faults: AtomicWriteFaults? = nil, beforeHost: ((ProofStore) throws -> Void)? = nil,
         localRoute: (any LocalCatalogReading)? = nil) async throws {
        if let extra = Set(seed.keys).subtracting(Self.rootSeedKeys).sorted().first {
            throw VectorHarnessError.unsupported("#\(number) seed key \(extra)")
        }
        self.vectors = vectors
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("ParticipantVectors-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        var record: [String: JSONValue] = ["revision": .number(0)]
        if let name = seed["record"] {
            guard let key = name.stringValue, let named = vectors.records[key] else {
                throw VectorHarnessError.fixture("#\(number) seed record names no record")
            }
            record = named
        }
        let seedRuns: [JSONValue]
        switch seed["runs"] {
        case nil, .null?: seedRuns = []
        case .array(let runs)?: seedRuns = runs
        default: throw VectorHarnessError.fixture("#\(number) seed runs is not a list")
        }
        // Participant memory: a commit never reads it. An exited run with
        // no process is seeded as retained events; a running or
        // cleanup-pending one is replayed (plan S9), its entry written
        // without what the replay writes.
        var memory: (runId: String, sessionId: String, events: [ParticipantEvent], lastSequence: Int, lost: RetainedRun.Loss?)?
        var replay: ReplaySeed?
        var diskRuns = seedRuns
        if operation != HostOperation.workspaceCommitProof.rawValue, let value = seed["memory"], value != .null {
            if value.objectValue?["state"]?.stringValue == "exited" {
                memory = try Self.retained(value, runs: seedRuns, number: number)
            } else {
                let seeded = try ReplaySeed(value, runs: seedRuns, launchId: vectors.context.launchId, number: number)
                replay = seeded
                diskRuns = seedRuns.map { run in
                    guard var entry = run.objectValue, entry["runId"] == .string(seeded.runId) else { return run }
                    entry["terminal"] = .null
                    entry["groupCleared"] = .null
                    return .object(entry)
                }
            }
        }
        // A replay begins at its first retained event, which may come before
        // the chain's first stated clock.
        var worldClock = clock ?? Self.defaultClock
        if let replay, let start = ParticipantTimestamp.parse(replay.retained[0].at),
           let stated = ParticipantTimestamp.parse(worldClock), start < stated {
            worldClock = replay.retained[0].at
        }

        let directory = folder.appendingPathComponent("proof", isDirectory: true)
        let workspaceSeed = WorkspaceSeed(workspaceHandle: vectors.context.workspaceHandle, record: record)
        let first = try ProofStore(directory: directory, keys: keys, seed: workspaceSeed)
        first.close()
        seededPrepareIds = try Self.writeRuns(diskRuns, to: first)
        switch seed["store"] {
        case nil: break
        case .string("corrupt")?: try Data("{invented damaged state".utf8).writePlainState(to: first)
        default: throw VectorHarnessError.unsupported("#\(number) store seed")
        }
        let own = faults == nil ? VectorFaults() : nil
        self.faults = own
        store = try ProofStore(directory: directory, keys: keys, seed: workspaceSeed, ledgerCapacity: ProofStore.defaultLedgerCapacity,
                               fileManager: .default, faults: faults ?? own)
        try beforeHost?(store)

        let pin: ParticipantPin
        if let value = seed["pin"] {
            guard let seeded = ParticipantPin(json: value) else { throw VectorHarnessError.fixture("#\(number) seed pin") }
            pin = seeded
        } else {
            pin = vectors.context.participant
        }
        var inputBound: Int?
        if let value = seed["inputBound"] {
            guard let bound = value.safeIntegerValue, (1...ParticipantLimits.inputTotalBytes).contains(bound) else {
                throw VectorHarnessError.fixture("#\(number) seed inputBound")
            }
            inputBound = bound
        }
        hostConfiguration = ParticipantHostConfiguration(pin: pin, inputBound: inputBound, localRoute: localRoute)
        host = DeskHostProtocol(store: store, connections: connections, drafts: DraftBindingRegistry(), info: Self.info,
                                events: sink, participants: hostConfiguration)

        virtual = try VirtualWorld(clock: worldClock)
        launcher = ScriptedLauncher(world: virtual, cliVersion: vectors.context.cliVersion)
        availability = VectorAvailability(try Self.availability(seed["availability"], number: number))
        coordinator = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
            hostConfiguration: hostConfiguration, availability: availability, launchId: vectors.context.launchId,
            clock: virtual.clock, executor: executor, launcher: launcher, log: log, wakeups: VirtualWakeups(world: virtual),
            confirmation: confirmation))
        router = HostRouter(hostProtocol: host, lane: coordinator)

        // The vectors' document is generation 2 with one adopted connection
        // (a `connection` seed names another); nothing is pushed, since no
        // connection exists while it advances.
        var generation = vectors.context.documentGeneration
        var connectionId = vectors.context.connectionId
        if let value = seed["connection"] {
            guard let fields = value.objectValue, Set(fields.keys) == ["connectionId", "generation"],
                  let id = fields["connectionId"]?.stringValue, let seeded = fields["generation"]?.safeIntegerValue,
                  seeded >= generation else { throw VectorHarnessError.fixture("#\(number) seed connection") }
            connectionId = id
            generation = seeded
        }
        while connections.currentGeneration < generation { await host.beginGeneration() }
        _ = connections.adopt(id: connectionId)
        self.connectionId = connectionId
        try await coordinator.attach(host: host, store: store, connections: connections, sink: sink)
        if let memory {
            try await coordinator.seedRetained(runId: memory.runId, sessionId: memory.sessionId, events: memory.events,
                                               lastSequence: memory.lastSequence, lost: memory.lost)
        }
        if let replay {
            try await self.replay(replay, number: number, vectors: vectors)
            // The folder holds exactly the seed's runs again, the replayed
            // terminal and cleanup evidence included.
            guard let runs = try runsOnDisk() else { throw VectorHarnessError.mismatch("#\(number) replay: no readable state.json") }
            if let difference = VectorReplay.difference(.array(runs), .array(seedRuns)) {
                throw VectorHarnessError.mismatch("#\(number) replay: runs \(difference)")
            }
        }
        _ = sink.take()
        executor.reset()
        // The root's own faults and script, as a later case's would be.
        try prepare(seed: seed, number: number, isRoot: true, actions: actions)
    }

    /// Replays a `running` or `cleanup-pending` memory seed (plan S9; see the
    /// file's opening comment), then drains: every update consumed and
    /// written.
    private func replay(_ seed: ReplaySeed, number: Int, vectors: ParticipantVectors) async throws {
        let configuration = StreamJSONReader.Configuration(expectedInit: launcher.expectedInit, inputBytes: seed.inputBytes,
                                                           preparedBytes: seed.preparedBytes, limits: launcher.limits)
        let run: ScriptedParticipantRun
        do {
            run = try virtual.replayRunning(identity: seed.identity, configuration: configuration, mode: seed.mode,
                                            retained: seed.running, log: log)
        } catch {
            throw VectorHarnessError.mismatch("#\(number) replay: \(error)")
        }
        replayed.append(run)
        try await coordinator.adoptSpawned(runId: seed.runId, sessionId: seed.sessionId, handle: run)
        if let terminal = seed.terminal {
            let terminalAt = try virtual.time(ofWall: terminal.at)
            switch seed.process {
            case "survives-sigkill":
                // A Stop 12 s before the terminal: SIGTERM, the 10 s wait,
                // one SIGKILL and the 2 s probe, the group left uncleared.
                guard terminalAt >= virtual.now + 12_000 else {
                    throw VectorHarnessError.unsupported("#\(number) a stop-incomplete terminal sooner than 12 s after the replay")
                }
                try virtual.advance(to: terminalAt - 12_000)
                let stop = JSONValue.object([
                    "v": .number(1), "requestId": .string(UUID().uuidString.lowercased()), "connectionId": .string(connectionId),
                    "generation": .number(Double(connections.currentGeneration)),
                    "operation": .string(HostOperation.participantStop.rawValue),
                    "payload": .object(["workspaceHandle": .string(vectors.context.workspaceHandle), "runId": .string(seed.runId),
                                        "sessionId": .string(seed.sessionId)])
                ])
                let request = Task { await self.send(stop) }
                guard let reply = try await answer(request, settling: true) else {
                    throw VectorHarnessError.mismatch("#\(number) replay: the Stop did not answer within \(vectorWaitSeconds) s")
                }
                guard reply.fields["state"] == .string("cleanup-pending"), reply.fields["terminal"] == terminal.jsonValue else {
                    throw VectorHarnessError.mismatch("#\(number) replay: the Stop answered \(reply.jsonValue)")
                }
            default:
                // `supervisor-lost`: only the supervisor dies, at the terminal.
                try virtual.advance(to: terminalAt)
                virtual.supervisorDies(run)
            }
        }
        guard await drain() else { throw VectorHarnessError.mismatch("#\(number) replay: the coordinator did not consume the run") }
        let made = run.events
        guard made.count == seed.retained.count else {
            throw VectorHarnessError.mismatch("#\(number) replay: \(made.count) events, \(seed.retained.count) retained")
        }
        for (event, kept) in zip(made, seed.retained) {
            if let difference = VectorReplay.difference(event.jsonValue, kept.jsonValue) {
                throw VectorHarnessError.mismatch("#\(number) replay: sequence \(kept.sequence): \(difference)")
            }
        }
        guard await coordinator.retainedRun?.runId == seed.runId, await coordinator.retainedRun?.lastSequence == seed.lastSequence else {
            throw VectorHarnessError.mismatch("#\(number) replay: the coordinator does not keep the seeded run's events")
        }
    }

    /// The availability fake (contract section 19): `{result, reason,
    /// confirmation}`, built through `@testable import`, the only way to an
    /// available answer. Absent, the shipping report.
    static func availability(_ seed: JSONValue?, number: Int) throws -> any AvailabilityReporting {
        guard let seed else { return CheckedAvailability(checker: ShippingAvailability()) }
        guard let fields = seed.objectValue, Set(fields.keys).isSubset(of: ["result", "reason", "confirmation"]) else {
            throw VectorHarnessError.fixture("#\(number) seed availability")
        }
        let availability: ParticipantAvailability
        switch (fields["result"]?.stringValue, fields["reason"]?.stringValue) {
        case ("available"?, nil):
            availability = .available
        case ("unavailable"?, let name?):
            guard let reason = ParticipantUnavailableReason(rawValue: name) else {
                throw VectorHarnessError.fixture("#\(number) seed availability reason \(name)")
            }
            availability = .unavailable(reason)
        default:
            throw VectorHarnessError.fixture("#\(number) seed availability result")
        }
        var confirmation: ParticipantConfirmationDisplay?
        if let value = fields["confirmation"] {
            guard let display = ParticipantConfirmationDisplay(jsonValue: value) else {
                throw VectorHarnessError.fixture("#\(number) seed confirmation")
            }
            confirmation = display
        }
        return SeededAvailability(seeded: ParticipantAvailabilityReport(availability: availability, confirmation: confirmation))
    }

    /// A `memory` seed the coordinator can hold without a process: `state:
    /// exited`, `process: null`. Running and cleanup-pending runs are
    /// replayed instead (`ReplaySeed`).
    static func retained(_ value: JSONValue, runs: [JSONValue], number: Int) throws
        -> (runId: String, sessionId: String, events: [ParticipantEvent], lastSequence: Int, lost: RetainedRun.Loss?) {
        guard let fields = value.objectValue,
              Set(fields.keys) == ["runId", "state", "lastSequence", "retained", "lost", "process"],
              let runId = fields["runId"]?.stringValue, let state = fields["state"]?.stringValue,
              let lastSequence = fields["lastSequence"]?.safeIntegerValue,
              case .array(let retained)? = fields["retained"], let process = fields["process"] else {
            throw VectorHarnessError.fixture("#\(number) seed memory")
        }
        guard state == "exited", process == .null else {
            throw VectorHarnessError.unsupported("#\(number) memory state \(state) with process \(process)")
        }
        let events = try retained.map { value in
            guard let event = ParticipantEvent(jsonValue: value) else { throw VectorHarnessError.fixture("#\(number) retained event") }
            return event
        }
        let entry = runs.compactMap(\.objectValue).first { $0["runId"]?.stringValue == runId }
        guard let sessionId = entry?["sessionId"]?.stringValue ?? events.first?.sessionId else {
            throw VectorHarnessError.fixture("#\(number) memory names a run with no session")
        }
        var lost: RetainedRun.Loss?
        switch fields["lost"] {
        case .null?:
            break
        case .object(let loss)?:
            guard Set(loss.keys) == ["throughSequence", "reason"],
                  let reason = loss["reason"]?.stringValue.flatMap(ParticipantLostReason.init(rawValue:)) else {
                throw VectorHarnessError.fixture("#\(number) memory lost")
            }
            lost = RetainedRun.Loss(reason: reason, throughSequence: loss["throughSequence"]?.safeIntegerValue)
        default:
            throw VectorHarnessError.fixture("#\(number) memory lost")
        }
        return (runId, sessionId, events, lastSequence, lost)
    }

    /// Moves the coordinator's wall clock to a case's `clock`, forward only.
    func advance(to clock: JSONValue?) throws {
        guard let clock else { return }
        guard let wall = clock.stringValue else { throw VectorHarnessError.fixture("a seed clock is not a string") }
        try virtual.advance(toWall: wall)
    }

    /// A case's own seed, before its requests: its clock, and its
    /// availability, `runs`, `record`, `script`, `process` and `faults` as
    /// section 19 states them. A root's availability and runs were seeded
    /// when the world was built. With a `run-script` action the script is
    /// that action's, not the next launch's.
    func prepare(seed: [String: JSONValue], number: Int, isRoot: Bool, actions: [String] = []) throws {
        if !isRoot, let extra = Set(seed.keys).subtracting(Self.laterSeedKeys).sorted().first {
            throw VectorHarnessError.unsupported("#\(number) afterCase with seed key \(extra)")
        }
        try advance(to: seed["clock"])
        if !isRoot, let value = seed["availability"] { availability.set(try Self.availability(value, number: number)) }
        actionScript = nil
        var script: [ScriptStep]?
        if let value = seed["script"] {
            guard case .array(let steps) = value else { throw VectorHarnessError.fixture("#\(number) script is not a list") }
            script = try steps.map(ScriptStep.init(vector:))
        }
        let mode = try SimulatedProcessMode(vector: try seed["process"].map { value in
            guard let name = value.stringValue else { throw VectorHarnessError.fixture("#\(number) process is not a string") }
            return name
        })
        if actions.contains("run-script") {
            guard let script, seed["process"] == nil else {
                throw VectorHarnessError.unsupported("#\(number) run-script without a script, or with a process")
            }
            actionScript = script
        } else if script != nil || seed["process"] != nil {
            launcher.prepare(script: script ?? [], mode: mode)
        }
        var names: [String]?
        if let value = seed["faults"] {
            guard case .array(let list) = value else { throw VectorHarnessError.fixture("#\(number) faults is not a list") }
            names = try list.map { item in
                guard let name = item.stringValue else { throw VectorHarnessError.fixture("#\(number) a fault is not a string") }
                guard Self.faultNames.contains(name) else { throw VectorHarnessError.unsupported("#\(number) fault \(name)") }
                return name
            }
        }
        if !isRoot, seed["runs"] != nil || seed["record"] != nil {
            if let names, names.isEmpty, undeterminedArmed, seed["record"] == nil, case .array(let runs)? = seed["runs"] {
                // A later `runs` is what `state.json` holds once a re-read
                // can see it after an undetermined start record; it comes
                // only with the `faults: []` that disarms that fault.
                faults?.disarm()
                try rewriteRuns(runs)
            } else {
                guard names == nil, faults?.undeterminedFlushes != true else {
                    throw VectorHarnessError.unsupported("#\(number) a later runs or record beside faults")
                }
                try override(record: seed["record"], runs: seed["runs"], number: number)
            }
        }
        guard let names else { return }
        // The list is the armed set from here: `[]` disarms everything.
        sink.failing = names.contains("pushes-fail")
        guard let faults else {
            if !names.filter({ $0 != "pushes-fail" }).isEmpty {
                throw VectorHarnessError.unsupported("#\(number) faults on a store with a test's own faults")
            }
            return
        }
        faults.disarm()
        availability.releaseHold()
        held = nil
        for name in names {
            switch name {
            case "hold-commit-write":
                faults.arm(.commitResult)
                held = name
            case "hold-start-record-write":
                faults.arm(.nextWrite)
                held = name
            case "hold-availability-recheck":
                availabilityGate = availability.hold()
                held = name
            case "pushes-fail":
                break
            default:
                faults.undeterminedFlushes = true
                undeterminedArmed = true
            }
        }
    }

    /// A later step's `record` and `runs` (plan S9: #79): the world goes on
    /// from the chain's end, so every entry the chain wrote must be there
    /// byte for byte, in order, and only new prepared entries (with their
    /// implied identities) may follow; the committed record becomes the
    /// named one. The open store then re-reads the folder authoritatively,
    /// as a later open would.
    private func override(record: JSONValue?, runs: JSONValue?, number: Int) throws {
        guard var state = try JSONValue.decode(store.plainStateForTesting()).objectValue else {
            throw VectorHarnessError.unsupported("#\(number) an unreadable state.json cannot take a later seed")
        }
        if let runs {
            guard case .array(let wanted) = runs, let current = try runsOnDisk(), wanted.count >= current.count else {
                throw VectorHarnessError.unsupported("#\(number) a later runs list that drops entries")
            }
            if let difference = VectorReplay.difference(.array(Array(wanted.prefix(current.count))), .array(current)) {
                throw VectorHarnessError.unsupported("#\(number) a later runs list that changes an entry the chain wrote: \(difference)")
            }
            let added = Array(wanted.dropFirst(current.count))
            guard case .array(var identities)? = state["identities"] else { throw VectorHarnessError.fixture("#\(number) identities") }
            for run in added {
                guard let entry = run.objectValue, entry["start"] == .null, entry["terminal"] == .null,
                      let prepareId = entry["prepareRequestId"]?.stringValue, let requestId = UUID.canonicalV4(prepareId),
                      let runId = entry["runId"]?.stringValue, let revision = entry["preparedRevision"]?.safeIntegerValue else {
                    throw VectorHarnessError.unsupported("#\(number) a later entry that is not a fresh prepared run")
                }
                let identity = RequestIdentity(requestId: requestId, payloadHash: Self.inventedPayloadHash(prepareId), outcome: .ok,
                                               revision: revision, runId: runId)
                identities.append(try JSONValue.decode(JSONEncoder().encode(identity)))
                seededPrepareIds.insert(prepareId)
            }
            state["identities"] = .array(identities)
            state["runs"] = .array(wanted)
        }
        if let record {
            guard let name = record.stringValue, let named = vectors.records[name], let revision = named["revision"]?.safeIntegerValue,
                  var workspace = state["workspace"]?.objectValue else {
                throw VectorHarnessError.fixture("#\(number) a later record names no record")
            }
            workspace["record"] = .object(named)
            workspace["revision"] = .number(Double(revision))
            state["workspace"] = .object(workspace)
        }
        try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: store)
        do {
            _ = try store.rereadRuns()
        } catch {
            throw VectorHarnessError.mismatch("#\(number) the store did not re-read the later seed: \(error)")
        }
    }

    /// Replaces `state.json`'s runs list as the folder would show it, the
    /// rest of the file kept.
    private func rewriteRuns(_ runs: [JSONValue]) throws {
        guard var state = try JSONValue.decode(store.plainStateForTesting()).objectValue else {
            throw VectorHarnessError.fixture("an unreadable state.json cannot take seeded runs")
        }
        state["runs"] = .array(runs)
        try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: store)
    }

    /// What a step's checks compare against: the folder as the case request
    /// found it (after any in-flight request reached its hold).
    struct Before {
        let status: StoreStatus
        let runs: [JSONValue]?
        let bytes: Data?
        let folder: [String: Data]
        let launches: Int
        let executorRuns: Int
        /// The participant writes this launch already owed for each run
        /// (Codex S9 ruling b: all a busy refusal may make durable).
        let owed: [String: [ParticipantCoordinator.OwedWrite]]
    }

    /// What one step came to.
    struct Outcome {
        let before: Before
        let reply: HostResponse
        let inFlightReply: HostResponse?
        /// The folder right after the case's reply, before any held write
        /// went on.
        let atReply: [String: Data]
        let runsAtReply: [JSONValue]?
        /// Every pushed detail of the step, in order, after settling.
        let pushed: [JSONValue]
    }

    /// Sends a step: its actions first (then the world settles), or its
    /// in-flight request, held at its fault; then the case request, the
    /// hold's release by section 19's rule, both replies, and settling.
    func drive(_ step: ParticipantVectors.Case) async throws -> Outcome {
        var inFlightTask: Task<HostResponse, Never>?
        let hold = held
        // A hold is only for an in-flight request: on its own it would hold
        // the case's own write and then let it go unchecked.
        if hold != nil, step.inFlight == nil {
            throw VectorHarnessError.unsupported("#\(step.number) a hold fault without an inFlight request")
        }
        if !step.actions.isEmpty {
            guard step.inFlight == nil else { throw VectorHarnessError.unsupported("#\(step.number) actions with an inFlight request") }
            // One at a time, settled after each: a lock's stop sequence ends
            // while it is locked, before the unlock that follows (S10).
            for action in step.actions {
                try await act(action, step: step)
                try await settle()
            }
        }
        // Read before anything is held: `ProofStore.status` takes the
        // store's writer lock, which a held write keeps.
        let status = store.status
        if let inFlight = step.inFlight {
            guard let hold else { throw VectorHarnessError.unsupported("#\(step.number) inFlight without a hold fault") }
            let request = inFlight.request
            inFlightTask = Task { await self.send(request) }
            let reached: Bool
            switch hold {
            case "hold-availability-recheck":
                let gate = availabilityGate
                reached = await waitUntil { (gate?.arrived ?? 0) > 0 }
            default:
                reached = await faults?.waitUntilHeld() ?? false
            }
            guard reached else { throw VectorHarnessError.mismatch("#\(step.number) the in-flight request never reached \(hold)") }
        }
        let before = Before(status: status, runs: try runsOnDisk(), bytes: stateBytes(), folder: try folderSnapshot(),
                            launches: launcher.requests.count, executorRuns: executor.runs, owed: await coordinator.owedWrites())
        let request = step.request
        let caseTask = Task { await self.send(request) }
        var reply: HostResponse?
        var atReply: [String: Data] = [:]
        var runsAtReply: [JSONValue]?
        func replied(settling: Bool) async throws {
            guard let answered = try await answer(caseTask, settling: settling) else {
                throw VectorHarnessError.mismatch("#\(step.number) the request did not answer within \(vectorWaitSeconds) s")
            }
            reply = answered
            // A Stop answers from memory before the run's terminal write
            // lands (Codex Q31): the folder "at the reply" is taken once the
            // writes the coordinator queued have returned, so no snapshot
            // catches one halfway. Not under a hold, which keeps the store.
            if settling, !(await waitUntil({ !(await self.coordinator.isWriting) })) {
                throw VectorHarnessError.mismatch("#\(step.number) the coordinator's writes did not return within \(vectorWaitSeconds) s")
            }
            atReply = try folderSnapshot()
            runsAtReply = try runsOnDisk()
        }
        if inFlightTask != nil, let hold {
            if hold == "hold-commit-write" {
                // Held until the case reply is compared.
                try await replied(settling: false)
            } else {
                // Held until the case request is admitted: a Stop waits on
                // the start, or the reply came.
                let runId = step.inFlight?.request.objectValue?["payload"]?.objectValue?["runId"]?.stringValue ?? ""
                let done = ResultBox<Bool>()
                let watcher = Task { _ = await caseTask.value; done.set(true) }
                let admitted = await waitUntil {
                    if done.value == true { return true }
                    return await self.coordinator.stopWaiters(for: runId) > 0
                }
                watcher.cancel()
                guard admitted else { throw VectorHarnessError.mismatch("#\(step.number) the case request was never admitted") }
                if done.value == true { try await replied(settling: false) }
            }
            faults?.release()
            availability.releaseHold()
            held = nil
        }
        // A request that waits on a run's process (a Stop of a running or
        // cleanup-pending run) has the world settled under it.
        if reply == nil { try await replied(settling: true) }
        var inFlightReply: HostResponse?
        if let inFlightTask {
            guard let answered = await value(of: inFlightTask) else {
                throw VectorHarnessError.mismatch("#\(step.number) the in-flight request did not answer within \(vectorWaitSeconds) s")
            }
            inFlightReply = answered
        }
        try await settle()
        guard faultTimeouts == 0 else {
            throw VectorHarnessError.mismatch("#\(step.number) a hold or gate was never released and let itself go")
        }
        return Outcome(before: before, reply: reply!, inFlightReply: inFlightReply, atReply: atReply, runsAtReply: runsAtReply,
                       pushed: sink.take())
    }

    /// A request's reply, or nil after `vectorWaitSeconds` without one. With
    /// `settling`, a request that waits on a run's process (a Stop waiting
    /// for its terminal or a cleanup retry's answer: the coordinator's
    /// `processWaiters`) has the world settled under it, so the stop
    /// sequence or the retry's probe runs on virtual time; the request was
    /// already admitted, and has signalled, when the world moves. Bounded
    /// in settles as well as in time.
    func answer(_ task: Task<HostResponse, Never>, settling: Bool) async throws -> HostResponse? {
        guard settling else { return await value(of: task) }
        let box = ResultBox<HostResponse>()
        let watcher = Task { box.set(await task.value) }
        defer { watcher.cancel() }
        for _ in 0..<3 {
            let ready = await waitUntil {
                if box.value != nil { return true }
                return await self.coordinator.processWaiters > 0
            }
            if let answered = box.value { return answered }
            guard ready else { return nil }
            try await settle()
        }
        _ = await waitUntil { box.value != nil }
        return box.value
    }

    /// One section 19 action: S9's on the one scripted run it fits
    /// (anything else is unsupported, so an action never lands on a
    /// guessed run), S10's on the stack, the lane's step before the host's
    /// for lock (section 14: no participant push after `locked`).
    private func act(_ action: String, step: ParticipantVectors.Case) async throws {
        let number = step.number
        func only(_ fits: (ScriptedParticipantRun) -> Bool) throws -> ScriptedParticipantRun {
            let matching = ownedRuns.filter(fits)
            guard matching.count == 1, let run = matching.first else {
                throw VectorHarnessError.unsupported("#\(number) \(action) fits \(matching.count) runs")
            }
            return run
        }
        switch action {
        case "run-script":
            // Continues the live run from the case clock.
            guard let script = actionScript else { throw VectorHarnessError.unsupported("#\(number) run-script without a script") }
            virtual.play(script, on: try only { $0.snapshot.terminal == nil && $0.system.leader == .alive }, untilTerminal: true)
        case "group-clears":
            virtual.groupClears(try only { $0.system.survivorAlive })
        case "supervisor-dies":
            virtual.supervisorDies(try only { $0.system.supervisorAlive && !$0.isFinished })
        case "pipes-close":
            virtual.pipesClose(try only { $0.system.pipesOpen })
        case "lock":
            coordinator.lockNow()
            await host.lock()
        case "unlock":
            // A verified unlock: its epoch is read just before the host's
            // unlock (nothing comes between a verification and that; S11
            // reading 4); the host's store opens first, then the lane writes
            // what it held.
            let epoch = coordinator.lockEpoch
            await host.unlock()
            await coordinator.unlock(ifNoLockSince: epoch)
        case "begin-generation":
            await host.beginGeneration()
        case "issue-connection":
            // The fixed id the case's request comes from.
            guard let id = step.request.objectValue?["connectionId"]?.stringValue else {
                throw VectorHarnessError.unsupported("#\(number) issue-connection with no request connection")
            }
            await host.issueConnection(adopting: id)
            connectionId = id
        default:
            throw VectorHarnessError.unsupported("#\(number) action \(action)")
        }
    }

    /// Codex Q15's settling, with the coordinator's own work drained
    /// between advances: every update each launched run yielded applied,
    /// each finished stream's end seen, and no coordinator write in flight
    /// (a spawned run's terminal or cleanup write, which runs behind its
    /// update since S9, a never-spawned terminal write, or a re-read).
    /// Bounded both in advances and in wall time.
    func settle() async throws {
        let stalled = VectorHarnessError.mismatch("the coordinator did not consume its runs' updates within \(vectorWaitSeconds) s")
        // The first stalled drain ends settling: no further advance waits
        // another `vectorWaitSeconds`.
        try await virtual.settle(maxAdvances: 100_000) {
            guard await self.drain() else { throw stalled }
        }
        guard await drain() else { throw stalled }
    }

    /// Holds and gates that let themselves go because nothing released
    /// them in time: a harness mistake, so the case fails rather than
    /// passing late.
    var faultTimeouts: Int { (faults?.holdTimeouts ?? 0) + availability.gateTimeouts }

    /// Every launched run's updates applied (and their end seen, once the
    /// run finished), no write in flight, and no claimed confirmation
    /// revocation still waiting on the owner (Codex S8 R1: a late end makes
    /// its call off the coordinator, after the end is published).
    func drain() async -> Bool {
        await waitUntil {
            for run in self.ownedRuns {
                guard let consumed = await self.coordinator.consumption(of: run.identity.runId) else { return false }
                if consumed.applied < run.recordedUpdates.count || (run.isFinished && !consumed.finished) { return false }
            }
            if let localDrain = self.localDrain, !(await localDrain()) { return false }
            guard !(await self.coordinator.isWriting) else { return false }
            return !(await self.coordinator.isRevoking)
        }
    }

    /// Adds seeded run entries and the `ok` identity each implies (its
    /// `prepareRequestId`, `runId` and `preparedRevision`) to a closed
    /// store's `state.json`. The identity's payload hash is invented and
    /// deterministic: SHA-256 of a label naming the id, which no request's
    /// canonical payload produces. Returns the seeded prepare ids.
    static func writeRuns(_ runs: [JSONValue], to store: ProofStore) throws -> Set<String> {
        guard !runs.isEmpty else { return [] }
        guard var state = try JSONValue.decode(store.plainStateForTesting()).objectValue,
              case .array(var identities)? = state["identities"] else { throw VectorHarnessError.fixture("unreadable fresh state") }
        var prepareIds = Set<String>()
        for run in runs {
            guard let entry = run.objectValue, let prepareId = entry["prepareRequestId"]?.stringValue,
                  let requestId = UUID.canonicalV4(prepareId), let runId = entry["runId"]?.stringValue,
                  let revision = entry["preparedRevision"]?.safeIntegerValue else {
                throw VectorHarnessError.fixture("a seeded run lacks its prepare identity")
            }
            let identity = RequestIdentity(requestId: requestId, payloadHash: inventedPayloadHash(prepareId), outcome: .ok,
                                           revision: revision, runId: runId)
            identities.append(try JSONValue.decode(JSONEncoder().encode(identity)))
            prepareIds.insert(prepareId)
        }
        state["identities"] = .array(identities)
        state["runs"] = .array(runs)
        try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: store)
        return prepareIds
    }

    static func inventedPayloadHash(_ prepareRequestId: String) -> String {
        SHA256.hash(data: Data("invented seeded prepare identity \(prepareRequestId)".utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The request's canonical bytes through the router, as the WebKit glue
    /// would hand them over.
    func send(_ request: JSONValue) async -> HostResponse {
        await router.handle(data: request.canonicalData())
    }

    /// The runs list as `state.json` holds it; a store with no runs writes
    /// no `runs` key, which reads as the empty list. Nil when there is no
    /// readable state (a `store: corrupt` seed).
    func runsOnDisk() throws -> [JSONValue]? {
        guard let data = try? store.plainStateForTesting(), let state = (try? JSONValue.decode(data))?.objectValue else { return nil }
        switch state["runs"] {
        case nil: return []
        case .array(let runs)?: return runs
        default: throw VectorHarnessError.mismatch("state.json runs is not a list")
        }
    }

    /// `state.json`'s bytes, or nil when it is absent.
    func stateBytes() -> Data? { (try? store.plainStateForTesting()) ?? (try? Data(contentsOf: store.stateURL)) }

    /// Every file in the store's folder, by relative path, with its bytes:
    /// `state.json` (record, ledger, identities, receipts, runs), the
    /// workspace marker, the lock file, kept attempted records and any
    /// leftover temporary file. `state.json` is taken as its plaintext when
    /// it opens under the store's key (its ciphertext changes on every
    /// write, even of the same state), else as its raw bytes.
    func folderSnapshot() throws -> [String: Data] {
        let root = storeDirectory.standardizedFileURL.resolvingSymlinksInPath()
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else {
            throw VectorHarnessError.mismatch("the store folder cannot be listed")
        }
        var files: [String: Data] = [:]
        for case let url as URL in walker where try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
            let path = url.standardizedFileURL.resolvingSymlinksInPath().path
            let raw = try Data(contentsOf: url)
            let isState = url.standardizedFileURL.resolvingSymlinksInPath() == store.stateURL.standardizedFileURL.resolvingSymlinksInPath()
            files[String(path.dropFirst(root.path.count))] = isState ? ((try? store.plainStateForTesting()) ?? raw) : raw
        }
        return files
    }

    /// Closes the host and its store, opens the folder again and returns
    /// the store's status with its runs as the reopened store publishes
    /// them: the files must pass every section 15 load invariant.
    func reopen() async throws -> (status: StoreStatus, runs: [JSONValue]?) {
        await coordinator.detach()
        await host.close()
        let reopened = try ProofStore(directory: storeDirectory, keys: keys, seed: WorkspaceSeed(record: ["revision": .number(0)]))
        defer { reopened.close() }
        guard reopened.status == .ready else { return (reopened.status, nil) }
        return (.ready, try reopened.refreshPublishedRuns().runs.map(\.jsonValue))
    }

    /// A new document and its connection (S10 tests), as the actions
    /// `begin-generation` and `issue-connection` make them, on `host` (the
    /// world's own unless a test reopened the folder under another): the
    /// requests a test builds for this world come from it from here.
    func reload(on host: DeskHostProtocol? = nil, connection id: String = "51000000-0000-4000-8000-0000000000d1") async {
        let host = host ?? self.host
        await host.beginGeneration()
        await host.issueConnection(adopting: id)
        connectionId = id
    }

    /// Lets every held write and gate go, then removes the folder.
    func clean() {
        faults?.disarm()
        availability.releaseHold()
        store.close()
        try? FileManager.default.removeItem(at: folder)
    }
}

/// Replays one case and checks everything it states.
enum VectorReplay {
    /// Case keys the replay drives and compares. A case with any other
    /// would otherwise run without what it says.
    static let caseKeys: Set<String> = ["name", "seed", "request", "reply", "pushed", "afterRuns", "inFlight", "actions"]
    /// Operations whose answers the participant write invariant covers.
    static let participantAnswers: Set<String> = [
        HostOperation.participantAvailability.rawValue, HostOperation.participantStatus.rawValue,
        HostOperation.participantEvents.rawValue, HostOperation.participantStop.rawValue, HostOperation.participantStart.rawValue
    ]
    /// Reads, which never use the executor; status may, for section 7's
    /// re-read, in a world where a start record's write was undetermined.
    static let participantReads: Set<String> = [
        HostOperation.participantAvailability.rawValue, HostOperation.participantStatus.rawValue,
        HostOperation.participantEvents.rawValue
    ]

    /// `inspect` sees the world once every step's stated fields have
    /// matched, before the confirmation and reopen checks (the Claude host
    /// cases read what the scripted launcher received there).
    static func run(_ target: ParticipantVectors.Case, in vectors: ParticipantVectors,
                    inspect: ((VectorWorld) throws -> Void)? = nil) async throws {
        let chain = try vectors.chain(to: target)
        for step in chain {
            if let extra = step.keys.subtracting(caseKeys).sorted().first {
                throw VectorHarnessError.unsupported("#\(step.number) case key \(extra)")
            }
            // Only the actions the harness drives (plans S9 and S10).
            if let action = step.actions.first(where: { !VectorWorld.actionNames.contains($0) }) {
                throw VectorHarnessError.unsupported("#\(step.number) action \(action)")
            }
        }
        for later in chain.dropFirst() {
            if let extra = Set(later.seed.keys).subtracting(VectorWorld.laterSeedKeys).sorted().first {
                throw VectorHarnessError.unsupported("#\(later.number) afterCase with seed key \(extra)")
            }
        }
        // The world's wall clock starts at the chain's first stated clock.
        let firstClock = chain.lazy.compactMap { $0.seed["clock"]?.stringValue }.first
        let world = try await VectorWorld(root: chain[0], vectors: vectors, clock: firstClock)
        defer { world.clean() }
        for step in chain {
            for id in [step.requestId, step.inFlight?.request.objectValue?["requestId"]?.stringValue].compactMap({ $0 })
            where world.seededPrepareIds.contains(id) {
                throw VectorHarnessError.unsupported("#\(step.number) sends a seeded prepare id, whose hash is invented")
            }
        }
        var statusBefore = world.store.status
        for (index, step) in chain.enumerated() {
            if index > 0 { try world.prepare(seed: step.seed, number: step.number, isRoot: false, actions: step.actions) }
            let droppedBefore = world.sink.droppedCount
            let outcome = try await world.drive(step)
            if world.sink.failing, world.sink.droppedCount == droppedBefore {
                throw VectorHarnessError.mismatch("#\(step.number) pushes-fail was armed, but nothing was dropped: the fault proved nothing")
            }
            let label = index == chain.count - 1 ? "" : "ancestor #\(step.number) \(step.name): "
            try compareStated(step, outcome, world: world, label: label)
            if index == chain.count - 1 {
                statusBefore = outcome.before.status
                try checkTarget(target, outcome, world: world)
            }
        }
        try inspect?(world)
        try await checkConfirmation(world: world)
        // The folder reopens as it was seeded (ready or not), and a ready
        // one publishes exactly the runs on disk: every load invariant holds.
        let runsAfter = try world.runsOnDisk()
        let reopened = try await world.reopen()
        guard reopened.status == statusBefore else { throw VectorHarnessError.mismatch("the store reopens \(reopened.status), was \(statusBefore)") }
        if let runs = reopened.runs, let difference = difference(.array(runs), .array(runsAfter ?? [])) {
            throw VectorHarnessError.mismatch("reopened runs: \(difference)")
        }
    }

    /// Every field a step states (Codex Q26), in the chain as on its own:
    /// the reply, the in-flight reply, the pushes and the runs after.
    static func compareStated(_ step: ParticipantVectors.Case, _ outcome: VectorWorld.Outcome, world: VectorWorld, label: String) throws {
        if let difference = difference(outcome.reply.jsonValue, step.reply) { throw VectorHarnessError.mismatch("\(label)reply: \(difference)") }
        if let inFlight = step.inFlight {
            guard let reply = outcome.inFlightReply else { throw VectorHarnessError.mismatch("\(label)no in-flight reply") }
            if let difference = difference(reply.jsonValue, inFlight.reply) {
                throw VectorHarnessError.mismatch("\(label)in-flight reply: \(difference)")
            }
        }
        if let expected = step.pushed, let difference = difference(.array(outcome.pushed), .array(expected)) {
            throw VectorHarnessError.mismatch("\(label)pushed: \(difference)")
        }
        if let expected = step.afterRuns {
            guard let runs = try world.runsOnDisk() else { throw VectorHarnessError.mismatch("\(label)runs: no readable state.json") }
            if let difference = difference(.array(runs), .array(expected)) { throw VectorHarnessError.mismatch("\(label)runs: \(difference)") }
        }
    }

    /// The target's separate invariants (Codex Q26): nothing written,
    /// pushed or launched beyond what its replies account for.
    static func checkTarget(_ target: ParticipantVectors.Case, _ outcome: VectorWorld.Outcome, world: VectorWorld) throws {
        let before = outcome.before
        // A refusal writes nothing at all: no record, ledger entry,
        // identity, receipt, run, attempted record or leftover file. One
        // narrow exception (Codex S9 ruling b): a start that reached
        // section 7 step 12 and was refused `participant-busy` queued the
        // terminal and cleanup writes this launch already owed for other
        // runs, so it may make exactly those durable, and push a
        // never-spawned terminal made durable that way once; its own run,
        // identity, receipt and workspace record and every other file stay
        // as they were, and it launches nothing (below). Every earlier
        // refusal keeps the whole rule. No vector reaches the exception
        // with a write owed; the coordinator's tests cover it.
        let busyStart = target.operation == HostOperation.participantStart.rawValue && outcome.reply.reason == .participantBusy
        let refusedRunId = target.request.objectValue?["payload"]?.objectValue?["runId"]?.stringValue
        // Stated pushes are compared exactly (`compareStated`); unstated
        // ones may only be the exception's.
        let unstatedPushes = target.pushed == nil ? outcome.pushed : []
        if target.reply.objectValue?["outcome"] == .string("refused") {
            if busyStart {
                if let other = busyReconciliation(refusedRunId: refusedRunId, before: before.folder, after: outcome.atReply,
                                                  owed: before.owed, pushed: unstatedPushes) {
                    throw VectorHarnessError.mismatch("a participant-busy refusal did more than reconcile owed writes: \(other)")
                }
            } else if let changed = folderChange(before.folder, outcome.atReply) {
                throw VectorHarnessError.mismatch("a refusal changed the store folder: \(changed)")
            }
        }
        // An absent `pushed` is not compared, but nothing may be pushed
        // (a busy refusal's reconciled pushes were checked above).
        if target.pushed == nil, !outcome.pushed.isEmpty, !busyStart {
            throw VectorHarnessError.mismatch("unintended push: the case states no pushes, but \(outcome.pushed.count) went out")
        }
        // Only an accepted start may launch, once: an `ok` start whose
        // record was not on disk before the step. A replay (its record was
        // there already) launches nothing.
        let recordedBefore = Set((before.runs ?? []).compactMap { $0.objectValue?["start"]?.objectValue?["requestId"]?.stringValue })
        let starts = [(target.request, outcome.reply), (target.inFlight?.request, outcome.inFlightReply)]
            .filter { request, reply in
                guard let fields = request?.objectValue, fields["operation"] == .string(HostOperation.participantStart.rawValue),
                      reply?.outcome == .ok, let requestId = fields["requestId"]?.stringValue else { return false }
                return !recordedBefore.contains(requestId)
            }
        let launches = world.launcher.requests.count - before.launches
        guard launches <= starts.count else {
            throw VectorHarnessError.mismatch("unintended launch: \(launches) launches for \(starts.count) accepted starts")
        }
        // `afterRuns` absent: the runs list was not written, except that a
        // start whose reply is `unknown` may have left its start record
        // visible (the write was undetermined) and nothing else.
        let runsAfter = try world.runsOnDisk()
        if target.afterRuns == nil {
            if let runsBefore = before.runs {
                guard let runsAfter else { throw VectorHarnessError.mismatch("runs: state.json became unreadable") }
                if let difference = difference(.array(runsAfter), .array(runsBefore)),
                   !startRecordOnly(target, outcome, before: runsBefore, after: runsAfter) {
                    // A busy refusal's reconciled writes, and only those
                    // (Codex S9 ruling b), may have changed the runs.
                    guard busyStart else { throw VectorHarnessError.mismatch("unintended write: runs \(difference)") }
                    if let other = busyReconciliation(refusedRunId: refusedRunId, before: before.folder, after: try world.folderSnapshot(),
                                                      owed: before.owed, pushed: unstatedPushes) {
                        throw VectorHarnessError.mismatch("unintended write: runs \(difference); \(other)")
                    }
                }
            } else if world.stateBytes() != before.bytes {
                throw VectorHarnessError.mismatch("an unreadable state.json was replaced")
            }
        }
        // The participant write invariant, whether or not `afterRuns` is
        // stated: nothing in the folder changes but `state.json`, and that
        // only in its runs list. At the reply, and settled too unless a
        // held workspace request went on after the reply.
        if let operation = target.operation, participantAnswers.contains(operation) {
            try checkParticipantWrites(before: before.folder, after: outcome.atReply, runsBefore: before.runs, runsAfter: outcome.runsAtReply)
            let workspaceInFlight = target.inFlight.map {
                $0.request.objectValue?["operation"]?.stringValue?.hasPrefix("participant.") != true
            } ?? false
            if !workspaceInFlight {
                try checkParticipantWrites(before: before.folder, after: try world.folderSnapshot(), runsBefore: before.runs,
                                           runsAfter: runsAfter)
            }
            let mayReread = operation == HostOperation.participantStatus.rawValue && world.undeterminedArmed
            if participantReads.contains(operation), !mayReread, world.executor.runs != before.executorRuns {
                throw VectorHarnessError.mismatch("unintended write: \(operation) used the executor")
            }
        }
    }

    /// Section 17 (Codex S5 rulings), over the whole chain: every launched
    /// run whose stream observed paid overflow ended the confirmation, and
    /// the owner was called exactly once for each run that ended it (by an
    /// observation or the five-second rule). And Codex F0 answer 12: exactly
    /// one claim per launch attempt (a throwing launch included), so no
    /// refusal, replay, definite or undetermined write, recovery or Stop
    /// before step 14 ever claims.
    static func checkConfirmation(world: VectorWorld) async throws {
        guard world.confirmation.claims == world.launcher.requests.count else {
            throw VectorHarnessError.mismatch("claims: \(world.confirmation.claims) for \(world.launcher.requests.count) launch attempts")
        }
        var ended = 0
        for run in world.ownedRuns {
            guard let evidence = await world.coordinator.confirmationEvidence(of: run.identity.runId) else {
                throw VectorHarnessError.mismatch("confirmation: no memory of the launched run \(run.identity.runId)")
            }
            let observed = run.recordedUpdates.contains { if case .overflowObserved = $0 { return true } else { return false } }
            if observed, !(evidence.ended && evidence.overflowObserved) {
                throw VectorHarnessError.mismatch("confirmation: \(run.identity.runId) observed overflow and ended nothing")
            }
            if evidence.ended { ended += 1 }
        }
        guard world.confirmation.paidOverflowEnds == ended else {
            throw VectorHarnessError.mismatch("confirmation: \(world.confirmation.paidOverflowEnds) ends for \(ended) runs that ended it")
        }
    }

    /// Whether the only change is the target start's own record on its run
    /// (an undetermined write the folder shows), for an `unknown` start.
    static func startRecordOnly(_ target: ParticipantVectors.Case, _ outcome: VectorWorld.Outcome, before: [JSONValue],
                                after: [JSONValue]) -> Bool {
        guard target.operation == HostOperation.participantStart.rawValue, outcome.reply.outcome == .unknown,
              let runId = target.request.objectValue?["payload"]?.objectValue?["runId"]?.stringValue,
              let requestId = target.requestId, before.count == after.count else { return false }
        for (old, new) in zip(before, after) {
            guard var oldEntry = old.objectValue, var newEntry = new.objectValue else { return false }
            if oldEntry["runId"] == .string(runId), oldEntry["start"] == .null,
               newEntry["start"]?.objectValue?["requestId"] == .string(requestId) {
                oldEntry["start"] = nil
                newEntry["start"] = nil
            }
            if difference(.object(oldEntry), .object(newEntry)) != nil { return false }
        }
        return true
    }

    /// Section 7 step 12's narrow exception to Codex Q26's "a refusal
    /// writes nothing" (Codex S9 ruling b), over two `folderSnapshot()`s:
    /// nil when every change from `before` to `after`, and every push, is
    /// one of the writes `owed` held for another run before the refused
    /// start arrived, made durable; otherwise what else happened. Every
    /// file but `state.json` stays byte-identical, and `state.json` too
    /// when no entry changed (else the same beyond its runs, by canonical
    /// value, since the store rewrote it); the runs keep their order and
    /// the refused run's entry is unchanged; each changed entry is another
    /// run's, and is its entry before with one owed write applied: that
    /// write's exact terminal, where the entry had none or that same one
    /// (never another replaced), and the `groupCleared` owed with it (never
    /// true back to false). A push is a never-spawned owed terminal the
    /// folder now holds, the run's one event, at most once per connection.
    static func busyReconciliation(refusedRunId: String?, before: [String: Data], after: [String: Data],
                                   owed: [String: [ParticipantCoordinator.OwedWrite]], pushed: [JSONValue]) -> String? {
        let state = "/state.json"
        var otherBefore = before
        var otherAfter = after
        otherBefore[state] = nil
        otherAfter[state] = nil
        if let changed = folderChange(otherBefore, otherAfter) { return "it changed \(changed)" }
        guard let oldState = before[state].flatMap({ try? JSONValue.decode($0) })?.objectValue,
              let newState = after[state].flatMap({ try? JSONValue.decode($0) })?.objectValue,
              case .array(let oldRuns)? = oldState["runs"], case .array(let newRuns)? = newState["runs"] else {
            return before[state] == after[state] && pushed.isEmpty ? nil : "state.json is unreadable or holds no runs list"
        }
        var oldRest = oldState
        var newRest = newState
        oldRest["runs"] = nil
        newRest["runs"] = nil
        if difference(.object(newRest), .object(oldRest)) != nil { return "it changed state.json beyond its runs" }
        guard oldRuns.count == newRuns.count else { return "it added or removed a run" }
        // The never-spawned owed terminals the folder now holds, exactly as
        // the store holds them (that terminal with null groupCleared): each
        // may be pushed, as its run's one event (Codex S9-N1).
        var pushable: [String: JSONValue] = [:]
        var changedEntry = false
        for (old, new) in zip(oldRuns, newRuns) {
            guard let entry = old.objectValue, let runId = entry["runId"]?.stringValue,
                  let later = new.objectValue, later["runId"] == .string(runId) else { return "it reordered the runs" }
            for write in owed[runId] ?? [] where write.neverSpawned {
                if difference(later["terminal"] ?? .null, write.terminal.jsonValue) == nil,
                   (later["groupCleared"] ?? .null) == .null,
                   let sessionId = later["sessionId"]?.stringValue,
                   let event = ParticipantEvent(runId: runId, sessionId: sessionId, recorded: write.terminal) {
                    pushable[runId] = event.jsonValue
                }
            }
            guard difference(new, old) != nil else { continue }
            changedEntry = true
            if runId == refusedRunId { return "it changed the refused run's own entry" }
            let applied = (owed[runId] ?? []).contains { write in
                let terminal = entry["terminal"] ?? .null
                guard terminal == .null || difference(terminal, write.terminal.jsonValue) == nil else { return false }
                guard entry["groupCleared"] != .bool(true) || write.groupCleared == true else { return false }
                var expected = entry
                expected["terminal"] = write.terminal.jsonValue
                expected["groupCleared"] = write.groupCleared.map(JSONValue.bool) ?? .null
                return difference(.object(expected), new) == nil
            }
            if !applied { return "it changed \(runId)'s entry beyond the writes owed for it" }
        }
        // Nothing owed was made durable: `state.json` keeps its exact bytes
        // (Q26's byte-identical rule, unweakened).
        if !changedEntry, before[state] != after[state] { return "it rewrote state.json with no owed write made durable" }
        var seen: Set<String> = []
        for push in pushed {
            guard let detail = push.objectValue, detail["type"] == .string("participant.event"),
                  let event = detail["event"], let runId = event.objectValue?["runId"]?.stringValue,
                  let expected = pushable[runId], difference(event, expected) == nil else {
                return "it pushed something other than a never-spawned owed terminal now durable"
            }
            guard seen.insert("\(detail["connectionId"]?.stringValue ?? "")|\(runId)").inserted else {
                return "it pushed \(runId)'s terminal twice to one connection"
            }
        }
        return nil
    }

    /// The participant write invariant over two `folderSnapshot()`s.
    static func checkParticipantWrites(before: [String: Data], after: [String: Data], runsBefore: [JSONValue]?,
                                       runsAfter: [JSONValue]?) throws {
        let state = "/state.json"
        var otherBefore = before
        var otherAfter = after
        otherBefore[state] = nil
        otherAfter[state] = nil
        if let changed = folderChange(otherBefore, otherAfter) {
            throw VectorHarnessError.mismatch("unintended write: a participant answer changed \(changed)")
        }
        let runsChanged: Bool
        switch (runsBefore, runsAfter) {
        case (let earlier?, let later?): runsChanged = difference(.array(later), .array(earlier)) != nil
        case (nil, nil): runsChanged = false
        default: runsChanged = true
        }
        guard runsChanged else {
            if before[state] != after[state] {
                throw VectorHarnessError.mismatch("unintended write: a participant answer that changed no run rewrote state.json")
            }
            return
        }
        guard let oldState = before[state].flatMap({ try? JSONValue.decode($0) })?.objectValue,
              let newState = after[state].flatMap({ try? JSONValue.decode($0) })?.objectValue else {
            throw VectorHarnessError.mismatch("unintended write: state.json became unreadable")
        }
        var oldRest = oldState
        var newRest = newState
        oldRest["runs"] = nil
        newRest["runs"] = nil
        if let difference = difference(.object(newRest), .object(oldRest)) {
            throw VectorHarnessError.mismatch("unintended write: a participant write changed state.json beyond its runs: \(difference)")
        }
    }

    /// Nil when the canonical bytes agree; otherwise the first byte where
    /// they differ. Bytes, never `String` or `Character` equality, which is
    /// canonical equivalence: precomposed é and e + U+0301, or the Kelvin
    /// sign and K, are equal Swift strings but different wire bytes, and
    /// nothing on the wire is normalized (Codex Q17).
    static func difference(_ actual: JSONValue, _ expected: JSONValue) -> String? {
        let actualBytes = [UInt8](actual.canonicalData())
        let expectedBytes = [UInt8](expected.canonicalData())
        guard actualBytes != expectedBytes else { return nil }
        let index = zip(actualBytes, expectedBytes).enumerated().first { $0.element.0 != $0.element.1 }?.offset
            ?? min(actualBytes.count, expectedBytes.count)
        func at(_ bytes: [UInt8]) -> String {
            let byte = index < bytes.count ? String(format: "0x%02X", bytes[index]) : "end"
            // The excerpt is for reading only; a cut multibyte character shows as U+FFFD.
            let excerpt = String(decoding: bytes[max(0, index - 60)..<min(bytes.count, index + 60)], as: UTF8.self)
            return "\(byte) …\(excerpt)…"
        }
        return "differs at byte \(index): actual \(at(actualBytes)) expected \(at(expectedBytes))"
    }

    /// The first path whose bytes changed, appeared or vanished between two
    /// `folderSnapshot()`s; nil when the folder is byte-identical.
    static func folderChange(_ before: [String: Data], _ after: [String: Data]) -> String? {
        Set(before.keys).union(after.keys).sorted().first { before[$0] != after[$0] }
    }
}

/// The seeded availability report (the test fake): reported as it is.
struct SeededAvailability: AvailabilityReporting {
    let seeded: ParticipantAvailabilityReport

    func report() async -> ParticipantAvailabilityReport { seeded }
    func recheck() async -> ParticipantAvailabilityReport { seeded }
}

/// Runs each piece of store work on its own thread, never the shared pool
/// (a write held inside the store's lock cannot starve the tasks under
/// test), and counts them: every coordinator write must pass through here.
/// After `holdNext(skipping:)`, one piece waits on its thread before it
/// reaches the store (so the store's lock stays free), signalling `held`
/// first, until `releaseHeld()`, for at most `vectorWaitSeconds`.
final class CountingExecutor: MutationExecutor, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    /// Pieces still to pass before the one that waits (nil: none waits).
    private var holdAfter: Int?
    private var timeouts = 0
    let held = DispatchSemaphore(value: 0)
    private let releaseSignal = DispatchSemaphore(value: 0)

    var runs: Int {
        lock.lock(); defer { lock.unlock() }
        return count
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        count = 0
    }

    /// The next piece after `skipping` more waits before the store.
    func holdNext(skipping: Int = 0) {
        lock.lock(); defer { lock.unlock() }
        holdAfter = skipping
    }

    /// Lets the waiting piece (or the next one to wait) go.
    func releaseHeld() { releaseSignal.signal() }

    /// Holds that ended because nothing released them in time (a test
    /// mistake: the test must fail).
    var holdTimeouts: Int {
        lock.lock(); defer { lock.unlock() }
        return timeouts
    }

    /// Counts the piece; whether it waits.
    private func recordRun() -> Bool {
        lock.lock(); defer { lock.unlock() }
        count += 1
        guard let after = holdAfter else { return false }
        if after > 0 {
            holdAfter = after - 1
            return false
        }
        holdAfter = nil
        return true
    }

    func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        let waits = recordRun()
        return try await withCheckedThrowingContinuation { continuation in
            Thread {
                if waits {
                    self.held.signal()
                    if self.releaseSignal.wait(timeout: .now() + vectorWaitSeconds) == .timedOut {
                        self.lock.lock(); self.timeouts += 1; self.lock.unlock()
                    }
                }
                continuation.resume(with: Result { try work() })
            }.start()
        }
    }
}

extension Data {
    /// Seals these bytes as `store`'s state and writes them in place: a
    /// hand-edited or damaged state that still opens under the store's key.
    func writePlainState(to store: ProofStore) throws { try store.writePlainStateForTesting(self) }
}
