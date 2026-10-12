import DeskHost
@testable import DeskHostWebKit
import Foundation
import WebKit
import XCTest

/// The host's unsaved-work check on real WebKit, without the Desk build:
/// the invented bundle's page is loaded through the host (so it carries
/// the host's document-start scripts), page-world listeners are armed as a
/// page would arm them, and the check runs from the host's own script world
/// exactly as `liveUnsavedWork` runs it. Invented page and store in a
/// throwaway folder; runs in every `swift test`.
@MainActor
final class UnsavedWorkCheckTests: XCTestCase {
    private var fixture: BundleFixture!
    private var host: DeskWebViewHost!

    override func setUp() async throws {
        fixture = try BundleFixture()
        let manifest = try DeskBundleScanner.manifest(forBundleAt: fixture.bundle)
        let resolver = AssetResolver(manifest: manifest, bundleDirectory: fixture.bundle)
        let store = try ProofStore(directory: fixture.root.appendingPathComponent("proof", isDirectory: true), keys: InventedInMemoryKeyProvider())
        let sink = WebKitHostEventSink { _ in }
        let hostProtocol = DeskHostProtocol(store: store, connections: ConnectionRegistry(), drafts: DraftBindingRegistry(),
                                            info: HostInfo(appVersion: "0.0.0-proof", hostBuild: "unsaved-work-check"), events: sink)
        host = DeskWebViewHost(hostProtocol: hostProtocol, resolver: resolver, eventSink: sink, frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        host.load()
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if !host.webView.isLoading, host.documentConnection != nil, host.documentConnection == host.currentConnection { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertNotNil(host.documentConnection, "the invented page committed holding the current connection")
        XCTAssertEqual(host.documentConnection, host.currentConnection)
        _ = try await eval("""
        window.__proofListeners = [];
        window.__proofListen = function (type, listener, capture) {
          window.__proofListeners.push([type, listener, capture]);
          window.addEventListener(type, listener, capture);
        };
        true
        """)
    }

    override func tearDown() async throws {
        if let host, !host.isClosed { await host.close() }
        fixture?.clean()
    }

    /// Evaluates in the page's world, or in `world` when given.
    private func eval(_ javaScript: String, in world: WKContentWorld? = nil) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            host.webView.evaluateJavaScript(javaScript, in: nil, in: world ?? .page) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    /// The check as the host runs it: from its own world, read as the host
    /// reads it.
    private func check() async -> DeskWebViewHost.UnsavedWorkAnswer {
        let result = await withCheckedContinuation { continuation in
            host.webView.evaluateJavaScript(DeskWebViewHost.beforeUnloadCheck, in: nil, in: .defaultClient) { continuation.resume(returning: $0) }
        }
        return DeskWebViewHost.unsavedWorkAnswer(from: result)
    }

    private static let disarm = """
    window.onbeforeunload = null;
    window.onerror = null;
    window.__proofListeners.forEach(function (l) { window.removeEventListener(l[0], l[1], l[2]); });
    window.__proofListeners = [];
    true
    """
    private static let throwing = "__proofListen('beforeunload', function () { throw new Error('invented guard failure'); }, false);"
    private static let stopsTheRest = "function (e) { e.stopImmediatePropagation(); }"

    /// W4-R1 and W4-R2. Each row is a guard a page may hold, and the answer
    /// WebKit's own navigation gives it: it asks to confirm leaving
    /// (unsaved), it does not (clean), or a listener threw before it could
    /// say (no answer). The unsaved and clean rows are the ones WebKit's own
    /// navigation was seen to ask about, or not, after a click into the page
    /// (a scratch probe through its private confirmation callback, not part
    /// of the host). Before the fix the check dispatched a plain `Event`, on
    /// which a handler's returned message, a listener's `returnValue`
    /// message and a handler returning false cancel nothing: those read
    /// clean (W4-R1), while an empty `returnValue`, which WebKit does not
    /// ask about, read unsaved. And it noticed a throw through an `error`
    /// listener added only when it ran, after the page's own, so a page's
    /// capturing `error` listener that stops the rest hid the throw: clean
    /// again (W4-R2). Now the event is a real `BeforeUnloadEvent`, and the
    /// host counts errors with a listener registered at document start,
    /// ahead of any of the page's.
    func testTheCheckAnswersEachGuardAsWebKitsOwnEventWould() async throws {
        let rows: [(String, String, DeskWebViewHost.UnsavedWorkAnswer)] = [
            ("no guard", "", .clean),
            ("a listener calls preventDefault", "__proofListen('beforeunload', function (e) { e.preventDefault(); }, false);", .unsaved),
            ("the Desk's own guard: preventDefault and an empty returnValue",
             "__proofListen('beforeunload', function (e) { e.preventDefault(); e.returnValue = ''; }, false);", .unsaved),
            ("onbeforeunload returns a message", "window.onbeforeunload = function () { return 'invented unsaved'; };", .unsaved),
            ("a listener sets returnValue to a message", "__proofListen('beforeunload', function (e) { e.returnValue = 'invented unsaved'; }, false);", .unsaved),
            ("onbeforeunload returns false", "window.onbeforeunload = function () { return false; };", .unsaved),
            ("onbeforeunload returns an empty message", "window.onbeforeunload = function () { return ''; };", .unsaved),
            ("a listener sets returnValue to false", "__proofListen('beforeunload', function (e) { e.returnValue = false; }, false);", .unsaved),
            ("onbeforeunload returns nothing", "window.onbeforeunload = function () {};", .clean),
            ("a listener sets an empty returnValue", "__proofListen('beforeunload', function (e) { e.returnValue = ''; }, false);", .clean),
            ("a listener throws", Self.throwing, .unknown),
            ("a listener throws, window.onerror returns true", "window.onerror = function () { return true; }; " + Self.throwing, .unknown),
            ("a listener throws, a bubbling error listener stops the rest", "__proofListen('error', \(Self.stopsTheRest), false); " + Self.throwing, .unknown),
            ("a listener throws, a capturing error listener stops the rest", "__proofListen('error', \(Self.stopsTheRest), true); " + Self.throwing, .unknown),
            ("a listener cancels, a capturing error listener stops the rest",
             "__proofListen('error', \(Self.stopsTheRest), true); __proofListen('beforeunload', function (e) { e.preventDefault(); }, false);", .unsaved),
            ("one listener cancels, another throws", "__proofListen('beforeunload', function (e) { e.preventDefault(); }, false); " + Self.throwing, .unsaved),
        ]
        for (guardName, arm, expected) in rows {
            _ = try await eval(Self.disarm)
            _ = try await eval(arm + " true")
            let answer = await check()
            XCTAssertEqual(answer, expected, guardName)
        }
        _ = try await eval(Self.disarm)
        let clean = await check()
        XCTAssertEqual(clean, .clean, "disarmed, the page answers clean again")
    }

    /// The app's close and quit question (`pageHoldsUnsavedWork`) on real
    /// WebKit, through the host itself: a clean page holds nothing, a page
    /// that cancels holds unsaved work, and a page whose guard throws
    /// cannot answer, which is reported as `.noAnswer`, never as nothing
    /// unsaved. The app is never asked, and the page keeps its connection.
    func testPageHoldsUnsavedWorkReportsAGuardThatThrowsAsNoAnswer() async throws {
        host.confirmLeavingUnsavedWork = { _, _ in XCTFail("the app is not asked"); return false }
        let connection = host.currentConnection
        let clean = await host.pageHoldsUnsavedWork()
        XCTAssertNil(clean, "no guard: clean")
        _ = try await eval("__proofListen('beforeunload', function (e) { e.preventDefault(); }, false); true")
        let unsaved = await host.pageHoldsUnsavedWork()
        XCTAssertEqual(unsaved, .unsaved)
        _ = try await eval(Self.disarm)
        _ = try await eval(Self.throwing + " true")
        let throwing = await host.pageHoldsUnsavedWork()
        XCTAssertEqual(throwing, .noAnswer, "a guard that throws cannot say what the page keeps")
        _ = try await eval(Self.disarm)
        let disarmed = await host.pageHoldsUnsavedWork()
        XCTAssertNil(disarmed, "disarmed, clean again")
        XCTAssertEqual(host.currentConnection, connection, "asking spends nothing")
        XCTAssertEqual(host.documentConnection, connection)
    }

    /// W4-R2: the error count the check reads is the host's own. It exists
    /// in the host's script world from the start of the document, the page
    /// cannot see or replace it there, and an error the page reported
    /// outside the check does not make a later check read as no answer.
    func testTheErrorCountIsTheHostsOwnAndCountsOnlyDuringTheCheck() async throws {
        let inHostWorld = try await eval("typeof window.__trueConvoHostErrorsReported", in: .defaultClient) as? String
        XCTAssertEqual(inHostWorld, "function", "registered at document start in the host's world")
        let inPage = try await eval("typeof window.__trueConvoHostErrorsReported") as? String
        XCTAssertEqual(inPage, "undefined", "the page's world does not see it")
        _ = try await eval("window.__trueConvoHostErrorsReported = function () { return 0; }; true")
        _ = try await eval("setTimeout(function () { throw new Error('invented error outside the check'); }, 0); true")
        try await Task.sleep(nanoseconds: 300_000_000)
        let reported = try await eval("window.__trueConvoHostErrorsReported()", in: .defaultClient) as? Int
        XCTAssertEqual(reported, 1, "the page's error outside the check reached the host's count")
        let answer = await check()
        XCTAssertEqual(answer, .clean, "an earlier error does not count against a later check")
        _ = try await eval(Self.throwing + " true")
        let throwing = await check()
        XCTAssertEqual(throwing, .unknown, "the page's own replacement in its world changes nothing in the host's")
    }
}
