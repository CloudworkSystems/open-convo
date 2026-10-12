import DeskHost
import Foundation
import ParticipantSupervisorCore

/// The init values section 16's run records. Until that run exists they are
/// configuration, injected by the app build; the reader only compares.
public struct ParticipantInitExpectation: Equatable, Sendable {
    public var model: String
    public var slashCommands: [String]
    public var skills: [String]
    /// The recorded `plugins` array, compared exactly.
    public var plugins: JSONValue
    public var apiKeySource: String

    public init(model: String, slashCommands: [String], skills: [String], plugins: JSONValue, apiKeySource: String) {
        self.model = model
        self.slashCommands = slashCommands
        self.skills = skills
        self.plugins = plugins
        self.apiKeySource = apiKeySource
    }
}

/// Bounds and timings (contract sections 8, 11 and 15), in bytes and milliseconds.
public struct StreamJSONReaderLimits: Equatable, Sendable {
    public var maxLineBytes = 1_048_576
    public var maxStdoutBytes = 32 * 1_048_576
    public var maxStderrKeptBytes = 65_536
    public var maxEventTextBytes = 16_384
    public var coalesceMillis: UInt64 = 250
    public var maxInputPlusOutputBytes = 262_144
    public var maxProjectedRunBytes = 785_408
    public var initTimeoutMillis: UInt64 = 30_000
    public var quietTimeoutMillis: UInt64 = 120_000
    public var totalTimeoutMillis: UInt64 = 900_000
    /// After the supervisor reports the group's end, how long to wait for
    /// stdout EOF (bytes still in the pipe) before deciding from the exit.
    public var exitDecisionGraceMillis: UInt64 = 1_000

    public init() {}

    public static let contract = StreamJSONReaderLimits()
}

/// A fixed reason for whatever the CLI wrote to stderr. Only this, and a
/// byte count, is ever logged; the text itself is dropped.
public enum StderrReason: String, Sendable, CaseIterable {
    case none
    case signedOut = "signed-out"
    case rateLimited = "rate-limited"
    case network
    case unrecognized

    static func classify(_ bytes: [UInt8]) -> StderrReason {
        guard !bytes.isEmpty else { return .none }
        let text = String(decoding: bytes, as: UTF8.self).lowercased()
        func has(_ needles: [String]) -> Bool { needles.contains { text.contains($0) } }
        if has(["not logged in", "/login", "invalid api key", "authentication", "unauthorized", "oauth"]) {
            return .signedOut
        }
        if has(["rate limit", "usage limit", "429"]) { return .rateLimited }
        if has(["enotfound", "econnrefused", "econnreset", "etimedout", "network", "fetch failed"]) {
            return .network
        }
        return .unrecognized
    }
}

/// Turns one run's stream-json stdout, stderr and supervisor reports into
/// participant events (contract sections 8 and 11). Pure and synchronous:
/// every input carries the monotonic time in milliseconds, so tests drive it
/// with invented lines and an invented clock.
///
/// - Lines split on `\n` only (a U+2028 inside a JSON string is text), each
///   at most 1 MiB, 32 MiB in all; anything unreadable fails `process-error`.
/// - Only `text_delta`s of `text` content blocks become text; thinking and
///   every other block or delta are ignored.
/// - Init rule: pinned model, empty `tools` and `mcp_servers`, and
///   `slash_commands`, `skills`, `plugins` and `apiKeySource` equal to the
///   recorded values, else `process-error`. `started` follows a passing init.
/// - Overflow rule: text is held until a rate-limit message shows
///   `overageStatus` `rejected` with `isUsingOverage` and `overageInUse` not
///   true. Any other `overageStatus`, a true flag, or a result first fails
///   `paid-overflow`.
/// - Text events are 1-16,384 UTF-8 bytes, cut between scalars, emitted 250 ms
///   after the first unemitted byte, before the buffer passes 16,384 bytes,
///   on the result, or before any terminal. Input plus output stays within
///   262,144 bytes and the projected run within 785,408, else
///   `reply-too-long` after the longest prefix that fits. A success result
///   ends the text: a text delta after it fails `process-error`.
/// - Exactly one terminal, decided once and emitted when the supervisor
///   reports the group's end (`cleared`, `uncleared`, or the supervisor lost).
public struct StreamJSONReader {
    public enum Output: Equatable, Sendable {
        case started
        case text(String)
        case terminal(ParticipantTerminal, groupCleared: Bool?)
        /// Native decided to end the run: write `stop` to the supervisor.
        case sendStop
        /// A terminal recorded `groupCleared: false` and the group has since cleared.
        case groupClearedAfterTerminal
        /// The group is confirmed gone, or ownership is lost (supervisor gone
        /// and both output pipes at EOF): the busy guard may lift.
        case cleanupReleased
    }

    public struct Configuration: Equatable, Sendable {
        public var expectedInit: ParticipantInitExpectation
        /// UTF-8 bytes of the run's input.
        public var inputBytes: Int
        /// The prepared run's serialized size (section 6).
        public var preparedBytes: Int
        public var limits: StreamJSONReaderLimits

        public init(expectedInit: ParticipantInitExpectation, inputBytes: Int, preparedBytes: Int,
                    limits: StreamJSONReaderLimits = .contract) {
            self.expectedInit = expectedInit
            self.inputBytes = inputBytes
            self.preparedBytes = preparedBytes
            self.limits = limits
        }
    }

    private enum Decision: Equatable {
        case completed
        case stopped
        case failed(ParticipantFailureReason)
    }

    private enum GroupState: Equatable {
        case unknown
        case cleared
        case uncleared
        case lost
    }

    private let configuration: Configuration
    private var limits: StreamJSONReaderLimits { configuration.limits }

    public private(set) var initPassed = false
    public private(set) var overflowPassed = false
    public private(set) var terminal: ParticipantTerminal?
    /// Null until a terminal; then true, false, or null when nothing ran.
    public private(set) var groupCleared: Bool?
    public private(set) var cleanupReleased = false
    /// The control socket closed before `cleared`: the group can no longer be
    /// signalled, and ownership ends only when both output pipes reach EOF.
    public private(set) var supervisorLost = false
    /// UTF-8 bytes of text emitted so far.
    public private(set) var emittedTextBytes = 0
    public private(set) var stdoutBytes = 0
    public private(set) var stderrBytes = 0

    private var spawnedAt: UInt64?
    private var lastStdoutAt: UInt64?
    private var line: [UInt8] = []
    private var stdoutEOF = false
    private var stderrEOF = false
    private var stderrKept: [UInt8] = []
    private var blockTypes: [Int: String] = [:]
    private var held = ""
    private var heldBytes = 0
    /// Held text arrived past the whole output budget, so the run cannot fit.
    private var heldOverran = false
    private var pending = ""
    private var pendingBytes = 0
    private var pendingSince: UInt64?
    /// `preparedBytes` + 3 + Σ(escaped string bytes + 3) + 64, so far.
    private var projectedBytes: Int
    private var successResult = false
    private var exitStatus: Int32?
    private var groupState = GroupState.unknown
    private var groupStateAt: UInt64 = 0
    private var decision: Decision?
    private var spawnFailed = false

    public init(configuration: Configuration) {
        self.configuration = configuration
        projectedBytes = configuration.preparedBytes + 3 + 64
    }

    /// The fixed reason for stderr so far.
    public var stderrReason: StderrReason { StderrReason.classify(stderrKept) }

    /// The CLI's wait status once the supervisor reported it.
    public var cliExitStatus: Int32? { exitStatus }

    // MARK: Inputs

    public mutating func supervisor(_ message: SupervisorMessage, now: UInt64) -> [Output] {
        var out: [Output] = []
        switch message {
        case .spawned:
            if spawnedAt == nil {
                spawnedAt = now
                lastStdoutAt = now
            }
        case .spawnFailed:
            spawnFailed = true
            if decision == nil { decision = .failed(.processError) }
            emitTerminal(groupCleared: nil, into: &out)
            release(into: &out)
        case .exit(let status):
            if exitStatus == nil { exitStatus = status }
        case .cleared:
            if groupState != .lost {
                groupState = .cleared
                groupStateAt = now
                if terminal != nil {
                    // A terminal recorded `false` earlier; the group is gone now.
                    if groupCleared == false {
                        groupCleared = true
                        out.append(.groupClearedAfterTerminal)
                    }
                    release(into: &out)
                }
            }
        case .uncleared:
            if groupState == .unknown {
                groupState = .uncleared
                groupStateAt = now
            }
        }
        settle(now: now, into: &out)
        return out
    }

    /// The control socket closed. Before `cleared` (and after a spawn), the
    /// supervisor is lost: the run ends now with `groupCleared: false`, never
    /// later set true, and cleanup stays pending until both pipes reach EOF.
    public mutating func controlClosed(now: UInt64) -> [Output] {
        var out: [Output] = []
        guard groupState != .cleared, !spawnFailed, !cleanupReleased else { return out }
        supervisorLost = true
        groupState = .lost
        groupStateAt = now
        if terminal == nil {
            // A lost supervisor is a process error (a completed reply too: its
            // group's end is unknown), unless native had already decided a
            // failure (its reason, such as `paid-overflow`, is kept) or a Stop
            // is in progress (`stop-incomplete`, from `groupCleared: false`).
            if decision == nil || decision == .completed { decision = .failed(.processError) }
            emitAccepted(into: &out)
            emitTerminal(groupCleared: false, into: &out)
        }
        releaseIfPipesClosed(into: &out)
        return out
    }

    /// User Stop, lock, window close or quit. The caller has already written
    /// `stop`. Accepted text is emitted; held text is dropped.
    ///
    /// Once the supervisor has reported the CLI's exit 0, the CLI ended on
    /// its own before the Stop, which no longer changes how it ended: its
    /// stdout (which a control message can overtake) decides, `completed`
    /// with a success result, else `process-error`.
    public mutating func stopRequested(now: UInt64) -> [Output] {
        var out: [Output] = []
        guard terminal == nil, decision == nil else { return out }
        if exitStatus == 0 { return out }
        decision = .stopped
        emitAccepted(into: &out)
        settle(now: now, into: &out)
        return out
    }

    public mutating func consumeStdout(_ bytes: Data, now: UInt64) -> [Output] {
        var out: [Output] = []
        lastStdoutAt = now
        stdoutBytes += bytes.count
        guard decision == nil else { return out }   // ended: keep draining, read nothing
        guard stdoutBytes <= limits.maxStdoutBytes else {
            end(.processError, now: now, into: &out)
            return out
        }
        var start = bytes.startIndex
        while start < bytes.endIndex, decision == nil {
            if let newline = bytes[start...].firstIndex(of: 0x0A) {
                guard line.count + (newline - start) <= limits.maxLineBytes else {
                    end(.processError, now: now, into: &out)
                    return out
                }
                line.append(contentsOf: bytes[start..<newline])
                let complete = line
                line.removeAll(keepingCapacity: true)
                handleLine(complete, now: now, into: &out)
                start = newline + 1
            } else {
                guard line.count + (bytes.endIndex - start) <= limits.maxLineBytes else {
                    end(.processError, now: now, into: &out)
                    return out
                }
                line.append(contentsOf: bytes[start...])
                start = bytes.endIndex
            }
        }
        settle(now: now, into: &out)
        return out
    }

    /// The spawner's stdout bound was reached.
    public mutating func stdoutLimitReached(now: UInt64) -> [Output] {
        var out: [Output] = []
        end(.processError, now: now, into: &out)
        return out
    }

    public mutating func stdoutClosed(now: UInt64) -> [Output] {
        var out: [Output] = []
        if !stdoutEOF {
            stdoutEOF = true
            if decision == nil, !line.isEmpty {
                // A last line without its newline.
                let last = line
                line.removeAll()
                handleLine(last, now: now, into: &out)
            }
        }
        settle(now: now, into: &out)
        releaseIfPipesClosed(into: &out)
        return out
    }

    public mutating func consumeStderr(_ bytes: Data) {
        stderrBytes += bytes.count
        let room = limits.maxStderrKeptBytes - stderrKept.count
        if room > 0 { stderrKept.append(contentsOf: bytes.prefix(room)) }
    }

    public mutating func stderrClosed(now: UInt64) -> [Output] {
        var out: [Output] = []
        stderrEOF = true
        releaseIfPipesClosed(into: &out)
        return out
    }

    /// Timers: coalescing, the three timeouts and the exit-decision grace.
    public mutating func tick(now: UInt64) -> [Output] {
        var out: [Output] = []
        if decision == nil, exitStatus == nil, let spawnedAt {
            let quietSince = lastStdoutAt ?? spawnedAt
            if (!initPassed && now >= spawnedAt + limits.initTimeoutMillis)
                || now >= quietSince + limits.quietTimeoutMillis
                || now >= spawnedAt + limits.totalTimeoutMillis {
                end(.timeout, now: now, into: &out)
            }
        }
        if decision == nil, let since = pendingSince, now >= since + limits.coalesceMillis {
            if !emitPending(into: &out) { end(.replyTooLong, now: now, into: &out) }
        }
        settle(now: now, into: &out)
        return out
    }

    /// The earliest time `tick` has something to do, if any.
    public func nextDeadline() -> UInt64? {
        var deadlines: [UInt64] = []
        if decision == nil, let since = pendingSince { deadlines.append(since + limits.coalesceMillis) }
        if decision == nil, exitStatus == nil, let spawnedAt {
            if !initPassed { deadlines.append(spawnedAt + limits.initTimeoutMillis) }
            deadlines.append((lastStdoutAt ?? spawnedAt) + limits.quietTimeoutMillis)
            deadlines.append(spawnedAt + limits.totalTimeoutMillis)
        }
        if terminal == nil, groupState == .cleared, decision == nil {
            deadlines.append(groupStateAt + limits.exitDecisionGraceMillis)
        }
        return deadlines.min()
    }

    // MARK: Lines

    private mutating func handleLine(_ bytes: [UInt8], now: UInt64, into out: inout [Output]) {
        guard decision == nil else { return }
        if bytes.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) { return }
        guard let value = try? JSONValue.decode(Data(bytes)),
              case .object(let message) = value,
              case .string(let type)? = message["type"] else {
            end(.processError, now: now, into: &out)
            return
        }
        switch type {
        case "system":
            if message["subtype"] == .string("init") { handleInit(message, now: now, into: &out) }
        case "rate_limit_event":
            guard initPassed else { return end(.processError, now: now, into: &out) }
            handleRateLimit(message, now: now, into: &out)
        case "stream_event":
            guard initPassed else { return end(.processError, now: now, into: &out) }
            handleStreamEvent(message, now: now, into: &out)
        case "result":
            guard initPassed else { return end(.processError, now: now, into: &out) }
            handleResult(message, now: now, into: &out)
        case "assistant":
            // The whole message repeats the streamed deltas; text comes only from deltas.
            guard initPassed else { return end(.processError, now: now, into: &out) }
        default:
            break
        }
    }

    private mutating func handleInit(_ message: [String: JSONValue], now: UInt64, into out: inout [Output]) {
        let expected = configuration.expectedInit
        func strings(_ value: JSONValue?) -> [String]? {
            guard case .array(let items)? = value else { return nil }
            var result: [String] = []
            for item in items {
                guard case .string(let text) = item else { return nil }
                result.append(text)
            }
            return result
        }
        let passes = message["model"] == .string(expected.model)
            && message["tools"] == .array([])
            && message["mcp_servers"] == .array([])
            && strings(message["slash_commands"]) == expected.slashCommands
            && strings(message["skills"]) == expected.skills
            && message["plugins"] == expected.plugins
            && message["apiKeySource"] == .string(expected.apiKeySource)
        guard passes else { return end(.processError, now: now, into: &out) }
        if !initPassed {
            initPassed = true
            out.append(.started)
        }
    }

    private mutating func handleRateLimit(_ message: [String: JSONValue], now: UInt64, into out: inout [Output]) {
        guard case .object(let info)? = message["rate_limit_info"] else {
            return end(.processError, now: now, into: &out)
        }
        // "Not true": absent or false. Anything else counts as true.
        func notTrue(_ value: JSONValue?) -> Bool { value == nil || value == .bool(false) }
        guard notTrue(info["isUsingOverage"]), notTrue(info["overageInUse"]) else {
            return end(.paidOverflow, now: now, into: &out)
        }
        switch info["overageStatus"] {
        case nil:
            break   // Says nothing about overflow; text stays held.
        case .string("rejected")?:
            if !overflowPassed {
                overflowPassed = true
                let released = held
                let overran = heldOverran
                held = ""
                heldBytes = 0
                heldOverran = false
                accept(released, now: now, into: &out)
                if overran { end(.replyTooLong, now: now, into: &out) }
            }
        default:
            end(.paidOverflow, now: now, into: &out)
        }
    }

    private mutating func handleStreamEvent(_ message: [String: JSONValue], now: UInt64, into out: inout [Output]) {
        // A subagent's stream (tools are empty, so none is expected) is not the reply.
        if let parent = message["parent_tool_use_id"], parent != .null { return }
        guard case .object(let event)? = message["event"], case .string(let eventType)? = event["type"] else {
            return end(.processError, now: now, into: &out)
        }
        switch eventType {
        case "message_start":
            blockTypes.removeAll()
        case "content_block_start":
            guard let index = Self.integer(event["index"]),
                  case .object(let block)? = event["content_block"],
                  case .string(let blockType)? = block["type"] else {
                return end(.processError, now: now, into: &out)
            }
            blockTypes[index] = blockType
        case "content_block_delta":
            guard let index = Self.integer(event["index"]),
                  case .object(let delta)? = event["delta"],
                  case .string(let deltaType)? = delta["type"] else {
                return end(.processError, now: now, into: &out)
            }
            guard deltaType == "text_delta", blockTypes[index] == "text" else { return }
            guard case .string(let text)? = delta["text"] else {
                return end(.processError, now: now, into: &out)
            }
            receive(text, now: now, into: &out)
        default:
            break
        }
    }

    private mutating func handleResult(_ message: [String: JSONValue], now: UInt64, into out: inout [Output]) {
        guard overflowPassed else { return end(.paidOverflow, now: now, into: &out) }
        guard emitPending(into: &out) else { return end(.replyTooLong, now: now, into: &out) }
        if message["subtype"] == .string("success"), message["is_error"] == .bool(false) {
            successResult = true
        } else {
            end(.processError, now: now, into: &out)
        }
    }

    private static func integer(_ value: JSONValue?) -> Int? {
        guard case .number(let number)? = value, number >= 0, number < 1_000_000, number == number.rounded() else {
            return nil
        }
        return Int(number)
    }

    // MARK: Text

    private var outputBudget: Int {
        limits.maxInputPlusOutputBytes - configuration.inputBytes - emittedTextBytes
    }

    private mutating func receive(_ text: String, now: UInt64, into out: inout [Output]) {
        guard !text.isEmpty else { return }
        // The result ends the reply: text after it is outside the stream (and
        // means the CLI went on talking to the model), so the run ends.
        guard !successResult else { return end(.processError, now: now, into: &out) }
        guard overflowPassed else {
            // Held, never shown, until the overflow rule passes. More than the
            // whole budget can never be emitted, so no more is kept, and once a
            // delta is cut nothing after it is: what is released must be a
            // prefix of the reply.
            guard !heldOverran else { return }
            let room = max(0, limits.maxInputPlusOutputBytes - configuration.inputBytes - heldBytes)
            let kept = Self.prefix(of: text, maxBytes: room)
            held += kept.text
            heldBytes += kept.bytes
            if kept.bytes < text.utf8.count { heldOverran = true }
            return
        }
        accept(text, now: now, into: &out)
    }

    /// Adds accepted text to the buffer, emitting before it would pass 16,384 bytes.
    private mutating func accept(_ text: String, now: UInt64, into out: inout [Output]) {
        for scalar in text.unicodeScalars {
            guard decision == nil else { return }
            let size = UTF8.width(scalar)
            if pendingBytes + size > limits.maxEventTextBytes {
                guard emitPending(into: &out) else { return end(.replyTooLong, now: now, into: &out) }
            }
            if pendingSince == nil { pendingSince = now }
            pending.unicodeScalars.append(scalar)
            pendingBytes += size
        }
    }

    /// Emits the buffer as one text event, or its longest scalar-aligned
    /// prefix that keeps input plus output and the projected run within
    /// bounds. False when the bounds cut it (the caller ends `reply-too-long`).
    @discardableResult
    private mutating func emitPending(into out: inout [Output]) -> Bool {
        guard !pending.isEmpty else { return true }
        let text = pending
        pending = ""
        pendingBytes = 0
        pendingSince = nil
        let byteRoom = outputBudget
        let projectedRoom = limits.maxProjectedRunBytes - projectedBytes - 3
        var bytes = 0
        var escaped = 2
        var cut = text.unicodeScalars.endIndex
        var index = text.unicodeScalars.startIndex
        while index < text.unicodeScalars.endIndex {
            let scalar = text.unicodeScalars[index]
            let size = UTF8.width(scalar)
            let escapedSize = Self.escapedWidth(scalar)
            if bytes + size > byteRoom || escaped + escapedSize > projectedRoom {
                cut = index
                break
            }
            bytes += size
            escaped += escapedSize
            index = text.unicodeScalars.index(after: index)
        }
        if bytes > 0 {
            let emitted = cut == text.unicodeScalars.endIndex ? text : String(text.unicodeScalars[..<cut])
            out.append(.text(emitted))
            emittedTextBytes += bytes
            projectedBytes += escaped + 3
        }
        return cut == text.unicodeScalars.endIndex
    }

    /// Emits accepted text before an end; held text is dropped.
    private mutating func emitAccepted(into out: inout [Output]) {
        if overflowPassed { emitPending(into: &out) }
        pending = ""
        pendingBytes = 0
        pendingSince = nil
        held = ""
        heldBytes = 0
        heldOverran = false
    }

    /// Bytes `JSON.stringify` writes for one scalar inside a string.
    static func escapedWidth(_ scalar: Unicode.Scalar) -> Int {
        switch scalar {
        case "\"", "\\", "\n", "\r", "\t", "\u{08}", "\u{0C}": return 2
        default: return scalar.value < 0x20 ? 6 : UTF8.width(scalar)
        }
    }

    /// The longest scalar-aligned prefix of at most `maxBytes` UTF-8 bytes.
    static func prefix(of text: String, maxBytes: Int) -> (text: String, bytes: Int) {
        var bytes = 0
        var result = ""
        for scalar in text.unicodeScalars {
            let size = UTF8.width(scalar)
            if bytes + size > maxBytes { break }
            result.unicodeScalars.append(scalar)
            bytes += size
        }
        return (result, bytes)
    }

    // MARK: Ending

    /// Native decided to end the run: emit accepted text, drop the rest, and
    /// have the supervisor run the stop sequence. The terminal follows the
    /// group's end.
    private mutating func end(_ reason: ParticipantFailureReason, now: UInt64, into out: inout [Output]) {
        guard decision == nil else { return }
        decision = .failed(reason)
        emitAccepted(into: &out)
        line.removeAll()
        if groupState == .unknown { out.append(.sendStop) }
        settle(now: now, into: &out)
    }

    /// Decides from the exit once stdout has drained (or cannot), and emits
    /// the terminal once the group's end is known and a decision exists.
    private mutating func settle(now: UInt64, into out: inout [Output]) {
        guard terminal == nil, !spawnFailed else { return }
        let groupEnded = groupState == .cleared || groupState == .uncleared
        if decision == nil, groupState != .lost {
            // Bytes written before the exit may still be in the pipe: wait for
            // EOF, unless members survive (they may hold it open) or the grace
            // after `cleared` is over.
            let graceOver = groupState == .cleared && now >= groupStateAt + limits.exitDecisionGraceMillis
            if exitStatus != nil, stdoutEOF || groupState == .uncleared || graceOver {
                decision = exitStatus == 0 && successResult ? .completed : .failed(.processError)
                emitAccepted(into: &out)
            } else if exitStatus == nil, groupState == .uncleared || graceOver {
                decision = .failed(.processError)
                emitAccepted(into: &out)
            }
        }
        guard groupEnded, decision != nil else { return }
        let cleared = groupState == .cleared
        emitTerminal(groupCleared: cleared, into: &out)
        if cleared { release(into: &out) }
    }

    private mutating func emitTerminal(groupCleared cleared: Bool?, into out: inout [Output]) {
        guard terminal == nil, let decision else { return }
        let value: ParticipantTerminal
        switch decision {
        case .completed: value = .completed
        case .stopped: value = .stopped(cleared == false ? .stopIncomplete : .localStop)
        case .failed(let reason): value = .failed(reason)
        }
        terminal = value
        groupCleared = cleared
        out.append(.terminal(value, groupCleared: cleared))
    }

    private mutating func release(into out: inout [Output]) {
        guard !cleanupReleased else { return }
        cleanupReleased = true
        out.append(.cleanupReleased)
    }

    private mutating func releaseIfPipesClosed(into out: inout [Output]) {
        if groupState == .lost, stdoutEOF, stderrEOF { release(into: &out) }
    }
}
