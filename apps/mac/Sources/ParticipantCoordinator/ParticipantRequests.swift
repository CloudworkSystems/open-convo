import DeskHost

// Payload shapes for the participant operations
// (`docs/desk-native-participant-contract.md` sections 3, 4, 7 and 9). Each
// parser refuses in the contract's order, the same precedence the commit
// claim uses (Codex Q6):
// 1. a key outside the operation's exact set: `unknown-field`;
// 2. a missing or ill-formed `workspaceHandle`, `runId` or `sessionId`, in
//    that order: `invalid-identity`;
// 3. any other missing key or wrong type (`afterSequence` a nonnegative safe
//    integer, `maxEvents` 1-64): `malformed-envelope`;
// 4. `runId` and `sessionId` equal ignoring case: `invalid-identity`.
// The handle itself is compared afterwards (`unknown-handle`), by the
// coordinator, against the attached store. `participant.start` adds its
// own keys to these steps (`ParticipantRequests.start`).

/// The `{workspaceHandle, runId, sessionId}` that `participant.stop` and
/// `participant.status` take exactly, and `participant.events` begins with.
struct ParticipantRunRead: Equatable, Sendable {
    static let keys: Set<String> = ["workspaceHandle", "runId", "sessionId"]

    let workspaceHandle: String
    /// Canonical lowercase UUIDv4, as written.
    let runId: String
    /// A record id, exactly as written: compared to the run's byte for byte.
    let sessionId: String
}

/// `participant.events`: the run plus where to read from and how many.
struct ParticipantEventsRead: Equatable, Sendable {
    static let keys: Set<String> = ParticipantRunRead.keys.union(["afterSequence", "maxEvents"])

    let run: ParticipantRunRead
    /// A nonnegative safe integer.
    let afterSequence: Int
    /// 1-64 (`ParticipantLimits.maxEvents`).
    let maxEvents: Int
}

/// `participant.start` (contract sections 4 and 7 step 2): the run's three
/// ids beside the read ids, the participant the page prepared, and the
/// input chunks. Strings stay exactly as written: step 9 compares them to
/// the prepared entry byte for byte.
struct ParticipantStartRequest: Equatable, Sendable {
    static let keys: Set<String> = ParticipantRunRead.keys.union(["userMessageId", "assistantMessageId", "participant", "inputChunks"])

    let run: ParticipantRunRead
    /// Canonical lowercase UUIDv4, as written.
    let userMessageId: String
    let assistantMessageId: String
    /// `{id, label, model, executionHost}`, each exactly as written (not
    /// checked as a pin here: a value that cannot be the prepared one is
    /// `run-mismatch` at step 9).
    let participant: [String: String]
    /// As written. Their count, sizes and hash are checked at steps 9 and 11.
    let inputChunks: [String]

    var runId: String { run.runId }
}

/// A parsed payload, or the refusal its shape earns.
enum ParticipantParsed<Value> {
    case value(Value)
    case refused(HostRefusal)
}

enum ParticipantRequests {
    /// `participant.availability` takes exactly `{}`.
    static func availability(_ payload: [String: JSONValue]) -> HostRefusal? {
        payload.isEmpty ? nil : .unknownField
    }

    /// `participant.stop` and `participant.status`.
    static func runRead(_ payload: [String: JSONValue]) -> ParticipantParsed<ParticipantRunRead> {
        guard Set(payload.keys).isSubset(of: ParticipantRunRead.keys) else { return .refused(.unknownField) }
        guard let run = identities(payload) else { return .refused(.invalidIdentity) }
        guard distinct(run) else { return .refused(.invalidIdentity) }
        return .value(run)
    }

    /// `participant.events`.
    static func events(_ payload: [String: JSONValue]) -> ParticipantParsed<ParticipantEventsRead> {
        guard Set(payload.keys).isSubset(of: ParticipantEventsRead.keys) else { return .refused(.unknownField) }
        guard let run = identities(payload) else { return .refused(.invalidIdentity) }
        guard let afterSequence = payload["afterSequence"]?.safeIntegerValue,
              let maxEvents = payload["maxEvents"]?.safeIntegerValue,
              (1...ParticipantLimits.maxEvents).contains(maxEvents) else { return .refused(.malformedEnvelope) }
        guard distinct(run) else { return .refused(.invalidIdentity) }
        return .value(ParticipantEventsRead(run: run, afterSequence: afterSequence, maxEvents: maxEvents))
    }

    /// `participant.start`, in the same order: unknown keys; the five ids'
    /// presence and form (`workspaceHandle`, `runId`, `sessionId`,
    /// `userMessageId`, `assistantMessageId`); then `participant` (an
    /// object of exactly its four keys, each a string) and `inputChunks` (a
    /// list of strings), `malformed-envelope`; then the four run ids
    /// distinct ignoring case.
    static func start(_ payload: [String: JSONValue]) -> ParticipantParsed<ParticipantStartRequest> {
        guard Set(payload.keys).isSubset(of: ParticipantStartRequest.keys) else { return .refused(.unknownField) }
        guard let run = identities(payload), let userMessageId = ParticipantIds.runLike(payload["userMessageId"]),
              let assistantMessageId = ParticipantIds.runLike(payload["assistantMessageId"]) else { return .refused(.invalidIdentity) }
        guard let fields = payload["participant"]?.objectValue, Set(fields.keys) == ParticipantPin.keys else {
            return .refused(.malformedEnvelope)
        }
        var participant: [String: String] = [:]
        for (key, value) in fields {
            guard let text = value.stringValue else { return .refused(.malformedEnvelope) }
            participant[key] = text
        }
        guard case .array(let values)? = payload["inputChunks"] else { return .refused(.malformedEnvelope) }
        let inputChunks = values.compactMap(\.stringValue)
        guard inputChunks.count == values.count else { return .refused(.malformedEnvelope) }
        guard ParticipantIds.distinctIgnoringCase([run.runId, run.sessionId, userMessageId, assistantMessageId]) else {
            return .refused(.invalidIdentity)
        }
        return .value(ParticipantStartRequest(run: run, userMessageId: userMessageId, assistantMessageId: assistantMessageId,
                                              participant: participant, inputChunks: inputChunks))
    }

    /// Presence and form of the three ids, in the contract's order. Their
    /// distinctness is checked last, after every type.
    private static func identities(_ payload: [String: JSONValue]) -> ParticipantRunRead? {
        guard let workspaceHandle = payload["workspaceHandle"]?.opaqueStringValue,
              let runId = ParticipantIds.runLike(payload["runId"]),
              let sessionId = ParticipantIds.session(payload["sessionId"]) else { return nil }
        return ParticipantRunRead(workspaceHandle: workspaceHandle, runId: runId, sessionId: sessionId)
    }

    private static func distinct(_ run: ParticipantRunRead) -> Bool {
        ParticipantIds.distinctIgnoringCase([run.runId, run.sessionId])
    }
}
