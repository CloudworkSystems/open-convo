import Darwin
import Foundation

// The launch seam (contract sections 7 step 15 and 11). A coordinator starts
// a run through `ParticipantLaunching` and reads it through
// `ParticipantRunning`, so a test can put a scripted run on a virtual clock
// behind the same seam. INACTIVE: nothing outside the test target constructs
// `ProcessParticipantLauncher`, and shipping has no CLI path to give it, a
// second barrier behind availability, which still answers
// `overflow-unverified`.

/// One run as its owner sees it: its updates, Stop, and a status read from
/// memory. `ParticipantRun` is the real one.
public protocol ParticipantRunning: AnyObject, Sendable {
    /// Every update in order; finishes once the run's process events have
    /// ended. That is not proof the CLI exited: after a failed pipe read
    /// (not EOF), the updates can finish with cleanup still pending.
    var updates: AsyncStream<ParticipantRunUpdate> { get }
    /// Writes `stop` to the supervisor before anything else. True means only
    /// that the local write succeeded (see `ParticipantRun.stop()`).
    @discardableResult func stop() -> Bool
    var snapshot: ParticipantRunSnapshot { get }
}

extension ParticipantRun: ParticipantRunning {}

/// What a start hands the launcher once its record is durable.
public struct ParticipantLaunchRequest: Sendable {
    public var identity: ParticipantRunIdentity
    /// The build's pinned model, the only variable part of the command line.
    public var model: String
    /// An off-Mac run's earlier turns (section 21.2): exactly the ones the
    /// start just re-resolved and re-hashed, user then assistant for each
    /// context run, oldest first. Empty for a run with no context runs.
    public var context: [LocalTurn]
    /// The prepared entry's `contextBytes`; must equal the turns' text bytes.
    public var contextBytes: Int
    /// The prepared run's `inputChunks`, kept as an array: the prepared
    /// `inputHash` is over the array, so chunk boundaries matter there even
    /// though they never reach the CLI.
    public var inputChunks: [String]
    /// The prepared entry's `inputBytes`; must equal the new message's bytes.
    public var inputBytes: Int
    /// The prepared entry's `preparedBytes` (section 6).
    public var preparedBytes: Int

    public init(identity: ParticipantRunIdentity, model: String, context: [LocalTurn] = [], contextBytes: Int = 0,
                inputChunks: [String], inputBytes: Int, preparedBytes: Int) {
        self.identity = identity
        self.model = model
        self.context = context
        self.contextBytes = contextBytes
        self.inputChunks = inputChunks
        self.inputBytes = inputBytes
        self.preparedBytes = preparedBytes
    }

    /// The new message (Codex Q17): the chunks concatenated as they are and
    /// UTF-8 encoded, with no separator, trailing newline, JSON wrapper or
    /// Unicode normalization.
    public var message: Data {
        Data(inputChunks.joined().utf8)
    }

    /// The preamble of section 21.3's layout, exactly.
    public static let stdinPreamble = "The earlier turns of this conversation follow, oldest first, then the new message. "
        + "Each part starts with a line in square brackets naming it and the exact length of its text in UTF-8 bytes. "
        + "Reply only to the new message."

    /// The CLI's stdin (section 21.3). With no earlier turns, exactly
    /// `message`, as in revision 3. Otherwise the one fixed layout: the
    /// preamble, then each turn and the new message, each after a header
    /// line naming it and its text's UTF-8 byte count, the parts separated
    /// by a blank line, with `\n` line endings and nothing after the
    /// message.
    public var stdin: Data {
        guard !context.isEmpty else { return message }
        var text = Self.stdinPreamble + "\n\n"
        for turn in context {
            text += "[earlier \(turn.role) turn, \(turn.text.utf8.count) bytes]\n" + turn.text + "\n\n"
        }
        let message = inputChunks.joined()
        text += "[new message, \(message.utf8.count) bytes]\n" + message
        return Data(text.utf8)
    }
}

public enum ParticipantLaunchError: Error, Equatable {
    /// The new message's bytes are not the entry's `inputBytes` (Codex Q17).
    case inputBytesMismatch(expected: Int, actual: Int)
    /// The earlier turns' text bytes are not the entry's `contextBytes`, or
    /// a turn is neither the user's nor the assistant's (section 21.3).
    case contextMismatch
}

/// Starts runs. One launch is one spawn attempt: a throw means nothing ran
/// (the caller records `failed` `process-error` with `groupCleared` null).
public protocol ParticipantLaunching: Sendable {
    /// The CLI version a start record names for runs this launcher starts
    /// (Codex Q16): configuration, never the page, an environment variable or
    /// unchecked saved data, and never probed from the binary. This is the
    /// one source: a coordinator reads it here and keeps no copy of its own,
    /// so a record cannot name a version other than the one launched.
    var cliVersion: String { get }
    func launch(_ request: ParticipantLaunchRequest) throws -> any ParticipantRunning
}

/// The private parent of every participant run's working folder (Codex Q18):
/// `participants`, mode 0700, inside the Desk run folder the caller has
/// already validated. Each run gets a fresh empty 0700 child of it from
/// `ParticipantWorkingFolder.create(under:)`; the run folder itself, which
/// holds the store, is never a working folder. Only invented temporary
/// folders reach this in the current slices.
public enum ParticipantsFolder {
    public static let name = "participants"

    /// Opens `deskRunFolder` without following a link, makes `participants`
    /// in it if it is missing, and checks it on an open descriptor: a plain
    /// folder (not a link), owned by this user, mode exactly 0700. An
    /// existing one that fails is refused, never repaired. Removes nothing.
    public static func prepare(in deskRunFolder: URL) throws -> ParticipantsParent {
        let runFolder = open(deskRunFolder.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard runFolder >= 0 else { throw ParticipantWorkingFolderError.parentMissing }
        defer { _ = close(runFolder) }
        var runInfo = stat()
        guard fstat(runFolder, &runInfo) == 0, runInfo.st_uid == getuid(), (runInfo.st_mode & 0o022) == 0 else {
            throw ParticipantWorkingFolderError.parentNotPrivate
        }
        var created = false
        if mkdirat(runFolder, name, 0o700) == 0 {
            created = true
        } else if errno != EEXIST {
            throw ParticipantWorkingFolderError.createFailed(errno)
        }
        let folder = openat(runFolder, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard folder >= 0 else { throw ParticipantWorkingFolderError.notPrivate }
        defer { _ = close(folder) }
        // The umask can only narrow a new folder's mode; set it exactly.
        if created { _ = fchmod(folder, 0o700) }
        var info = stat()
        guard fstat(folder, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(),
              (info.st_mode & 0o7777) == 0o700 else {
            throw ParticipantWorkingFolderError.notPrivate
        }
        return ParticipantsParent(url: deskRunFolder.appendingPathComponent(name, isDirectory: true))
    }
}

/// A `participants` folder `ParticipantsFolder.prepare` checked. Only
/// `prepare` makes one, so the production launcher cannot be handed the Desk
/// run folder, or any other unchecked folder, as the parent of its runs'
/// working folders.
public struct ParticipantsParent: Sendable, Equatable {
    public let url: URL

    fileprivate init(url: URL) {
        self.url = url
    }
}

/// The production launcher, in order: a fresh working folder
/// (`ParticipantWorkingFolder.create(under:)`), the allow-listed environment
/// (`ParticipantEnvironment.build` over this process's own environment), the
/// pinned command line around `request.model` with `request.stdin` as input,
/// the spawn, then a `ParticipantRun`. Removing the working folder is tried
/// once the run's updates finish (its process events have ended, which after
/// a failed pipe read does not prove the CLI exited), or at once when the
/// spawn throws. Removal can fail (the filesystem refuses): then the folder
/// may still be there, with whatever the run left in it, and
/// `working-folder-not-removed` is logged for the run, before its updates
/// finish or the spawn's error is thrown. That is a fact about files, not
/// about the process group.
///
/// Constructed only by tests. `cliVersion` is the build's pin
/// (`ParticipantCommandLine.pinnedCLIVersion`), not a parameter.
public struct ProcessParticipantLauncher: ParticipantLaunching {
    public let supervisorPath: String
    public let cliPath: String
    /// The private participants parent, as `ParticipantsFolder.prepare` checked it.
    public let workingParent: ParticipantsParent
    public let expectedInit: ParticipantInitExpectation
    public let limits: StreamJSONReaderLimits
    public let processLimits: ParticipantProcessLimits
    public let clock: ParticipantClock
    public let log: ParticipantLogSink
    /// Tests only (through `@testable`): the variables the allow-list reads
    /// in place of this process's own. Nil, the only public choice, reads
    /// this process's own at each launch. The allow-list applies either way.
    let environment: [String: String]?

    public var cliVersion: String { ParticipantCommandLine.pinnedCLIVersion }

    public init(supervisorPath: String, cliPath: String, workingParent: ParticipantsParent,
                expectedInit: ParticipantInitExpectation, limits: StreamJSONReaderLimits = .contract,
                processLimits: ParticipantProcessLimits = ParticipantProcessLimits(),
                clock: ParticipantClock = SystemParticipantClock(), log: ParticipantLogSink = SystemParticipantLog()) {
        self.init(supervisorPath: supervisorPath, cliPath: cliPath, workingParent: workingParent,
                  expectedInit: expectedInit, limits: limits, processLimits: processLimits, clock: clock, log: log,
                  environment: nil)
    }

    init(supervisorPath: String, cliPath: String, workingParent: ParticipantsParent,
         expectedInit: ParticipantInitExpectation, limits: StreamJSONReaderLimits = .contract,
         processLimits: ParticipantProcessLimits = ParticipantProcessLimits(),
         clock: ParticipantClock = SystemParticipantClock(), log: ParticipantLogSink = SystemParticipantLog(),
         environment: [String: String]?) {
        self.supervisorPath = supervisorPath
        self.cliPath = cliPath
        self.workingParent = workingParent
        self.expectedInit = expectedInit
        self.limits = limits
        self.processLimits = processLimits
        self.clock = clock
        self.log = log
        self.environment = environment
    }

    public func launch(_ request: ParticipantLaunchRequest) throws -> any ParticipantRunning {
        let message = request.message
        guard message.count == request.inputBytes else {
            throw ParticipantLaunchError.inputBytesMismatch(expected: request.inputBytes, actual: message.count)
        }
        guard request.context.allSatisfy({ $0.role == "user" || $0.role == "assistant" }),
              request.context.reduce(0, { $0 + $1.text.utf8.count }) == request.contextBytes else {
            throw ParticipantLaunchError.contextMismatch
        }
        let input = request.stdin
        let folder = try ParticipantWorkingFolder.create(under: workingParent.url)
        let process: SpawnedParticipant
        do {
            process = try ParticipantProcessSpawner(limits: processLimits).spawn(ParticipantProcessLaunch(
                supervisorPath: supervisorPath, cliPath: cliPath, model: request.model,
                environment: ParticipantEnvironment.build(from: environment ?? ProcessInfo.processInfo.environment),
                workingFolder: folder, input: input))
        } catch {
            if !folder.remove() {
                log.record(ParticipantLogEntry(runId: request.identity.runId, kind: .workingFolderNotRemoved))
            }
            throw error
        }
        let run = ParticipantRun(
            identity: request.identity, process: process,
            // Section 8's `reply-too-long` counts the context too (21.4).
            configuration: StreamJSONReader.Configuration(expectedInit: expectedInit,
                                                          inputBytes: request.contextBytes + request.inputBytes,
                                                          preparedBytes: request.preparedBytes, limits: limits),
            clock: clock, log: log)
        return LaunchedParticipantRun(run: run, runId: request.identity.runId, workingFolder: folder, log: log)
    }
}

/// A run that tries to remove its working folder once its updates finish,
/// before its own updates finish. Every update is passed on in order. An
/// owner that sees the end knows the removal was tried, not that the folder
/// is gone: when the filesystem refused, `working-folder-not-removed` was
/// logged for the run before the end. `ParticipantRun` in production; any
/// run in tests.
final class LaunchedParticipantRun: ParticipantRunning, @unchecked Sendable {
    let updates: AsyncStream<ParticipantRunUpdate>
    private let run: any ParticipantRunning

    init(run: any ParticipantRunning, runId: String, workingFolder: ParticipantWorkingFolder, log: ParticipantLogSink) {
        self.run = run
        var continuation: AsyncStream<ParticipantRunUpdate>.Continuation!
        updates = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        let inner = run.updates
        Task.detached { [continuation] in
            for await update in inner { continuation!.yield(update) }
            if !workingFolder.remove() {
                log.record(ParticipantLogEntry(runId: runId, kind: .workingFolderNotRemoved))
            }
            continuation!.finish()
        }
    }

    @discardableResult
    func stop() -> Bool {
        run.stop()
    }

    var snapshot: ParticipantRunSnapshot {
        run.snapshot
    }
}
