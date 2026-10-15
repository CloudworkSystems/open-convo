import Foundation
import ParticipantProcess

/// Limits for one local run (contract sections 8, 15 and 20.4).
public struct LocalChatLimits: Equatable, Sendable {
    public var maxEventTextBytes = 16_384
    public var coalesceMillis: UInt64 = 250
    /// Context, input and output together (section 20.3 and Codex round 4
    /// on #38): the reply's budget is what context and input leave of this.
    public var maxContextInputOutputBytes = 262_144
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
    /// Bytes the reply may use: the shared bound less context and input.
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
    private var pendingSince: UInt64?
    private var acceptedOutputBytes = 0

    /// `contextBytes` and `inputBytes` are the prepared entry's (20.3, 20.5).
    public init(identity: ParticipantRunIdentity, contextBytes: Int, inputBytes: Int,
                limits: LocalChatLimits = .contract) {
        self.identity = identity
        self.limits = limits
        self.outputBudget = max(0, limits.maxContextInputOutputBytes - contextBytes - inputBytes)
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
            if !content.isEmpty {
                let left = outputBudget - acceptedOutputBytes
                if content.utf8.count > left {
                    // The longest scalar-aligned prefix that fits is accepted
                    // first, then the run ends `reply-too-long`.
                    var prefix = String.UnicodeScalarView()
                    var size = 0
                    for scalar in content.unicodeScalars {
                        let width = String(scalar).utf8.count
                        if size + width > left { break }
                        prefix.append(scalar)
                        size += width
                    }
                    accept(String(prefix), monotonic: now, wall: wall, into: &effects)
                    end(.failed(.replyTooLong), wall: wall, cancel: true, into: &effects)
                    return
                }
                accept(content, monotonic: now, wall: wall, into: &effects)
            }
        }
        if done {
            // Cancel too, so a peer that keeps the connection open can't hold
            // the run (and the next start) past its terminal.
            end(.completed, wall: wall, cancel: true, into: &effects)
        }
    }

    private mutating func accept(_ content: String, monotonic now: UInt64, wall: Int64, into effects: inout [Effect]) {
        guard !content.isEmpty else { return }
        acceptedOutputBytes += content.utf8.count
        if pending.isEmpty { pendingSince = now }
        pending += content
        if pending.utf8.count >= limits.maxEventTextBytes { flush(wall: wall, into: &effects) }
    }

    // MARK: Events

    /// Emits accepted text in chunks of at most `maxEventTextBytes`, cut
    /// between Unicode scalars (section 8).
    private mutating func flush(wall: Int64, into effects: inout [Effect]) {
        guard !pending.isEmpty else { pendingSince = nil; return }
        var chunk = String.UnicodeScalarView()
        var size = 0
        for scalar in pending.unicodeScalars {
            let width = String(scalar).utf8.count
            if size + width > limits.maxEventTextBytes {
                effects.append(.update(.event(emit(.text, text: String(chunk), wall: wall))))
                chunk = String.UnicodeScalarView()
                size = 0
            }
            chunk.append(scalar)
            size += width
        }
        if !chunk.isEmpty { effects.append(.update(.event(emit(.text, text: String(chunk), wall: wall)))) }
        pending = ""
        pendingSince = nil
    }

    /// Accepted text, then the one terminal, recorded with `groupCleared: true`.
    private mutating func end(_ terminal: ParticipantTerminal, wall: Int64, cancel: Bool, into effects: inout [Effect]) {
        guard terminalEvent == nil else { return }
        if startedEmitted { flush(wall: wall, into: &effects) }
        let event = emit(terminal.type, reason: terminal.reason, wall: wall)
        terminalEvent = event
        effects.append(.update(.terminal(event, groupCleared: true)))
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
