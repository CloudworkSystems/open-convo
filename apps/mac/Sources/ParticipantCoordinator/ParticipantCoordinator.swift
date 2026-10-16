import DeskHost
import Foundation
import ParticipantProcess

/// The participant lane (`docs/desk-native-participant-contract.md`
/// sections 3-10): one actor for the whole app launch, behind `HostRouter`.
///
/// INACTIVE. Nothing in the app constructs it; only the test target depends
/// on this module, and linking it constructs nothing (Codex Q1, Q19). It
/// answers `participant.availability`, `.status`, `.events`, `.stop` and
/// `participant.start` (section 7) with the memory of the runs it starts
/// (`RunMemory.swift`): Stop of a running, stopping or cleanup-pending run
/// signals first and answers from that memory, a lost supervisor is
/// answered without signalling, and a run's terminal and cleanup evidence
/// are written in the background, bounded and idempotent, with every new
/// start busy until they are durable (section 10; Codex Q31). Lock, unlock,
/// window close and quit (section 14; plan S10) are `ParticipantLane`'s
/// lifecycle calls, below `detach()`.
///
/// Lifetime (Codex Q21). The coordinator outlives any one Desk window: it
/// builds each Desk stack's participant host (`makeHost`), is attached to
/// the current stack (its store, connection registry and event sink;
/// `ParticipantStackAttaching`, the Desk session's lane) and detached when
/// that stack closes, keeping its text-free memory: owned groups, run
/// state and the terminal and cleanup writes it still owes. A detached
/// coordinator answers nothing and pushes nothing, and it attaches again
/// only to a stack over the same workspace folder, whose attach then queues
/// those owed writes (Codex Q32; S9 ruling c). Its own lock and closed
/// flags (`CoordinatorGate`) are set on the app's thread, before any await,
/// and outlive stacks too.
///
/// Store access (contract section 7, concurrency). The coordinator never
/// takes `ProofStore`'s writer lock on its own thread. It reads only the
/// published runs copy (`ProofStore.publishedRuns`, behind the store's
/// snapshot lock), so status, events and Stop answer while a commit holds
/// the store through its flush. Every write, and the authoritative re-read
/// after an undetermined start record, runs on the configured
/// `MutationExecutor`.
///
/// Identity (section 3). Availability, status, events and Stop claim no
/// request identity and leave none. A start claims its request id in the
/// one `ParticipantHostConfiguration.identities` the workspace lane shares
/// (a stack is attached only when its host was built over that stack's
/// store and registry with this configuration, that same index included,
/// `===`), and keeps it only when its start record may have been written.
public actor ParticipantCoordinator: ParticipantLane, ParticipantStackAttaching {
    public struct Configuration: Sendable {
        /// The value the stack's `DeskHostProtocol` was built with: its pin
        /// and input bound are the ones the commit checks used, and its
        /// identity space is the one both lanes claim through.
        public let hostConfiguration: ParticipantHostConfiguration
        /// Where availability comes from. A shipping host passes
        /// `CheckedAvailability(checker: ShippingAvailability())`, which is
        /// always `overflow-unverified`; only `ParticipantProcess` can make
        /// an answer that says available.
        public let availability: any AvailabilityReporting
        /// This app launch's id, canonical lowercase UUIDv4: a start record
        /// names it, and a recorded start with another one is an earlier
        /// launch's.
        public let launchId: String
        /// Wall time for the events and start records the coordinator makes
        /// itself; monotonic time for section 17's five-second rule.
        public let clock: any ParticipantClock
        /// Runs every store write, off this actor.
        public let executor: any MutationExecutor
        /// Starts runs. Its `cliVersion` is the one version a start record
        /// may name (Codex Q16); the coordinator keeps no copy.
        public let launcher: any ParticipantLaunching
        public let log: any ParticipantLogSink
        /// Wake-ups on `clock`'s monotonic time (section 17's five-second
        /// rule).
        public let wakeups: any ParticipantWakeups
        /// Section 17's confirmation owner: the coordinator ends it and
        /// claims each run from it. Nil from the first public initializer,
        /// so there is no confirmation to end or claim (and shipping
        /// availability stays `overflow-unverified`); the second gives
        /// `PaidUsageConfirmationOwner` as both this and `availability`.
        /// Tests may give a fake.
        let confirmation: (any ParticipantConfirmationOwning)?

        public init(hostConfiguration: ParticipantHostConfiguration, availability: any AvailabilityReporting, launchId: String,
                    clock: any ParticipantClock, executor: any MutationExecutor, launcher: any ParticipantLaunching,
                    log: any ParticipantLogSink) {
            self.init(hostConfiguration: hostConfiguration, availability: availability, launchId: launchId, clock: clock,
                      executor: executor, launcher: launcher, log: log, wakeups: DispatchParticipantWakeups(clock: clock),
                      confirmation: nil)
        }

        /// Section 17 built (plan F4): `owner` is both where availability
        /// comes from and the confirmation the coordinator ends and claims
        /// runs from, so the two can never disagree. `hostConfiguration` must
        /// carry section 17's first-trial input bound (4,096 UTF-8 bytes):
        /// a host with the confirmation never lacks it, and another value
        /// stops here (Codex F34-3; the Desk host is built from the same
        /// configuration, since attach refuses another bound). Nothing in
        /// the app calls this yet: activation (F7) composes it.
        public init(hostConfiguration: ParticipantHostConfiguration, confirmationOwner owner: PaidUsageConfirmationOwner,
                    launchId: String, clock: any ParticipantClock, executor: any MutationExecutor,
                    launcher: any ParticipantLaunching, log: any ParticipantLogSink) {
            precondition(hostConfiguration.inputBound == ParticipantLimits.firstTrialInputBound,
                         "section 17: a host with the confirmation has the first-trial input bound")
            self.init(hostConfiguration: hostConfiguration, availability: owner, launchId: launchId, clock: clock,
                      executor: executor, launcher: launcher, log: log, wakeups: DispatchParticipantWakeups(clock: clock),
                      confirmation: owner)
        }

        init(hostConfiguration: ParticipantHostConfiguration, availability: any AvailabilityReporting, launchId: String,
             clock: any ParticipantClock, executor: any MutationExecutor, launcher: any ParticipantLaunching,
             log: any ParticipantLogSink, wakeups: any ParticipantWakeups, confirmation: (any ParticipantConfirmationOwning)?) {
            precondition(ParticipantIds.runLike(.string(launchId)) != nil, "a launch id is a canonical lowercase UUIDv4")
            self.hostConfiguration = hostConfiguration
            self.availability = availability
            self.launchId = launchId
            self.clock = clock
            self.executor = executor
            self.launcher = launcher
            self.log = log
            self.wakeups = wakeups
            self.confirmation = confirmation
        }
    }

    /// Why `attach` refused a stack. Nothing changes when it refuses.
    public enum AttachError: Error, Equatable, Sendable {
        /// A stack is attached already; detach it first.
        case alreadyAttached
        /// The stack's store is another workspace or folder than the one
        /// this launch first attached (Codex Q21).
        case differentWorkspace
        /// The stack's host is not a participant host over this store and
        /// registry built with this configuration: another identity space
        /// (the two lanes would accept request ids independently: Codex
        /// Q20, Q22), another pin or input bound, or a v1 host.
        case differentHost
        /// `detach()` ran while this attach refreshed the store: the stack
        /// it was attaching is being let go, so nothing was attached.
        case detached
        /// The store is closed: its writer lock is released, so it is never
        /// used again (Codex Q21). A reopened folder is a new store.
        case closedStore
        /// A window close or quit is under way (one that began while this
        /// attach refreshed the store included), or a quit began this
        /// launch: nothing was attached (Codex Q33: a quit's one bound is
        /// never restarted or reopened by a new stack).
        case shuttingDown
    }

    /// The Desk stack the coordinator answers for. `serial` is its attach:
    /// a request admitted on one attach answers `unknown-connection` once
    /// another has replaced it, the same store attached again included
    /// (Codex S8: same-store re-attach epochs).
    private struct Stack {
        let store: ProofStore
        let connections: ConnectionRegistry
        let serial: Int
    }

    /// One write of a terminal for a run that never spawned, in flight, on
    /// the store it was started on, with the exact terminal it writes.
    private struct InFlightCancellation {
        let store: ProofStore
        let task: Task<CancellationResult, Never>
        let sessionId: String
        let terminal: ParticipantRunTerminal
        /// The run's start record is durable (or an earlier attempt's
        /// pending terminal says so): until this write returns, the run's
        /// memory is this terminal, as if pending (`heldTerminal`).
        let startRecorded: Bool
        /// Decided while nothing could be pushed (`cancellationTask`):
        /// never pushed, even once durable.
        let quiet: Bool
    }

    /// The terminal of a run that never spawned that is not durable yet:
    /// the exact terminal, retried as it is by the next Stop, so the run
    /// never reads as `not-dispatched` or as an earlier launch's meanwhile
    /// (Codex Q5, Q28; S7 reading (c)). A never-dispatched run keeps one
    /// only while its write is undetermined (a definite failure leaves it
    /// `not-dispatched`, which is true). A run whose start record this
    /// launch made durable keeps one until it is durable, through definite
    /// failures too: it was dispatched, and only this memory says it never
    /// spawned. A pending one whose write meets another terminal or no
    /// entry, or that a read finds beside another terminal (or its own with
    /// a non-null `groupCleared`), is kept `conflict` until the app quits
    /// (Codex S9 ruling a; `failClosed`). Until a run's first write returns
    /// its terminal is in `cancellations` instead (`heldTerminal`).
    private struct PendingCancellation {
        let sessionId: String
        let terminal: ParticipantRunTerminal
        /// The run's start record is durable: kept until the terminal is.
        let startRecorded: Bool
        /// The last attempt was undetermined and may still prove durable,
        /// so a retry the store refuses before writing is `unknown`, not
        /// that refusal.
        let mayBeDurable: Bool
        /// Decided while nothing could be pushed: never pushed, even once
        /// a later retry makes it durable (section 14: a terminal held by a
        /// lock is written at the unlock, never pushed).
        let quiet: Bool
        /// The store holds another terminal for the run, or no entry:
        /// never retried, never dropped or written over the other, and
        /// every start stays busy until the app quits (ruling a).
        var conflict = false
    }

    /// A start that passed steps 1-12 and is marked `starting`.
    private struct AdmittedStart {
        let requestId: UUID
        let payloadHash: String
        let entry: ParticipantRunEntry
        let request: ParticipantStartRequest
        /// `CoordinatorGate.State.serial` when step 1 passed: a lock, window
        /// close, quit or detach since moves it, and the start then spawns
        /// nothing (section 7).
        let serial: Int
    }

    private enum Admission {
        case answer(HostResponse)
        case admitted(AdmittedStart)
    }

    public nonisolated let configuration: Configuration
    nonisolated let pushGate: ParticipantPushGate
    /// The lock and closed flags, the lock epoch and the live handles, set
    /// on the app's thread (`lockNow`, `beginShutdown`).
    nonisolated let gate: CoordinatorGate
    /// Signalled whenever a shutdown's wait may be over.
    private nonisolated let progress = ProgressSignal()
    private var stack: Stack?
    /// Counts attaches: each stack's `serial`.
    private var stackSerial = 0
    /// `finishShutdown` calls waiting now (a test probe reads it).
    private var finishingShutdown = 0
    /// The lock or close drops of retained text (`CoordinatorGate.State
    /// .textDrops`) and the stop rounds this actor has applied.
    private var appliedTextDrops = 0
    private var appliedStopRounds = 0
    /// The workspace folder this launch first attached; later stacks must
    /// be the same one.
    private var workspace: (directory: URL, workspaceId: UUID)?
    /// The current or most recent run's events.
    private var retained: RetainedRun?
    /// Every run this launch is starting or has started (`RunMemory.swift`).
    private var owned: [String: OwnedRun] = [:]
    /// One authoritative re-read per undetermined start at a time, on the
    /// stack (`serial`) that asked for it; every request on that stack that
    /// needs it shares it, and a request on another stack waits for it to
    /// end and then re-reads on its own (Codex S8).
    private var rereads: [String: (serial: Int, task: Task<UncertainResolution, Never>)] = [:]
    private var pendingCancellations: [String: PendingCancellation] = [:]
    /// One terminal write per never-spawned run at a time; concurrent Stops
    /// on the same store share it and its one terminal. A Stop from a later
    /// stack never joins one started on an earlier stack's store (Codex
    /// Q21).
    private var cancellations: [String: InFlightCancellation] = [:]
    /// Never-spawned runs of this launch whose terminal is durable (plan S9).
    private var endedRuns: [String: EndedRun] = [:]
    /// One persistence pass per spawned run at a time (Codex Q31).
    private var persisting: [String: Task<Void, Never>] = [:]
    /// Runs whose evidence changed while their pass was in flight: one more
    /// pass follows it.
    private var persistAgain: Set<String> = []
    /// Moves on every `detach()`, so an attach that was waiting on its
    /// store refresh sees that its stack was let go meanwhile.
    private var attachEpoch = 0

    public init(configuration: Configuration) {
        self.configuration = configuration
        let pushes = ParticipantPushGate()
        pushGate = pushes
        gate = CoordinatorGate(pushes: pushes)
    }

    // MARK: Desk stack

    /// Attaches the current Desk stack: its host, the store and connection
    /// registry that host was built over, and its event sink. The host must
    /// be a participant host over exactly that store and registry, built
    /// with this coordinator's configuration (its identity space, pin and
    /// input bound). The store's runs copy is refreshed first, on the
    /// executor (an opened store publishes nothing durable before its first
    /// folder flush); a store that cannot refresh stays as it published
    /// itself (missing, corrupt or not yet durable), which the read side
    /// answers truthfully. A `detach()` during that refresh lets go of the
    /// stack being attached. Memory is kept from earlier stacks. A closed
    /// store is refused: nothing of a released writer lock is reused (Codex
    /// Q21).
    ///
    /// Attaching ends a window close's `closing` flag, so pushes reach this
    /// stack unless the coordinator is locked. A close or quit under way
    /// refuses it, a `beginShutdown` that lands while it refreshes the
    /// store included, and so does any quit this launch began
    /// (`shuttingDown`): a stack attaches only after a close's detach, and
    /// never during or after a quit, so nothing reopens starts or pushes
    /// while one runs or restarts its bound. Then, unless locked, every
    /// terminal and cleanup write this launch owes for the folder is queued
    /// once, before this stack's first request is handled (Codex Q32; S9
    /// ruling c), one pass per write and run at a time; a conflicted one
    /// never (ruling a). Locked, they wait for the unlock.
    public func attach(host: DeskHostProtocol, store: ProofStore, connections: ConnectionRegistry,
                       sink: HostEventSink) async throws {
        guard host.isParticipantHost(store: store, connections: connections, configuration: configuration.hostConfiguration) else {
            throw AttachError.differentHost
        }
        guard !store.publishedRuns.closed else { throw AttachError.closedStore }
        guard stack == nil else { throw AttachError.alreadyAttached }
        if let workspace, workspace.directory != store.directory || workspace.workspaceId != store.workspaceId {
            throw AttachError.differentWorkspace
        }
        guard !gate.refusesAttach else { throw AttachError.shuttingDown }
        let epoch = attachEpoch
        _ = try? await configuration.executor.run { try store.refreshPublishedRuns() }
        guard epoch == attachEpoch else { throw AttachError.detached }
        // Another attach may have finished while this one waited.
        guard stack == nil else { throw AttachError.alreadyAttached }
        if let workspace, workspace.directory != store.directory || workspace.workspaceId != store.workspaceId {
            throw AttachError.differentWorkspace
        }
        guard !store.publishedRuns.closed else { throw AttachError.closedStore }
        // The gate decides under its own lock, against a close or quit that
        // began on the app's thread at any moment until now.
        guard gate.attach(sink: sink, connections: connections) else { throw AttachError.shuttingDown }
        workspace = (store.directory, store.workspaceId)
        stackSerial += 1
        stack = Stack(store: store, connections: connections, serial: stackSerial)
        syncLifecycle()
        reconcileUnresolved(store: store)
        noteProgress()
    }

    /// Lets go of the stack. What stops, and what does not (Codex S7):
    /// - Refused from here: every new request (`unknown-connection`), every
    ///   push (the push gate is detached before this returns), and every
    ///   new piece of store work through the stack's store: no persistence
    ///   pass, cancellation write or re-read is started through it again.
    ///   An attach still refreshing its store attaches nothing. A start in
    ///   progress spawns nothing (section 7; its durable start record gets
    ///   its never-spawned terminal, kept until a stack over the same folder
    ///   is attached).
    /// - Drained, not recalled: store work already handed to the executor
    ///   finishes against the store it was started on, and the coordinator's
    ///   memory follows its outcome. A never-spawned terminal's write
    ///   returns its result to the Stop that made or joined it, as the store
    ///   answered (`store-locked` once the store closed): that Stop is an
    ///   earlier request of the stack let go. Every other request admitted on
    ///   it that is still waiting (on a start, the start a Stop cancelled
    ///   before step 14 included, a terminal, a cleanup retry or a re-read)
    ///   answers `unknown-connection`, even if the same store was attached
    ///   again meanwhile (`Stack.serial`); a re-read that returns after its
    ///   stack was let go decides nothing. A never-spawned terminal that
    ///   such a drained write leaves owed is queued once more, through the
    ///   stack attached when it returns, if that is another store over the
    ///   same folder (that attach's own flush skipped it while it was in
    ///   flight: S9 ruling c).
    /// - Not this layer's: a reply the coordinator returns goes back
    ///   through the transport that asked, which drops it once the asking
    ///   document's connection is gone (`HostMessageHandler`'s stale-reply
    ///   check, S11): an answer computed across a detach, an availability
    ///   answer included, never reaches another document.
    ///
    /// A window close's bound ends with its detach, so a quit after it
    /// begins its own; a quit's bound never ends (Codex Q33).
    ///
    /// Memory stays, retained event text included: detach is not where text
    /// is dropped. The app's lock and close steps (`lockNow`,
    /// `beginShutdown`) drop it first, with `lost` `locked` or `closed`,
    /// keeping only text-free run and terminal metadata (Codex Q21), and a
    /// drop they asked for is applied here before the stack goes if it was
    /// not yet. Every app detach follows a close; a test that detaches
    /// directly keeps the text.
    public func detach() {
        syncLifecycle()
        attachEpoch &+= 1
        gate.detach()
        stack = nil
        noteProgress()
    }

    /// Builds a Desk stack's host for this coordinator
    /// (`ParticipantStackAttaching.makeHost`; Codex's S10 carried
    /// requirement 1): a participant host over `store` and `connections`,
    /// pushing through `events`, built with this coordinator's own
    /// `configuration.hostConfiguration`. The same value, not a copy of
    /// its settings: its pin and input bound are the ones the commit checks
    /// use, and its `RequestIdentityIndex` is the one both lanes claim
    /// through (held by reference, so `attach`'s `===` check accepts the
    /// host; Codex Q20, Q22). The one place in Sources that hands a
    /// participant configuration to a host; nothing in the app constructs a
    /// coordinator (Codex Q1), so the app's Desk stays a v1 host.
    public nonisolated func makeHost(store: ProofStore, connections: ConnectionRegistry, drafts: DraftBindingRegistry,
                                     info: HostInfo, events: HostEventSink) -> DeskHostProtocol {
        DeskHostProtocol(store: store, connections: connections, drafts: drafts, info: info, events: events,
                         participants: configuration.hostConfiguration)
    }

    // MARK: Lifecycle (section 14; plan S10; Codex Q21, Q31-Q33)

    /// Lock begins (`ParticipantLane.lockNow`), before the host's
    /// `lock()`. Synchronous, with no actor hop: the lock flag, a new lock
    /// epoch, pushes suspended (after any push already under way returns
    /// from the sink), and `stop` to every live run's supervisor (each
    /// run's stop sequence finishes in the background, its terminal kept in
    /// memory, never pushed, its write held for the unlock). A start in
    /// progress spawns nothing, unless its launch was already under way:
    /// that run is sent `stop` as soon as it registers, and ends like any
    /// stopped run (section 7, S10 reading 2). The retained text is dropped
    /// (`lost` `locked`) and the stopped runs marked stopping by a
    /// follow-up on the actor, and before then by whatever reaches the
    /// actor first (a request, or a run's next update), so no request
    /// answered after this returns gives that text.
    public nonisolated func lockNow() {
        for handle in gate.lockNow() { handle.stop() }
        Task { await self.lifecycleFollowUp() }
    }

    public nonisolated var lockEpoch: Int { gate.state.lockEpoch }

    /// Moves on every `lockNow()` and every `beginShutdown(quitting:)`
    /// (`ParticipantLane.lifecycleEpoch`), set under the gate's lock before
    /// either returns, so the WebKit transport, reading it on the main
    /// thread, drops an answer to a request admitted before them.
    public nonisolated var lifecycleEpoch: Int { gate.state.lifecycleEpoch }

    /// After the host's `unlock()`, for a verified unlock that began at
    /// `epoch`: if no lock came since, the flag clears, pushes may go out
    /// again (to connections issued from now on) unless a close is under
    /// way, and every terminal and cleanup write held while locked is
    /// queued once, in the background, for the stack attached now (the
    /// same folder: Codex Q32). Nothing restarts. Each write checks the
    /// flag again before it goes to the store, and a locked store refuses
    /// it anyway.
    public func unlock(ifNoLockSince epoch: Int) async {
        guard gate.unlock(ifNoLockSince: epoch) else { return }
        syncLifecycle()
        if let store = stack?.store { reconcileUnresolved(store: store) }
        noteProgress()
    }

    /// Before later workspace store work outside this lane
    /// (`ParticipantLane.reconcileBeforeStoreWork`; S9 ruling c, plan S11):
    /// the pass `attach` and `unlock` queue, for every write owed for the
    /// attached stack's folder, then a wait for each pass and never-spawned
    /// write in flight at that moment to return. One attempt per owed write
    /// (a pass makes at most one per write, in order; a conflicted run is
    /// never queued, ruling a); what a pass queues once more afterwards
    /// (`persistAgain`, a drained write re-queued) is not waited for, so
    /// the wait is bounded by the writes owed when it began. With no stack,
    /// or while locked (Codex Q32), nothing is queued or waited for. Each
    /// write still checks the stack and the lock flag before it goes to the
    /// store.
    public func reconcileBeforeStoreWork() async {
        guard let store = stack?.store, !gate.isLocked else { return }
        syncLifecycle()
        reconcileUnresolved(store: store)
        let passes = Array(persisting.values)
        let writes = cancellations.values.map(\.task)
        noteProgress()
        for pass in passes { await pass.value }
        for write in writes { _ = await write.value }
    }

    /// Window close (`quitting` false) or quit begins
    /// (`ParticipantLane.beginShutdown(quitting:)`), before the host's
    /// `revokeForShutdown()`. Synchronous, like `lockNow`: the closed flag
    /// (every start is `store-locked`, and no stack attaches), pushes
    /// suspended, `stop` to every live run's supervisor, and the retained
    /// text dropped (`lost` `closed`), keeping only text-free run and
    /// terminal memory. The overall bound of `finishShutdown(quitting:)`
    /// runs from here (Codex Q33). A quit that begins during a window close
    /// shares that close's bound, whenever its own `finishShutdown` comes:
    /// the close's detach does not end it.
    public nonisolated func beginShutdown(quitting: Bool) {
        for handle in gate.beginShutdown(at: configuration.clock.monotonicMillis(), quitting: quitting) { handle.stop() }
        Task { await self.lifecycleFollowUp() }
    }

    /// Waits for what `beginShutdown(quitting:)` stopped (calling it first,
    /// with the same `quitting`, if the caller did not), for at most
    /// `ParticipantLimits.shutdownMillis` after it in all (Codex Q33): one
    /// bound for every participant obligation, starting, live, stopping,
    /// cleanup-pending or writes pending, with or without a stack, never
    /// one per run or phase, and never extended by calling again. A quit's
    /// bound runs from its own `beginShutdown(quitting: true)`, or from the
    /// window close under way then, whose bound it shares, however late
    /// this call comes and whatever detach came between; a quit after a
    /// close that ended, with no window, begins its own. It waits for:
    /// - every start in progress to end, and every spawned run's terminal;
    /// - `quitting`: also every group to be confirmed gone or released, and
    ///   every run's updates to end (a window close leaves those owned: the
    ///   coordinator keeps them busy across close and reopen, Codex Q21);
    /// - every terminal, cleanup and never-spawned write and re-read in
    ///   flight; then, once, one more bounded pass for every write still
    ///   owed, when a stack is attached and the coordinator is not locked.
    ///   Locked, or with no stack, nothing is written (Codex Q32: a quit
    ///   while locked leaves `exit-unrecorded` for the next launch).
    /// At the bound it returns whatever is unfinished; nothing it waited for
    /// is cancelled, and nothing stands in for a write that did not happen.
    /// Parent-death cleanup (section 11) still bounds every group once the
    /// app is gone.
    public func finishShutdown(quitting: Bool) async -> ParticipantShutdownReport {
        beginShutdown(quitting: quitting)
        syncLifecycle()
        let began = gate.state.boundStart(quitting: quitting) ?? configuration.clock.monotonicMillis()
        let deadline = began &+ ParticipantLimits.shutdownMillis
        let progress = self.progress
        let wakeup = configuration.wakeups.wake(atMonotonicMillis: deadline) { progress.signal() }
        finishingShutdown += 1
        defer {
            finishingShutdown -= 1
            wakeup.cancel()
        }
        var reconciled = false
        while true {
            let ticket = progress.ticket
            if shutdownSettled(quitting: quitting) {
                if !reconciled, let store = stack?.store, !gate.isLocked, !owedWrites().isEmpty {
                    reconciled = true
                    reconcileUnresolved(store: store)
                    continue
                }
                return ParticipantShutdownReport(reachedBound: false, remaining: currentObligations())
            }
            if configuration.clock.monotonicMillis() >= deadline {
                return ParticipantShutdownReport(reachedBound: true, remaining: currentObligations())
            }
            await progress.wait(after: ticket)
        }
    }

    /// What this launch still owes (Codex Q33), with or without a stack.
    /// Read after `beginShutdown(quitting: true)`, no start is admitted
    /// any more, so the answer cannot be overtaken by one. A confirmation
    /// revocation whose owner call has not returned is not counted: it
    /// keeps starts busy (Codex S8 R1), but the owner's call returns
    /// promptly (`ParticipantConfirmationOwning`) and nothing here is
    /// written for it, so a quit neither waits for it nor needs the
    /// participant bound for it (S10 reading 5).
    public func obligations() -> ParticipantObligations {
        syncLifecycle()
        return currentObligations()
    }

    private func currentObligations() -> ParticipantObligations {
        var obligations = ParticipantObligations()
        var writing = Set<String>()
        for (runId, memory) in owned {
            switch memory.phase {
            case .starting:
                obligations.starting += 1
            case .uncertain:
                // Spawned nothing and never will; nothing is owed for it
                // until a request re-reads it.
                break
            case .live(let live):
                if live.terminal == nil && !live.updatesFinished {
                    obligations.live += 1
                } else if !(live.cleanupReleased && live.updatesFinished) {
                    obligations.cleanupPending += 1
                }
                if !live.persistence.isResolved { writing.insert(runId) }
            }
        }
        writing.formUnion(pendingCancellations.keys)
        writing.formUnion(cancellations.keys)
        writing.formUnion(rereads.keys)
        writing.formUnion(persisting.keys)
        obligations.writesPending = writing.count
        return obligations
    }

    /// Nothing a shutdown waits for can still change by itself: no start in
    /// progress, every spawned run's terminal in (and, `quitting`, its
    /// cleanup released and updates ended), and no store work in flight.
    private func shutdownSettled(quitting: Bool) -> Bool {
        guard cancellations.isEmpty, rereads.isEmpty, persisting.isEmpty else { return false }
        for memory in owned.values {
            switch memory.phase {
            case .starting:
                return false
            case .uncertain:
                continue
            case .live(let live):
                if live.terminal == nil && !live.updatesFinished { return false }
                if quitting, !(live.cleanupReleased && live.updatesFinished) { return false }
            }
        }
        return true
    }

    private func lifecycleFollowUp() {
        syncLifecycle()
        noteProgress()
    }

    /// Applies, on the actor, what lock and close asked for on the app's
    /// thread: the retained text dropped (`locked` or `closed`), and every
    /// run they stopped marked stopping (its first Stop's latch, so a later
    /// Stop joins it and signals nothing more: section 10). Every entry to
    /// the actor that reads or keeps text calls this first.
    private func syncLifecycle() {
        let state = gate.state
        if state.textDrops != appliedTextDrops {
            appliedTextDrops = state.textDrops
            retained = retained?.droppingText(state.dropReason)
        }
        if state.stopRounds != appliedStopRounds {
            appliedStopRounds = state.stopRounds
            for (runId, memory) in owned {
                guard case .live(var live) = memory.phase, live.terminal == nil, !live.updatesFinished,
                      live.terminalLatch == nil else { continue }
                live.stopRequested = true
                live.terminalLatch = WaitLatch()
                owned[runId]?.phase = .live(live)
            }
        }
    }

    /// A start, run, write or re-read changed: a shutdown waiting looks again.
    private func noteProgress() {
        progress.signal()
    }

    // MARK: Requests

    /// Section 4's order after the envelope: shape and identities, the
    /// handle, then the operation.
    ///
    /// `HostRouter` runs `HostPreflight` before calling here. It runs again
    /// here, against the attached stack's registry, for two paths the router
    /// does not cover: a direct call (tests, or WebKit glue that hands the
    /// lane a decoded request), and a request admitted by an earlier stack's
    /// router that reaches the coordinator after it detached or attached
    /// another stack (Codex Q21). On the router's path it repeats the same
    /// checks against the same registry, so it agrees with the router unless
    /// the registry moved in between: a new generation begun or the
    /// connection revoked after the router's check and before this one is
    /// refused here (`stale-generation` or `unknown-connection`), as it
    /// would have been a moment later at the router.
    public func handle(_ request: HostRequest) async -> HostResponse {
        let echo = request.echo
        syncLifecycle()
        guard request.operation.isParticipant else { return .refused(.unknownOperation, echo: echo) }
        guard let stack else { return .refused(.unknownConnection, echo: echo) }
        if let refusal = HostPreflight.check(request, connections: stack.connections) { return .refused(refusal, echo: echo) }
        switch request.operation {
        case .participantAvailability:
            return await availability(request)
        case .participantStatus:
            return await status(request, stack: stack)
        case .participantEvents:
            return events(request, stack: stack)
        case .participantStop:
            return await stop(request, stack: stack)
        case .participantStart:
            return await start(request, stack: stack)
        case .capabilities, .workspaceRead, .workspaceCommitProof, .dictationBindDraft, .dictationUnbindDraft,
             .workspaceReconcile, .dictationReceipt:
            return .refused(.unknownOperation, echo: echo)
        }
    }

    /// The stack a request was admitted on, still attached after an await;
    /// nil (the request answers `unknown-connection`) once it was let go,
    /// even if the same store was attached again since (Codex S8).
    private func stillAttached(_ stack: Stack) -> Stack? {
        guard let current = self.stack, current.serial == stack.serial else { return nil }
        return current
    }

    // MARK: Availability (section 5)

    private func availability(_ request: HostRequest) async -> HostResponse {
        if let refusal = ParticipantRequests.availability(request.payload) { return .refused(refusal, echo: request.echo) }
        // Passed through as it is, unless `ownedReport` lowers it. Codex
        // Q13's downgrade (a present confirmation that is not `active` never
        // goes with an available answer) lives in
        // `ParticipantAvailabilityReport` itself, whose only initializer
        // applies it, so no report reaching here can break it. The pin comes
        // from this build's configuration, never the checker; `available`,
        // `reason` and any confirmation come only from the report, so
        // nothing here can make an answer available.
        let report = ownedReport(await configuration.availability.report())
        var entry = configuration.hostConfiguration.pin.jsonValue.objectValue ?? [:]
        entry.merge(report.jsonFields) { pinned, _ in pinned }
        guard let route = configuration.hostConfiguration.localRoute else {
            return .ok(request.echo, ["participants": .array([.object(entry)])])
        }
        // Section 20.2: the Claude Code entry first, exactly as above, then
        // the local route's entries and its one `routes` item, read afresh.
        // Whether a local model is available is the catalog's answer
        // (`LocalCatalogAnswer.availabilityFields`), never this actor's.
        return .ok(request.echo, await route.localCatalog().checked.availabilityFields(claude: entry))
    }

    /// A report that carries a confirmation, from a coordinator with no
    /// section 17 owner to end it: nothing here could end that
    /// confirmation on an overflow observation or the five-second rule, so
    /// the answer is lowered to `overflow-unverified`, the display kept
    /// (Codex Q13: an omission is never a bypass). Only a wiring mistake
    /// reaches this; shipping reports carry no confirmation.
    private func ownedReport(_ report: ParticipantAvailabilityReport) -> ParticipantAvailabilityReport {
        guard report.availability.available, let confirmation = report.confirmation, configuration.confirmation == nil else {
            return report
        }
        return ParticipantAvailabilityReport(availability: .unavailable(.overflowUnverified), confirmation: confirmation)
    }

    // MARK: Start (section 7)

    /// Section 7, in order. An undetermined start record of this run is
    /// re-read first (steps 1-3 decide before it, and again after), so that
    /// steps 1-12 and the starting mark then run with no await between
    /// them; the first awaits are step 13's availability recheck and step
    /// 14's write.
    private func start(_ request: HostRequest, stack: Stack) async -> HostResponse {
        let echo = request.echo
        var stack = stack
        if let runId = ParticipantIds.runLike(request.payload["runId"]), case .uncertain? = owned[runId]?.phase {
            if let refusal = startPrechecks(request, stack: stack) { return .refused(refusal, echo: echo) }
            let resolution = await resolveUncertain(runId: runId, stack: stack)
            guard let current = stillAttached(stack) else { return .refused(.unknownConnection, echo: echo) }
            if let refusal = HostPreflight.check(request, connections: current.connections) { return .refused(refusal, echo: echo) }
            // Re-read failed: still undetermined, so this start answers
            // `unknown` and spawns nothing (section 7).
            if case .unresolved = resolution { return .unknown(echo) }
            stack = current
        }
        switch admit(request, stack: stack) {
        case .answer(let response):
            return response
        case .admitted(let admitted):
            return await run(admitted, echo: echo, stack: stack)
        }
    }

    /// Steps 1-3 alone, for a start that must re-read before step 4.
    private func startPrechecks(_ request: HostRequest, stack: Stack) -> HostRefusal? {
        let lifecycle = gate.state
        let runs = stack.store.publishedRuns
        if lifecycle.locked || lifecycle.closing || runs.locked || runs.closed { return .storeLocked }
        switch ParticipantRequests.start(request.payload) {
        case .refused(let refusal): return refusal
        case .value(let start):
            return ParticipantPin.sameBytes(start.run.workspaceHandle, stack.store.workspaceHandle) ? nil : .unknownHandle
        }
    }

    /// Steps 1-12 and the starting mark, with no await. A refusal releases
    /// the request id's claim before it answers, so it leaves no identity
    /// and writes nothing.
    private func admit(_ request: HostRequest, stack: Stack) -> Admission {
        let echo = request.echo
        // Read once, before step 1: a lock, close, quit or detach after this
        // read moves `serial`, which the start checks before step 14 and
        // after it, so none can slip between the check and the mark.
        let lifecycle = gate.state
        let runs = stack.store.publishedRuns
        // 1. The lock flag: the coordinator's own lock and closed flags
        // (S10; S8 reading 1's published store flag gives way), set by
        // `lockNow` and `beginShutdown` before any await. The store's
        // published locked or closed flag stays a backstop with the same
        // answer: a locked store refuses the start record's write anyway.
        if lifecycle.locked || lifecycle.closing || runs.locked || runs.closed {
            return .answer(.refused(.storeLocked, echo: echo))
        }
        // 2. Shape and identities.
        let start: ParticipantStartRequest
        switch ParticipantRequests.start(request.payload) {
        case .refused(let refusal): return .answer(.refused(refusal, echo: echo))
        case .value(let value): start = value
        }
        // 3. The handle.
        guard ParticipantPin.sameBytes(start.run.workspaceHandle, stack.store.workspaceHandle) else {
            return .answer(.refused(.unknownHandle, echo: echo))
        }

        // 4. Identity. A durable start record under this id replays `ok`
        // with the same bytes (only the published durable copy proves a
        // record: Codex Q5); then the shared index decides and claims in
        // one step.
        let requestId = request.requestId
        let payloadHash = request.payloadHash
        if let recorded = runs.runs.first(where: { $0.start?.requestId == request.requestIdString }), let record = recorded.start {
            guard record.payloadHash == payloadHash else { return .answer(.refused(.payloadMismatch, echo: echo)) }
            return .answer(.ok(echo, ["runId": .string(recorded.runId)]))
        }
        let identities = configuration.hostConfiguration.identities
        switch identities.claimStarting(requestId, payloadHash: payloadHash) {
        case .v1Identity:
            return .answer(.refused(.payloadMismatch, echo: echo))
        case .starting(let claimed), .recorded(let claimed):
            // Still starting, or written but not proven durable: the same
            // bytes cannot be told dispatched or not.
            return .answer(claimed == payloadHash ? .unknown(echo) : .refused(.payloadMismatch, echo: echo))
        case .claimed:
            break
        }
        // Every answer from here gives the claim back first.
        func answer(_ response: HostResponse) -> Admission {
            identities.releaseStarting(requestId)
            return .answer(response)
        }
        func refuse(_ reason: HostRefusal) -> Admission { answer(.refused(reason, echo: echo)) }
        // Codex S6: the published copy can keep a start's reservation the
        // index never saw (an earlier non-authoritative reload, before the
        // host registered). Its bytes are not known here, so it is neither
        // a replay nor a mismatch: `unknown`. Only the store's
        // authoritative re-read releases it.
        if runs.reservedStartRequestIds.contains(request.requestIdString) { return answer(.unknown(echo)) }

        // 5 and 6. The run's durable entry.
        let entry: ParticipantRunEntry
        switch runs.lookup(runId: start.runId) {
        case .found(let found):
            entry = found
        case .absent:
            return refuse(.unknownRun)
        case .unproven:
            switch runs.status {
            case .corrupt: return refuse(.storeCorrupt)
            case .missing: return refuse(.storeMissing)
            case .ready: return answer(.unknown(echo))   // not durable or settled yet: nothing is proven
            }
        }
        // 7. Started, starting, or owned under another id.
        if owned[start.runId] != nil || entry.start != nil { return refuse(.duplicateRun) }
        // 8. Stopped before starting.
        if entry.terminal != nil { return refuse(.runNotPrepared) }
        // A Stop before starting whose terminal is being written, or whose
        // write is undetermined: whether the run was stopped is not known
        // yet, and it must not start meanwhile.
        if cancellations[start.runId] != nil || pendingCancellations[start.runId] != nil { return answer(.unknown(echo)) }
        // 9. The run the page prepared: ids, participant and input hash,
        // byte for byte.
        guard ParticipantPin.sameBytes(start.run.sessionId, entry.sessionId),
              ParticipantPin.sameBytes(start.userMessageId, entry.userMessageId),
              ParticipantPin.sameBytes(start.assistantMessageId, entry.assistantMessageId),
              Self.isParticipant(start.participant, entry.participant),
              PayloadHash.hex(of: .array(start.inputChunks.map(JSONValue.string))) == entry.inputHash else {
            return refuse(.runMismatch)
        }
        // 10. Prepared for another pin than this build's (Codex Q25): never
        // run under another model. A local run (section 20) is refused here
        // too, sending nothing, until its start is wired (step 3 PR 3c).
        guard entry.participant == configuration.hostConfiguration.pin else { return refuse(.participantChanged) }
        // 11. Chunk limits and the first-trial bound, which also refuses a
        // run prepared above it.
        guard Self.inputFits(start.inputChunks, bound: configuration.hostConfiguration.inputBound) else {
            return refuse(.textTooLarge)
        }
        // 12. Another start in progress; a spawned run whose cleanup,
        // updates, or terminal and cleanup writes are not done, or whose
        // confirmation revocation is claimed and has not returned from the
        // owner (Codex S8 R1: the confirmation may still read active); or a
        // never-spawned terminal whose write is in flight or not yet durable
        // (Codex Q31: no start while any participant terminal or cleanup
        // write is unresolved), a conflicted one included, until the app
        // quits (Codex S9 ruling a). An earlier launch's runs are not here. The
        // refusal is retryable; the writes it waits for are queued now, in
        // the background (the reply never waits for the store). It writes
        // nothing for its own run, but those queued writes are other runs'
        // owed ones, and a never-spawned terminal made durable by one is
        // pushed then (S9 reading 6): the one refusal that may write for
        // other runs, and only those pre-existing owed writes (Codex S9
        // ruling b).
        if owned.values.contains(where: \.blocksStarts) || !cancellations.isEmpty || !pendingCancellations.isEmpty {
            reconcileUnresolved(store: stack.store)
            return refuse(.participantBusy)
        }
        // 13. The starting mark, before the first await.
        owned[start.runId] = OwnedRun(runId: start.runId, sessionId: entry.sessionId,
                                      phase: .starting(StartingRun(requestId: requestId)))
        return .admitted(AdmittedStart(requestId: requestId, payloadHash: payloadHash, entry: entry, request: start,
                                       serial: lifecycle.serial))
    }

    /// Steps 13-15 for an admitted start. Every path out ends the starting
    /// mark and resolves its latch, so a Stop waiting on it always answers.
    private func run(_ admitted: AdmittedStart, echo: HostEcho, stack: Stack) async -> HostResponse {
        let runId = admitted.entry.runId
        let identities = configuration.hostConfiguration.identities
        let latch = startingLatch(runId)
        defer {
            latch?.resolve(.reevaluate)
            noteProgress()
        }

        // 13. The availability recheck: never a reused check (section 5).
        let report = ownedReport(await configuration.availability.recheck())
        guard stillAttached(stack) != nil else {
            // Let go during the recheck: nothing is written for a stack
            // that was let go, not even a waiting Stop's cancellation (the
            // Stop answers `unknown-connection` too). A lock or close that
            // left the stack attached is the check below.
            identities.releaseStarting(admitted.requestId)
            owned[runId] = nil
            return .refused(.unknownConnection, echo: echo)
        }
        // A Stop seen before step 14: the start writes nothing and is
        // refused `run-not-prepared` once the cancellation is durable.
        if stopRequested(runId) {
            identities.releaseStarting(admitted.requestId)
            return await cancelBeforeStart(admitted, latch: latch, stack: stack, echo: echo)
        }
        // A lock, window close or quit seen before step 14, with no Stop
        // waiting (S10 reading): nothing is written, not even a terminal,
        // since nobody asked to stop this run, which stays
        // `not-dispatched`; the start is refused as step 1 refuses it now.
        if gate.state.serial != admitted.serial {
            identities.releaseStarting(admitted.requestId)
            owned[runId] = nil
            return .refused(.storeLocked, echo: echo)
        }
        guard report.availability.available,
              let record = ParticipantRunStart(requestId: admitted.requestId.canonicalString, payloadHash: admitted.payloadHash,
                                               at: Self.at(wall: configuration.clock.wallMillis(), createdAt: admitted.entry.createdAt),
                                               launchId: configuration.launchId, cliVersion: configuration.launcher.cliVersion) else {
            // Unavailable, or a launcher whose version cannot be recorded.
            identities.releaseStarting(admitted.requestId)
            owned[runId] = nil
            return .refused(.participantUnavailable, echo: echo)
        }

        // 14. The start record: the store's compare-and-set, on the
        // executor.
        let store = stack.store
        let written: Result<ParticipantRunEntry, Error>
        do {
            written = .success(try await configuration.executor.run { try store.recordStart(runId: runId, record) })
        } catch {
            written = .failure(error)
        }
        // The stack let go during the write (Codex S8): its reply is
        // `unknown-connection` whatever the write did.
        let attached = stillAttached(stack) != nil
        let entry: ParticipantRunEntry
        switch written {
        case .success(let durable):
            entry = durable
        case .failure(let error):
            if let refusal = Self.definiteStartFailure(error) {
                // Nothing applied (Codex Q29): a waiting Stop reads the run
                // again and cancels it as never dispatched.
                identities.releaseStarting(admitted.requestId)
                owned[runId] = nil
                return attached ? .refused(refusal, echo: echo) : .refused(.unknownConnection, echo: echo)
            }
            // Undetermined: nothing is spawned, and the claim stays until an
            // authoritative re-read settles the record (Codex Q5, Q27).
            owned[runId]?.phase = .uncertain(UncertainStart(requestId: admitted.requestId, retainedBefore: retained?.runId))
            return attached ? .unknown(echo) : .refused(.unknownConnection, echo: echo)
        }
        identities.recordStart(admitted.requestId)
        // Codex Q30: a durable start record replaces the previous run's
        // retained events.
        retained = RetainedRun.started(runId: runId, sessionId: entry.sessionId)

        // A Stop, or a lock, window close, quit or detach, seen at or after
        // step 14: spawn nothing; `stopped` `local-stop` at sequence 1,
        // nothing spawned; reply `ok` (`unknown-connection` once let go).
        // From here the cancellation machinery holds the run's memory: its
        // terminal stays pending until durable (`startRecorded`). Decided
        // while nothing may be pushed, it is never pushed; while locked or
        // let go it is not written either, only kept for the unlock or the
        // next attach over the same folder (`writeCancellation`; Codex Q32).
        if stopRequested(runId) || gate.state.serial != admitted.serial || !attached {
            owned[runId] = nil
            let task = cancellationTask(runId: runId, sessionId: entry.sessionId,
                                        terminal: unspawnedTerminal(.stopped(.localStop), createdAt: entry.createdAt),
                                        startRecorded: true, store: store)
            latch?.resolve(.answered(await task.value))
            return stillAttached(stack) != nil ? .ok(echo, ["runId": .string(runId)]) : .refused(.unknownConnection, echo: echo)
        }

        // 15. Spawn. A throw is `failed` `process-error` at sequence 1 with
        // nothing spawned; the reply is still `ok` (section 7).
        let launch = ParticipantLaunchRequest(
            identity: ParticipantRunIdentity(runId: runId, sessionId: entry.sessionId,
                                             createdAtMillis: ParticipantTimestamp.parse(entry.createdAt) ?? 0),
            model: configuration.hostConfiguration.pin.model, inputChunks: admitted.request.inputChunks,
            inputBytes: entry.inputBytes, preparedBytes: entry.preparedBytes)
        // Section 17's run claim (Codex F0 answer 12), at the commit-to-spawn
        // boundary: after the durable record and the checks after it, once,
        // synchronously on this actor, with no await between it and the
        // launch below. Refused (no active confirmation, say ended by a
        // logout, or by a Check Claude that saw a change, during the write):
        // nothing is spawned and the run takes the never-spawned failure path
        // a throwing launch takes (`failed` `process-error` at sequence 1, the
        // start still `ok`). A throwing launch after a successful claim still
        // counts.
        if let owner = configuration.confirmation, !owner.claimRun() {
            owned[runId] = nil
            _ = await cancellationTask(runId: runId, sessionId: entry.sessionId,
                                       terminal: unspawnedTerminal(.failed(.processError), createdAt: entry.createdAt),
                                       startRecorded: true, store: store).value
            return stillAttached(stack) != nil ? .ok(echo, ["runId": .string(runId)]) : .refused(.unknownConnection, echo: echo)
        }
        let handle: any ParticipantRunning
        do {
            handle = try configuration.launcher.launch(launch)
        } catch {
            owned[runId] = nil
            _ = await cancellationTask(runId: runId, sessionId: entry.sessionId,
                                       terminal: unspawnedTerminal(.failed(.processError), createdAt: entry.createdAt),
                                       startRecorded: true, store: store).value
            return stillAttached(stack) != nil ? .ok(echo, ["runId": .string(runId)]) : .refused(.unknownConnection, echo: echo)
        }
        own(runId: runId, sessionId: entry.sessionId, handle: handle, admittedAt: admitted.serial)
        return .ok(echo, ["runId": .string(runId)])
    }

    /// Step 15's end: the spawned run is this launch's, and its updates are
    /// consumed in order from here. Its handle is registered with the gate,
    /// so lock, close and quit can `stop` it from the app's thread; one that
    /// came after the start last looked (`serial`) stops it here.
    private func own(runId: String, sessionId: String, handle: any ParticipantRunning, admittedAt serial: Int) {
        let watch = UpdatesWatch(owner: configuration.confirmation, clock: configuration.clock)
        var live = LiveRun(handle: handle, watch: watch)
        if gate.register(runId: runId, handle: handle, admittedAt: serial) {
            handle.stop()
            live.stopRequested = true
            live.terminalLatch = WaitLatch()
        }
        owned[runId] = OwnedRun(runId: runId, sessionId: sessionId, phase: .live(live))
        let updates = Self.relay(handle.updates, watch: watch, clock: configuration.clock, wakeups: configuration.wakeups)
        Task { await self.consume(runId: runId, updates: updates) }
    }

    /// The Stop came before step 14: the start wrote nothing. The run is
    /// cancelled as never dispatched (one shared write with the waiting
    /// Stops), and the start answers by that write: `run-not-prepared` once
    /// it is durable (a confirmed cancellation, section 12), else the
    /// write's own failure; `unknown-connection` once its stack was let go
    /// (the Stops that made or joined the write answer by it: `detach()`).
    private func cancelBeforeStart(_ admitted: AdmittedStart, latch: StartLatch?, stack: Stack, echo: HostEcho) async -> HostResponse {
        let runId = admitted.entry.runId
        owned[runId] = nil
        let task = cancellationTask(runId: runId, sessionId: admitted.entry.sessionId,
                                    terminal: unspawnedTerminal(.stopped(.localStop), createdAt: admitted.entry.createdAt),
                                    startRecorded: false, store: stack.store)
        // The Stops read the run again and join that same write.
        latch?.resolve(.reevaluate)
        let result = await task.value
        guard stillAttached(stack) != nil else { return .refused(.unknownConnection, echo: echo) }
        switch result {
        case .recorded: return .refused(.runNotPrepared, echo: echo)
        case .refused(let reason): return .refused(reason, echo: echo)
        case .undetermined: return .unknown(echo)
        }
    }

    private func startingLatch(_ runId: String) -> StartLatch? {
        guard case .starting(let starting)? = owned[runId]?.phase else { return nil }
        return starting.latch
    }

    private func stopRequested(_ runId: String) -> Bool {
        guard case .starting(let starting)? = owned[runId]?.phase else { return false }
        return starting.stopRequested
    }

    /// A start record write that failed with nothing applied (section 7
    /// step 14), as the start answers it; nil when it may have been applied.
    private static func definiteStartFailure(_ error: Error) -> HostRefusal? {
        guard let failure = error as? ProofStoreError else { return nil }
        switch failure {
        case .startNotApplied, .writeFailed, .corrupt, .runEntryConflict: return .storeCorrupt
        case .locked, .closed: return .storeLocked
        case .missing: return .storeMissing
        case .duplicateRun: return .duplicateRun
        case .runNotPrepared: return .runNotPrepared
        case .unknownRun: return .unknownRun
        case .replayExists: return .payloadMismatch
        default: return nil
        }
    }

    /// Step 9's participant: exactly the prepared one, byte for byte.
    private static func isParticipant(_ fields: [String: String], _ pin: ParticipantPin) -> Bool {
        guard let id = fields["id"], let label = fields["label"], let model = fields["model"],
              let executionHost = fields["executionHost"] else { return false }
        return ParticipantPin.sameBytes(id, pin.id) && ParticipantPin.sameBytes(label, pin.label)
            && ParticipantPin.sameBytes(model, pin.model) && ParticipantPin.sameBytes(executionHost, pin.executionHost)
    }

    /// Step 11: at least one chunk, each 1-16,384 bytes, together at most
    /// 262,144 and at most the first-trial bound when the host has one.
    private static func inputFits(_ chunks: [String], bound: Int?) -> Bool {
        guard !chunks.isEmpty, chunks.allSatisfy({ (1...ParticipantLimits.chunkBytes).contains($0.utf8.count) }) else { return false }
        let total = chunks.reduce(0) { $0 + $1.utf8.count }
        return total <= min(ParticipantLimits.inputTotalBytes, bound ?? ParticipantLimits.inputTotalBytes)
    }

    /// A time this coordinator writes: the latest of the wall clock and the
    /// run's `createdAt` (section 8's rule with no earlier event).
    private static func at(wall: Int64, createdAt: String) -> String {
        let created = ParticipantTimestamp.parse(createdAt) ?? wall
        return ParticipantTimestamp.format(millis: ParticipantEventTime.atMillis(wall: wall, previous: created, createdAt: created))
    }

    // MARK: Spawned runs

    /// Reads a spawned run's updates as they arrive, off this actor, and
    /// hands them on in the same order for `consume`. Its one other act is
    /// section 17's: the five seconds start when `cleanup-released`
    /// arrives here (Codex S5 rulings), and the watch keeps that deadline.
    /// Everything else, the confirmation end for an observed overflow
    /// included, happens in order in `apply`; and the five seconds are met
    /// only if `consume` has applied every update and seen their end before
    /// the deadline (`UpdatesWatch.finish` compares the time it sees the end
    /// with it: Codex S8 R1). Since S9 no update waits for a store write
    /// (Codex Q31: writes run behind them, `persist`), so a slow or held
    /// write neither delays an observation nor, on its own, ends the
    /// confirmation; starts still wait for it (section 7 step 12).
    private static func relay(_ updates: AsyncStream<ParticipantRunUpdate>, watch: UpdatesWatch, clock: any ParticipantClock,
                              wakeups: any ParticipantWakeups) -> AsyncStream<ParticipantRunUpdate> {
        let (relayed, continuation) = AsyncStream<ParticipantRunUpdate>.makeStream(bufferingPolicy: .unbounded)
        Task.detached {
            for await update in updates {
                if case .cleanupReleased = update { watch.cleanupReleased(at: clock.monotonicMillis(), wakeups: wakeups) }
                continuation.yield(update)
            }
            continuation.finish()
        }
        return relayed
    }

    /// Applies every update of a spawned run in order, then marks the
    /// updates finished (Codex S5 rulings: start admission waits for this).
    /// The watch decides first whether they finished within section 17's
    /// five seconds, and, if they missed them, claims the confirmation's
    /// revocation (Codex S8 R1); the run stays busy until that returns,
    /// and nothing here waits for it. A Stop still waiting then answers
    /// from memory as it stands.
    private func consume(runId: String, updates: AsyncStream<ParticipantRunUpdate>) async {
        for await update in updates {
            apply(update, runId: runId)
        }
        // The process reports nothing more: no lock or close stops it now.
        gate.unregister(runId: runId)
        defer { noteProgress() }
        guard case .live(var live)? = owned[runId]?.phase else { return }
        live.watch.finish()
        live.updatesFinished = true
        let latches = [live.terminalLatch, live.retryLatch]
        live.retryLatch = nil
        owned[runId]?.phase = .live(live)
        for latch in latches { latch?.resolve() }
    }

    /// One update, applied to memory at once: every answer from here sees
    /// it, and a Stop waiting on it answers. Its push goes out in order; its
    /// store write is queued behind the run's earlier ones and runs in the
    /// background (Codex Q31: process truth never waits for the store lock
    /// or a retry; `persist`). The update counts as applied here.
    private func apply(_ update: ParticipantRunUpdate, runId: String) {
        // A lock or close that came since the actor last looked marks this
        // run stopping first, so the copy below carries that mark and its
        // latch, and writing the copy back can never undo them (S10 review).
        syncLifecycle()
        guard case .live(var live)? = owned[runId]?.phase else { return }
        var resolved: [WaitLatch?] = []
        var writes = false
        // An event is kept and pushed only once the run's memory is written
        // back below, so nothing those steps change is overwritten by it.
        var event: ParticipantEvent?
        switch update {
        case .event(let next):
            live.lastSequence = next.sequence
            event = next
        case .terminal(let terminal, let groupCleared):
            // The one terminal and the cleanup evidence recorded with it,
            // kept exactly (Codex Q31) until the store holds them durably.
            live.lastSequence = terminal.sequence
            live.terminal = terminal
            live.groupCleared = groupCleared
            live.persistence.terminal = terminal.terminalRecord
            live.persistence.recordedGroupCleared = groupCleared
            event = terminal
            resolved = [live.terminalLatch]
            writes = true
        case .groupCleared:
            // An actual probe found the group gone after a terminal that
            // recorded false: true is owed, as a write after the terminal's.
            live.groupCleared = true
            live.persistence.clearedLater = true
            resolved = [live.retryLatch]
            live.retryLatch = nil
            writes = true
        case .cleanupRetryUncleared:
            // The retry could not clear the group now: a waiting Stop
            // answers `cleanup-pending`. Nothing changes or is recorded.
            resolved = [live.retryLatch]
            live.retryLatch = nil
        case .cleanupReleased:
            // Its five seconds were started by `relay` when it arrived.
            live.cleanupReleased = true
            resolved = [live.retryLatch]
            live.retryLatch = nil
        case .overflowObserved:
            // Section 17: paid usage may have been in use. Not an event.
            // The owner is called here, in order, and this actor waits for
            // it (it must return promptly: `ParticipantConfirmationOwning`).
            live.overflowObserved = true
            live.watch.overflowObserved()
        }
        live.applied += 1
        owned[runId]?.phase = .live(live)
        if let event {
            retain(event)
            pushGate.push(event)
        }
        // The write is queued before any waiting Stop answers.
        if writes { persist(runId) }
        for latch in resolved { latch?.resolve() }
        noteProgress()
    }

    // MARK: Terminal and cleanup persistence (Codex Q31)

    /// Queues one persistence pass for a spawned run that owes a write: at
    /// once when none is in flight, else right after the one in flight. A
    /// pass makes at most one attempt per owed write, in order (the exact
    /// terminal with the evidence recorded with it, then `groupCleared`
    /// true for that same exact terminal), and stops at the first that does
    /// not prove durable; what stays owed is retried by the next pass,
    /// which comes with the run's next store work or another start's
    /// admission (never a timer). Nothing waits for it but the busy guard.
    /// A pass writes only through the stack it was queued on, and only
    /// while that stack is attached: after `detach()` the write stays owed
    /// for a pass on the next stack. While the coordinator is locked no
    /// pass starts and none goes on (Codex Q32): the write stays owed, in
    /// memory only, for the unlock.
    private func persist(_ runId: String) {
        guard persisting[runId] == nil else {
            persistAgain.insert(runId)
            return
        }
        guard !gate.isLocked, case .live(let live)? = owned[runId]?.phase, live.persistence.owesWrite,
              let store = stack?.store else { return }
        persisting[runId] = Task { await self.persistPass(runId: runId, store: store) }
    }

    /// Every unresolved participant write gets one more pass (section 7 step
    /// 12's busy refusal; a Stop): spawned runs' terminals and cleanup, and
    /// never-spawned terminals that are pending and not in flight. A
    /// conflicted one is never retried (Codex S9 ruling a). Nothing waits
    /// for these. Locked, nothing is queued (Codex Q32).
    ///
    /// Also the ordering boundary S10 adds (Codex S9 ruling c): `attach`
    /// and `unlock` call this synchronously on the actor, so every owed
    /// write of the folder is queued before the stack's or the unlocked
    /// stack's next request is handled. A run's later store work queues
    /// behind its own pass (`persisting`, `persistAgain`; one never-spawned
    /// write per run, `cancellations`), and new start records wait behind
    /// step 12's busy barrier. Passes of different runs are independent
    /// tasks, not first-in-first-out. Workspace commits and the app's
    /// dispatch recovery, the later store work outside this lane, wait for
    /// one such pass first (`reconcileBeforeStoreWork`, S11).
    private func reconcileUnresolved(store: ProofStore) {
        guard !gate.isLocked else { return }
        for (runId, memory) in owned {
            if case .live(let live) = memory.phase, live.persistence.owesWrite { persist(runId) }
        }
        for (runId, pending) in pendingCancellations where cancellations[runId] == nil && !pending.conflict {
            _ = cancellationTask(runId: runId, sessionId: pending.sessionId, terminal: pending.terminal,
                                 startRecorded: pending.startRecorded, store: store)
        }
    }

    private func persistPass(runId: String, store: ProofStore) async {
        defer {
            persisting[runId] = nil
            if persistAgain.remove(runId) != nil { persist(runId) }
            noteProgress()
        }
        // The terminal first, then the cleanup upgrade: at most one attempt
        // each, the second only once the first is durable.
        for _ in 0..<2 {
            // A stack let go meanwhile: its store is never used again. A
            // lock meanwhile: nothing more until its unlock (Codex Q32).
            guard stack?.store === store, !gate.isLocked else { return }
            guard case .live(var live)? = owned[runId]?.phase, live.persistence.owesWrite else { return }
            // A re-read first: what the store's durable copy already holds
            // (another path's folder flush may have made an undetermined
            // write durable) is not written again.
            live.persistence.adopt(store.publishedRuns.entry(for: runId))
            owned[runId]?.phase = .live(live)
            guard live.persistence.owesWrite else { return }
            // Both writes name the exact terminal this run owns, and the
            // store compares it inside its lock, in the same locked step as
            // the change (Codex S9-R1). The snapshot adopted above is no
            // proof: another terminal can reach the folder between it and
            // the executor's mutation, and the cleanup upgrade must refuse
            // it there, unchanged, rather than mark its cleanup true and
            // find the conflict afterwards. A cleanup upgrade is owed only
            // after a terminal (the reader reports a cleared group only
            // after one that recorded false), so there is a terminal to
            // name. Were one ever owed with none, it could never be named:
            // irreconcilable as a conflict is (ruling a), so never
            // attempted, logged once, and starts stay busy until quit.
            guard let terminal = live.persistence.terminal else {
                live.persistence.conflict = true
                owned[runId]?.phase = .live(live)
                configuration.log.record(ParticipantLogEntry(runId: runId, kind: .writeConflict))
                return
            }
            let write: @Sendable () throws -> ParticipantRunEntry
            let writesTerminal: Bool
            if !live.persistence.terminalDurable {
                let cleared = live.persistence.recordedGroupCleared
                write = { try store.recordTerminal(runId: runId, terminal, groupCleared: cleared) }
                writesTerminal = true
            } else {
                // The monotonic false-to-true upgrade of this exact
                // terminal; already true is a no-op, and another terminal,
                // a null, or no entry is refused unchanged. An entry that
                // holds no terminal (the folder lost the one this launch
                // proved durable) gets this exact terminal with true in
                // the same locked write: the run's own facts, replacing
                // no other terminal (the earlier `markGroupCleared`
                // refused it; named for Codex's S9-R1 re-review).
                write = { try store.recordTerminal(runId: runId, terminal, groupCleared: true) }
                writesTerminal = false
            }
            let outcome: Result<ParticipantRunEntry, Error>
            do {
                outcome = .success(try await configuration.executor.run(write))
            } catch {
                outcome = .failure(error)
            }
            guard case .live(var after)? = owned[runId]?.phase else { return }
            after.persistence.attempts += 1
            var durable = false
            switch outcome {
            case .success(let entry):
                // Durable: the write and its folder flush returned, or the
                // store already held it with the flush now confirmed.
                after.persistence.uncertain = false
                after.persistence.adopt(entry)
                durable = writesTerminal ? after.persistence.terminalDurable : after.persistence.clearedDurable
                // An answer that does not hold what was written is another
                // run state: never replaced, so never retried.
                if !durable { after.persistence.conflict = true }
            case .failure(ProofStoreError.replacedUnsynced):
                // Undetermined: the folder shows it, not provably durably;
                // the next attempt retries the flush (the store answers it).
                after.persistence.uncertain = true
            case .failure(ProofStoreError.writeFailed):
                // Definite: nothing of this write was applied.
                after.persistence.uncertain = false
            case .failure(ProofStoreError.runEntryConflict), .failure(ProofStoreError.unknownRun):
                // The store holds another terminal for the run, or no such
                // run (compared inside its lock, for the cleanup upgrade as
                // for the terminal: S9-R1), and changed nothing: never
                // replaced, so never retried.
                after.persistence.conflict = true
            case .failure:
                // Locked, closed, missing or unreadable: still owed.
                break
            }
            owned[runId]?.phase = .live(after)
            if after.persistence.conflict {
                // Never retried, so logged once, text-free: every start
                // stays busy until the app quits, and this says why.
                configuration.log.record(ParticipantLogEntry(runId: runId, kind: .writeConflict,
                                                             eventType: writesTerminal ? after.terminal?.type : nil,
                                                             sequence: writesTerminal ? after.terminal?.sequence : nil))
            }
            guard durable else { return }
        }
    }

    /// Keeps `event` with the current run's events when it is that run's
    /// next one. While lock or close is under way no text is kept: the
    /// event is only counted (`lost` `locked` or `closed`), a terminal
    /// kept (section 9).
    private func retain(_ event: ParticipantEvent) {
        syncLifecycle()
        guard let current = retained, current.runId == event.runId else { return }
        let lifecycle = gate.state
        let next = lifecycle.keepsText ? current.appending(event) : current.addingWithoutText(event, reason: lifecycle.dropReason)
        if let next { retained = next }
    }

    // MARK: Undetermined start record (section 7)

    /// The authoritative re-read before the next start, Stop or status of
    /// a run whose start record's write was undetermined; concurrent askers
    /// on the same stack share one. One in flight for another stack (the
    /// same store attached again included) is never joined: it is let
    /// finish, and this stack re-reads if the run is still undetermined
    /// (Codex S8). The bound is a backstop; each turn follows a re-read's
    /// end.
    private func resolveUncertain(runId: String, stack: Stack) async -> UncertainResolution {
        for _ in 0..<8 {
            guard let inFlight = rereads[runId] else { break }
            if inFlight.serial == stack.serial { return await inFlight.task.value }
            _ = await inFlight.task.value
            guard stillAttached(stack) != nil else { return .unresolved }
        }
        guard rereads[runId] == nil else { return .unresolved }
        let task = Task { await self.reread(runId: runId, stack: stack) }
        rereads[runId] = (stack.serial, task)
        return await task.value
    }

    /// One folder flush and `state.json` re-read (`ProofStore.rereadRuns`):
    /// - the record is there: nothing ran; `failed` `process-error` at
    ///   sequence 1 with `groupCleared` null is recorded and pushed, and
    ///   the start's replacement of the retained events applies now, unless
    ///   a run started since holds them (Codex Q28, Q30);
    /// - it is not: nothing of the attempt was written; its claim goes, and
    ///   the run reads as the folder shows it (`not-dispatched` again: an
    ///   explicit Start with a new request id may follow, Codex Q27). The id
    ///   is released, not kept as a tombstone (Codex S8 answer 1): a start
    ///   arriving under it again, the exact retry included, is a new start
    ///   that runs every check of section 7 again and dispatches at most
    ///   once. Nothing here resends or resumes the attempt;
    /// - the re-read fails: still undetermined;
    /// - its stack was let go meanwhile (detached, or attached again since):
    ///   it decides nothing, and the next request re-reads through the
    ///   stack attached then (Codex S8).
    private func reread(runId: String, stack: Stack) async -> UncertainResolution {
        defer {
            if rereads[runId]?.serial == stack.serial { rereads[runId] = nil }
            noteProgress()
        }
        guard case .uncertain(let attempt)? = owned[runId]?.phase else { return .settled }
        // Let go before this task began (the asker's await freed the actor):
        // no store work starts through that stack's store (`detach()`).
        guard stillAttached(stack) != nil else { return .unresolved }
        let store = stack.store
        let snapshot: ParticipantRunsSnapshot
        do {
            snapshot = try await configuration.executor.run { try store.rereadRuns() }
        } catch {
            return .unresolved
        }
        guard stillAttached(stack) != nil else { return .unresolved }
        guard case .uncertain(let current)? = owned[runId]?.phase, current.requestId == attempt.requestId else { return .settled }
        let identities = configuration.hostConfiguration.identities
        let entry: ParticipantRunEntry
        switch snapshot.lookup(runId: runId) {
        case .found(let found): entry = found
        case .absent:
            identities.releaseStarting(attempt.requestId)
            owned[runId] = nil
            return .absent
        case .unproven:
            return .unresolved
        }
        guard entry.start?.requestId == attempt.requestId.canonicalString else {
            identities.releaseStarting(attempt.requestId)
            owned[runId] = nil
            return .absent
        }
        identities.recordStart(attempt.requestId)
        owned[runId] = nil
        if retained?.runId == attempt.retainedBefore { retained = RetainedRun.started(runId: runId, sessionId: entry.sessionId) }
        if let recorded = entry.terminal, let event = ParticipantEvent(runId: runId, sessionId: entry.sessionId, recorded: recorded) {
            endedRuns[runId] = EndedRun(sessionId: entry.sessionId, terminal: event, groupCleared: entry.groupCleared)
            return .found(.recorded(event))
        }
        // From here the cancellation machinery holds the run's memory: its
        // terminal stays pending until durable (`startRecorded`).
        let terminal = unspawnedTerminal(.failed(.processError), createdAt: entry.createdAt)
        return .found(await cancellationTask(runId: runId, sessionId: entry.sessionId, terminal: terminal, startRecorded: true,
                                             store: store).value)
    }

    // MARK: Status (section 10)

    private func status(_ request: HostRequest, stack: Stack) async -> HostResponse {
        let echo = request.echo
        let read: ParticipantRunRead
        switch ParticipantRequests.runRead(request.payload) {
        case .refused(let refusal): return .refused(refusal, echo: echo)
        case .value(let value): read = value
        }
        guard ParticipantPin.sameBytes(read.workspaceHandle, stack.store.workspaceHandle) else {
            return .refused(.unknownHandle, echo: echo)
        }
        var stack = stack
        if let memory = owned[read.runId] {
            guard ParticipantPin.sameBytes(memory.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
            if case .uncertain = memory.phase {
                let resolution = await resolveUncertain(runId: read.runId, stack: stack)
                guard let current = stillAttached(stack) else { return .refused(.unknownConnection, echo: echo) }
                stack = current
                if case .unresolved = resolution { return .ok(echo, Self.pendingStatusFields(runId: read.runId)) }
            }
        }
        if let memory = owned[read.runId] {
            guard ParticipantPin.sameBytes(memory.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
            return .ok(echo, Self.statusFields(owned: memory))
        }
        switch stack.store.publishedRuns.lookup(runId: read.runId) {
        case .absent:
            // A never-spawned terminal held in memory answers from it even
            // with no entry (its write meets that and fails closed: Codex
            // S9 ruling a); otherwise the run is unknown.
            if let held = heldTerminal(read.runId) {
                guard ParticipantPin.sameBytes(held.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
                return .ok(echo, Self.pendingStatusFields(runId: read.runId))
            }
            return .refused(.unknownRun, echo: echo)
        case .unproven:
            // Only run memory answers, as for Stop and events (plan S9):
            // a never-spawned terminal held in memory, or an ended one.
            if let held = heldTerminal(read.runId) {
                guard ParticipantPin.sameBytes(held.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
                return .ok(echo, Self.pendingStatusFields(runId: read.runId))
            }
            if let ended = endedRuns[read.runId] {
                guard ParticipantPin.sameBytes(ended.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
                return .ok(echo, Self.statusFields(runId: read.runId, state: "exited",
                                                   lastSequence: max(ended.terminal.sequence, retainedLast(read.runId)),
                                                   terminal: ended.terminal, groupCleared: ended.groupCleared))
            }
            // Codex Q23: nothing readable and no run memory. Status never
            // answers outcome `unknown`. Retained events alone never answer
            // (every run whose events are kept has run memory beside them).
            return .ok(echo, Self.statusFields(runId: read.runId, state: "unknown", lastSequence: nil, unknownReason: "store-unreadable"))
        case .found(let entry):
            guard ParticipantPin.sameBytes(entry.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
            settleDurablePending(entry)
            if isCancellationPending(entry) { return .ok(echo, Self.pendingStatusFields(runId: read.runId)) }
            return .ok(echo, Self.statusFields(entry: entry))
        }
    }

    /// The last sequence of the run's retained events, or 0 when another
    /// run's are kept.
    private func retainedLast(_ runId: String) -> Int {
        retained?.runId == runId ? retained?.lastSequence ?? 0 : 0
    }

    /// Status from this launch's memory of a run it starts or started:
    /// - starting: `starting`, `lastSequence` 0;
    /// - an undetermined start record: `unknown` `start-uncertain`, 0;
    /// - spawned with no terminal: `running` with its last sequence, or
    ///   `stopping` once a Stop asked it to stop;
    /// - a terminal: `cleanup-pending` while the group is not confirmed gone
    ///   (`groupCleared` false) and cleanup is not released (an owned group,
    ///   or a lost supervisor's pipes not at EOF); otherwise `exited` (the
    ///   group cleared, nothing spawned, or ownership lost). Both carry the
    ///   terminal and `groupCleared` as memory holds them: launch-local
    ///   process truth, which a pending write does not change (Codex Q31);
    ///   such an answer proves the process and cleanup state, not a disk
    ///   write. Starts stay busy on their own rule
    ///   (`LiveRun.blocksStarts`), which may outlast `exited`.
    private static func statusFields(owned memory: OwnedRun) -> [String: JSONValue] {
        switch memory.phase {
        case .starting:
            return statusFields(runId: memory.runId, state: "starting", lastSequence: 0)
        case .uncertain:
            return pendingStatusFields(runId: memory.runId)
        case .live(let live):
            guard let terminal = live.terminal else {
                return statusFields(runId: memory.runId, state: live.stopRequested ? "stopping" : "running",
                                    lastSequence: live.lastSequence)
            }
            return statusFields(runId: memory.runId, state: live.isCleanupPending ? "cleanup-pending" : "exited",
                                lastSequence: max(live.lastSequence, terminal.sequence), terminal: terminal,
                                groupCleared: live.groupCleared)
        }
    }

    /// A run with nothing spawned whose terminal is pending (see
    /// `isCancellationPending`), or whose start record's write is
    /// undetermined: `unknown` `start-uncertain`, never `not-dispatched`
    /// (Codex Q5) or an earlier launch's `exit-unrecorded`, with
    /// `lastSequence` 0. A pending terminal's sequence 1 is not counted
    /// until its write is durable: until then nothing vouches for it, and a
    /// definite failure of a retry leaves a never-dispatched run
    /// `not-dispatched` at 0, so `lastSequence` never has to go back down.
    /// Events answers the same.
    private static func pendingStatusFields(runId: String) -> [String: JSONValue] {
        statusFields(runId: runId, state: "unknown", lastSequence: 0, unknownReason: "start-uncertain")
    }

    /// Status from a durable entry with no live memory of its run:
    /// - a terminal: `exited` with it and the stored `groupCleared` (an
    ///   earlier launch's, never spawned, or ended);
    /// - no start, no terminal: `not-dispatched`, `lastSequence` 0;
    /// - a start and no terminal: `unknown` `exit-unrecorded`, `lastSequence`
    ///   null (an earlier launch dispatched it and recorded no exit; this
    ///   launch has no process to report on).
    private static func statusFields(entry: ParticipantRunEntry) -> [String: JSONValue] {
        if let recorded = entry.terminal {
            guard let terminal = ParticipantEvent(runId: entry.runId, sessionId: entry.sessionId, recorded: recorded) else {
                return statusFields(runId: entry.runId, state: "unknown", lastSequence: nil, unknownReason: "store-unreadable")
            }
            return statusFields(runId: entry.runId, state: "exited", lastSequence: recorded.sequence, terminal: terminal,
                                groupCleared: entry.groupCleared)
        }
        if entry.start == nil {
            return statusFields(runId: entry.runId, state: "not-dispatched", lastSequence: 0)
        }
        return statusFields(runId: entry.runId, state: "unknown", lastSequence: nil, unknownReason: "exit-unrecorded")
    }

    private static func statusFields(runId: String, state: String, lastSequence: Int?, terminal: ParticipantEvent? = nil,
                                     groupCleared: Bool? = nil, unknownReason: String? = nil) -> [String: JSONValue] {
        [
            "runId": .string(runId),
            "state": .string(state),
            "lastSequence": lastSequence.map { .number(Double($0)) } ?? .null,
            "terminal": terminal?.jsonValue ?? .null,
            "groupCleared": groupCleared.map(JSONValue.bool) ?? .null,
            "unknownReason": unknownReason.map(JSONValue.string) ?? .null
        ]
    }

    // MARK: Events (section 9)

    private func events(_ request: HostRequest, stack: Stack) -> HostResponse {
        let echo = request.echo
        let read: ParticipantEventsRead
        switch ParticipantRequests.events(request.payload) {
        case .refused(let refusal): return .refused(refusal, echo: echo)
        case .value(let value): read = value
        }
        guard ParticipantPin.sameBytes(read.run.workspaceHandle, stack.store.workspaceHandle) else {
            return .refused(.unknownHandle, echo: echo)
        }
        let runId = read.run.runId
        let memory = retained?.runId == runId ? retained : nil
        let source: ParticipantEventSource
        if let owner = owned[runId] {
            guard ParticipantPin.sameBytes(owner.sessionId, read.run.sessionId) else { return .refused(.runMismatch, echo: echo) }
            if case .live(let live) = owner.phase {
                // A spawned run of this launch answers from memory, store
                // readable or not, as status and Stop do (plan S9): its
                // retained events while they are kept (else lost
                // `replaced`), and its terminal as process truth, a pending
                // write included (Codex Q31).
                source = ParticipantEventSource(retained: memory?.events ?? [], recordedTerminal: live.terminal,
                                                lastSequence: max(live.lastSequence, memory?.lastSequence ?? 0),
                                                lossReason: memory?.lost?.reason ?? .replaced)
            } else {
                // Starting, or an undetermined start record: nothing emitted
                // yet, as status reads it. No re-read here; status, Stop or
                // the next start makes it.
                source = Self.pendingEventSource
            }
        } else {
            switch stack.store.publishedRuns.lookup(runId: runId) {
            case .absent:
                // A never-spawned terminal held in memory answers from it,
                // as status does (Codex S9 ruling a).
                guard let held = heldTerminal(runId) else { return .refused(.unknownRun, echo: echo) }
                guard ParticipantPin.sameBytes(held.sessionId, read.run.sessionId) else {
                    return .refused(.runMismatch, echo: echo)
                }
                source = Self.pendingEventSource
            case .unproven:
                // Only run memory can answer, as for status and Stop (plan
                // S9): a never-spawned terminal held in memory, or an ended
                // one with its retained events. With neither, native cannot
                // read the run's entry and holds nothing for it: outcome
                // `unknown` (Codex Q23). Retained events alone never answer.
                if let held = heldTerminal(runId) {
                    guard ParticipantPin.sameBytes(held.sessionId, read.run.sessionId) else {
                        return .refused(.runMismatch, echo: echo)
                    }
                    source = Self.pendingEventSource
                } else if let ended = endedRuns[runId] {
                    guard ParticipantPin.sameBytes(ended.sessionId, read.run.sessionId) else {
                        return .refused(.runMismatch, echo: echo)
                    }
                    source = ParticipantEventSource(retained: memory?.events ?? [], recordedTerminal: ended.terminal,
                                                    lastSequence: max(ended.terminal.sequence, memory?.lastSequence ?? 0),
                                                    lossReason: memory?.lost?.reason ?? .replaced)
                } else {
                    return .unknown(echo)
                }
            case .found(let entry):
                guard ParticipantPin.sameBytes(entry.sessionId, read.run.sessionId) else { return .refused(.runMismatch, echo: echo) }
                settleDurablePending(entry)
                source = isCancellationPending(entry) ? Self.pendingEventSource : eventSource(entry: entry, memory: memory)
            }
        }
        let answer = source.answer(afterSequence: read.afterSequence, maxEvents: read.maxEvents) { candidate in
            HostResponse.ok(echo, candidate.fields(runId: runId)).canonicalData().count
        }
        return .ok(echo, answer.fields(runId: runId))
    }

    /// A run with nothing emitted yet whose state is not settled (starting,
    /// an undetermined start record, or a never-spawned terminal that is
    /// pending), as status reads it: nothing emitted,
    /// `lastSequence` 0, so every page is `[]` with `more` false and no
    /// loss. Outcome `ok`, since native holds that state (section 9 keeps
    /// `unknown` for a run native cannot read and holds nothing for); a
    /// pending terminal is not given until it is durable. A durable retry
    /// later adds it at sequence 1, and a definite failure leaves exactly
    /// this answer.
    private static let pendingEventSource = ParticipantEventSource(retained: [], recordedTerminal: nil, lastSequence: 0,
                                                                   lossReason: .replaced)

    /// The events native can give for a durable entry: the retained ones
    /// when this run is the one kept, and always the recorded terminal.
    private func eventSource(entry: ParticipantRunEntry, memory: RetainedRun?) -> ParticipantEventSource {
        let terminal = entry.terminal.flatMap { ParticipantEvent(runId: entry.runId, sessionId: entry.sessionId, recorded: $0) }
        let lastSequence: Int?
        if let memory {
            lastSequence = max(memory.lastSequence, terminal?.sequence ?? 0)
        } else if let terminal {
            lastSequence = terminal.sequence
        } else {
            // Never dispatched: nothing was assigned. Dispatched with no
            // terminal and nothing in memory: not known.
            lastSequence = entry.start == nil ? 0 : nil
        }
        // Gone because another run of this launch replaced them, or because
        // the launch that kept them ended.
        let fallback: ParticipantLostReason =
            entry.start?.launchId == configuration.launchId && retained != nil ? .replaced : .restarted
        return ParticipantEventSource(retained: memory?.events ?? [], recordedTerminal: terminal, lastSequence: lastSequence,
                                      lossReason: memory?.lost?.reason ?? fallback)
    }

    // MARK: Stop (section 10, with section 7 for starting runs)

    private func stop(_ request: HostRequest, stack: Stack) async -> HostResponse {
        let echo = request.echo
        let read: ParticipantRunRead
        switch ParticipantRequests.runRead(request.payload) {
        case .refused(let refusal): return .refused(refusal, echo: echo)
        case .value(let value): read = value
        }
        guard ParticipantPin.sameBytes(read.workspaceHandle, stack.store.workspaceHandle) else {
            return .refused(.unknownHandle, echo: echo)
        }
        var stack = stack
        // This launch's memory of the run first. Each turn of the loop
        // follows a start ending or a re-read settling, so a run cannot keep
        // it going; the bound is only a backstop.
        for _ in 0..<8 {
            guard let memory = owned[read.runId] else { break }
            guard ParticipantPin.sameBytes(memory.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
            switch memory.phase {
            case .starting(var starting):
                // Section 7: Stop during `starting` sets stop-requested and
                // waits for the start.
                starting.stopRequested = true
                owned[read.runId]?.phase = .starting(starting)
                let end = await starting.latch.wait()
                guard let current = stillAttached(stack) else { return .refused(.unknownConnection, echo: echo) }
                stack = current
                if case .answered(let result) = end { return Self.stopReply(result, echo: echo) }
            case .uncertain:
                // Codex Q28: re-read first. There: the Stop answers by the
                // `failed` `process-error` write it made (that terminal;
                // `store-corrupt` or another definite refusal; `unknown`).
                // Not there: never dispatched, read again below. Re-read
                // failed: `unknown`.
                let resolution = await resolveUncertain(runId: read.runId, stack: stack)
                guard let current = stillAttached(stack) else { return .refused(.unknownConnection, echo: echo) }
                stack = current
                switch resolution {
                case .unresolved: return .unknown(echo)
                case .found(let result): return Self.stopReply(result, echo: echo)
                case .absent, .settled: break
                }
            case .live:
                return await stopSpawned(read.runId, echo: echo, stack: stack)
            }
        }
        if owned[read.runId] != nil { return .unknown(echo) }
        // Codex Q21: a cancellation still in flight on an earlier stack's
        // store is never joined from this one (its answer would be that
        // store's). It is let finish, and the run is read again from this
        // stack's store; a store that has since closed applied nothing.
        while let inFlight = cancellations[read.runId], inFlight.store !== stack.store {
            _ = await inFlight.task.value
            guard stillAttached(stack) != nil else { return .refused(.unknownConnection, echo: echo) }
        }
        switch stack.store.publishedRuns.lookup(runId: read.runId) {
        case .absent:
            // A never-spawned terminal held in memory answers from it even
            // with no entry: its write meets that and fails closed (Codex
            // S9 ruling a).
            guard let held = heldTerminal(read.runId) else { return .refused(.unknownRun, echo: echo) }
            guard ParticipantPin.sameBytes(held.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
            return Self.stopReply(await stopHeld(read.runId, store: stack.store), echo: echo)
        case .unproven:
            // Only run memory answers, as for status and events (plan S9).
            if let ended = endedRuns[read.runId] {
                guard ParticipantPin.sameBytes(ended.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
                return .ok(echo, Self.stopFields(runId: read.runId, state: "exited", terminal: ended.terminal,
                                                 groupCleared: ended.groupCleared))
            }
            guard let held = heldTerminal(read.runId) else { return .unknown(echo) }
            guard ParticipantPin.sameBytes(held.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
            return Self.stopReply(await stopHeld(read.runId, store: stack.store), echo: echo)
        case .found(let entry):
            guard ParticipantPin.sameBytes(entry.sessionId, read.sessionId) else { return .refused(.runMismatch, echo: echo) }
            settleDurablePending(entry)
            // A terminal for a run that never spawned held in memory (in
            // flight, not yet durable or conflicted) while the entry does
            // not hold exactly it (no terminal, another one, or it with a
            // non-null `groupCleared`): join or retry that same terminal,
            // or, conflicted, answer from memory (Codex S9 ruling a). Never
            // the entry's.
            if let held = heldTerminal(read.runId), !Self.holds(entry, held.terminal) {
                return Self.stopReply(await stopHeld(read.runId, store: stack.store), echo: echo)
            }
            if let recorded = entry.terminal {
                // Already ended, or never spawned; or an earlier launch's,
                // whose stored `groupCleared` stands (false stays false).
                // Nothing is signalled.
                guard let terminal = ParticipantEvent(runId: entry.runId, sessionId: entry.sessionId, recorded: recorded) else {
                    return .unknown(echo)
                }
                return .ok(echo, Self.stopFields(runId: read.runId, state: "exited", terminal: terminal, groupCleared: entry.groupCleared))
            }
            // A never-dispatched cancellation's first write, in flight:
            // join it.
            if let inFlight = cancellations[read.runId], inFlight.store === stack.store {
                return Self.stopReply(await inFlight.task.value, echo: echo)
            }
            if entry.start != nil {
                // Dispatched with no recorded exit, and no memory of it here
                // (a run this launch dispatched has its process or its
                // pending terminal): an earlier launch's run.
                return .ok(echo, Self.stopFields(runId: read.runId, state: "not-owned", terminal: nil, groupCleared: nil))
            }
            return Self.stopReply(await cancel(runId: read.runId, sessionId: entry.sessionId,
                                               terminal: unspawnedTerminal(.stopped(.localStop), createdAt: entry.createdAt),
                                               startRecorded: false, store: stack.store), echo: echo)
        }
    }

    /// Stop of a run this launch spawned (section 10), answered from memory:
    /// launch-local process truth, which a terminal or cleanup write still
    /// pending does not change and never waits for (Codex Q31). Every
    /// signal goes out first, synchronously, before any await or store
    /// access (`ParticipantRunning.stop()` writes `stop` before anything
    /// else).
    /// - Running or stopping: the first Stop signals and every Stop waits
    ///   on the run's terminal, so concurrent Stops share one terminal (the
    ///   stop sequence bounds it: section 11's 10 s plus 2 s; a lost
    ///   supervisor ends it at once). Then `exited` (`stopped` `local-stop`
    ///   with `groupCleared` true) or `cleanup-pending` (`stop-incomplete`
    ///   with false).
    /// - Ended, with the group cleared, nothing spawned, or cleanup
    ///   released: `exited` with the terminal; nothing is signalled.
    /// - Cleanup-pending: the retry (`stop()` again: one more SIGKILL and a
    ///   2 s probe), shared by concurrent Stops. The group gone (an actual
    ///   probe) is `exited` with `groupCleared` true, written after the
    ///   terminal; members left is `cleanup-pending`. No new event.
    /// - No supervisor (`stop()` false: it is gone): nothing is signalled;
    ///   `cleanup-pending` until both pipes reach EOF, then `exited`, with
    ///   `groupCleared` false, never set true.
    /// A Stop also queues any write the run still owes (never waited for).
    private func stopSpawned(_ runId: String, echo: HostEcho, stack: Stack) async -> HostResponse {
        guard case .live(var live)? = owned[runId]?.phase else { return .unknown(echo) }
        if live.terminal == nil {
            let latch: WaitLatch
            if let shared = live.terminalLatch {
                latch = shared
            } else {
                // The first Stop: signal now, then remember it.
                live.handle.stop()
                latch = WaitLatch()
                live.stopRequested = true
                live.terminalLatch = latch
                owned[runId]?.phase = .live(live)
            }
            // Updates that already ended bring no terminal: answer as memory stands.
            if !live.updatesFinished { await latch.wait() }
        } else if live.isCleanupPending {
            if let shared = live.retryLatch {
                persist(runId)
                await shared.wait()
            } else if live.handle.stop(), !live.updatesFinished {
                // The retry was signalled; its answer comes as an update.
                let latch = WaitLatch()
                live.retryLatch = latch
                owned[runId]?.phase = .live(live)
                persist(runId)
                await latch.wait()
            } else {
                // No supervisor to signal (or no update can come): memory
                // decides as it stands.
                persist(runId)
                return spawnedStopReply(runId, echo: echo)
            }
        } else {
            persist(runId)
        }
        guard stillAttached(stack) != nil else { return .refused(.unknownConnection, echo: echo) }
        return spawnedStopReply(runId, echo: echo)
    }

    /// A spawned run's Stop reply from memory: `exited` or `cleanup-pending`
    /// with its terminal; `unknown` if its updates ended with none.
    private func spawnedStopReply(_ runId: String, echo: HostEcho) -> HostResponse {
        guard case .live(let live)? = owned[runId]?.phase, let terminal = live.terminal else { return .unknown(echo) }
        return .ok(echo, Self.stopFields(runId: runId, state: live.isCleanupPending ? "cleanup-pending" : "exited", terminal: terminal,
                                         groupCleared: live.groupCleared))
    }

    /// The one terminal of a run that never spawned: at sequence 1, at the
    /// latest of the wall clock and the run's `createdAt` (section 8's `at`
    /// rule with no earlier event). `stopped` `local-stop` for a Stop
    /// (never dispatched, or during the start record's write), `failed`
    /// `process-error` for a spawn that threw or an undetermined start
    /// record found later.
    private func unspawnedTerminal(_ terminal: ParticipantTerminal, createdAt: String) -> ParticipantRunTerminal {
        // A valid section 8 pair at sequence 1 with a formatted time.
        terminal.record(sequence: 1, at: Self.at(wall: configuration.clock.wallMillis(), createdAt: createdAt))!
    }

    /// The terminal write of a run that never spawned (section 10's
    /// never-dispatched Stop among them): recorded durably, so a later
    /// start is refused, then pushed. Concurrent requests for the run on
    /// this store share one write and its one terminal. `startRecorded`:
    /// the run's start record is durable, so the terminal stays pending
    /// until it is durable too (a retry inherits it from what is pending).
    private func cancel(runId: String, sessionId: String, terminal: ParticipantRunTerminal, startRecorded: Bool,
                        store: ProofStore) async -> CancellationResult {
        await cancellationTask(runId: runId, sessionId: sessionId, terminal: terminal, startRecorded: startRecorded, store: store).value
    }

    /// A Stop of a run whose never-spawned terminal is held in memory
    /// (`heldTerminal`): it joins that exact terminal's write in flight on
    /// this store, or retries a pending one. A conflicted one is never
    /// retried (Codex S9 ruling a): `unknown`, from memory, as status reads
    /// it (`start-uncertain`).
    private func stopHeld(_ runId: String, store: ProofStore) async -> CancellationResult {
        if let pending = pendingCancellations[runId] {
            if pending.conflict { return .undetermined }
            return await cancel(runId: runId, sessionId: pending.sessionId, terminal: pending.terminal,
                                startRecorded: pending.startRecorded, store: store)
        }
        if let inFlight = cancellations[runId], inFlight.store === store { return await inFlight.task.value }
        return .undetermined
    }

    /// The never-spawned terminal this launch holds in memory for the run:
    /// a pending one (undetermined; not yet durable for a run whose start
    /// record is durable; or conflicted: Codex S9 ruling a), or, for a run
    /// whose start record is durable, the one whose first write is in
    /// flight (S8's spawn failure, a Stop at or after step 14, a re-read
    /// that finds the record), from when that write is taken until it
    /// returns. Status, events and Stop answer the run from it whenever the
    /// run's entry does not hold exactly it (`holds`), the entry missing
    /// included, so no read answers from another terminal or the missing
    /// entry before that write returns and later answers otherwise. A
    /// never-dispatched cancellation's first write in flight is not held:
    /// the run reads as the folder shows it until that write settles
    /// (Codex Q28, Q29).
    private func heldTerminal(_ runId: String) -> (sessionId: String, terminal: ParticipantRunTerminal)? {
        if let pending = pendingCancellations[runId] { return (pending.sessionId, pending.terminal) }
        if let inFlight = cancellations[runId], inFlight.startRecorded { return (inFlight.sessionId, inFlight.terminal) }
        return nil
    }

    /// The entry holds exactly this never-spawned terminal as its write
    /// leaves it: that terminal with `groupCleared` null (nothing was
    /// spawned). The store's comparison: the same terminal with any other
    /// `groupCleared` is `runEntryConflict` to the write, and so a conflict
    /// to a read too.
    private static func holds(_ entry: ParticipantRunEntry, _ terminal: ParticipantRunTerminal) -> Bool {
        entry.terminal == terminal && entry.groupCleared == nil
    }

    /// The write in flight for the run on this store, or a new one. Taken
    /// and registered with no await, so whoever asks next joins it. A
    /// terminal decided while nothing may be pushed (lock, window close or
    /// quit under way, or no stack) is quiet: never pushed, even once a
    /// later write makes it durable (section 14: held, then written, never
    /// pushed). A retry keeps what its first attempt decided.
    private func cancellationTask(runId: String, sessionId: String, terminal: ParticipantRunTerminal, startRecorded: Bool,
                                  store: ProofStore) -> Task<CancellationResult, Never> {
        if let inFlight = cancellations[runId], inFlight.store === store { return inFlight.task }
        let quiet = pendingCancellations[runId]?.quiet ?? !pushGate.isOpen
        let task = Task {
            await self.writeCancellation(runId: runId, sessionId: sessionId, terminal: terminal, startRecorded: startRecorded,
                                         quiet: quiet, store: store)
        }
        cancellations[runId] = InFlightCancellation(store: store, task: task, sessionId: sessionId, terminal: terminal,
                                                    startRecorded: startRecorded || pendingCancellations[runId]?.startRecorded == true,
                                                    quiet: quiet)
        return task
    }

    /// One such write, on the executor. Durable: the event is pushed once,
    /// logged, and kept with the run's events when it is the current run,
    /// and nothing stays pending. Otherwise the answer is the attempt's:
    /// - undetermined (`replacedUnsynced`): `unknown`, and the exact
    ///   terminal is kept to retry;
    /// - definitely failed (`writeFailed`: nothing applied, and the folder
    ///   does not show this terminal): `store-corrupt`;
    /// - refused before writing: locked or closed is `store-locked`, missing
    ///   `store-missing`, unreadable `store-corrupt`, unless the last
    ///   attempt was undetermined and may still prove durable: `unknown`;
    /// - another terminal for the run, or no entry (`runEntryConflict`,
    ///   `unknownRun`: compared inside the store's lock, nothing changed):
    ///   `unknown`. A run whose start record is durable (its first write
    ///   included), or a never-dispatched cancellation already pending
    ///   after an undetermined attempt, fails closed (`failClosed`: Codex
    ///   S9 ruling a); a never-dispatched first attempt has nothing
    ///   pending, and the run reads as the folder shows it (Codex Q28,
    ///   Q29);
    /// - anything else: `unknown`.
    /// After a failure the exact terminal stays pending while it may have
    /// been applied, and always for a run whose start record is durable
    /// (`PendingCancellation`): such a run never loses its memory before
    /// its terminal is durable (Codex Q28; S7 reading (c)).
    ///
    /// Locked, or with the stack it was started for let go (its store is
    /// never used again: Codex Q21), nothing goes to the store: the attempt
    /// answers as if the store refused it before writing (`store-locked`,
    /// or `unknown` after an undetermined one), and the terminal is kept
    /// exactly when such a refusal keeps it, text-free, for the unlock or
    /// the next attach over the same folder (Codex Q32). A write already
    /// handed to the executor is not recalled.
    private func writeCancellation(runId: String, sessionId: String, terminal: ParticipantRunTerminal, startRecorded: Bool,
                                   quiet: Bool, store: ProofStore) async -> CancellationResult {
        defer {
            cancellations[runId] = nil
            // Drained on a stack let go while another store over the same
            // folder was attached: that attach's flush skipped this run, its
            // write being in flight, so a terminal still owed is queued once
            // more now, through the stack attached (S9 ruling c), as a
            // spawned run's pass is (`persistAgain`). Never on the same
            // store, so never a loop; never while locked; never a conflict.
            if let current = stack?.store, current !== store, !gate.isLocked,
               let pending = pendingCancellations[runId], !pending.conflict {
                _ = cancellationTask(runId: runId, sessionId: pending.sessionId, terminal: pending.terminal,
                                     startRecorded: pending.startRecorded, store: current)
            }
            noteProgress()
        }
        let earlier = pendingCancellations[runId]
        let keep = startRecorded || earlier?.startRecorded == true
        let mayBeDurable = earlier?.mayBeDurable == true
        func remaining(mayBeDurable: Bool) {
            pendingCancellations[runId] = keep || mayBeDurable
                ? PendingCancellation(sessionId: sessionId, terminal: terminal, startRecorded: keep, mayBeDurable: mayBeDurable,
                                      quiet: quiet)
                : nil
        }
        guard !gate.isLocked, stack?.store === store else {
            remaining(mayBeDurable: mayBeDurable)
            return mayBeDurable ? .undetermined : .refused(.storeLocked)
        }
        do {
            let entry = try await configuration.executor.run { try store.recordTerminal(runId: runId, terminal, groupCleared: nil) }
            guard let recorded = entry.terminal, Self.holds(entry, terminal) else {
                // An answer that does not hold what was written is another
                // run state: as a conflict.
                if keep || mayBeDurable {
                    failClosed(runId: runId, sessionId: sessionId, terminal: terminal, startRecorded: keep, quiet: quiet)
                }
                return .undetermined
            }
            pendingCancellations[runId] = nil
            guard let event = ParticipantEvent(runId: runId, sessionId: entry.sessionId, recorded: recorded) else { return .undetermined }
            recordDurable(event, quiet: quiet)
            return .recorded(event)
        } catch ProofStoreError.runEntryConflict, ProofStoreError.unknownRun {
            if keep || mayBeDurable { failClosed(runId: runId, sessionId: sessionId, terminal: terminal, startRecorded: keep, quiet: quiet) }
            return .undetermined
        } catch ProofStoreError.replacedUnsynced {
            remaining(mayBeDurable: true)
            return .undetermined
        } catch ProofStoreError.writeFailed {
            remaining(mayBeDurable: false)
            return .refused(.storeCorrupt)
        } catch ProofStoreError.locked, ProofStoreError.closed {
            remaining(mayBeDurable: mayBeDurable)
            return mayBeDurable ? .undetermined : .refused(.storeLocked)
        } catch ProofStoreError.missing {
            remaining(mayBeDurable: mayBeDurable)
            return mayBeDurable ? .undetermined : .refused(.storeMissing)
        } catch ProofStoreError.corrupt {
            remaining(mayBeDurable: mayBeDurable)
            return mayBeDurable ? .undetermined : .refused(.storeCorrupt)
        } catch {
            if keep { remaining(mayBeDurable: true) }
            return .undetermined
        }
    }

    /// Codex S9 ruling (a) for a pending never-spawned terminal, as for a
    /// spawned run's writes: the store holds another terminal for the run,
    /// or no entry. The exact terminal stays in memory, conflicted: never
    /// retried, never dropped, never written over the other terminal or
    /// into a recreated entry, and never pushed. Every start stays
    /// `participant-busy` until the app quits (section 7 step 12), and
    /// status, events and Stop answer the run from this memory (pending:
    /// `start-uncertain` at 0, nothing emitted, Stop `unknown`). Logged
    /// once, text-free.
    private func failClosed(runId: String, sessionId: String, terminal: ParticipantRunTerminal, startRecorded: Bool, quiet: Bool) {
        guard pendingCancellations[runId]?.conflict != true else { return }
        pendingCancellations[runId] = PendingCancellation(sessionId: sessionId, terminal: terminal, startRecorded: startRecorded,
                                                          mayBeDurable: false, quiet: quiet, conflict: true)
        configuration.log.record(ParticipantLogEntry(runId: runId, kind: .writeConflict,
                                                     eventType: ParticipantEventType(rawValue: terminal.type), sequence: terminal.sequence))
    }

    /// A never-spawned run's terminal is durable: pushed once to every
    /// valid connection (unless `quiet`: decided while nothing could be
    /// pushed), logged, kept with the current run's events, and
    /// remembered text-free as an ended run (`groupCleared` null: nothing
    /// was spawned).
    private func recordDurable(_ event: ParticipantEvent, quiet: Bool) {
        endedRuns[event.runId] = EndedRun(sessionId: event.sessionId, terminal: event, groupCleared: nil)
        if !quiet { pushGate.push(event) }
        let reason: ParticipantLogReason?
        switch event.terminal {
        case .stopped(let stop)?: reason = .stop(stop)
        case .failed(let failure)?: reason = .failure(failure)
        case .completed?, nil: reason = nil
        }
        configuration.log.record(ParticipantLogEntry(runId: event.runId, kind: .event, eventType: event.type, sequence: event.sequence,
                                                     reason: reason))
        retain(event)
    }

    /// A pending never-spawned terminal as a read finds the run's published
    /// durable entry holding a terminal. While the run's own write is in
    /// flight nothing happens here; that write settles it.
    /// - Exactly this terminal, `groupCleared` null (`holds`): it became
    ///   durable without its own retry (a later answer of the store on
    ///   another path, a v1 read or commit, retried the folder flush and
    ///   published the visible state). It is pushed and logged once, as its
    ///   own write would have done, and the pending entry goes.
    /// - Another terminal, or this one with a non-null `groupCleared`:
    ///   irreconcilable, as its write would find it (the store refuses
    ///   both). The run fails closed (`failClosed`: Codex S9 ruling a),
    ///   keeping its own terminal in memory; nothing is pushed, and starts
    ///   stay busy.
    private func settleDurablePending(_ entry: ParticipantRunEntry) {
        guard let pending = pendingCancellations[entry.runId], !pending.conflict, let recorded = entry.terminal,
              cancellations[entry.runId] == nil else {
            return
        }
        guard Self.holds(entry, pending.terminal) else {
            failClosed(runId: entry.runId, sessionId: pending.sessionId, terminal: pending.terminal, startRecorded: pending.startRecorded,
                       quiet: pending.quiet)
            return
        }
        pendingCancellations[entry.runId] = nil
        guard let event = ParticipantEvent(runId: entry.runId, sessionId: entry.sessionId, recorded: recorded) else { return }
        recordDurable(event, quiet: pending.quiet)
    }

    private static func stopReply(_ result: CancellationResult, echo: HostEcho) -> HostResponse {
        switch result {
        case .recorded(let terminal):
            return .ok(echo, stopFields(runId: terminal.runId, state: "exited", terminal: terminal, groupCleared: nil))
        case .refused(let reason):
            return .refused(reason, echo: echo)
        case .undetermined:
            return .unknown(echo)
        }
    }

    /// `providerCancelConfirmed` is always false: Stop proves only what
    /// happened on this Mac.
    private static func stopFields(runId: String, state: String, terminal: ParticipantEvent?, groupCleared: Bool?) -> [String: JSONValue] {
        [
            "runId": .string(runId),
            "state": .string(state),
            "terminal": terminal?.jsonValue ?? .null,
            "groupCleared": groupCleared.map(JSONValue.bool) ?? .null,
            "providerCancelConfirmed": .bool(false)
        ]
    }

    /// A run whose never-spawned terminal is held in memory
    /// (`heldTerminal`: pending, conflicted included, or, for a run whose
    /// start record is durable, its first write in flight) while its entry
    /// does not hold exactly that terminal (no terminal, another one, or
    /// it with a non-null `groupCleared`), or (for a run with a start
    /// record and no terminal on disk) still being written: it reads
    /// `unknown` `start-uncertain`, never as dispatched by an earlier
    /// launch or as the other terminal (Codex S9 ruling a). A
    /// never-dispatched run whose cancellation is still being written reads
    /// `not-dispatched` until that write settles, as before.
    private func isCancellationPending(_ entry: ParticipantRunEntry) -> Bool {
        if let held = heldTerminal(entry.runId) { return !Self.holds(entry, held.terminal) }
        return entry.terminal == nil && entry.start != nil && cancellations[entry.runId] != nil
    }

    // MARK: Test hooks

    /// Seeds the current or most recent run's retained events, as a run of
    /// this launch would have left them with no process left (a vector's
    /// `memory` with `state: exited` and `process: null`). Reachable only
    /// through `@testable import`. Throws when the events do not form one
    /// run's contiguous, bounded list.
    func seedRetained(runId: String, sessionId: String, events: [ParticipantEvent], lastSequence: Int,
                      lost: RetainedRun.Loss?) throws {
        guard let run = RetainedRun(runId: runId, sessionId: sessionId, events: events, lastSequence: lastSequence, lost: lost) else {
            throw SeedError.notOneRun
        }
        retained = run
    }

    enum SeedError: Error {
        case notOneRun
    }

    /// How far the coordinator has consumed a spawned run's updates: how
    /// many it applied to memory (their store writes run behind them: see
    /// `isWriting`), and whether it saw them end. Nil for a run it did not
    /// spawn.
    func consumption(of runId: String) -> (applied: Int, finished: Bool)? {
        guard case .live(let live)? = owned[runId]?.phase else { return nil }
        return (live.applied, live.updatesFinished)
    }

    /// Stops that waited on the run's start in progress (zero when it is
    /// not starting).
    func stopWaiters(for runId: String) -> Int {
        guard case .starting(let starting)? = owned[runId]?.phase else { return 0 }
        return starting.latch.waiters
    }

    /// The run's phase in memory: `starting`, `uncertain`, `live`, or nil.
    func phase(of runId: String) -> String? {
        switch owned[runId]?.phase {
        case .starting?: return "starting"
        case .uncertain?: return "uncertain"
        case .live?: return "live"
        case nil: return nil
        }
    }

    /// Whether the confirmation's end was decided for the run (by section
    /// 17's five-second rule or an observation; its owner call may still be
    /// outstanding: `isRevoking`), and whether its stream observed overflow.
    func confirmationEvidence(of runId: String) -> (ended: Bool, overflowObserved: Bool)? {
        guard case .live(let live)? = owned[runId]?.phase else { return nil }
        return (live.watch.endedConfirmation, live.overflowObserved)
    }

    /// Whether any never-spawned terminal write, re-read or spawned run's
    /// persistence pass is in flight.
    var isWriting: Bool { !cancellations.isEmpty || !rereads.isEmpty || !persisting.isEmpty }

    /// Whether a `finishShutdown` is waiting (a test probe).
    var isFinishingShutdown: Bool { finishingShutdown > 0 }

    /// The current retained run's events (a test probe: what text memory
    /// holds; lock and close leave only a terminal).
    var retainedEvents: [ParticipantEvent] { retained?.events ?? [] }

    /// The current retained run's loss, if any (a test probe).
    var retainedLoss: RetainedRun.Loss? { retained?.lost }

    /// A spawned run's live memory as section 10's status reads it (a test
    /// probe): whether a Stop or lock or close asked it to stop.
    func stopRequested(of runId: String) -> Bool? {
        guard case .live(let live)? = owned[runId]?.phase else { return nil }
        return live.stopRequested
    }

    /// Whether any run's confirmation revocation is claimed and its owner
    /// call has not returned (Codex S8 R1; a test probe).
    var isRevoking: Bool {
        owned.values.contains { memory in
            if case .live(let live) = memory.phase { return live.watch.revocationOutstanding }
            return false
        }
    }

    /// Makes `handle` this launch's spawned run of `runId`, as step 15 does
    /// once its start record is durable (that record must already be on
    /// disk): the run's updates are consumed from here, and its events
    /// replace the retained ones (Codex Q30). The vector harness's memory
    /// seeds replay a run through this (plan S9). Reachable only through
    /// `@testable import`.
    func adoptSpawned(runId: String, sessionId: String, handle: any ParticipantRunning) throws {
        guard owned[runId] == nil, let started = RetainedRun.started(runId: runId, sessionId: sessionId) else {
            throw SeedError.notOneRun
        }
        retained = started
        own(runId: runId, sessionId: sessionId, handle: handle, admittedAt: gate.state.serial)
    }

    /// Requests waiting on a spawned run's process: Stops waiting for its
    /// terminal or a cleanup retry's answer (a test probe; the vector
    /// harness advances virtual time while any wait).
    var processWaiters: Int {
        owned.values.reduce(0) { total, memory in
            guard case .live(let live) = memory.phase else { return total }
            return total + (live.terminalLatch?.waiters ?? 0) + (live.retryLatch?.waiters ?? 0)
        }
    }

    /// A spawned run's persistence as memory holds it (a test probe).
    func persistence(of runId: String) -> RunPersistence? {
        guard case .live(let live)? = owned[runId]?.phase else { return nil }
        return live.persistence
    }

    /// Whether any participant terminal or cleanup write is unresolved (a
    /// test probe of section 7 step 12's Q31 extension).
    var hasUnresolvedWrites: Bool {
        !cancellations.isEmpty || !pendingCancellations.isEmpty || owned.values.contains { memory in
            if case .live(let live) = memory.phase { return !live.persistence.isResolved }
            return false
        }
    }

    /// A participant write this launch already owes, as the run entry
    /// fields it may leave once durable: its exact terminal and the
    /// `groupCleared` written with it.
    struct OwedWrite: Equatable {
        let terminal: ParticipantRunTerminal
        let groupCleared: Bool?
        /// A never-spawned run's terminal, pushed once it is durable.
        let neverSpawned: Bool
    }

    /// Every write a busy start's admission would queue now
    /// (`reconcileUnresolved`), per run: a spawned run's exact terminal
    /// with the evidence recorded with it until that is durable, and
    /// `groupCleared` true for the same terminal while the upgrade is owed;
    /// a pending never-spawned terminal not in flight, with null. A run in
    /// conflict owes nothing it would write. A test probe of section 7 step
    /// 12's narrow exception to Codex Q26 (Codex S9 ruling b): a busy
    /// refusal may make exactly these durable, and nothing else.
    func owedWrites() -> [String: [OwedWrite]] {
        var owed: [String: [OwedWrite]] = [:]
        for (runId, memory) in owned {
            guard case .live(let live) = memory.phase, live.persistence.owesWrite,
                  let terminal = live.persistence.terminal else { continue }
            var writes: [OwedWrite] = []
            if !live.persistence.terminalDurable {
                writes.append(OwedWrite(terminal: terminal, groupCleared: live.persistence.recordedGroupCleared, neverSpawned: false))
            }
            if live.persistence.clearedLater, !live.persistence.clearedDurable {
                writes.append(OwedWrite(terminal: terminal, groupCleared: true, neverSpawned: false))
            }
            owed[runId] = writes
        }
        for (runId, pending) in pendingCancellations where cancellations[runId] == nil && !pending.conflict {
            owed[runId, default: []].append(OwedWrite(terminal: pending.terminal, groupCleared: nil, neverSpawned: true))
        }
        return owed
    }

    /// One persistence pass for every unresolved write, as a busy start's
    /// admission queues it, awaited (a test hook).
    func reconcileNow() async {
        guard let store = stack?.store else { return }
        reconcileUnresolved(store: store)
        for task in Array(persisting.values) { await task.value }
        for inFlight in Array(cancellations.values) { _ = await inFlight.task.value }
    }

    /// The current retained run's id and last sequence.
    var retainedRun: (runId: String, lastSequence: Int, events: Int)? {
        retained.map { ($0.runId, $0.lastSequence, $0.events.count) }
    }
}
