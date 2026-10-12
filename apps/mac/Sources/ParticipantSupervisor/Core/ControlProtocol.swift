/// The supervisor's control channel (contract section 11): a fixed, textless
/// set of one-line ASCII messages on the control socket. Nothing the CLI
/// writes ever crosses it; the CLI's text goes from its pipes straight to the
/// app.

/// Messages the supervisor sends to the app.
public enum SupervisorMessage: Equatable, Sendable {
    /// The CLI is running in its own process group.
    case spawned
    /// `posix_spawn` of the CLI failed; there is no group.
    case spawnFailed
    /// The CLI (the group leader) exited, with its raw wait status as kqueue's
    /// `NOTE_EXITSTATUS` reports it. The leader is not reaped yet.
    case exit(status: Int32)
    /// A probe found the group empty; the leader is reaped. Last message.
    case cleared
    /// Members survived the stop sequence's SIGKILL; the group stays reserved.
    case uncleared

    /// The message's line, without its newline.
    public var line: String {
        switch self {
        case .spawned: return "spawned"
        case .spawnFailed: return "spawn-failed"
        case .exit(let status): return "exit \(status)"
        case .cleared: return "cleared"
        case .uncleared: return "uncleared"
        }
    }

    /// The bytes written to the socket: the line and one newline.
    public var wireBytes: [UInt8] { Array((line + "\n").utf8) }

    /// Parses exactly one known line; anything else is nil.
    public init?(line: String) {
        switch line {
        case "spawned": self = .spawned
        case "spawn-failed": self = .spawnFailed
        case "cleared": self = .cleared
        case "uncleared": self = .uncleared
        default:
            let prefix = "exit "
            guard line.hasPrefix(prefix) else { return nil }
            let digits = String(line.dropFirst(prefix.count))
            // Canonical decimal only, so each status has one spelling.
            guard let status = Int32(digits), String(status) == digits else { return nil }
            self = .exit(status: status)
        }
    }
}

/// Commands the app sends to the supervisor. `stop` starts the stop sequence;
/// sent while members survive, it is the cleanup retry.
public enum SupervisorCommand: Equatable, Sendable {
    case stop

    public var line: String { "stop" }
    public var wireBytes: [UInt8] { Array("stop\n".utf8) }

    public init?(line: String) {
        guard line == "stop" else { return nil }
        self = .stop
    }
}

/// Splits control bytes into lines on `\n` only. A line longer than
/// `maxLineBytes` is dropped whole, so a confused peer cannot grow the buffer.
public struct ControlLineSplitter: Sendable {
    public static let maxLineBytes = 32

    private var buffer: [UInt8] = []
    private var discarding = false

    public init() {}

    public mutating func append<Bytes: Sequence>(_ bytes: Bytes) -> [String] where Bytes.Element == UInt8 {
        var lines: [String] = []
        for byte in bytes {
            if byte == 0x0A {
                // Every known line is ASCII; anything else cannot match one.
                if !discarding, buffer.allSatisfy({ $0 < 0x80 }) {
                    lines.append(String(decoding: buffer, as: UTF8.self))
                }
                buffer.removeAll(keepingCapacity: true)
                discarding = false
            } else if !discarding {
                if buffer.count == Self.maxLineBytes {
                    buffer.removeAll(keepingCapacity: true)
                    discarding = true
                } else {
                    buffer.append(byte)
                }
            }
        }
        return lines
    }
}
