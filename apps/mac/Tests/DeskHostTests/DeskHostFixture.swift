import Foundation
import Testing
@testable import DeskHost

/// A throwaway folder per test. Nothing here reads or writes outside it.
struct DeskHostFixture {
    let directory: URL
    let files = FileManager.default
    let keys = InventedInMemoryKeyProvider()

    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskHostTests-\(UUID().uuidString)", isDirectory: true)
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    var storeDirectory: URL { directory.appendingPathComponent("proof", isDirectory: true) }

    func makeStore(seed: WorkspaceSeed = .inventedRevisionZero(), ledgerCapacity: Int = ProofStore.defaultLedgerCapacity,
                   fileManager: FileManager = .default, faults: AtomicWriteFaults? = nil) throws -> ProofStore {
        try ProofStore(directory: storeDirectory, keys: keys, seed: seed, ledgerCapacity: ledgerCapacity, fileManager: fileManager, faults: faults)
    }

    func clean() { try? files.removeItem(at: directory) }
}

/// Collects every host event, in order.
final class RecordingSink: HostEventSink, @unchecked Sendable {
    private let lock = NSLock()
    private var events: [HostEvent] = []

    func push(_ event: HostEvent) {
        lock.lock()
        defer { lock.unlock() }
        events.append(event)
    }

    var all: [HostEvent] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }

    var finals: [HostEvent] { all.filter { $0.type == "dictation.final" } }
    var receipts: [HostEvent] { all.filter { $0.type == "dictation.receipt" } }
    var connectionEvents: [HostEvent] { all.filter { $0.type == "host.connection" } }

    /// Texts pushed as `dictation.final`; the only place text ever lands.
    var finalTexts: [String] {
        finals.compactMap { if case .dictationFinal(_, _, _, _, let text) = $0 { return text } else { return nil } }
    }
}

/// A file manager whose temp-file creation can be switched off, standing in
/// for a full disk or an unwritable folder at the moment of a write. `arm`
/// scripts which of the next creates fail (0-based), so one commit can lose
/// exactly its second or third write.
final class FlakyFileManager: FileManager {
    private let stateLock = NSLock()
    private var failAll = false
    private var failingCalls: Set<Int> = []
    private var callIndex = 0

    var failWrites: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return failAll }
        set { stateLock.lock(); defer { stateLock.unlock() }; failAll = newValue }
    }

    func arm(failing calls: Set<Int>) {
        stateLock.lock()
        defer { stateLock.unlock() }
        failingCalls = calls
        callIndex = 0
    }

    func disarm() { arm(failing: []) }

    override func createFile(atPath path: String, contents data: Data?, attributes attr: [FileAttributeKey: Any]? = nil) -> Bool {
        stateLock.lock()
        let index = callIndex
        callIndex += 1
        let fails = failAll || failingCalls.contains(index)
        stateLock.unlock()
        if fails { return false }
        return super.createFile(atPath: path, contents: data, attributes: attr)
    }
}

/// Scripts a failure at one stage of one atomic write, counted from the
/// last `arm` (0-based, every `AtomicFile.write` is one count whatever its
/// target), and optionally keeps the store's later folder-flush retries
/// failing. Each injected failure reports `EIO`.
final class WriteFaultScript: AtomicWriteFaults, @unchecked Sendable {
    private let lock = NSLock()
    private var writeIndex = -1
    private var scripted: [Int: AtomicWriteStage] = [:]
    private var retriesFail = false
    private(set) var log: [(write: Int, stage: AtomicWriteStage, file: String)] = []

    func arm(_ faults: [Int: AtomicWriteStage]) {
        lock.lock()
        defer { lock.unlock() }
        writeIndex = -1
        scripted = faults
        log = []
    }

    var failFlushRetries: Bool {
        get { lock.lock(); defer { lock.unlock() }; return retriesFail }
        set { lock.lock(); defer { lock.unlock() }; retriesFail = newValue }
    }

    func fault(before stage: AtomicWriteStage, target: URL) -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        if stage == .target { writeIndex += 1 }
        log.append((writeIndex, stage, target.lastPathComponent))
        return scripted[writeIndex] == stage ? EIO : nil
    }

    func flushRetryFault(target: URL) -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        return retriesFail ? EIO : nil
    }
}

/// Hands out scripted ids in order, then fresh random ones, so a registry's
/// uniqueness loop can never spin on a repeated id.
final class IdSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: [UUID]

    init(_ ids: [UUID]) { remaining = ids }

    func next() -> UUID {
        lock.lock()
        defer { lock.unlock() }
        return remaining.isEmpty ? UUID() : remaining.removeFirst()
    }
}

extension JSONValue {
    var arrayValue: [JSONValue]? {
        if case .array(let values) = self { return values }
        return nil
    }
}

/// Holds mutation work until the test opens the gate, so a second request can
/// arrive while the first is still outstanding.
actor MutationGate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var arrivals: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        let pending = arrivals
        arrivals = []
        for arrival in pending { arrival.resume() }
        await withCheckedContinuation { waiters.append($0) }
    }

    /// Returns once some mutation is parked at the gate.
    func waitForArrival() async {
        if !waiters.isEmpty { return }
        await withCheckedContinuation { arrivals.append($0) }
    }

    func open() {
        opened = true
        let pending = waiters
        waiters = []
        for waiter in pending { waiter.resume() }
    }
}

/// Parks before the store work: the mutation has the barrier but nothing is
/// on disk yet.
struct GatedExecutor: MutationExecutor {
    let gate = MutationGate()

    func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        await gate.wait()
        return try work()
    }
}

/// Parks after the store work: the result is durable but the actor has not
/// yet seen it, so the connection can vanish in between.
struct PostWorkGatedExecutor: MutationExecutor {
    let gate = MutationGate()

    func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        let result = Result { try work() }
        await gate.wait()
        return try result.get()
    }
}

/// Two mutations, two different pauses. The first call parks after its store
/// work (the result is durable, the actor has not seen it); the second parks
/// before its store work (the barrier is held, nothing is on disk yet). Any
/// later call runs straight through.
final class TwoStageExecutor: MutationExecutor, @unchecked Sendable {
    let afterFirst = MutationGate()
    let beforeSecond = MutationGate()
    private let lock = NSLock()
    private var calls = 0

    func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        lock.lock()
        let call = calls
        calls += 1
        lock.unlock()
        switch call {
        case 0:
            let result = Result { try work() }
            await afterFirst.wait()
            return try result.get()
        case 1:
            await beforeSecond.wait()
            return try work()
        default:
            return try work()
        }
    }
}

/// A host wired to a fresh store with one issued connection.
final class HostHarness {
    static let info = HostInfo(appVersion: "0.0-test", hostBuild: "test-build")

    let fixture: DeskHostFixture
    let store: ProofStore
    let connections = ConnectionRegistry()
    let sink = RecordingSink()
    let drafts: DraftBindingRegistry
    let host: DeskHostProtocol
    let connection: HostConnection

    /// `participants` makes a participant host (test-only; Codex Q1).
    /// `prepareStore` runs on the fresh store before the host is built, so
    /// a participant host registers its identity index after it.
    init(executor: MutationExecutor = BackgroundMutationExecutor(), fileManager: FileManager = .default,
         seed: WorkspaceSeed = .inventedRevisionZero(), ledgerCapacity: Int = ProofStore.defaultLedgerCapacity,
         faults: AtomicWriteFaults? = nil, withSink: Bool = true, participants: ParticipantHostConfiguration? = nil,
         drafts: DraftBindingRegistry = DraftBindingRegistry(), prepareStore: ((ProofStore) throws -> Void)? = nil) throws {
        fixture = try DeskHostFixture()
        store = try fixture.makeStore(seed: seed, ledgerCapacity: ledgerCapacity, fileManager: fileManager, faults: faults)
        try prepareStore?(store)
        self.drafts = drafts
        host = DeskHostProtocol(store: store, connections: connections, drafts: drafts, info: Self.info, events: withSink ? sink : nil,
                                executor: executor, participants: participants)
        connection = connections.issue()
    }

    /// A recording started now and finished with `text`: the common case
    /// where nothing changes in between.
    func deliver(_ text: String) async -> FinalDelivery {
        let token = await host.beginRecording()
        return await host.deliverFinal(token, text: text)
    }

    func clean() {
        store.close()
        fixture.clean()
    }

    var handle: String { store.workspaceHandle }

    func request(_ operation: HostOperation, payload: [String: JSONValue] = [:], requestId: UUID = UUID(),
                 connection: HostConnection? = nil, generation: Int? = nil) -> HostRequest {
        let connection = connection ?? self.connection
        return HostRequest(requestId: requestId, connectionId: connection.id, generation: generation ?? connection.generation,
                           operation: operation, payload: payload)
    }

    func readRequest(connection: HostConnection? = nil) -> HostRequest {
        request(.workspaceRead, payload: ["workspaceHandle": .string(handle)], connection: connection)
    }

    func commitRequest(expectedRevision: Int, record: [String: JSONValue], deliveryId: UUID? = nil, requestId: UUID = UUID(),
                       connection: HostConnection? = nil) -> HostRequest {
        var payload: [String: JSONValue] = [
            "workspaceHandle": .string(handle),
            "expectedRevision": .number(Double(expectedRevision)),
            "record": .object(record)
        ]
        if let deliveryId { payload["dictationDeliveryId"] = .string(deliveryId.canonicalString) }
        return request(.workspaceCommitProof, payload: payload, requestId: requestId, connection: connection)
    }

    func bindRequest(sessionId: String = UUID().canonicalString, expectedRevision: Int = 0, expectedText: String = "Before 😀 after",
                     selection: (Int, Int) = (7, 9), requestId: UUID = UUID(), connection: HostConnection? = nil) -> HostRequest {
        request(.dictationBindDraft, payload: [
            "workspaceHandle": .string(handle),
            "sessionId": .string(sessionId),
            "expectedRevision": .number(Double(expectedRevision)),
            "expectedText": .string(expectedText),
            "selection": .object(["start": .number(Double(selection.0)), "end": .number(Double(selection.1))])
        ], requestId: requestId, connection: connection)
    }

    func unbindRequest(bindingId: UUID, requestId: UUID = UUID(), connection: HostConnection? = nil) -> HostRequest {
        request(.dictationUnbindDraft, payload: ["bindingId": .string(bindingId.canonicalString)],
                requestId: requestId, connection: connection)
    }

    func reconcileRequest(target: UUID, requestId: UUID = UUID(), connection: HostConnection? = nil) -> HostRequest {
        request(.workspaceReconcile, payload: ["workspaceHandle": .string(handle), "targetRequestId": .string(target.canonicalString)],
                requestId: requestId, connection: connection)
    }

    func receiptRequest(deliveryId: UUID, requestId: UUID = UUID(), connection: HostConnection? = nil) -> HostRequest {
        request(.dictationReceipt, payload: ["deliveryId": .string(deliveryId.canonicalString)], requestId: requestId, connection: connection)
    }

    /// Binds a draft and returns the host-issued binding id.
    func bind(expectedRevision: Int, sessionId: String = UUID().canonicalString, connection: HostConnection? = nil) async throws -> UUID {
        let response = await host.handle(bindRequest(sessionId: sessionId, expectedRevision: expectedRevision, connection: connection))
        #expect(response.outcome == .ok)
        return try #require(response.bindingId)
    }

    /// Commits an invented record at the next revision and returns the reply.
    @discardableResult
    func commit(_ label: String, expectedRevision: Int, revision: Int? = nil, requestId: UUID = UUID(),
                connection: HostConnection? = nil) async -> HostResponse {
        await host.handle(commitRequest(expectedRevision: expectedRevision, record: inventedRecord(label, revision: revision ?? expectedRevision + 1),
                                        requestId: requestId, connection: connection))
    }

    func read() async -> WorkspaceRecord? {
        let response = await host.handle(readRequest())
        guard response.outcome == .ok, let record = response.record, let revision = response.revision else { return nil }
        return WorkspaceRecord(workspaceId: store.workspaceId, workspaceHandle: handle, revision: revision, record: record,
                               committedAt: nil, requestId: nil)
    }
}

/// An invented Desk record: only `revision` is read by the host.
func inventedRecord(_ label: String, revision: Int) -> [String: JSONValue] {
    [
        "revision": .number(Double(revision)),
        "label": .string(label),
        "sessions": .array([.object(["id": .string(UUID().canonicalString), "draft": .string("invented draft \(label)")])])
    ]
}

func envelopeJSON(_ overrides: [String: String] = [:], dropping: Set<String> = [], extra: [String: String] = [:]) -> Data {
    var fields: [String: String] = [
        "v": "1",
        "requestId": "\"\(UUID().canonicalString)\"",
        "connectionId": "\"invented-connection\"",
        "generation": "0",
        "operation": "\"host.capabilities\"",
        "payload": "{}"
    ]
    for (key, value) in overrides { fields[key] = value }
    for key in dropping { fields.removeValue(forKey: key) }
    for (key, value) in extra { fields[key] = value }
    let body = fields.keys.sorted().map { "\"\($0)\":\(fields[$0]!)" }.joined(separator: ",")
    return Data("{\(body)}".utf8)
}
