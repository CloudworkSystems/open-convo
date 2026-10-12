import DeskHost
import ParticipantProcess

// `participant.events` (`docs/desk-native-participant-contract.md` section 9):
// what this launch keeps of a run's events, and how one page is cut from it.
// Event text lives only here, in memory, never on disk or in a log.

/// Why the event a page asks for is gone (section 9's `lost.reason`).
enum ParticipantLostReason: String, Sendable, CaseIterable {
    case locked
    case closed
    case restarted
    case replaced
}

/// The current or most recent run's events, as this launch keeps them: one
/// run only. Its text stays until lock (`locked`), window close (`closed`)
/// or another run's start (`replaced`); reload and a web content crash keep
/// it. Quit and crash lose it (`restarted`, decided by the next launch,
/// which holds nothing). A recorded terminal is never gone: it comes from
/// the run's entry, not from here.
struct RetainedRun: Equatable, Sendable {
    /// What dropped this run's earlier events, and the last sequence
    /// dropped (nil when not known).
    struct Loss: Equatable, Sendable {
        let reason: ParticipantLostReason
        let throughSequence: Int?
    }

    /// The retained text a run may hold at most (section 9: 256 KiB). Input
    /// plus output is at most 262,144 bytes, so a run's text always fits.
    static let maxTextBytes = 262_144

    let runId: String
    let sessionId: String
    /// Contiguous and ascending, each with this run's ids.
    let events: [ParticipantEvent]
    /// The highest sequence assigned to the run this launch.
    let lastSequence: Int
    let lost: Loss?

    /// Nil unless the events belong to this run, rise by one from their
    /// first, end at or before `lastSequence`, and hold at most
    /// `maxTextBytes` of text; and a loss names a sequence before the first
    /// retained one.
    init?(runId: String, sessionId: String, events: [ParticipantEvent], lastSequence: Int, lost: Loss?) {
        guard ParticipantIds.runLike(.string(runId)) != nil, ParticipantIds.session(.string(sessionId)) != nil,
              lastSequence >= 0, lastSequence <= ProofLimits.maxSafeInteger,
              events.allSatisfy({ $0.runId == runId && ParticipantPin.sameBytes($0.sessionId, sessionId) }),
              zip(events, events.dropFirst()).allSatisfy({ $0.sequence + 1 == $1.sequence }),
              (events.last?.sequence ?? 0) <= lastSequence,
              events.reduce(0, { $0 + ($1.text?.utf8.count ?? 0) }) <= Self.maxTextBytes else { return nil }
        if let lost, let through = lost.throughSequence {
            guard through >= 1, through <= lastSequence, through < (events.first?.sequence ?? Int.max) else { return nil }
        }
        self.runId = runId
        self.sessionId = sessionId
        self.events = events
        self.lastSequence = lastSequence
        self.lost = lost
    }

    /// A run of this launch whose start record just became durable: nothing
    /// assigned yet (section 9: its start replaces the previous run's
    /// events, Codex Q30).
    static func started(runId: String, sessionId: String) -> RetainedRun? {
        RetainedRun(runId: runId, sessionId: sessionId, events: [], lastSequence: 0, lost: nil)
    }

    /// This run with `event` added as its next one: nil unless it is this
    /// run's and numbered `lastSequence + 1`, and the text still fits.
    func appending(_ event: ParticipantEvent) -> RetainedRun? {
        guard event.runId == runId, ParticipantPin.sameBytes(event.sessionId, sessionId), event.sequence == lastSequence + 1 else {
            return nil
        }
        return RetainedRun(runId: runId, sessionId: sessionId, events: events + [event], lastSequence: event.sequence, lost: lost)
    }

    /// This run with its event text gone for `reason` (lock or window
    /// close: section 9; Codex Q21, S7): every retained event but a
    /// terminal (never lost, and text-free) is dropped, and the loss
    /// reaches the last one dropped. Only text-free numbers stay. With
    /// nothing to drop, it is unchanged. Should that reduced run ever be
    /// refused (it cannot be while the invariants of `init` hold), it fails
    /// closed: no event is kept at all, never the text.
    func droppingText(_ reason: ParticipantLostReason) -> RetainedRun {
        guard let last = events.last(where: { $0.terminal == nil }) else { return self }
        let kept = events.filter { $0.terminal != nil }
        return RetainedRun(runId: runId, sessionId: sessionId, events: kept, lastSequence: lastSequence,
                           lost: Loss(reason: reason, throughSequence: last.sequence))
            ?? RetainedRun(textFree: self, reason: reason)
    }

    /// `run` with no event kept and the loss's end unknown: the fail-closed
    /// form of `droppingText`. Its ids and `lastSequence` passed `init`
    /// already, and an empty list with an open-ended loss meets every
    /// other condition, so it needs no check.
    private init(textFree run: RetainedRun, reason: ParticipantLostReason) {
        runId = run.runId
        sessionId = run.sessionId
        events = []
        lastSequence = run.lastSequence
        lost = Loss(reason: reason, throughSequence: nil)
    }

    /// `event`, this run's next one, while no text is kept (lock or window
    /// close under way): earlier text is dropped as `droppingText` drops
    /// it, a terminal is kept, and any other event is only counted, lost
    /// for `reason` with its text never kept. Nil unless it is this run's
    /// next one.
    func addingWithoutText(_ event: ParticipantEvent, reason: ParticipantLostReason) -> RetainedRun? {
        guard event.runId == runId, ParticipantPin.sameBytes(event.sessionId, sessionId), event.sequence == lastSequence + 1 else {
            return nil
        }
        let base = droppingText(reason)
        if event.terminal != nil { return base.appending(event) }
        return RetainedRun(runId: runId, sessionId: sessionId, events: [], lastSequence: event.sequence,
                           lost: Loss(reason: reason, throughSequence: event.sequence))
    }
}

/// One `participant.events` answer: its `ok` fields after `runId`.
struct ParticipantEventsAnswer: Equatable, Sendable {
    struct Lost: Equatable, Sendable {
        let fromSequence: Int
        let throughSequence: Int?
        let reason: ParticipantLostReason
    }

    let events: [ParticipantEvent]
    let more: Bool
    let lastSequence: Int?
    let lost: Lost?
    let terminal: ParticipantEvent?

    /// Exactly `runId, events, more, lastSequence, lost, terminal`, nulls
    /// written out.
    func fields(runId: String) -> [String: JSONValue] {
        [
            "runId": .string(runId),
            "events": .array(events.map(\.jsonValue)),
            "more": .bool(more),
            "lastSequence": lastSequence.map { .number(Double($0)) } ?? .null,
            "lost": lost.map {
                .object([
                    "fromSequence": .number(Double($0.fromSequence)),
                    "throughSequence": $0.throughSequence.map { .number(Double($0)) } ?? .null,
                    "reason": .string($0.reason.rawValue)
                ])
            } ?? .null,
            "terminal": terminal?.jsonValue ?? .null
        ]
    }
}

/// What native knows of one run's events when a page is asked for: the
/// retained events, the recorded terminal and the high-water mark.
struct ParticipantEventSource: Sendable {
    /// Contiguous retained events (possibly none).
    let retained: [ParticipantEvent]
    /// The recorded terminal, rebuilt from the run's entry: never gone.
    let recordedTerminal: ParticipantEvent?
    /// Highest assigned this launch or recorded as a terminal; nil when
    /// unknown (a restart without a terminal).
    let lastSequence: Int?
    /// Why an event that is not here is gone.
    let lossReason: ParticipantLostReason

    /// The page after `afterSequence` (section 9; Codex Q24):
    /// - at or past `lastSequence`: no events, no loss;
    /// - at the largest safe integer, with `lastSequence` unknown: no events,
    ///   no loss, since no representable event can follow (Codex S7 R1);
    /// - the next event known (retained, or the recorded terminal itself):
    ///   the known events from it, contiguous, at most `maxEvents`, stopping
    ///   before the reply's canonical JSON would pass 1,048,576 bytes but
    ///   always at least one; `more` exactly when known events remain;
    /// - otherwise the next event is gone: `lost` from it through the
    ///   recorded terminal's sequence minus one (null without one), no
    ///   events, and that terminal. A terminal immediately after
    ///   `afterSequence` is returned as an event, never as a zero-length
    ///   loss.
    ///
    /// `replyBytes` measures the whole reply's canonical JSON for an answer;
    /// it is called once, for the answer with no events.
    func answer(afterSequence: Int, maxEvents: Int, replyBytes: (ParticipantEventsAnswer) -> Int) -> ParticipantEventsAnswer {
        if let last = lastSequence, afterSequence >= last {
            return ParticipantEventsAnswer(events: [], more: false, lastSequence: last, lost: nil, terminal: nil)
        }
        // No representable event follows the largest legal cursor, so there
        // is nothing to return and nothing lost (a `fromSequence` past it
        // would fail the page's safe-integer check).
        guard afterSequence < ProofLimits.maxSafeInteger else {
            return ParticipantEventsAnswer(events: [], more: false, lastSequence: lastSequence, lost: nil, terminal: nil)
        }
        var known: [Int: ParticipantEvent] = [:]
        for event in retained { known[event.sequence] = event }
        if let recordedTerminal { known[recordedTerminal.sequence] = recordedTerminal }
        let next = afterSequence + 1
        guard known[next] != nil else {
            return ParticipantEventsAnswer(
                events: [], more: false, lastSequence: lastSequence,
                lost: .init(fromSequence: next, throughSequence: recordedTerminal.map { $0.sequence - 1 }, reason: lossReason),
                terminal: recordedTerminal)
        }
        var available: [ParticipantEvent] = []
        var sequence = next
        while let event = known[sequence] {
            available.append(event)
            sequence += 1
        }

        // Canonical JSON is compositional: an array of n events adds each
        // event's own bytes and n - 1 commas, and `more: true` is one byte
        // shorter than `more: false`.
        let limit = ParticipantLimits.eventsReplyBytes
        let empty = replyBytes(ParticipantEventsAnswer(events: [], more: false, lastSequence: lastSequence, lost: nil, terminal: nil))
        func size(_ index: Int) -> Int { available[index].jsonValue.canonicalData().count }
        func bytes(taking count: Int, total: Int) -> Int { total - (count < available.count ? 1 : 0) }
        let most = min(maxEvents, available.count)
        var taken = 1
        var total = empty + size(0)
        while taken < most {
            let candidate = total + 1 + size(taken)
            guard bytes(taking: taken + 1, total: candidate) <= limit else { break }
            total = candidate
            taken += 1
        }
        return ParticipantEventsAnswer(events: Array(available.prefix(taken)), more: taken < available.count,
                                       lastSequence: lastSequence, lost: nil, terminal: nil)
    }
}
