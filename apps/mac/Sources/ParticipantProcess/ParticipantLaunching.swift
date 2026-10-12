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
    /// The prepared run's `inputChunks`, kept as an array: the prepared
    /// `inputHash` is over the array, so chunk boundaries matter there even
    /// though they never reach the CLI.
    public var inputChunks: [String]
    /// The prepared entry's `inputBytes`; must equal `stdin.count`.
    public var inputBytes: Int
    /// The prepared entry's `preparedBytes` (section 6).
    public var preparedBytes: Int

    public init(identity: ParticipantRunIdentity, model: String, inputChunks: [String], inputBytes: Int,
                preparedBytes: Int) {
        self.identity = identity
        self.model = model
        self.inputChunks = inputChunks
        self.inputBytes = inputBytes
        self.preparedBytes = preparedBytes
    }

    /// The CLI's stdin (Codex Q17): the chunks concatenated as they are and
    /// UTF-8 encoded, with no separator, trailing newline, JSON wrapper or
    /// Unicode normalization.
    public var stdin: Data {
        Data(inputChunks.joined().utf8)
    }
}

public enum ParticipantLaunchError: Error, Equatable {
    /// The stdin bytes are not the entry's `inputBytes` (Codex Q17).
    case inputBytesMismatch(expected: Int, actual: Int)
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
        let input = request.stdin
        guard input.count == request.inputBytes else {
            throw ParticipantLaunchError.inputBytesMismatch(expected: request.inputBytes, actual: input.count)
        }
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
            configuration: StreamJSONReader.Configuration(expectedInit: expectedInit, inputBytes: request.inputBytes,
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
