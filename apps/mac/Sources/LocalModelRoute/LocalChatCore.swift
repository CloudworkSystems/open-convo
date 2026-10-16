import Foundation
import ParticipantProcess

/// Limits for one local run (contract sections 8, 15 and 20.4).
public struct LocalChatLimits: Equatable, Sendable {
    public var maxEventTextBytes = 16_384
    public var coalesceMillis: UInt64 = 250
    /// Context, input and output together (section 20.3 and Codex round 4
    /// on #38): the reply's budget is what context and input leave of this.
    public var maxContextInputOutputBytes = 262_144
    /// The open run's canonical JSON as the page saves it (sections 8 and
    /// 15): the prepared run plus every text event's escaped string, as
    /// `StreamJSONReader` projects it (Codex round 3 on #42).
    public var maxProjectedRunBytes = 785_408
    /// One streamed line from Ollama.
    public var maxLineBytes = 1_048_576
    public var firstByteTimeoutMillis: UInt64 = 30_000
    public var quietTimeoutMillis: UInt64 = 120_000
    public var totalTimeoutMillis: UInt64 = 900_000

    public init() {}
    public static let contract = LocalChatLimits()
}

/// How the HTTP request ended, as the transport saw it.
public enum LocalChatFinish: Equatable, Sendable {
    /// The connection closed normally.
    case closed
    /// A redirect was refused (section 20.1).
    case redirectRefused
    /// A transport error (connection refused, dropped, timed out underneath).
    case failed
    /// Native cancelled it (Stop or its own decision); expected after a terminal.
    case cancelled
}

/// The pure part of one local run: Ollama's streaming `/api/chat` reply in,
/// section 8 events out. It owns no clock, timer or connection; every input
/// carries monotonic and wall milliseconds and every answer is a list of
/// effects for the caller to carry out in order. `LocalChatRun` drives it
/// over HTTP; tests drive it on an invented clock.
public struct LocalChatCore {
    public enum Effect: Equatable, Sendable {
        case update(ParticipantRunUpdate)
        /// Cancel the HTTP request (native ended the run or Stop asked).
        case cancelRequest
    }

    public let identity: ParticipantRunIdentity
    private let limits: LocalChatLimits
    /// UTF-8 bytes the reply may use: the shared bound less context and
    /// input.
    private let outputBudget: Int

    private var sequence = 0
    private var lastAtMillis: Int64
    private var terminalEvent: ParticipantEvent?
    private var startedEmitted = false
    private var requestSentAt: UInt64?
    private var lastBytesAt: UInt64?
    private var responseSeen = false
    private var lineBuffer: [UInt8] = []
    private var pending = ""
    private var pendingBytes = 0
    /// `StreamJSONReader.escapedWidth` summed over `pending`, without its
    /// quotes.
    private var pendingEscapedBytes = 0
    private var pendingSince: UInt64?
    private var acceptedOutputBytes = 0
    /// `preparedBytes` + 3 + Σ(escaped event text + 2 quotes + 3) + 64, so
    /// far: the saved run's projected canonical size, `StreamJSONReader`'s
    /// formula exactly.
    private var projectedBytes: Int

    /// `contextBytes`, `inputBytes` and `preparedBytes` are the prepared
    /// entry's (sections 6, 20.3 and 20.5). A reply ends `reply-too-long`
    /// after the longest prefix that keeps both bounds: context, input and
    /// output within 262,144 UTF-8 bytes, and the saved run's canonical JSON,
    /// with the reply's escapes, within 785,408.
    public init(identity: ParticipantRunIdentity, contextBytes: Int, inputBytes: Int, preparedBytes: Int,
                limits: LocalChatLimits = .contract) {
        self.identity = identity
        self.limits = limits
        self.outputBudget = max(0, limits.maxContextInputOutputBytes - contextBytes - inputBytes)
        self.projectedBytes = preparedBytes + 3 + 64
        self.lastAtMillis = identity.createdAtMillis
    }

    /// No process group: a terminal always records `groupCleared: true` (the
    /// HTTP task finished or was cancelled and no more bytes are accepted),
    /// and cleanup is released with it (section 20.4).
    public var snapshot: ParticipantRunSnapshot {
        ParticipantRunSnapshot(lastSequence: sequence, terminal: terminalEvent,
                               groupCleared: terminalEvent == nil ? nil : true,
                               cleanup: terminalEvent == nil ? .owned : .released)
    }

    public var isFinished: Bool { terminalEvent != nil }

    public func nextDeadline() -> UInt64? {
        guard terminalEvent == nil, let sent = requestSentAt else { return nil }
        var deadlines = [sent + limits.totalTimeoutMillis]
        if !responseSeen { deadlines.append(sent + limits.firstByteTimeoutMillis) }
        if let last = lastBytesAt { deadlines.append(last + limits.quietTimeoutMillis) }
        if let since = pendingSince { deadlines.append(since + limits.coalesceMillis) }
        return deadlines.min()
    }

    // MARK: Inputs

    public mutating func requestSent(monotonic now: UInt64) {
        if requestSentAt == nil { requestSentAt = now }
    }

    /// The response's status line. Only 200 starts the run.
    public mutating func response(status: Int, monotonic now: UInt64, wall: Int64) -> [Effect] {
        guard terminalEvent == nil, !responseSeen else { return [] }
        responseSeen = true
        lastBytesAt = now
        var effects: [Effect] = []
        if status == 200 {
            startedEmitted = true
            effects.append(.update(.event(emit(.started, wall: wall))))
        } else {
            end(.failed(.processError), wall: wall, cancel: true, into: &effects)
        }
        return effects
    }

    /// Response body bytes: newline-delimited JSON objects.
    public mutating func bytes(_ data: [UInt8], monotonic now: UInt64, wall: Int64) -> [Effect] {
        guard terminalEvent == nil, startedEmitted else { return [] }
        lastBytesAt = now
        var effects: [Effect] = []
        for byte in data {
            if terminalEvent != nil { break }
            if byte == 0x0A {
                let line = lineBuffer
                lineBuffer.removeAll(keepingCapacity: true)
                handleLine(line, monotonic: now, wall: wall, into: &effects)
            } else {
                lineBuffer.append(byte)
                if lineBuffer.count > limits.maxLineBytes {
                    end(.failed(.processError), wall: wall, cancel: true, into: &effects)
                }
            }
        }
        return effects
    }

    /// The request ended. Without a terminal this is a failure: a reply
    /// that ends without `done: true` is incomplete.
    public mutating func finished(_ how: LocalChatFinish, monotonic now: UInt64, wall: Int64) -> [Effect] {
        guard terminalEvent == nil else { return [] }
        var effects: [Effect] = []
        // A last line without its newline still counts.
        if !lineBuffer.isEmpty, how == .closed {
            let line = lineBuffer
            lineBuffer.removeAll()
            handleLine(line, monotonic: now, wall: wall, into: &effects)
        }
        if terminalEvent == nil { end(.failed(.processError), wall: wall, cancel: false, into: &effects) }
        return effects
    }

    /// User Stop, lock, Desk close or quit (section 14): accepted text first,
    /// then `stopped` `local-stop`; the request is cancelled.
    public mutating func stopRequested(monotonic now: UInt64, wall: Int64) -> [Effect] {
        guard terminalEvent == nil else { return [] }
        var effects: [Effect] = []
        end(.stopped(.localStop), wall: wall, cancel: true, into: &effects)
        return effects
    }

    /// Timers: coalescing and the three timeouts.
    public mutating func tick(monotonic now: UInt64, wall: Int64) -> [Effect] {
        guard terminalEvent == nil, let sent = requestSentAt else { return [] }
        var effects: [Effect] = []
        if now >= sent + limits.totalTimeoutMillis
            || (!responseSeen && now >= sent + limits.firstByteTimeoutMillis)
            || (lastBytesAt.map { now >= $0 + limits.quietTimeoutMillis } ?? false) {
            end(.failed(.timeout), wall: wall, cancel: true, into: &effects)
            return effects
        }
        if let since = pendingSince, now >= since + limits.coalesceMillis {
            flush(wall: wall, into: &effects)
        }
        return effects
    }

    // MARK: Lines

    private mutating func handleLine(_ line: [UInt8], monotonic now: UInt64, wall: Int64, into effects: inout [Effect]) {
        // A blank line is not an object either (Codex round 2 on #42): it
        // falls through to the JSON check below and fails.
        guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
              object["error"] == nil else {
            end(.failed(.processError), wall: wall, cancel: true, into: &effects)
            return
        }
        // Every line is `{message?, done}` (Codex round 1 on #42): `done` is
        // always a Bool, and a line that isn't done carries a message.
        // A real JSON Boolean only: `as? Bool` would also accept 0 and 1.
        guard let doneValue = object["done"], CFGetTypeID(doneValue as CFTypeRef) == CFBooleanGetTypeID(),
              let done = doneValue as? Bool else {
            end(.failed(.processError), wall: wall, cancel: true, into: &effects)
            return
        }
        if object["message"] != nil || !done {
            guard let message = object["message"] as? [String: Any], let content = message["content"] as? String else {
                end(.failed(.processError), wall: wall, cancel: true, into: &effects)
                return
            }
            accept(content, monotonic: now, wall: wall, into: &effects)
            // The longest prefix that fits was accepted, then the run ended.
            if terminalEvent != nil { return }
        }
        if done {
            // Cancel too, so a peer that keeps the connection open can't hold
            // the run (and the next start) past its terminal.
            end(.completed, wall: wall, cancel: true, into: &effects)
        }
    }

    /// Accepts the reply scalar by scalar, as `StreamJSONReader.accept`
    /// does: an event is emitted before it would pass 16,384 bytes, and the
    /// first scalar that cannot fit either bound ends the run
    /// `reply-too-long` with the text before it emitted (sections 8 and 15).
    /// Escapes count: a quote, backslash or control character takes 2 or 6
    /// bytes in the saved run, other scalars their UTF-8 width.
    private mutating func accept(_ content: String, monotonic now: UInt64, wall: Int64, into effects: inout [Effect]) {
        for scalar in content.unicodeScalars {
            let size = UTF8.width(scalar)
            if pendingBytes + size > limits.maxEventTextBytes { flush(wall: wall, into: &effects) }
            let escapedSize = StreamJSONReader.escapedWidth(scalar)
            if acceptedOutputBytes + size > outputBudget || 2 + pendingEscapedBytes + escapedSize > projectedRoom {
                end(.failed(.replyTooLong), wall: wall, cancel: true, into: &effects)
                return
            }
            if pending.isEmpty { pendingSince = now }
            pending.unicodeScalars.append(scalar)
            pendingBytes += size
            pendingEscapedBytes += escapedSize
            acceptedOutputBytes += size
        }
        if pendingBytes >= limits.maxEventTextBytes { flush(wall: wall, into: &effects) }
    }

    /// Escaped bytes one more text event may still add to the projected run.
    private var projectedRoom: Int {
        limits.maxProjectedRunBytes - projectedBytes - 3
    }

    // MARK: Events

    /// Emits accepted text as one event: `accept` keeps it within
    /// `maxEventTextBytes`, cut between Unicode scalars, and within both
    /// bounds (section 8).
    private mutating func flush(wall: Int64, into effects: inout [Effect]) {
        defer {
            pending = ""
            pendingBytes = 0
            pendingEscapedBytes = 0
            pendingSince = nil
        }
        guard !pending.isEmpty else { return }
        effects.append(.update(.event(emit(.text, text: pending, wall: wall))))
        projectedBytes += pendingEscapedBytes + 2 + 3
    }

    /// Accepted text, then the one terminal, recorded with `groupCleared: true`,
    /// then cleanup released.
    private mutating func end(_ terminal: ParticipantTerminal, wall: Int64, cancel: Bool, into effects: inout [Effect]) {
        guard terminalEvent == nil else { return }
        if startedEmitted { flush(wall: wall, into: &effects) }
        let event = emit(terminal.type, reason: terminal.reason, wall: wall)
        terminalEvent = event
        effects.append(.update(.terminal(event, groupCleared: true)))
        // No process group to wait for: cleanup is released with the
        // terminal, so the coordinator's busy rule (section 7 step 12) ends
        // once the updates end and the terminal is durable (step 3 PR 3c).
        effects.append(.update(.cleanupReleased))
        if cancel { effects.append(.cancelRequest) }
    }

    private mutating func emit(_ type: ParticipantEventType, text: String? = nil, reason: String? = nil,
                               wall: Int64) -> ParticipantEvent {
        sequence += 1
        lastAtMillis = ParticipantEventTime.atMillis(wall: wall, previous: lastAtMillis, createdAt: identity.createdAtMillis)
        return ParticipantEvent(runId: identity.runId, sessionId: identity.sessionId, sequence: sequence,
                                at: ParticipantTimestamp.format(millis: lastAtMillis), type: type, text: text, reason: reason)
    }
}
