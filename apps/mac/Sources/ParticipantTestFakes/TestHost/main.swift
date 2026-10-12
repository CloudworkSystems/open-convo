import Darwin
import Foundation
@_spi(ParticipantTesting) import ParticipantProcess

// A test-target host that plays the app, so a test can SIGKILL it (not its
// close handler) and watch the real supervisor clean up. Never bundled.
//
// ParticipantTestHost --supervisor <path> --cli <path> --workparent <path> --model <model> --input <text>
//
// It makes the run's working folder under `--workparent`
// (`ParticipantWorkingFolder`), spawns the supervisor through
// `ParticipantProcessSpawner` and reports on
// stdout, one line each: `supervisor <pid>`, `control <message>`,
// `control-closed`, `supervisor-exited <status>`, `stop-sent`, `stop-failed`,
// `lifeline-closed`, `sleeper <pid>`, `error <reason>`. Commands on stdin:
// `stop`, `close-lifeline` (closes the lifeline without exiting),
// `leak-lifeline` (hands the lifeline's write end to a `/bin/sleep`, so the
// lifeline cannot report the host's death), `leak-lifeline-and-control`
// (the control socket too, so its EOF cannot wake the supervisor either)
// and `quit`.

let outputLock = NSLock()
func say(_ line: String) {
    outputLock.lock()
    defer { outputLock.unlock() }
    let bytes = Array((line + "\n").utf8)
    var written = 0
    while written < bytes.count {
        let result = bytes.withUnsafeBytes { write(1, $0.baseAddress! + written, bytes.count - written) }
        if result > 0 { written += result } else if result < 0, errno == EINTR { continue } else { return }
    }
}

func option(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

/// `/bin/sleep 30` in its own group, holding `descriptors` as its fds 3, 4, ...
func spawnSleeper(holding descriptors: [Int32]) -> pid_t {
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP))
    posix_spawnattr_setpgroup(&attributes, 0)
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    for target in 0...2 { posix_spawn_file_actions_addopen(&actions, Int32(target), "/dev/null", O_RDWR, 0) }
    for (offset, descriptor) in descriptors.enumerated() {
        posix_spawn_file_actions_adddup2(&actions, descriptor, Int32(3 + offset))
    }
    let words: [String] = ["/bin/sleep", "30"]
    let argv: [UnsafeMutablePointer<CChar>?] = words.map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    var pid: pid_t = 0
    let result = posix_spawn(&pid, "/bin/sleep", &actions, &attributes, argv, environ)
    return result == 0 ? pid : -1
}

guard let supervisor = option("--supervisor"), let cli = option("--cli"),
      let workParent = option("--workparent"), let model = option("--model") else {
    say("error usage")
    exit(64)
}

guard let workingFolder = try? ParticipantWorkingFolder.create(under: URL(fileURLWithPath: workParent, isDirectory: true)) else {
    say("error workdir")
    exit(1)
}

let launch = ParticipantProcessLaunch(
    supervisorPath: supervisor,
    cliPath: cli,
    model: model,
    environment: ParticipantEnvironment.build(from: ProcessInfo.processInfo.environment),
    workingFolder: workingFolder,
    input: Data((option("--input") ?? "invented input").utf8))

let process: SpawnedParticipant
do {
    process = try ParticipantProcessSpawner().spawn(launch)
} catch {
    say("error spawn")
    exit(1)
}
say("supervisor \(process.supervisorProcessID)")

let events = process.events
Thread.detachNewThread {
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        for await event in events {
            switch event {
            case .control(let message): say("control \(message.line)")
            case .controlClosed: say("control-closed")
            case .supervisorExited(let status): say("supervisor-exited \(status)")
            default: break
            }
        }
        done.signal()
    }
    done.wait()
}

while let command = readLine() {
    switch command {
    case "stop":
        say(process.sendStop() ? "stop-sent" : "stop-failed")
    case "close-lifeline":
        process.closeLifelineForTesting()
        say("lifeline-closed")
    case "leak-lifeline":
        let pid = process.withLifelineDescriptorForTesting { spawnSleeper(holding: [$0]) } ?? -1
        say("sleeper \(pid)")
    case "leak-lifeline-and-control":
        let pid = process.withLifelineDescriptorForTesting { lifeline in
            process.withControlDescriptorForTesting { control in spawnSleeper(holding: [lifeline, control]) }
        } ?? nil
        say("sleeper \(pid ?? -1)")
    case "quit":
        exit(0)
    default:
        say("error command")
    }
}
// The test closed stdin: keep the run going until it kills the host.
while true { _ = sleep(60) }
