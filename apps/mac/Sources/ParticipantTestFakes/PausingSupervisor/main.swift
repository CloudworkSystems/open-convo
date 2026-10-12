import Darwin
import ParticipantSupervisorCore

// Test build of the supervisor, never bundled: the shipping engine and driver
// plus two test seams. It pauses after the lifeline and control are watched
// and before the app's pid is (1.5 s, or the milliseconds in
// `$TMPDIR/participant-test-supervisor-pause-ms`), so a test can kill the
// app inside the gap; and it writes the first way it found the app gone to
// `$TMPDIR/pausing-supervisor-<pid>.txt`. TMPDIR is on the environment
// allow-list, and the test sets it.

func temporaryPath(_ name: String) -> String? {
    guard let directory = getenv("TMPDIR") else { return nil }
    var path = String(cString: directory)
    if !path.hasSuffix("/") { path += "/" }
    return path + name
}

func pauseMicroseconds() -> useconds_t {
    guard let path = temporaryPath("participant-test-supervisor-pause-ms"),
          let file = fopen(path, "r") else { return 1_500_000 }
    defer { fclose(file) }
    var millis: Int32 = 0
    guard fscanf_millis(file, &millis), millis >= 0, millis <= 10_000 else { return 1_500_000 }
    return useconds_t(millis) * 1000
}

func fscanf_millis(_ file: UnsafeMutablePointer<FILE>, _ value: inout Int32) -> Bool {
    var buffer = [CChar](repeating: 0, count: 16)
    guard fgets(&buffer, Int32(buffer.count), file) != nil else { return false }
    let text = String(String(cString: buffer).filter { $0 != " " && $0 != "\n" })
    guard let parsed = Int32(text) else { return false }
    value = parsed
    return true
}

func recordCause(_ cause: AppGoneCause) {
    guard let path = temporaryPath("pausing-supervisor-\(getpid()).txt") else { return }
    let descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { return }
    let bytes = Array(cause.rawValue.utf8)
    _ = bytes.withUnsafeBytes { write(descriptor, $0.baseAddress!, bytes.count) }
    _ = close(descriptor)
}

let pause = pauseMicroseconds()
let hooks = SupervisorHooks(
    beforeAppWatch: { if pause > 0 { usleep(pause) } },
    appGoneObserved: { recordCause($0) }
)
exit(supervisorMain(arguments: CommandLine.arguments, hooks: hooks))
