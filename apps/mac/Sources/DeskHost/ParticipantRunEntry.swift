import Foundation

// The text-free participant run evidence `state.json` keeps
// (`docs/desk-native-participant-contract.md` section 15). Ids and
// timestamps stay the exact wire strings: `JSONEncoder`'s `.iso8601` drops
// milliseconds and `UUID` writes upper case, and an entry must read back
// byte for byte as the page and the shared vectors spell it. Every value
// here is built through a validating initializer, so an entry that breaks
// the section 15 shape cannot exist in memory, and a stored one that does
// makes the whole store corrupt.

/// What a preparing commit proves about its run (section 6 steps 1-7),
/// before the store binds it to the commit that introduces it.
public struct ParticipantPreparedRun: Equatable, Sendable {
    public let runId: String
    public let sessionId: String
    public let userMessageId: String
    public let assistantMessageId: String
    public let participant: ParticipantPin
    public let createdAt: String
    /// Lowercase hex SHA-256 of the canonical `inputChunks` array.
    public let inputHash: String
    public let inputBytes: Int
    public let preparedBytes: Int

    /// Nil unless the run and message ids are canonical lowercase UUIDv4,
    /// the session id a record id (case kept), the four distinct ignoring
    /// case, `createdAt` a real `.mmmZ` time, `inputHash` 64 lowercase hex
    /// digits, `inputBytes` 1-262,144 (section 6 step 6) and
    /// `preparedBytes` 1-785,408 (step 7).
    public init?(runId: String, sessionId: String, userMessageId: String, assistantMessageId: String,
                 participant: ParticipantPin, createdAt: String, inputHash: String, inputBytes: Int, preparedBytes: Int) {
        guard [runId, userMessageId, assistantMessageId].allSatisfy(ParticipantRunText.isRunLike),
              UUID.isRecordId(sessionId),
              ParticipantIds.distinctIgnoringCase([runId, sessionId, userMessageId, assistantMessageId]),
              WireTimestamp.isValid(createdAt), ParticipantRunText.isSHA256Hex(inputHash),
              (1...ParticipantLimits.inputTotalBytes).contains(inputBytes),
              (1...ParticipantLimits.preparedRunBytes).contains(preparedBytes) else { return nil }
        self.runId = runId
        self.sessionId = sessionId
        self.userMessageId = userMessageId
        self.assistantMessageId = assistantMessageId
        self.participant = participant
        self.createdAt = createdAt
        self.inputHash = inputHash
        self.inputBytes = inputBytes
        self.preparedBytes = preparedBytes
    }

    /// The three ids that share one uniqueness namespace across every entry
    /// (Codex Q4). `sessionId` is not among them: a session holds many runs.
    var namespacedIds: [String] { [runId, userMessageId, assistantMessageId] }
}

/// The start record (section 7 step 14): written once, never rewritten.
public struct ParticipantRunStart: Sendable {
    public static let keys: Set<String> = ["requestId", "payloadHash", "at", "launchId", "cliVersion"]

    /// The `participant.start` request id, canonical lowercase UUIDv4.
    public let requestId: String
    /// The start request's payload hash, lowercase hex SHA-256.
    public let payloadHash: String
    public let at: String
    /// This app launch's id, canonical lowercase UUIDv4.
    public let launchId: String
    /// The pinned CLI version the run was started under (Codex Q16).
    public let cliVersion: String

    public init?(requestId: String, payloadHash: String, at: String, launchId: String, cliVersion: String) {
        guard ParticipantRunText.isRunLike(requestId), ParticipantRunText.isSHA256Hex(payloadHash), WireTimestamp.isValid(at),
              ParticipantRunText.isRunLike(launchId), ParticipantPin.isValidField(cliVersion) else { return nil }
        self.requestId = requestId
        self.payloadHash = payloadHash
        self.at = at
        self.launchId = launchId
        self.cliVersion = cliVersion
    }

    init?(json: JSONValue) {
        guard let fields = json.objectValue, Set(fields.keys) == Self.keys,
              let requestId = fields["requestId"]?.stringValue, let payloadHash = fields["payloadHash"]?.stringValue,
              let at = fields["at"]?.stringValue, let launchId = fields["launchId"]?.stringValue,
              let cliVersion = fields["cliVersion"]?.stringValue else { return nil }
        self.init(requestId: requestId, payloadHash: payloadHash, at: at, launchId: launchId, cliVersion: cliVersion)
    }

    public var jsonValue: JSONValue {
        .object([
            "requestId": .string(requestId),
            "payloadHash": .string(payloadHash),
            "at": .string(at),
            "launchId": .string(launchId),
            "cliVersion": .string(cliVersion)
        ])
    }
}

extension ParticipantRunStart: Equatable {
    /// Exact bytes for `cliVersion`, the one free-form string here; Swift's
    /// `String ==` would call canonically equivalent text equal.
    public static func == (lhs: ParticipantRunStart, rhs: ParticipantRunStart) -> Bool {
        lhs.requestId == rhs.requestId && lhs.payloadHash == rhs.payloadHash && lhs.at == rhs.at
            && lhs.launchId == rhs.launchId && ParticipantPin.sameBytes(lhs.cliVersion, rhs.cliVersion)
    }
}

/// A run's one recorded terminal (sections 8 and 10): `{type, sequence, at,
/// reason}`, `reason` null for `completed`. Never rewritten.
public struct ParticipantRunTerminal: Equatable, Sendable {
    public static let keys: Set<String> = ["type", "sequence", "at", "reason"]

    /// Each terminal type and the reasons it carries (section 8).
    public static let reasons: [String: Set<String?>] = [
        "completed": [nil],
        "stopped": ["local-stop", "stop-incomplete"],
        "failed": ["reply-too-long", "paid-overflow", "timeout", "process-error"]
    ]

    public let type: String
    public let sequence: Int
    public let at: String
    public let reason: String?

    /// Nil unless `type` and `reason` are a section 8 pair, `sequence` is a
    /// safe integer of at least 1 (at least 2 for `completed`, which
    /// follows `started`) and `at` a real `.mmmZ` time.
    public init?(type: String, sequence: Int, at: String, reason: String?) {
        guard let allowed = Self.reasons[type], allowed.contains(reason), sequence >= (type == "completed" ? 2 : 1),
              ParticipantRunText.isSafeCount(sequence), WireTimestamp.isValid(at) else { return nil }
        self.type = type
        self.sequence = sequence
        self.at = at
        self.reason = reason
    }

    init?(json: JSONValue) {
        guard let fields = json.objectValue, Set(fields.keys) == Self.keys,
              let type = fields["type"]?.stringValue, let sequence = fields["sequence"]?.safeIntegerValue,
              let at = fields["at"]?.stringValue, let reasonValue = fields["reason"] else { return nil }
        let reason: String?
        switch reasonValue {
        case .null: reason = nil
        case .string(let text): reason = text
        default: return nil
        }
        self.init(type: type, sequence: sequence, at: at, reason: reason)
    }

    public var jsonValue: JSONValue {
        .object([
            "type": .string(type),
            "sequence": .number(Double(sequence)),
            "at": .string(at),
            "reason": reason.map(JSONValue.string) ?? .null
        ])
    }

    var isStopIncomplete: Bool { type == "stopped" && reason == "stop-incomplete" }
}

/// One `state.json` `runs` entry: exactly the fourteen keys of section 15,
/// with explicit nulls. Written at prepare, then given a start, a terminal
/// and a cleared group; never evicted.
public struct ParticipantRunEntry: Equatable, Sendable {
    public static let keys: Set<String> = [
        "runId", "sessionId", "userMessageId", "assistantMessageId", "participant", "createdAt", "inputHash",
        "inputBytes", "preparedBytes", "prepareRequestId", "preparedRevision", "start", "terminal", "groupCleared"
    ]

    public let runId: String
    public let sessionId: String
    public let userMessageId: String
    public let assistantMessageId: String
    /// The exact prepared participant; a start compares against it.
    public let participant: ParticipantPin
    public let createdAt: String
    public let inputHash: String
    public let inputBytes: Int
    public let preparedBytes: Int
    /// The `ok` commit that introduced the run, canonical lowercase.
    public let prepareRequestId: String
    public let preparedRevision: Int
    public let start: ParticipantRunStart?
    public let terminal: ParticipantRunTerminal?
    /// Null until a terminal; then true, false, or null when nothing was
    /// spawned. Only ever moves from false to true.
    public let groupCleared: Bool?

    /// The entry a preparing commit writes: no start, no terminal. Nil
    /// unless the commit's request id is a UUIDv4 (the only kind the host
    /// issues) and the revision a safe integer: anything else would be an
    /// entry the loader refuses, making the whole store corrupt for good.
    init?(prepared: ParticipantPreparedRun, prepareRequestId: UUID, preparedRevision: Int) {
        self.init(prepared: prepared, prepareRequestId: prepareRequestId.canonicalString, preparedRevision: preparedRevision,
                  start: nil, terminal: nil, groupCleared: nil)
    }

    private init?(prepared: ParticipantPreparedRun, prepareRequestId: String, preparedRevision: Int,
                  start: ParticipantRunStart?, terminal: ParticipantRunTerminal?, groupCleared: Bool?) {
        guard ParticipantRunText.isRunLike(prepareRequestId), ParticipantRunText.isSafeCount(preparedRevision),
              Self.isConsistent(start: start, terminal: terminal, groupCleared: groupCleared) else { return nil }
        runId = prepared.runId
        sessionId = prepared.sessionId
        userMessageId = prepared.userMessageId
        assistantMessageId = prepared.assistantMessageId
        participant = prepared.participant
        createdAt = prepared.createdAt
        inputHash = prepared.inputHash
        inputBytes = prepared.inputBytes
        preparedBytes = prepared.preparedBytes
        self.prepareRequestId = prepareRequestId
        self.preparedRevision = preparedRevision
        self.start = start
        self.terminal = terminal
        self.groupCleared = groupCleared
    }

    /// Strict: exactly the fourteen keys, each of its section 15 type and
    /// form. Anything else is nil, which the store reads as corrupt.
    public init?(json: JSONValue) {
        guard let fields = json.objectValue, Set(fields.keys) == Self.keys,
              let runId = fields["runId"]?.stringValue, let sessionId = fields["sessionId"]?.stringValue,
              let userMessageId = fields["userMessageId"]?.stringValue,
              let assistantMessageId = fields["assistantMessageId"]?.stringValue,
              let participantValue = fields["participant"], let participant = ParticipantPin(json: participantValue),
              let createdAt = fields["createdAt"]?.stringValue, let inputHash = fields["inputHash"]?.stringValue,
              let inputBytes = fields["inputBytes"]?.safeIntegerValue, let preparedBytes = fields["preparedBytes"]?.safeIntegerValue,
              let prepareRequestId = fields["prepareRequestId"]?.stringValue,
              let preparedRevision = fields["preparedRevision"]?.safeIntegerValue,
              let startValue = fields["start"], let terminalValue = fields["terminal"], let groupClearedValue = fields["groupCleared"],
              let prepared = ParticipantPreparedRun(runId: runId, sessionId: sessionId, userMessageId: userMessageId,
                                                    assistantMessageId: assistantMessageId, participant: participant,
                                                    createdAt: createdAt, inputHash: inputHash, inputBytes: inputBytes,
                                                    preparedBytes: preparedBytes) else { return nil }
        let start: ParticipantRunStart?
        if case .null = startValue {
            start = nil
        } else {
            guard let decoded = ParticipantRunStart(json: startValue) else { return nil }
            start = decoded
        }
        let terminal: ParticipantRunTerminal?
        if case .null = terminalValue {
            terminal = nil
        } else {
            guard let decoded = ParticipantRunTerminal(json: terminalValue) else { return nil }
            terminal = decoded
        }
        let groupCleared: Bool?
        switch groupClearedValue {
        case .null: groupCleared = nil
        case .bool(let value): groupCleared = value
        default: return nil
        }
        self.init(prepared: prepared, prepareRequestId: prepareRequestId, preparedRevision: preparedRevision,
                  start: start, terminal: terminal, groupCleared: groupCleared)
    }

    /// The fourteen keys, nulls written out (as the vectors' `afterRuns`).
    public var jsonValue: JSONValue {
        .object([
            "runId": .string(runId),
            "sessionId": .string(sessionId),
            "userMessageId": .string(userMessageId),
            "assistantMessageId": .string(assistantMessageId),
            "participant": participant.jsonValue,
            "createdAt": .string(createdAt),
            "inputHash": .string(inputHash),
            "inputBytes": .number(Double(inputBytes)),
            "preparedBytes": .number(Double(preparedBytes)),
            "prepareRequestId": .string(prepareRequestId),
            "preparedRevision": .number(Double(preparedRevision)),
            "start": start?.jsonValue ?? .null,
            "terminal": terminal?.jsonValue ?? .null,
            "groupCleared": groupCleared.map(JSONValue.bool) ?? .null
        ])
    }

    var namespacedIds: [String] { [runId, userMessageId, assistantMessageId] }

    /// This entry with `start` recorded; nil if that breaks a section 15
    /// rule. The store decides the refusal (duplicate, not prepared) first.
    func recording(start: ParticipantRunStart) -> ParticipantRunEntry? {
        Self(prepared: prepared, prepareRequestId: prepareRequestId, preparedRevision: preparedRevision,
             start: start, terminal: terminal, groupCleared: groupCleared)
    }

    func recording(terminal: ParticipantRunTerminal, groupCleared: Bool?) -> ParticipantRunEntry? {
        Self(prepared: prepared, prepareRequestId: prepareRequestId, preparedRevision: preparedRevision,
             start: start, terminal: terminal, groupCleared: groupCleared)
    }

    func clearingGroup() -> ParticipantRunEntry? {
        Self(prepared: prepared, prepareRequestId: prepareRequestId, preparedRevision: preparedRevision,
             start: start, terminal: terminal, groupCleared: true)
    }

    private var prepared: ParticipantPreparedRun {
        // Already validated when this entry was built.
        ParticipantPreparedRun(runId: runId, sessionId: sessionId, userMessageId: userMessageId,
                               assistantMessageId: assistantMessageId, participant: participant, createdAt: createdAt,
                               inputHash: inputHash, inputBytes: inputBytes, preparedBytes: preparedBytes)!
    }

    /// The per-entry load invariants of section 15: a run that never started
    /// ends only as Stop's never-dispatched `stopped` `local-stop` at
    /// sequence 1, and spawned nothing, so its `groupCleared` stays null
    /// (section 10); `groupCleared` exists only beside a terminal, and
    /// `stop-incomplete` always carries one.
    private static func isConsistent(start: ParticipantRunStart?, terminal: ParticipantRunTerminal?, groupCleared: Bool?) -> Bool {
        if start == nil, let terminal,
           !(terminal.type == "stopped" && terminal.reason == "local-stop" && terminal.sequence == 1 && groupCleared == nil) { return false }
        if groupCleared != nil, terminal == nil { return false }
        if let terminal, terminal.isStopIncomplete, groupCleared == nil { return false }
        return true
    }
}

extension ParticipantRunEntry: Codable {
    /// Decoded through `JSONValue` so the exact key set is seen
    /// (`JSONDecoder` would ignore an extra key) and nulls stay explicit.
    public init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard let entry = Self(json: value) else {
            throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: decoder.codingPath,
                                                                    debugDescription: "not a section 15 participant run entry"))
        }
        self = entry
    }

    public func encode(to encoder: Encoder) throws {
        try jsonValue.encode(to: encoder)
    }
}

/// The runs copy `ProofStore` publishes for the participant lane (section 7
/// concurrency; Codex Q5). Reading it takes only the store's snapshot lock,
/// never the writer lock held through a write's full flush, so status,
/// events and Stop never wait behind a commit.
public struct ParticipantRunsSnapshot: Equatable, Sendable {
    /// The store's status when this copy was published.
    public let status: StoreStatus
    /// The store refuses reads and writes until `unlockStore()`. `runs`
    /// stays the last durable copy (text-free); it proves no absence.
    public let locked: Bool
    /// The store was closed: drop the reference, which is never reused
    /// (Codex Q21). `runs` is empty and nothing is durable.
    public let closed: Bool
    /// `runs` is a state the folder durably holds. False before the first
    /// successful folder flush after an open, for a missing or corrupt
    /// store and after close; `runs` is then empty and proves nothing
    /// about any run.
    public let durable: Bool
    /// A newer replacement of `state.json` is visible but its folder flush
    /// is unconfirmed, so the durable state may already hold more than
    /// `runs` shows. Cleared by the next durable publish.
    public let uncertain: Bool
    /// Durable entries only (Codex Q5): a write whose flush failed is never
    /// here until a later flush or an authoritative re-read confirms it.
    public let runs: [ParticipantRunEntry]
    /// Start request ids recorded in `runs`: the only starts that may
    /// replay `ok`.
    public let startRequestIds: Set<String>
    /// Every start request id the folder may hold, durable or not: a superset
    /// of `startRequestIds` that also keeps the ids of unconfirmed start
    /// writes. Reserved, never replayed `ok`; an id leaves it only when an
    /// authoritative re-read no longer shows it (Codex Q5).
    public let reservedStartRequestIds: Set<String>

    init(status: StoreStatus, durable: Bool, uncertain: Bool, runs: [ParticipantRunEntry], reservedStartRequestIds: Set<String>,
         locked: Bool = false, closed: Bool = false) {
        self.status = status
        self.locked = locked
        self.closed = closed
        self.durable = durable
        self.uncertain = uncertain
        self.runs = runs
        let started = Set(runs.compactMap { $0.start?.requestId })
        startRequestIds = started
        self.reservedStartRequestIds = reservedStartRequestIds.union(started)
    }

    /// Before an open has decided anything.
    static let unopened = ParticipantRunsSnapshot(status: .missing, durable: false, uncertain: false, runs: [], reservedStartRequestIds: [])

    /// The durable entry for a canonical run id, if any. Nil does not prove
    /// the run absent (the copy may not be durable or settled yet); use
    /// `lookup(runId:)` before answering `unknown-run`.
    public func entry(for runId: String) -> ParticipantRunEntry? {
        runs.first { $0.runId == runId }
    }

    /// The durable entry, or whether this copy proves there is none. Only a
    /// ready, durable, settled copy of an open, unlocked store proves a run
    /// absent (`unknown-run`, Codex Q23); anything else is `unproven`.
    public func lookup(runId: String) -> ParticipantRunLookup {
        if let entry = entry(for: runId) { return .found(entry) }
        return status == .ready && durable && !uncertain && !locked && !closed ? .absent : .unproven
    }
}

/// What a published runs copy says about one run id.
public enum ParticipantRunLookup: Equatable, Sendable {
    /// The run's durable entry.
    case found(ParticipantRunEntry)
    /// The store durably holds no entry for it.
    case absent
    /// Nothing is proven: the copy is not durable yet, a newer write is
    /// unconfirmed, or the store is missing, corrupt, locked or closed.
    case unproven
}

/// Shared string forms for the run types.
enum ParticipantRunText {
    static func isRunLike(_ value: String) -> Bool {
        ParticipantIds.runLike(.string(value)) != nil
    }

    static func isSHA256Hex(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    static func isSafeCount(_ value: Int) -> Bool {
        value >= 0 && value <= ProofLimits.maxSafeInteger
    }
}
