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
///   `reply-too-long` after the longest prefix that fits, decided when the
///   accepted text that cannot fit arrives. A success result
///   ends the text: a text delta after it fails `process-error`.
/// - Exactly one terminal, decided once and emitted when the supervisor
///   reports the group's end (`cleared`, `uncleared`, or the supervisor lost).
/// - Overflow observation (section 17), apart from the terminal: once per
///   run, with any `paid-overflow` end; for a rate-limit line failing the
///   overflow rule before init (which still ends `process-error`); for such
///   a line complete in stdout after another end was decided (which keeps
///   its terminal); or conservatively when stdout cannot be read to its EOF
///   (a bound, the spawner's limit, a failed read, or no EOF at all).
public struct StreamJSONReader {
    public enum Output: Equatable, Sendable {
        case started
        case text(String)
        case terminal(ParticipantTerminal, groupCleared: Bool?)
        /// Paid overflow may have been in use (section 17): a confirmation
        /// that paid usage is off ends. Not an event and never on the wire;
        /// it changes no text, sequence or terminal. At most once per run:
        /// with a `paid-overflow` decision; for a rate-limit message failing
        /// the overflow rule before init (the run still ends
        /// `process-error`); for such a message in a complete stdout line
        /// after another decision (later lines are read only for this,
        /// within the line and stdout bounds, until it is seen); or,
        /// conservatively, when reading must stop before stdout's EOF (a
        /// bound passed, the spawner's stdout limit, a failed read, or the
        /// updates finishing without that EOF). Nothing more is read from
        /// stdout once it is out.
        case overflowObserved
        /// Native decided to end the run: write `stop` to the supervisor.
        case sendStop
        /// A terminal recorded `groupCleared: false` and the group has since cleared.
        case groupClearedAfterTerminal
        /// After a terminal recorded `groupCleared: false` (uncleared), a
        /// cleanup retry (a `stop` while uncleared: one SIGKILL and a 2 s
        /// probe) cannot clear the group now: the supervisor reported
        /// `uncleared` again (members left), or it was lost (nothing can be
        /// signalled; cleanup waits for both pipes' EOF, which a failed
        /// read never gives, and when the loss finds both already at EOF,
        /// `cleanupReleased` comes instead).
        /// `groupCleared` stays false and nothing is recorded; it lets a
        /// waiting Stop answer `cleanup-pending`. The supervisor's periodic
        /// re-probe never reports; its one other repeat is the last report as
        /// it exits after the app is gone, which only a test seam keeping the
        /// app alive sees.
        case cleanupRetryUncleared
        /// The group is confirmed gone, or ownership is lost (supervisor gone
        /// and both output pipes at a real EOF, not a failed read): the busy
        /// guard may lift.
        case cleanupReleased
    }

    public struct Configuration: Equatable, Sendable {
        public var expectedInit: ParticipantInitExpectation
        /// UTF-8 bytes of the run's input, an off-Mac run's context
        /// included (sections 8 and 21.4).
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
    /// `overflowObserved` went out; stdout is no longer read.
    public private(set) var overflowObserved = false
    public private(set) var terminal: ParticipantTerminal?
    /// Null until a terminal; then true, false, or null when nothing ran.
    public private(set) var groupCleared: Bool?
    public private(set) var cleanupReleased = false
    /// The control socket closed before `cleared`: the group can no longer be
    /// signalled, and ownership ends only when both output pipes reach EOF
    /// (never after a failed read on either).
    public private(set) var supervisorLost = false
    /// UTF-8 bytes of text emitted so far.
    public private(set) var emittedTextBytes = 0
    public private(set) var stdoutBytes = 0
    public private(set) var stderrBytes = 0

    private var spawnedAt: UInt64?
    private var lastStdoutAt: UInt64?
    private var line: [UInt8] = []
    /// Read to a real EOF: no process holds a write end any more.
    private var stdoutEOF = false
    private var stderrEOF = false
    /// Reading ended on a failed read: not EOF, and no proof about writers.
    private var stdoutFailed = false
    private var stderrFailed = false
    private var stderrKept: [UInt8] = []
    private var blockTypes: [Int: String] = [:]
    private var held = ""
    private var heldBytes = 0
    /// Held text arrived past the whole output budget, so the run cannot fit.
    private var heldOverran = false
    private var pending = ""
    private var pendingBytes = 0
    /// `escapedWidth` summed over `pending`, without its quotes.
    private var pendingEscapedBytes = 0
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
            } else if groupState == .uncleared, terminal != nil, !spawnFailed {
                // Only after a terminal with `groupCleared: false`: a spawn
                // failure has no group to retry.
                out.append(.cleanupRetryUncleared)
            }
        }
        settle(now: now, into: &out)
        return out
    }

    /// The control socket closed. Before `cleared` (and after a spawn), the
    /// supervisor is lost: the run ends now with `groupCleared: false`, never
    /// later set true, and cleanup stays pending until both pipes reach EOF
    /// (for good, after a failed read on either).
    /// After an uncleared terminal, no cleanup retry can finish: unless
    /// cleanup is released at once, this is `cleanupRetryUncleared`.
    public mutating func controlClosed(now: UInt64) -> [Output] {
        var out: [Output] = []
        guard groupState != .cleared, !spawnFailed, !cleanupReleased else { return out }
        let afterUnclearedTerminal = terminal != nil && groupState == .uncleared
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
        // A Stop may be waiting on a retry the lost supervisor will never
        // answer; exactly one of these two lets it answer.
        if afterUnclearedTerminal, !cleanupReleased { out.append(.cleanupRetryUncleared) }
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

    /// Until a decision, every line is read. After one, accepted text is
    /// already out and later output is dropped, but complete lines are still
    /// read for an overflow signal alone (section 17), within the same
    /// bounds, until `overflowObserved`; then nothing more is read.
    public mutating func consumeStdout(_ bytes: Data, now: UInt64) -> [Output] {
        var out: [Output] = []
        lastStdoutAt = now
        stdoutBytes += bytes.count
        guard !overflowObserved else { return out }   // keep draining, read nothing
        let decidedBefore = decision != nil
        guard stdoutBytes <= limits.maxStdoutBytes else {
            end(.processError, now: now, into: &out)
            observeOverflow(into: &out)   // the rest cannot be read
            return out
        }
        var start = bytes.startIndex
        while start < bytes.endIndex, !overflowObserved {
            if let newline = bytes[start...].firstIndex(of: 0x0A) {
                guard line.count + (newline - start) <= limits.maxLineBytes else {
                    end(.processError, now: now, into: &out)
                    observeOverflow(into: &out)   // this line cannot be read
                    return out
                }
                line.append(contentsOf: bytes[start..<newline])
                let complete = line
                line.removeAll(keepingCapacity: true)
                if decision == nil {
                    handleLine(complete, now: now, into: &out)
                } else {
                    inspectForOverflow(complete, into: &out)
                }
                start = newline + 1
            } else {
                guard line.count + (bytes.endIndex - start) <= limits.maxLineBytes else {
                    end(.processError, now: now, into: &out)
                    observeOverflow(into: &out)
                    return out
                }
                line.append(contentsOf: bytes[start...])
                start = bytes.endIndex
            }
        }
        if !decidedBefore { settle(now: now, into: &out) }
        return out
    }

    /// The spawner's stdout bound was reached: bytes past it are dropped
    /// unread, so overflow is observed conservatively.
    public mutating func stdoutLimitReached(now: UInt64) -> [Output] {
        var out: [Output] = []
        end(.processError, now: now, into: &out)
        observeOverflow(into: &out)
        return out
    }

    /// stdout reached EOF: a last line without its newline is complete.
    public mutating func stdoutClosed(now: UInt64) -> [Output] {
        var out: [Output] = []
        if !stdoutEOF, !stdoutFailed {
            stdoutEOF = true
            if !overflowObserved, !line.isEmpty {
                // A last line without its newline.
                let last = line
                line.removeAll()
                if decision == nil {
                    handleLine(last, now: now, into: &out)
                } else {
                    inspectForOverflow(last, into: &out)
                }
            }
        }
        settle(now: now, into: &out)
        releaseIfPipesClosed(into: &out)
        return out
    }

    /// Reading stdout failed before its EOF (a `read` error other than
    /// EINTR; section 17). Not EOF: a buffered partial line is never read
    /// as complete, and since what followed it was never read, overflow is
    /// observed conservatively, once. Otherwise stdout counts as done for
    /// the terminal: a decided run keeps its terminal, text and sequence,
    /// and an undecided one is decided by the existing rules with that
    /// line unread. For cleanup it never counts: a closed read end proves
    /// no writer gone, so a lost supervisor's cleanup is never released by
    /// the pipes.
    public mutating func stdoutReadFailed(now: UInt64) -> [Output] {
        var out: [Output] = []
        if !stdoutEOF, !stdoutFailed {
            stdoutFailed = true
            observeOverflow(into: &out)   // drops the partial line unread
        }
        settle(now: now, into: &out)
        return out
    }

    /// The run's updates are about to finish (its process events have ended;
    /// after a failed read, not proof the CLI exited). If stdout's EOF never
    /// arrived, what it still held was never read, so overflow is observed
    /// conservatively. Changes nothing else.
    public mutating func updatesFinishing() -> [Output] {
        var out: [Output] = []
        if !stdoutEOF { observeOverflow(into: &out) }
        return out
    }

    public mutating func consumeStderr(_ bytes: Data) {
        stderrBytes += bytes.count
        let room = limits.maxStderrKeptBytes - stderrKept.count
        if room > 0 { stderrKept.append(contentsOf: bytes.prefix(room)) }
    }

    public mutating func stderrClosed(now: UInt64) -> [Output] {
        var out: [Output] = []
        if !stderrFailed { stderrEOF = true }
        releaseIfPipesClosed(into: &out)
        return out
    }

    /// Reading stderr failed before its EOF. Its kept bytes stay as read;
    /// a lost supervisor's cleanup is never released by the pipes now.
    public mutating func stderrReadFailed(now: UInt64) -> [Output] {
        if !stderrEOF { stderrFailed = true }
        return []
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
            guard initPassed else {
                // Out of order, so `process-error`; an overflow signal in it still counts.
                if Self.signalsOverflow(message) { observeOverflow(into: &out) }
                return end(.processError, now: now, into: &out)
            }
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

    /// What one rate-limit message's `rate_limit_info` says under the overflow rule.
    private enum OverflowReading: Equatable {
        /// No `overageStatus` and no true flag: says nothing; text stays held.
        case silent
        /// `overageStatus` `rejected` with `isUsingOverage` and `overageInUse` not true.
        case passes
        /// A flag not "not true", or any other `overageStatus`: paid overflow.
        case overflow
    }

    private static func overflowReading(_ info: [String: JSONValue]) -> OverflowReading {
        // "Not true": absent or false. Anything else counts as true.
        func notTrue(_ value: JSONValue?) -> Bool { value == nil || value == .bool(false) }
        guard notTrue(info["isUsingOverage"]), notTrue(info["overageInUse"]) else { return .overflow }
        switch info["overageStatus"] {
        case nil: return .silent
        case .string("rejected")?: return .passes
        default: return .overflow
        }
    }

    /// A rate-limit message whose `rate_limit_info` fails the overflow rule:
    /// the one predicate `handleRateLimit` ends `paid-overflow` on.
    private static func signalsOverflow(_ message: [String: JSONValue]) -> Bool {
        guard message["type"] == .string("rate_limit_event"),
              case .object(let info)? = message["rate_limit_info"] else { return false }
        return overflowReading(info) == .overflow
    }

    private mutating func handleRateLimit(_ message: [String: JSONValue], now: UInt64, into out: inout [Output]) {
        guard case .object(let info)? = message["rate_limit_info"] else {
            return end(.processError, now: now, into: &out)
        }
        switch Self.overflowReading(info) {
        case .overflow:
            end(.paidOverflow, now: now, into: &out)
        case .silent:
            break   // Says nothing about overflow; text stays held.
        case .passes:
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
        }
    }

    /// After a decision: reads one complete line only for an overflow
    /// signal. Anything else, readable or not, changes nothing.
    private mutating func inspectForOverflow(_ bytes: [UInt8], into out: inout [Output]) {
        guard let value = try? JSONValue.decode(Data(bytes)), case .object(let message) = value,
              Self.signalsOverflow(message) else { return }
        observeOverflow(into: &out)
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
    ///
    /// A scalar that can no longer fit the bounds (input plus output, or the
    /// projected run) ends the run when it arrives, not at the next flush:
    /// the buffer before it, which fits, is emitted as the longest prefix
    /// that fits, then `reply-too-long` (vector #48: both at the delta's
    /// millisecond). The run has then ended: a Stop, a paid-overflow signal
    /// or an exit that arrives after that delta, even within the 250 ms the
    /// old flush-time rule waited, leaves the reason `reply-too-long`; a
    /// later overflow signal is still observed (`overflowObserved`).
    private mutating func accept(_ text: String, now: UInt64, into out: inout [Output]) {
        for scalar in text.unicodeScalars {
            guard decision == nil else { return }
            let size = UTF8.width(scalar)
            if pendingBytes + size > limits.maxEventTextBytes {
                guard emitPending(into: &out) else { return end(.replyTooLong, now: now, into: &out) }
            }
            let escapedSize = Self.escapedWidth(scalar)
            // The same tests `emitPending` cuts by: its quotes count 2.
            if pendingBytes + size > outputBudget || 2 + pendingEscapedBytes + escapedSize > projectedRoom {
                emitPending(into: &out)
                return end(.replyTooLong, now: now, into: &out)
            }
            if pendingSince == nil { pendingSince = now }
            pending.unicodeScalars.append(scalar)
            pendingBytes += size
            pendingEscapedBytes += escapedSize
        }
    }

    /// Escaped bytes one more text event may still add to the projected run.
    private var projectedRoom: Int {
        limits.maxProjectedRunBytes - projectedBytes - 3
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
        pendingEscapedBytes = 0
        pendingSince = nil
        let byteRoom = outputBudget
        let projectedRoom = self.projectedRoom
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
        pendingEscapedBytes = 0
        pendingSince = nil
        held = ""
        heldBytes = 0
        heldOverran = false
    }

    /// Bytes `JSON.stringify` writes for one scalar inside a string. Public
    /// so the local route counts a reply exactly as this reader does.
    public static func escapedWidth(_ scalar: Unicode.Scalar) -> Int {
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
    /// group's end. A partial line is kept: later lines are still read for
    /// an overflow signal. A `paid-overflow` end is itself an observation.
    private mutating func end(_ reason: ParticipantFailureReason, now: UInt64, into out: inout [Output]) {
        guard decision == nil else { return }
        decision = .failed(reason)
        if reason == .paidOverflow { observeOverflow(into: &out) }
        emitAccepted(into: &out)
        if groupState == .unknown { out.append(.sendStop) }
        settle(now: now, into: &out)
    }

    /// Emits `overflowObserved` once; stdout is no longer read after it.
    private mutating func observeOverflow(into out: inout [Output]) {
        guard !overflowObserved else { return }
        overflowObserved = true
        line.removeAll()
        out.append(.overflowObserved)
    }

    /// Decides from the exit once stdout has drained (or cannot), and emits
    /// the terminal once the group's end is known and a decision exists.
    private mutating func settle(now: UInt64, into out: inout [Output]) {
        guard terminal == nil, !spawnFailed else { return }
        let groupEnded = groupState == .cleared || groupState == .uncleared
        if decision == nil, groupState != .lost {
            // Bytes written before the exit may still be in the pipe: wait for
            // EOF, unless members survive (they may hold it open) or the grace
            // after `cleared` is over. A failed read ends the wait as EOF
            // would: nothing more will be read.
            let graceOver = groupState == .cleared && now >= groupStateAt + limits.exitDecisionGraceMillis
            let stdoutDone = stdoutEOF || stdoutFailed
            if exitStatus != nil, stdoutDone || groupState == .uncleared || graceOver {
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

    /// Only a real EOF on both pipes: a failed read leaves them unproven.
    private mutating func releaseIfPipesClosed(into out: inout [Output]) {
        if groupState == .lost, stdoutEOF, stderrEOF { release(into: &out) }
    }
}
