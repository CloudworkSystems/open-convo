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
// line} | {"err": text} | {"sleepMs": n} | {"exit": code} | {"hang": true}]}.
// Steps that end without `exit` or `hang` exit 0. With `leaveGroup` the fake,
// after forking any child, moves itself into its parent's group (the
// supervisor's) with `setpgid` and records the result in `moved.json`.

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

/// The forked child: stays in the fake's process group, holds its stdio.
func runChild(mode: String, records: String) -> Never {
    if mode == "ignore-term" { signal(SIGTERM, SIG_IGN) }
    writeAtomically("\(getpid())", to: records + "/child.pid")
    hangForever()
}

let arguments = CommandLine.arguments
if arguments.count == 4, arguments[1] == "--fake-child" {
    runChild(mode: arguments[2], records: arguments[3])
}

let descriptorsAtStart = openDescriptors()
let folder = (arguments[0] as NSString).deletingLastPathComponent
let records = folder + "/records"
_ = mkdir(records, 0o700)
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
    let argv: [UnsafeMutablePointer<CChar>?] = [arguments[0], "--fake-child", childMode, records].map { strdup($0) } + [nil]
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

let exec = execArguments()
let record: [String: Any] = [
    "pid": Int(getpid()),
    "pgid": Int(getpgrp()),
    "ppid": Int(getppid()),
    "argv": Array((exec?.argv ?? arguments).dropFirst()),
    "env": exec?.env ?? [],
    "cwd": FileManager.default.currentDirectoryPath,
    "stdin": stdinText,
    "fds": descriptorsAtStart.map { Int($0) }
]
if let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) {
    writeAtomically(String(decoding: data, as: UTF8.self), to: records + "/cli.json")
}

for step in scenario["steps"] as? [[String: Any]] ?? [] {
    if let line = step["out"] as? String {
        writeAll(1, line + "\n")
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
exit(0)
