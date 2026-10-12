import Foundation

// The preparing commit's checks (`docs/desk-native-participant-contract.md`
// section 6), pure and in the contract's order, so the protocol only places
// them and the store only adds steps 8 and 9. Nothing here is reached on a
// host without participants: that host refuses `participantRun` as an
// unknown field and never looks at `conversationRuns`.

/// A check that passed with its value, or the one refusal it owes.
public enum ParticipantCheck<Value: Equatable & Sendable>: Equatable, Sendable {
    case passed(Value)
    case refused(HostRefusal)
}

/// What a participant host's commit hands the store after steps 1-7: the run
/// it prepares, if it carries a claim, and the attempted record's run ids for
/// step 9, in order and as written (empty for a record without
/// `conversationRuns`, as schema 1).
public struct ParticipantCommitCheck: Equatable, Sendable {
    public let preparedRun: ParticipantPreparedRun?
    public let attemptedRunIds: [String]
}

/// The claim a preparing commit carries in `participantRun` (step 1). Ids
/// and `createdAt` stay the exact wire strings.
public struct ParticipantClaim: Equatable, Sendable {
    public let runId: String
    public let sessionId: String
    public let userMessageId: String
    public let assistantMessageId: String
    public let participantId: String
    public let createdAt: String
}

public enum ParticipantPrepare {
    public static let claimKeys: Set<String> = [
        "runId", "sessionId", "userMessageId", "assistantMessageId", "participantId", "createdAt"
    ]

    /// Step 3: the twelve prepared keys of the renderer at 2e1f37d. A run
    /// carrying `reason` or `closure` is later evidence, never a new run.
    public static let preparedRunKeys: Set<String> = [
        "version", "runId", "sessionId", "userMessageId", "assistantMessageId", "participant", "inputChunks",
        "outputChunks", "lastSequence", "phase", "createdAt", "updatedAt"
    ]

    /// Everything section 6 asks of a commit on a participant host, before
    /// the store, in this order (Codex Q6, Q7):
    /// 1. a claim beside `dictationDeliveryId` is `malformed-envelope`;
    /// 2. a present attempted `conversationRuns` must be a list of objects
    ///    each with a string `runId`, else `malformed-envelope`, with or
    ///    without a claim and before step 2 looks for the run;
    /// 3. the claim's steps 1-7, when there is one.
    /// The caller runs this after v1's checks through exact replay and
    /// before the delivery check.
    public static func check(record: [String: JSONValue], claim: JSONValue?, hasDeliveryId: Bool,
                             pin: ParticipantPin, inputBound: Int?) -> ParticipantCheck<ParticipantCommitCheck> {
        if claim != nil, hasDeliveryId { return .refused(.malformedEnvelope) }
        let attempted: [String]?
        switch attemptedRunIds(in: record) {
        case .refused(let reason): return .refused(reason)
        case .passed(let ids): attempted = ids
        }
        guard let claim else { return .passed(ParticipantCommitCheck(preparedRun: nil, attemptedRunIds: attempted ?? [])) }
        switch prepare(claim: claim, record: record, pin: pin, inputBound: inputBound) {
        case .refused(let reason): return .refused(reason)
        case .passed(let run): return .passed(ParticipantCommitCheck(preparedRun: run, attemptedRunIds: attempted ?? []))
        }
    }

    /// Steps 1-7 for one claim against the same request's record.
    public static func prepare(claim value: JSONValue, record: [String: JSONValue], pin: ParticipantPin,
                               inputBound: Int?) -> ParticipantCheck<ParticipantPreparedRun> {
        switch claim(value) {
        case .refused(let reason): return .refused(reason)
        case .passed(let claim): return prepare(claim, record: record, pin: pin, inputBound: inputBound)
        }
    }

    /// Step 1, with Codex's precedence (Q6): unknown keys (`unknown-field`);
    /// then each identity's presence, type and form in the order runId,
    /// sessionId, userMessageId, assistantMessageId (`invalid-identity`, a
    /// missing one included); then `participantId` (nonblank, at most 256
    /// UTF-8 bytes, the pin field rule) and `createdAt` (a real UTC
    /// millisecond time that formats back to the same 24 bytes), each
    /// `malformed-envelope`; then the four ids distinct ignoring case
    /// (`invalid-identity`). A claim that is not an object is
    /// `malformed-envelope`.
    public static func claim(_ value: JSONValue) -> ParticipantCheck<ParticipantClaim> {
        guard let fields = value.objectValue else { return .refused(.malformedEnvelope) }
        guard Set(fields.keys).isSubset(of: claimKeys) else { return .refused(.unknownField) }
        guard let runId = ParticipantIds.runLike(fields["runId"]),
              let sessionId = ParticipantIds.session(fields["sessionId"]),
              let userMessageId = ParticipantIds.runLike(fields["userMessageId"]),
              let assistantMessageId = ParticipantIds.runLike(fields["assistantMessageId"]) else { return .refused(.invalidIdentity) }
        guard let participantId = fields["participantId"]?.stringValue, ParticipantPin.isValidField(participantId),
              let createdAt = fields["createdAt"]?.stringValue, WireTimestamp.isValid(createdAt) else { return .refused(.malformedEnvelope) }
        guard ParticipantIds.distinctIgnoringCase([runId, sessionId, userMessageId, assistantMessageId]) else {
            return .refused(.invalidIdentity)
        }
        return .passed(ParticipantClaim(runId: runId, sessionId: sessionId, userMessageId: userMessageId,
                                        assistantMessageId: assistantMessageId, participantId: participantId, createdAt: createdAt))
    }

    /// The attempted record's run ids, strictly (Codex Q7), in order and as
    /// written: nil when the record has no `conversationRuns` (schema 1: no
    /// introduced runs); `malformed-envelope` unless it is a list of objects
    /// each with a string `runId`. Nothing else in the record is parsed.
    /// A list, not a `Set`: Swift's `String` equality is canonical
    /// equivalence, and run ids are compared by their bytes.
    public static func attemptedRunIds(in record: [String: JSONValue]) -> ParticipantCheck<[String]?> {
        guard let list = record["conversationRuns"] else { return .passed(nil) }
        guard case .array(let elements) = list else { return .refused(.malformedEnvelope) }
        var ids: [String] = []
        for element in elements {
            guard let runId = element.objectValue?["runId"]?.stringValue else { return .refused(.malformedEnvelope) }
            ids.append(runId)
        }
        return .passed(ids)
    }

    /// The committed record's run ids, leniently (Codex Q9): every string
    /// `runId` on an object element; malformed siblings, and an absent or
    /// non-list `conversationRuns`, contribute nothing. Only the committed
    /// workspace record is read this way, an opaque and possibly older
    /// record that a valid replacement may repair. The attempted list stays
    /// strict (above), and the store's own `runs` stays strict at load. A
    /// run found here is only "not introduced": it never creates a native
    /// entry, receipt or start. In order and as written, like
    /// `attemptedRunIds`.
    public static func committedRunIds(in record: [String: JSONValue]) -> [String] {
        guard case .array(let elements)? = record["conversationRuns"] else { return [] }
        return elements.compactMap { $0.objectValue?["runId"]?.stringValue }
    }

    /// Step 9's introduced runs: attempted ids whose bytes no committed id
    /// has, in attempted order.
    public static func introducedRunIds(attempted: [String], committed: [String]) -> [String] {
        let held = Set(committed.map { Array($0.utf8) })
        return attempted.filter { !held.contains(Array($0.utf8)) }
    }

    /// Steps 2-7 for a decoded claim, in order; the first failing step's
    /// refusal is the answer. Strings are compared byte for byte, as the
    /// page's `===` compares, never by Swift's canonical equivalence.
    public static func prepare(_ claim: ParticipantClaim, record: [String: JSONValue], pin: ParticipantPin,
                               inputBound: Int?) -> ParticipantCheck<ParticipantPreparedRun> {
        // 2. Schema 2 and exactly one element with the claimed run id.
        guard record["schemaVersion"] == .number(2), case .array(let elements)? = record["conversationRuns"] else {
            return .refused(.runNotFound)
        }
        let matches = elements.filter { element in
            element.objectValue?["runId"]?.stringValue.map { ParticipantPin.sameBytes($0, claim.runId) } ?? false
        }
        guard matches.count == 1, let run = matches[0].objectValue else { return .refused(.runNotFound) }

        // 3. Exactly the prepared form: the twelve keys, version 1, phase
        // prepared, nothing sequenced or written yet, never updated.
        guard Set(run.keys) == preparedRunKeys, run["version"] == .number(1), isString(run["phase"], "prepared"),
              run["lastSequence"] == .number(0), run["outputChunks"] == .array([]),
              sameValue(run["updatedAt"], run["createdAt"]) else { return .refused(.runNotPrepared) }

        // 4. The ids and createdAt the claim names.
        guard isString(run["sessionId"], claim.sessionId), isString(run["userMessageId"], claim.userMessageId),
              isString(run["assistantMessageId"], claim.assistantMessageId), isString(run["createdAt"], claim.createdAt) else {
            return .refused(.runMismatch)
        }

        // 5. The claim's participant id and the run's whole participant are
        // native's current pin. A participant object with any other key
        // set is not the pin.
        guard ParticipantPin.sameBytes(claim.participantId, pin.id),
              let participant = run["participant"].flatMap(ParticipantPin.init(json:)), participant == pin else {
            return .refused(.runMismatch)
        }

        // 6. Input: at least one chunk, each a string of 1-16,384 bytes, at
        // most 262,144 together and at most the host's first-trial bound.
        // A chunk that is not a string fails here too (Codex Q8); an
        // earlier step's failure has already won.
        guard case .array(let chunkValues)? = run["inputChunks"], !chunkValues.isEmpty else { return .refused(.textTooLarge) }
        var chunks: [String] = []
        var inputBytes = 0
        for value in chunkValues {
            guard let chunk = value.stringValue, (1...ParticipantLimits.chunkBytes).contains(chunk.utf8.count) else {
                return .refused(.textTooLarge)
            }
            chunks.append(chunk)
            inputBytes += chunk.utf8.count
        }
        guard inputBytes <= min(ParticipantLimits.inputTotalBytes, inputBound ?? ParticipantLimits.inputTotalBytes) else {
            return .refused(.textTooLarge)
        }

        // 7. The run's canonical JSON leaves room for a terminal.
        let preparedBytes = JSONValue.object(run).canonicalData().count
        guard preparedBytes <= ParticipantLimits.preparedRunBytes else { return .refused(.payloadTooLarge) }

        // Steps 1-7 establish every rule `ParticipantPreparedRun` checks, so
        // this cannot be nil; if it ever were, nothing is prepared.
        guard let prepared = ParticipantPreparedRun(
            runId: claim.runId, sessionId: claim.sessionId, userMessageId: claim.userMessageId,
            assistantMessageId: claim.assistantMessageId, participant: participant, createdAt: claim.createdAt,
            inputHash: PayloadHash.hex(of: .array(chunks.map(JSONValue.string))), inputBytes: inputBytes, preparedBytes: preparedBytes
        ) else { return .refused(.malformedEnvelope) }
        return .passed(prepared)
    }

    private static func isString(_ value: JSONValue?, _ expected: String) -> Bool {
        guard let string = value?.stringValue else { return false }
        return ParticipantPin.sameBytes(string, expected)
    }

    /// Equal values, with strings compared by their bytes.
    private static func sameValue(_ lhs: JSONValue?, _ rhs: JSONValue?) -> Bool {
        if let left = lhs?.stringValue, let right = rhs?.stringValue { return ParticipantPin.sameBytes(left, right) }
        return lhs == rhs
    }
}
