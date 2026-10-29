import Darwin
import Foundation

// A fake participant CLI for tests. Never the real one: it makes no network
// request, reads no account file and only writes invented stream-json from
// its scenario.
//
// The test puts this binary (as a symlink named after the CLI) in a folder
// of its own with `scenario.json` beside it. The fake reads the scenario from
// the folder of `argv[0]`, so the pinned argument list and the allow-listed
// environment stay exactly what production passes. It records what it saw
// in `records/` there: `cli.pid` first, then `cli.json` (pid, group, argv and
// environment as exec'd, working directory, stdin, open descriptors), and `child.pid`
// for a forked child.
//
// Scenario: {"sigterm": "exit" | "ignore", "child": null | "ignore-term" |
// "exit-on-term", "leaveGroup": bool, "readStdin": bool, "steps": [{"out":
// line} | {"outRaw": text} | {"err": text} | {"sleepMs": n} | {"exit": code} |
// {"hang": true}]}. `out` adds a newline; `outRaw` writes the text as is.
// Steps that end without `exit` or `hang` exit 0. With `leaveGroup` the fake,
// after forking any child, moves itself into its parent's group (the
// supervisor's) with `setpgid` and records the result in `moved.json`.
//
// Predicted Claude Code 2.1.283 modes (F1; `Predicted.swift` says where the
// shapes come from: a read-only reading, never a run). Chosen the same way,
// by the scenario beside the fake and the arguments the real CLI would get:
// - `--version`, `-v` or `-V` (optionally then `--verbose`): the line
//   `<version> (Claude Code)`, `version` from the scenario (default
//   "2.1.283"), with `--verbose` an invented `Commit:` line; exit 0.
// - `auth status` (optionally `--json`): the scenario's `authStatus`, one of
//   "subscription", "signed-out", "console", "api-key-env", "bedrock",
//   "vertex", "garbled" or "slow" (the subscription answer after `slowMs`,
//   default 6000, past section 5's 5 s bound); exit 0, or 1 signed out.
//   Without a known `authStatus` it exits 70; other `auth` commands exit 64.
//   These checks read no stdin, record `version.json` or `auth-status.json`
//   (pid, group, argv, environment, working directory, descriptors, and
//   `stdinState`, which peeks at stdin without consuming text: "eof",
//   "data", "open" or "closed"), append their record name to `checks.log`,
//   and never write `cli.pid` or `cli.json`.
// - `auth status` with `networkPort` or `networkSocket` in the scenario
//   first tries to connect to that listener (the test's own) and records
//   whether it could in `network.json`: the stand-in for the settings fetch
//   the real one may start, which step 4 runs with the network blocked.
// - For section 5's checks (F3), more invented variants: `authStatus`
//   "console-login", "api-key-helper", "oauth-token", "gateway",
//   "pro", "team", "enterprise" (a plan login on that plan), "unknown-plan", "unknown-method", "no-account", "logged-in-exit-1",
//   "logged-in-number", "empty" and "oversized", with the scenario's
//   `configDirectory` if it has one; `versionMode` "garbled",
//   "empty", "oversized", "exit-2" or "slow" (after `versionSlowMs`, default
//   6000); `versionTouchesSelf` sets the program file's times (its identity
//   changes) while answering `--version`; `checkChild` leaves a child that
//   ignores SIGTERM in the check's group (it records `child.pid`);
//   `checkStderrFlood` (a count) starts that many writers in the check's
//   group that ignore SIGTERM and SIGPIPE and keep writing to its stderr
//   without pause (each appends its pid to `flood.pids`).
// - A run whose scenario has `stream` ("normal", "no-overage-status",
//   "overage-allowed", "no-rate-limit", "local-slash" or "refused-429"):
//   after the usual records and stdin, the predicted lines with the argv's
//   `--model` as the model, then any `steps`; exit 0 (1 for "refused-429")
//   unless a step ends it first. Only under section 11's exact argv and
//   environment as exec'd (`PredictedInvocation`): otherwise it prints
//   nothing on stdout, says why on stderr and exits 70.

func openDescriptors() -> [Int32] {
    (0..<256).compactMap { fcntl(Int32($0), F_GETFD) == -1 ? nil : Int32($0) }
}

func writeAtomically(_ text: String, to path: String) {
    let temporary = path + ".tmp-\(getpid())"
    guard let data = text.data(using: .utf8), FileManager.default.createFile(atPath: temporary, contents: data) else { return }
    _ = rename(temporary, path)
}

func writeAll(_ descriptor: Int32, _ text: String) {
    let bytes = Array(text.utf8)
    var written = 0
    while written < bytes.count {
        let result = bytes.withUnsafeBytes { write(descriptor, $0.baseAddress! + written, bytes.count - written) }
        if result > 0 { written += result } else if result < 0, errno == EINTR { continue } else { return }
    }
}

func hangForever() -> Never {
    while true { _ = sleep(60) }
}

func sleepMillis(_ millis: Int) {
    var request = timespec(tv_sec: millis / 1000, tv_nsec: (millis % 1000) * 1_000_000)
    var remaining = timespec()
    while nanosleep(&request, &remaining) == -1, errno == EINTR { request = remaining }
}

/// The argv and environment exactly as `posix_spawn` delivered them, read
/// back from the kernel (`KERN_PROCARGS2`). `environ` is not used: this
/// process's own CoreFoundation adds `__CF_USER_TEXT_ENCODING` to it at load.
func execArguments() -> (argv: [String], env: [String])? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, getpid()]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return nil }
    var buffer = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return nil }
    let argc = buffer.withUnsafeBytes { Int($0.load(as: Int32.self)) }
    var index = 4
    while index < size, buffer[index] != 0 { index += 1 }   // exec path
    while index < size, buffer[index] == 0 { index += 1 }   // padding
    var strings: [String] = []   // exactly argc, empty ones included
    while index < size, strings.count < argc {
        let start = index
        while index < size, buffer[index] != 0 { index += 1 }
        strings.append(String(decoding: buffer[start..<index], as: UTF8.self))
        index += 1
    }
    var env: [String] = []
    while index < size {
        let start = index
        while index < size, buffer[index] != 0 { index += 1 }
        if index == start { break }
        env.append(String(decoding: buffer[start..<index], as: UTF8.self))
        index += 1
    }
    return (strings, env)
}

/// What a check's stdin is, without waiting long: "eof" (a pipe or file at
/// its end), "data", "open" (nothing yet after 200 ms) or "closed" (no
/// descriptor 0).
func stdinState() -> String {
    guard fcntl(0, F_GETFD) != -1 else { return "closed" }
    var poller = pollfd(fd: 0, events: Int16(POLLIN), revents: 0)
    guard poll(&poller, 1, 200) > 0 else { return "open" }
    var byte: UInt8 = 0
    return read(0, &byte, 1) == 0 ? "eof" : "data"
}

/// What this process was started with, as JSON: pid, group, parent, argv and
/// environment as exec'd, working directory, descriptors open at start, and
/// `stdin` when it was read.
func invocationRecord(descriptors: [Int32], stdin: String?, extra: [String: Any] = [:]) -> String? {
    let exec = execArguments()
    var record: [String: Any] = [
        "pid": Int(getpid()),
        "pgid": Int(getpgrp()),
        "ppid": Int(getppid()),
        "argv": Array((exec?.argv ?? CommandLine.arguments).dropFirst()),
        "env": exec?.env ?? [],
        "cwd": FileManager.default.currentDirectoryPath,
        "fds": descriptors.map { Int($0) }
    ]
    if let stdin { record["stdin"] = stdin }
    for (key, value) in extra { record[key] = value }
    guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return nil }
    return String(decoding: data, as: UTF8.self)
}

/// Appends one line to `path`.
func appendLine(_ line: String, to path: String) {
    let descriptor = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { return }
    writeAll(descriptor, line + "\n")
    _ = close(descriptor)
}

/// A predicted check (`--version`, `auth status`): reads no stdin and leaves
/// `cli.pid` and `cli.json` alone.
func runCheck(_ check: PredictedCheck, folder: String, records: String, descriptors: [Int32]) -> Never {
    let scenario = FileManager.default.contents(atPath: folder + "/scenario.json")
        .flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
    if let record = invocationRecord(descriptors: descriptors, stdin: nil, extra: ["stdinState": stdinState()]) {
        writeAtomically(record, to: records + "/" + check.recordName)
    }
    appendLine(check.recordName, to: records + "/checks.log")
    if scenario["checkChild"] as? Bool == true {
        // Spawned without a new group and with this process's stdio, so the
        // child is a member of the check's group and holds its pipes.
        var pid: pid_t = 0
        let argv: [UnsafeMutablePointer<CChar>?] = ([CommandLine.arguments[0], "--fake-child", "ignore-term", records] as [String])
            .map { strdup($0) } + [nil]
        _ = posix_spawn(&pid, CommandLine.arguments[0], nil, nil, argv, environ)
        argv.forEach { free($0) }
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: records + "/child.pid") { usleep(10_000) }
    }
    if let writers = scenario["checkStderrFlood"] as? Int, writers > 0 {
        // Like the child above: in the check's group, holding its stderr.
        for _ in 0..<writers {
            var pid: pid_t = 0
            let argv: [UnsafeMutablePointer<CChar>?] = ([CommandLine.arguments[0], "--fake-child", "stderr-flood", records] as [String])
                .map { strdup($0) } + [nil]
            _ = posix_spawn(&pid, CommandLine.arguments[0], nil, nil, argv, environ)
            argv.forEach { free($0) }
        }
        func recorded() -> Int {
            ((try? String(contentsOfFile: records + "/flood.pids", encoding: .utf8)) ?? "").split(separator: "\n").count
        }
        for _ in 0..<200 where recorded() < writers { usleep(10_000) }
    }
    switch check {
    case .version(let verbose):
        let mode = scenario["versionMode"] as? String
        if mode == "slow" { sleepMillis(scenario["versionSlowMs"] as? Int ?? 6_000) }
        if scenario["versionTouchesSelf"] as? Bool == true {
            var times = [timeval(tv_sec: 1_000_000_000, tv_usec: 0), timeval(tv_sec: 1_000_000_000, tv_usec: 0)]
            _ = utimes(CommandLine.arguments[0], &times)
        }
        let line = Predicted.versionLine(scenario["version"] as? String ?? Predicted.version)
        switch mode {
        case "garbled": writeAll(1, "Invented CLI, version text in another shape\n")
        case "empty": break
        case "oversized": writeAll(1, String(repeating: line, count: 8_000))
        case "exit-2":
            writeAll(1, line)
            exit(2)
        default:
            writeAll(1, line)
            if verbose { writeAll(1, Predicted.commitLine) }
        }
        exit(0)
    case .authStatus:
        guard let name = scenario["authStatus"] as? String,
              let answer = Predicted.authStatus(name, configDirectory: scenario["configDirectory"] as? String ?? "/invented/config")
        else {
            writeAll(2, "invented fake: no known authStatus in the scenario\n")
            exit(70)
        }
        if name == "slow" { sleepMillis(scenario["slowMs"] as? Int ?? 6_000) }
        tryNetwork(scenario, records: records)
        writeAll(1, answer.output)
        exit(answer.exit)
    case .unsupported:
        writeAll(2, "invented fake: this auth command is not modelled\n")
        exit(64)
    }
}

/// Stands in for the fetch the real `auth status` may start: with
/// `networkPort` (a TCP port on 127.0.0.1) or `networkSocket` (a local
/// socket path) in the scenario, tries to connect to each and records in
/// `network.json` whether it did, and the error if not. Both are listeners
/// the test itself opened; nothing else is reached.
func tryNetwork(_ scenario: [String: Any], records: String) {
    var outcome: [String: Any] = [:]
    func errorCode(_ result: Int32) -> Int { result == 0 ? 0 : Int(errno) }
    if let port = scenario["networkPort"] as? Int {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = socket < 0 ? -1 : withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        outcome["tcpConnected"] = result == 0
        outcome["tcpErrno"] = socket < 0 ? Int(errno) : errorCode(result)
        if socket >= 0 { _ = close(socket) }
    }
    if let path = scenario["networkSocket"] as? String {
        let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        _ = withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            path.utf8CString.withUnsafeBytes { buffer.copyMemory(from: UnsafeRawBufferPointer(rebasing: $0.prefix(buffer.count - 1))) }
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let result = socket < 0 ? -1 : withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        outcome["localConnected"] = result == 0
        outcome["localErrno"] = socket < 0 ? Int(errno) : errorCode(result)
        if socket >= 0 { _ = close(socket) }
    }
    guard !outcome.isEmpty, let data = try? JSONSerialization.data(withJSONObject: outcome) else { return }
    writeAtomically(String(decoding: data, as: UTF8.self), to: records + "/network.json")
}

/// The value after `--model`, as the real CLI would echo it in init.
func modelArgument(_ argv: [String]) -> String? {
    guard let index = argv.firstIndex(of: "--model"), index + 1 < argv.count else { return nil }
    return argv[index + 1]
}

/// The forked child: stays in the fake's process group, holds its stdio.
func runChild(mode: String, records: String) -> Never {
    if mode == "stderr-flood" { floodStderr(records: records) }
    if mode == "ignore-term" { signal(SIGTERM, SIG_IGN) }
    writeAtomically("\(getpid())", to: records + "/child.pid")
    hangForever()
}

/// A writer that keeps the check's stderr full until it is killed.
func floodStderr(records: String) -> Never {
    signal(SIGTERM, SIG_IGN)
    signal(SIGPIPE, SIG_IGN)
    appendLine("\(getpid())", to: records + "/flood.pids")
    let chunk = [UInt8](repeating: 0x78, count: 65_536)
    while true {
        _ = chunk.withUnsafeBytes { write(2, $0.baseAddress, $0.count) }
    }
}

let arguments = CommandLine.arguments
if arguments.count == 4, arguments[1] == "--fake-child" {
    runChild(mode: arguments[2], records: arguments[3])
}

let descriptorsAtStart = openDescriptors()
let folder = (arguments[0] as NSString).deletingLastPathComponent
let records = folder + "/records"
_ = mkdir(records, 0o700)
if let check = PredictedCheck(arguments: Array(arguments.dropFirst())) {
    runCheck(check, folder: folder, records: records, descriptors: descriptorsAtStart)
}
writeAtomically("\(getpid())", to: records + "/cli.pid")

guard let scenarioData = FileManager.default.contents(atPath: folder + "/scenario.json"),
      let scenario = (try? JSONSerialization.jsonObject(with: scenarioData)) as? [String: Any] else {
    writeAll(2, "invented fake: no scenario\n")
    exit(70)
}

if scenario["sigterm"] as? String == "ignore" { signal(SIGTERM, SIG_IGN) }

if let childMode = scenario["child"] as? String {
    // Spawned without a new group, so the child is a member of ours.
    var pid: pid_t = 0
    let argv: [UnsafeMutablePointer<CChar>?] = ([arguments[0], "--fake-child", childMode, records] as [String]).map { strdup($0) } + [nil]
    _ = posix_spawn(&pid, arguments[0], nil, nil, argv, environ)
    argv.forEach { free($0) }
    // Wait for its record, so a test that finds `cli.json` also finds the child.
    for _ in 0..<200 where !FileManager.default.fileExists(atPath: records + "/child.pid") { usleep(10_000) }
}

if scenario["leaveGroup"] as? Bool == true {
    let before = getpgrp()
    let result = setpgid(0, getpgid(getppid()))
    let failure = result == 0 ? 0 : errno
    writeAtomically("{\"before\":\(before),\"after\":\(getpgrp()),\"result\":\(result),\"errno\":\(failure)}",
                    to: records + "/moved.json")
}

var stdinText = ""
if scenario["readStdin"] as? Bool ?? true {
    var bytes: [UInt8] = []
    var buffer = [UInt8](repeating: 0, count: 65_536)
    while true {
        let count = read(0, &buffer, buffer.count)
        if count > 0 { bytes += buffer[0..<count]; continue }
        if count < 0, errno == EINTR { continue }
        break
    }
    stdinText = String(decoding: bytes, as: UTF8.self)
}

if let record = invocationRecord(descriptors: descriptorsAtStart, stdin: stdinText) {
    writeAtomically(record, to: records + "/cli.json")
}

var exitWhenStepsEnd: Int32 = 0
if let name = scenario["stream"] as? String {
    guard let stream = Predicted.stream(name) else {
        writeAll(2, "invented fake: unknown stream\n")
        exit(70)
    }
    let exec = execArguments()
    if let problem = PredictedInvocation.mismatch(argv: Array((exec?.argv ?? []).dropFirst()), env: exec?.env ?? []) {
        writeAll(2, "invented fake: a predicted stream needs section 11's argv and environment (\(problem))\n")
        exit(70)
    }
    let model = modelArgument(arguments) ?? Predicted.goldenModel
    for line in stream.lines { writeAll(1, Predicted.withModel(line, model) + "\n") }
    exitWhenStepsEnd = stream.exit
}

for step in scenario["steps"] as? [[String: Any]] ?? [] {
    if let line = step["out"] as? String {
        writeAll(1, line + "\n")
    } else if let text = step["outRaw"] as? String {
        writeAll(1, text)
    } else if let text = step["err"] as? String {
        writeAll(2, text)
    } else if let millis = step["sleepMs"] as? Int {
        usleep(useconds_t(millis * 1000))
    } else if let code = step["exit"] as? Int {
        exit(Int32(code))
    } else if step["hang"] as? Bool == true {
        hangForever()
    }
}
exit(exitWhenStepsEnd)
