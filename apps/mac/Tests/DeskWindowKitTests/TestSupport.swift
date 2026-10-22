import AppKit
import Darwin
import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
import WebKit
import XCTest

/// A throwaway folder for one test: an invented base folder for the Desk,
/// and a tiny invented Desk bundle (one HTML page, no handshake) for tests
/// that need a web view but not the real Desk page.
struct DeskTestFolder {
    let root: URL

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("DeskWindowKitTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// The invented home's Application Support folder (made on first use,
    /// as the Mac's own always exists).
    var support: URL { root.appendingPathComponent("Application Support", isDirectory: true) }

    var base: URL {
        support.appendingPathComponent("com.trueconvo.voice-cursor", isDirectory: true)
            .appendingPathComponent("desk-invented-proof", isDirectory: true)
    }

    var paths: DeskPaths { DeskPaths(applicationSupport: support) }

    /// A one-page invented Desk bundle.
    func fixtureBundle() throws -> DeskBundleLocation {
        let folder = root.appendingPathComponent("fixture-desk", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("<!doctype html><title>invented</title><main>Invented fixture Desk</main>".utf8)
            .write(to: folder.appendingPathComponent("index.html"))
        return try XCTUnwrap(DeskBundleLocation.developmentFolder(folder))
    }

    func clean() { try? FileManager.default.removeItem(at: root) }
}

/// The real built Desk (`TRUECONVO_DESK_BUNDLE`, DEBUG builds only), or a
/// skip: the proof is never faked.
func realDeskBundle() throws -> DeskBundleLocation {
    guard let location = DeskBundleLocation.current(bundle: Bundle(for: DeskLogCollector.self),
                                                    environment: ProcessInfo.processInfo.environment),
          location.source == .developmentFolder else {
        throw XCTSkip("Set TRUECONVO_DESK_BUNDLE to a built Desk native-dist copy to run the real Desk page.")
    }
    return location
}

/// The real Desk when the variable is set, the invented one-page Desk
/// otherwise (for tests that do not need the real page).
func anyDeskBundle(_ folder: DeskTestFolder) throws -> DeskBundleLocation {
    if let real = try? realDeskBundle() { return real }
    return try folder.fixtureBundle()
}

final class DeskLogCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    var log: DeskSession.Log {
        { [self] event, detail in
            lock.lock()
            defer { lock.unlock() }
            lines.append(detail.isEmpty ? event : "\(event) \(detail)")
        }
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}

@MainActor
func makeSession(_ folder: DeskTestFolder, bundle: DeskBundleLocation?, logs: DeskLogCollector = DeskLogCollector()) -> DeskSession {
    DeskSession(paths: folder.paths, bundle: bundle, info: HostInfo(appVersion: "0.0.0-test", hostBuild: "unit-desk-none"), log: logs.log)
}

@MainActor
func waitUntil(_ what: String, timeout: TimeInterval = 30, _ condition: () async throws -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if try await condition() { return }
        try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTFail("timed out waiting for \(what)")
    throw CancellationError()
}

@MainActor
func evaluate(_ webView: WKWebView, _ javaScript: String) async throws -> Any? {
    try await withCheckedThrowingContinuation { continuation in
        webView.evaluateJavaScript(javaScript, in: nil, in: .page) { result in
            switch result {
            case .success(let value): continuation.resume(returning: value)
            case .failure(let error): continuation.resume(throwing: error)
            }
        }
    }
}

/// Waits until the real Desk page finished its handshake on a connection
/// newer than `after` and rendered its shell.
@MainActor
func waitForRealDesk(_ session: DeskSession, after previous: HostConnection? = nil) async throws -> HostConnection {
    try await waitUntil("a Desk document after \(previous.map { "generation \($0.generation)" } ?? "none")") {
        guard let connection = session.host?.currentConnection else { return false }
        return connection != previous && (previous.map { connection.generation > $0.generation } ?? true)
    }
    let host = try XCTUnwrap(session.host)
    try await waitUntil("the Desk shell to render") {
        (try? await evaluate(host.webView, "document.querySelector('.application-shell') !== null && document.querySelector('main.recovery-page') === null")) as? Bool == true
    }
    return try XCTUnwrap(host.currentConnection)
}

/// Every file under `folder`, by relative path, with its bytes.
func snapshot(_ folder: URL) throws -> [String: Data] {
    var files: [String: Data] = [:]
    let prefix = folder.standardizedFileURL.path + "/"
    guard let enumerator = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) else { return files }
    for case let url as URL in enumerator where (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
        files[String(url.standardizedFileURL.path.dropFirst(prefix.count))] = try Data(contentsOf: url)
    }
    return files
}

/// Holds the store's writer lock the way a second copy of the app would.
final class WriterLockHolder {
    private var descriptor: Int32 = -1

    init?(folder: URL) {
        let descriptor = open(folder.appendingPathComponent("proof.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return nil }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return nil
        }
        self.descriptor = descriptor
    }

    func release() {
        guard descriptor >= 0 else { return }
        flock(descriptor, LOCK_UN)
        close(descriptor)
        descriptor = -1
    }

    deinit { release() }
}

func posixMode(_ url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
}

/// Holds the owner check open until the test answers it, standing in for
/// the password or Touch ID prompt being on screen.
@MainActor
final class HeldVerifier: DeskUnlockVerifier {
    private var pending: CheckedContinuation<DeskUnlockVerdict, Never>?
    var isWaiting: Bool { pending != nil }

    func verify(reason: String) async -> DeskUnlockVerdict {
        await withCheckedContinuation { pending = $0 }
    }

    func answer(_ verdict: DeskUnlockVerdict) {
        pending?.resume(returning: verdict)
        pending = nil
    }
}

/// Holds a step until released, so a test can act while it waits.
@MainActor
final class HeldStep {
    private var pending: CheckedContinuation<Void, Never>?
    var isWaiting: Bool { pending != nil }

    func wait() async {
        await withCheckedContinuation { pending = $0 }
    }

    func release() {
        pending?.resume()
        pending = nil
    }
}

/// Runs a nested run loop in the modal-panel mode until `done` or the time
/// is up. An alert's `runModal`, and `NSApp.terminate` waiting for a
/// `.terminateLater` reply, wait like this, nested inside their caller.
@MainActor
func spinNestedRunLoop(upTo seconds: TimeInterval, until done: () -> Bool) {
    let mode = RunLoop.Mode.modalPanel
    // AppKit counts the modal-panel mode among the common modes.
    CFRunLoopAddCommonMode(CFRunLoopGetMain(), CFRunLoopMode(mode.rawValue as CFString))
    let deadline = Date().addingTimeInterval(seconds)
    while !done(), Date() < deadline {
        _ = RunLoop.main.run(mode: mode, before: min(deadline, Date().addingTimeInterval(0.02)))
    }
}
