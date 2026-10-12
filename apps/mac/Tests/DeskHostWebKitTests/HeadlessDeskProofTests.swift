import Darwin
import DeskHost
@testable import DeskHostWebKit
import Foundation
import WebKit
import XCTest

/// The real thing, without a window: the pinned Desk native build is loaded
/// through `trueconvo-desk://desk/index.html` into a `WKWebView` built by
/// `DeskWebViewHost`, and the page's own code performs the handshake through
/// the `trueConvoHost` handler. Set `TRUECONVO_DESK_BUNDLE` to a copy of the
/// built `apps/desk/native-dist` folder; without it the proof is skipped,
/// never faked. Everything here is invented data in a throwaway folder.
@MainActor
final class HeadlessDeskProofTests: XCTestCase {
    private var root: URL!
    private var store: ProofStore!
    private var sink: WebKitHostEventSink!
    private var hostProtocol: DeskHostProtocol!
    private var registry: ConnectionRegistry!
    private var host: DeskWebViewHost!
    private var exchanges: [HostExchange] = []
    private let events = Locked<[HostEvent]>([])
    private var refusedNavigations: [URL?] = []
    private var decisions: [DeskWebViewHost.NavigationDecision] = []

    override func setUp() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let bundlePath = environment["TRUECONVO_DESK_BUNDLE"], !bundlePath.isEmpty else {
            throw XCTSkip("Set TRUECONVO_DESK_BUNDLE to a built Desk native-dist copy to run the headless proof.")
        }
        let bundle = URL(fileURLWithPath: bundlePath, isDirectory: true)
        root = FileManager.default.temporaryDirectory.appendingPathComponent("HeadlessDeskProof-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let manifest = try DeskBundleScanner.manifest(forBundleAt: bundle)
        try DeskBundleScanner.write(manifest, to: root.appendingPathComponent("desk-manifest.json"))
        let resolver = AssetResolver(manifest: try BundleManifest.load(from: root.appendingPathComponent("desk-manifest.json")),
                                     bundleDirectory: bundle)
        store = try ProofStore(directory: root.appendingPathComponent("proof", isDirectory: true), keys: InventedInMemoryKeyProvider())
        let events = self.events
        sink = WebKitHostEventSink { event in events.mutate { $0.append(event) } }
        registry = ConnectionRegistry()
        hostProtocol = DeskHostProtocol(store: store, connections: registry, drafts: DraftBindingRegistry(),
                                        info: HostInfo(appVersion: "0.0.0-proof", hostBuild: "headless"), events: sink)
        host = DeskWebViewHost(hostProtocol: hostProtocol, resolver: resolver, eventSink: sink, frame: CGRect(x: 0, y: 0, width: 1200, height: 800))
        host.messageHandler.observer = { [weak self] exchange in self?.exchanges.append(exchange) }
        host.onNavigationRefused = { [weak self] url in self?.refusedNavigations.append(url) }
        host.onNavigationDecided = { [weak self] decision in self?.decisions.append(decision) }
    }

    override func tearDown() async throws {
        if let host, !host.isClosed { await host.close() }
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    // MARK: Helpers

    private func eval(_ javaScript: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            host.webView.evaluateJavaScript(javaScript, in: nil, in: .page) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Runs an async function body in the page and awaits its promise.
    private func callAsync(_ body: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            host.webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 30, _ condition: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try await condition() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("timed out waiting for \(what)")
        throw ProofFailure.timeout(what)
    }

    private func waitForPage(_ what: String, _ expression: String, timeout: TimeInterval = 30) async throws {
        try await waitUntil(what, timeout: timeout) { (try? await eval(expression)) as? Bool == true }
    }

    private func okReplies(operation: String, connectionId: String, generation: Int) -> Int {
        exchanges.filter { $0 == .replied(operation: operation, connectionId: connectionId, generation: generation, outcome: .ok, reason: nil) }.count
    }

    private func waitForHandshake(generation: Int) async throws -> HostConnection {
        try await waitUntil("document generation \(generation) to begin") { host.currentConnection?.generation == generation }
        let connection = try XCTUnwrap(host.currentConnection)
        try await waitUntil("host.capabilities and workspace.read ok replies on \(connection.id)") {
            okReplies(operation: "host.capabilities", connectionId: connection.id, generation: generation) >= 1
                && okReplies(operation: "workspace.read", connectionId: connection.id, generation: generation) >= 1
        }
        try await waitForPage("the Desk shell to render", "document.querySelector('.application-shell') !== null && document.querySelector('main.recovery-page') === null")
        return connection
    }

    /// Waits for whatever document generation comes after `generation` and
    /// for its handshake.
    private func waitForHandshake(after generation: Int) async throws -> HostConnection {
        try await waitUntil("a document generation after \(generation) to begin") { (host.currentConnection?.generation ?? 0) > generation }
        let connection = try XCTUnwrap(host.currentConnection)
        return try await waitForHandshake(generation: connection.generation)
    }

    private func readEnvelope(connectionId: String, generation: Int) -> String {
        """
        { v: 1, requestId: "\(UUID().uuidString.lowercased())", connectionId: "\(connectionId)", generation: \(generation), operation: "workspace.read", payload: { workspaceHandle: "\(store.workspaceHandle)" } }
        """
    }

    private func readyEvents() -> [HostEvent] {
        events.value.filter { if case .hostConnection(_, _, let state, _) = $0 { return state == .ready } else { return false } }
    }

    private struct Bootstrap: Decodable, Equatable {
        let v: Int
        let connectionId: String
        let generation: Int
        let keys: [String]
        let frozen: Bool
        let writable: Bool
        let configurable: Bool
    }

    private func pageBootstrap() async throws -> Bootstrap {
        let evaluated = try await eval("""
        (function () {
          var d = Object.getOwnPropertyDescriptor(window, "trueConvoHostBootstrap");
          var b = d.value;
          return JSON.stringify({ v: b.v, connectionId: b.connectionId, generation: b.generation, keys: Object.keys(b).sort(),
            frozen: Object.isFrozen(b), writable: d.writable, configurable: d.configurable });
        })()
        """)
        let text = try XCTUnwrap(evaluated as? String)
        return try JSONDecoder().decode(Bootstrap.self, from: Data(text.utf8))
    }

    private func rawPost(_ argument: String) async throws -> String {
        let posted = try await callAsync("""
        try {
          const reply = await window.webkit.messageHandlers.trueConvoHost.postMessage(\(argument));
          return "resolved:" + JSON.stringify(reply);
        } catch (error) {
          return "rejected:" + String(error && error.message ? error.message : error);
        }
        """)
        return try XCTUnwrap(posted as? String)
    }

    private func envelope(_ connection: HostConnection, operation: String) -> String {
        let requestId = UUID().uuidString.lowercased()
        return """
        { v: 1, requestId: "\(requestId)", connectionId: "\(connection.id)", generation: \(connection.generation), operation: "\(operation)", payload: {} }
        """
    }

    // MARK: The proof

    func testPinnedDeskBuildHandshakesRendersReloadsLocksAndCloses() async throws {
        host.load()

        // 1. First document: the page boots through the bootstrap and the handler.
        let first = try await waitForHandshake(generation: 1)
        let title = try await eval("document.title") as? String
        XCTAssertEqual(title, "True Convo · Desk foundation")
        let bootstrap = try await pageBootstrap()
        XCTAssertEqual(bootstrap, Bootstrap(v: 1, connectionId: first.id, generation: 1, keys: ["connectionId", "generation", "v"],
                                            frozen: true, writable: false, configurable: false))
        let postMessageType = try await eval("typeof window.webkit.messageHandlers.trueConvoHost.postMessage") as? String
        XCTAssertEqual(postMessageType, "function")
        let alert = try await eval("document.querySelector('[role=alert]')?.textContent ?? null") as? String
        XCTAssertNil(alert, "no error rendered")
        let href = try await eval("location.href") as? String
        XCTAssertEqual(href, "trueconvo-desk://desk/index.html")
        XCTAssertTrue(events.value.contains(.hostConnection(connectionId: first.id, generation: 1, state: .ready, reason: .ready)))
        XCTAssertFalse(exchanges.contains { if case .transportFailure = $0 { return true } else { return false } }, "\(exchanges)")

        // 2. Transport rules through the real bridge: a non-object rejects, a
        //    wrong envelope resolves with a contract refusal.
        let rejected = try await rawPost("42")
        XCTAssertTrue(rejected.hasPrefix("rejected:"), rejected)
        XCTAssertTrue(rejected.contains(HostMessageHandler.transportError), rejected)
        XCTAssertTrue(exchanges.contains(.transportFailure(.notAnObject)))
        let refused = try await rawPost("{}")
        XCTAssertTrue(refused.hasPrefix("resolved:"), refused)
        XCTAssertTrue(refused.contains("\"reason\":\"unsupported-version\""), refused)
        let accepted = try await rawPost(envelope(first, operation: "host.capabilities"))
        XCTAssertTrue(accepted.contains("\"outcome\":\"ok\""), accepted)
        XCTAssertTrue(accepted.contains("\"store\":\"ready\""), accepted)

        // 3. Assets through the real scheme handler, from the page.
        let fetchedValue = try await callAsync("""
        const results = [];
        for (const path of ["./index.html", "./nope.txt", "./assets/", "./licenses/../index.html"]) {
          try { const r = await fetch(path); results.push(path + " " + r.status + " " + (r.headers.get("content-type") || "-")); }
          catch (e) { results.push(path + " threw"); }
        }
        return results.join("|");
        """)
        let fetched = try XCTUnwrap(fetchedValue as? String)
        XCTAssertTrue(fetched.contains("./index.html 200 text/html; charset=utf-8"), fetched)
        XCTAssertTrue(fetched.contains("./nope.txt 404"), fetched)
        XCTAssertTrue(fetched.contains("./assets/ 404"), fetched)

        // 4. Navigation away is cancelled; the page stays.
        _ = try? await eval("location.href = 'https://example.invalid/'")
        try await waitUntil("the foreign navigation to be refused") { refusedNavigations.contains { $0?.host == "example.invalid" } }
        let hrefAfterRefusal = try await eval("location.href") as? String
        XCTAssertEqual(hrefAfterRefusal, "trueconvo-desk://desk/index.html")
        XCTAssertEqual(host.currentConnection, first)

        // 5. Reload: a new generation, a new connection, a fresh bootstrap.
        host.reload()
        let second = try await waitForHandshake(generation: 2)
        XCTAssertNotEqual(second.id, first.id)
        let secondBootstrap = try await pageBootstrap()
        XCTAssertEqual(secondBootstrap.connectionId, second.id)
        XCTAssertEqual(secondBootstrap.generation, 2)
        XCTAssertTrue(events.value.contains(.hostConnection(connectionId: first.id, generation: 1, state: .revoked, reason: .navigation)))
        XCTAssertTrue(events.value.contains(.hostConnection(connectionId: second.id, generation: 2, state: .ready, reason: .ready)))
        let stale = try await rawPost(envelope(first, operation: "host.capabilities"))
        XCTAssertTrue(stale.contains("\"reason\":\"stale-generation\""), stale)

        // 6. Lock: the page receives host.connection locked, closes its runtime
        //    and sends nothing more; the old connection is refused.
        let before = exchanges.count
        await host.lock()
        try await waitUntil("the locked event") {
            events.value.contains(.hostConnection(connectionId: second.id, generation: 2, state: .locked, reason: .lock))
        }
        try await waitForPage("the page to show its closed state",
                              "document.querySelector('main.recovery-page h1')?.textContent === 'Workspace connection closed'")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(exchanges.count, before, "no request after lock: \(exchanges[before...])")
        let locked = try await rawPost(envelope(second, operation: "host.capabilities"))
        XCTAssertTrue(locked.contains("\"reason\":\"unknown-connection\""), locked)

        XCTAssertTrue(host.isLocked)
        XCTAssertNil(host.currentConnection)

        // 7. Unlock needs a fresh document: unlock itself begins generation 3
        //    (nothing to revoke) and bootstraps nothing; the reload is
        //    generation 4 and works again.
        await host.unlock()
        XCTAssertFalse(host.isLocked)
        XCTAssertNil(host.currentConnection)
        host.reload()
        let third = try await waitForHandshake(generation: 4)
        XCTAssertNotEqual(third.id, second.id)
        let thirdBootstrap = try await pageBootstrap()
        XCTAssertEqual(thirdBootstrap.connectionId, third.id)

        // 8. Close: revoked (shutdown) reaches the page, then the handler is gone.
        await host.close()
        XCTAssertTrue(host.isClosed)
        XCTAssertTrue(host.messageHandler.hasShutDown)
        XCTAssertNil(host.currentConnection)
        XCTAssertTrue(events.value.contains(.hostConnection(connectionId: third.id, generation: third.generation, state: .revoked, reason: .shutdown)))
        try await waitForPage("the page to show its closed state after shutdown",
                              "document.querySelector('main.recovery-page h1')?.textContent === 'Workspace connection closed'")
        let handlerType = try await eval("typeof (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.trueConvoHost)") as? String
        XCTAssertEqual(handlerType, "undefined")
        XCTAssertTrue(store.isLocked, "a closed store refuses")

        let seen = exchanges.compactMap { exchange -> String? in
            if case .replied(let operation, _, let generation, let outcome, let reason) = exchange {
                return "\(operation)@g\(generation)=\(outcome.rawValue)\(reason.map { "(\($0.rawValue))" } ?? "")"
            }
            return nil
        }
        print("HEADLESS-DESK-PROOF exchanges: \(seen.joined(separator: " "))")
        print("HEADLESS-DESK-PROOF events: \(events.value.map { "\($0.type)/\($0.generation)" }.joined(separator: " "))")
    }

    // MARK: Reviewer findings, through the real web view

    /// A page can post an object it could never send as bytes. A graph
    /// nested 5000 deep used to overflow the host's stack (one message killed
    /// the whole app); an unpaired surrogate used to pass into the store.
    /// Both now resolve with `malformed-envelope` and nothing echoed, and
    /// the host is still there to answer afterwards.
    func testHostileMessagesAreRefusedAndTheHostSurvives() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)

        let deep = try await callAsync("""
        let a = []; for (let i = 0; i < 5000; i++) a = [a];
        try { const r = await window.webkit.messageHandlers.trueConvoHost.postMessage({ v: 1, requestId: "\(UUID().uuidString.lowercased())", payload: a }); return "resolved:" + JSON.stringify(r); }
        catch (e) { return "rejected:" + String(e); }
        """) as? String
        let deepReply = try XCTUnwrap(deep)
        XCTAssertTrue(deepReply.contains("\"reason\":\"malformed-envelope\""), deepReply)
        XCTAssertTrue(deepReply.contains("\"requestId\":\"\""), "nothing echoed from a graph that was never read: \(deepReply)")

        // The edge: a valid request whose payload reaches exactly the limit
        // goes through the protocol actor (its own recursion, 512 KB stack)
        // and comes back refused for its content; one level more never
        // leaves the bridge. The envelope and the payload object are two of
        // the levels.
        for (arrays, expected) in [(JSONBridge.maxNestingDepth - 2, "unknown-field"), (JSONBridge.maxNestingDepth - 1, "malformed-envelope")] {
            let requestId = UUID().uuidString.lowercased()
            let edge = try await callAsync("""
            let a = [1]; for (let i = 1; i < \(arrays); i++) a = [a];
            const env = { v: 1, requestId: "\(requestId)", connectionId: "\(first.id)", generation: \(first.generation), operation: "host.capabilities", payload: { deep: a } };
            try { const r = await window.webkit.messageHandlers.trueConvoHost.postMessage(env); return "resolved:" + JSON.stringify(r); }
            catch (e) { return "rejected:" + String(e); }
            """) as? String
            let edgeReply = try XCTUnwrap(edge)
            XCTAssertTrue(edgeReply.contains("\"reason\":\"\(expected)\""), "\(arrays) arrays: \(edgeReply)")
            XCTAssertEqual(edgeReply.contains(requestId), expected == "unknown-field", "only the admitted one is echoed: \(edgeReply)")
        }

        // A lone high surrogate inside the request id (JS keeps it as one UTF-16 unit).
        let loneInEnvelope = try await rawPost("""
        { v: 1, requestId: "a\\uD800b", connectionId: "\(first.id)", generation: \(first.generation), operation: "host.capabilities", payload: {} }
        """)
        XCTAssertTrue(loneInEnvelope.contains("\"reason\":\"malformed-envelope\""), loneInEnvelope)
        XCTAssertTrue(loneInEnvelope.contains("\"requestId\":\"\""), "had WebKit or the bridge repaired it, invalid-identity would echo it: \(loneInEnvelope)")
        // The same text in a payload value of an otherwise valid request.
        let requestId = UUID().uuidString.lowercased()
        let loneInPayload = try await rawPost("""
        { v: 1, requestId: "\(requestId)", connectionId: "\(first.id)", generation: \(first.generation), operation: "workspace.read", payload: { workspaceHandle: "x\\uD800y" } }
        """)
        XCTAssertTrue(loneInPayload.contains("\"reason\":\"malformed-envelope\""), loneInPayload)
        XCTAssertFalse(loneInPayload.contains(requestId), "refused before the envelope was read: \(loneInPayload)")
        // A whole pair is ordinary text and reaches envelope validation.
        let pair = try await rawPost("""
        { v: 1, requestId: "\\uD83D\\uDE00", connectionId: "\(first.id)", generation: \(first.generation), operation: "host.capabilities", payload: {} }
        """)
        XCTAssertTrue(pair.contains("\"reason\":\"invalid-identity\""), pair)

        let afterwards = try await rawPost(envelope(first, operation: "host.capabilities"))
        XCTAssertTrue(afterwards.contains("\"outcome\":\"ok\""), "the host answers as before: \(afterwards)")
        XCTAssertEqual(host.currentConnection, first)
        XCTAssertFalse(exchanges.contains { if case .transportFailure = $0 { return true } else { return false } }, "\(exchanges)")
    }

    /// After `close()` the document is still alive in the view. The policy's
    /// `closed` branch must keep cancelling, from the page and from native,
    /// which it can only do while the delegates stay installed.
    func testClosedViewStillCancelsEveryNavigation() async throws {
        host.load()
        _ = try await waitForHandshake(generation: 1)
        let entry = "trueconvo-desk://desk/index.html"
        let title = try await eval("document.title") as? String

        _ = try? await eval("location.href = 'about:blank'")
        try await waitUntil("about:blank to be refused before close") { refusedNavigations.contains { $0?.absoluteString == "about:blank" } }
        let hrefBeforeClose = try await eval("location.href") as? String
        XCTAssertEqual(hrefBeforeClose, entry)

        await host.close()
        XCTAssertNotNil(host.webView.navigationDelegate, "the policy stays in charge of the closed view")
        XCTAssertNotNil(host.webView.uiDelegate)
        var seen = refusedNavigations.count
        _ = try? await eval("location.href = 'about:blank'")
        try await waitUntil("the page's about:blank navigation to be refused after close") {
            refusedNavigations.count > seen && refusedNavigations.last??.absoluteString == "about:blank"
        }
        seen = refusedNavigations.count
        _ = try? await eval("location.href = 'https://example.invalid/'")
        try await waitUntil("the page's foreign navigation to be refused after close") {
            refusedNavigations.count > seen && refusedNavigations.last??.host == "example.invalid"
        }
        seen = refusedNavigations.count
        host.webView.load(URLRequest(url: URL(string: "data:text/html,<title>after-close</title>")!))
        try await waitUntil("a native data: load to be refused after close") {
            refusedNavigations.count > seen && refusedNavigations.last??.scheme == "data"
        }
        seen = refusedNavigations.count
        host.webView.load(URLRequest(url: URL(string: entry)!))
        try await waitUntil("a native bundle load to be refused after close") {
            refusedNavigations.count > seen && refusedNavigations.last??.absoluteString == entry
        }
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(host.webView.url?.absoluteString, entry)
        let hrefAfterClose = try await eval("location.href") as? String
        let titleAfterClose = try await eval("document.title") as? String
        XCTAssertEqual(hrefAfterClose, entry)
        XCTAssertEqual(titleAfterClose, title)
        XCTAssertNil(host.currentConnection)
    }

    /// A stray in-bundle link to something the handler cannot answer with a
    /// page (a 404, a script, a folder) is refused before any generation is
    /// spent: the live connection, the page and its runtime all stay.
    func testStrayBundleLinkDoesNotEndTheSession() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let script = try XCTUnwrap(host.schemeHandler.responder.resolver.manifest.assets.first { $0.mediaType == "text/javascript" }?.path)
        for target in ["./nope.txt", "./assets/", "./" + script, "./index.html/"] {
            let seen = refusedNavigations.count
            _ = try? await eval("location.href = '\(target)'")
            try await waitUntil("\(target) to be refused") {
                refusedNavigations.count > seen && refusedNavigations.last??.scheme == "trueconvo-desk"
            }
        }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(host.currentConnection, first)
        XCTAssertEqual(events.value, [.hostConnection(connectionId: first.id, generation: 1, state: .ready, reason: .ready)],
                       "no revoked, no second generation")
        let href = try await eval("location.href") as? String
        XCTAssertEqual(href, "trueconvo-desk://desk/index.html")
        let shellStillUp = try await eval("document.querySelector('.application-shell') !== null && document.querySelector('main.recovery-page') === null") as? Bool
        XCTAssertEqual(shellStillUp, true)
        let afterwards = try await rawPost(envelope(first, operation: "host.capabilities"))
        XCTAssertTrue(afterwards.contains("\"outcome\":\"ok\""), afterwards)
    }

    private func describe(_ decisions: ArraySlice<DeskWebViewHost.NavigationDecision>) -> String {
        decisions.map { decision in
            "type=\(decision.navigationType.rawValue) source=\(decision.sourceURL?.absoluteString ?? "nil") target=\(decision.targetURL?.absoluteString ?? "nil") current=\(decision.currentURL?.absoluteString ?? "nil") document=\(decision.currentDocumentURL?.absoluteString ?? "nil") decision=\(decision.decision)"
        }.joined(separator: " | ")
    }

    /// W2 observation on real WebKit: the page's own skip link
    /// (`<a href="#desk-main">`) then `history.back()` to the fragment-less
    /// URL, then `history.forward()`. Records exactly which policy callbacks
    /// WebKit delivers and whether the document, its bootstrap and the live
    /// connection survive.
    func testSkipLinkThenHistoryBackKeepsTheDocumentAndTheConnection() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let entry = "trueconvo-desk://desk/index.html"
        _ = try await eval("window.__trueConvoProofMarker = 'document-1'; true")
        let registryEventsBefore = events.value.count

        // 1. Skip link, through the page.
        var seen = decisions.count
        let clicked = try await eval("(function () { const a = document.querySelector('a.skip-link'); if (!a) return 'missing'; a.click(); return a.getAttribute('href'); })()") as? String
        XCTAssertEqual(clicked, "#desk-main")
        try await waitForPage("the fragment to be applied", "location.hash === '#desk-main'")
        try await Task.sleep(nanoseconds: 500_000_000)
        let afterSkip = decisions[seen...]
        print("W2-OBSERVE skip-link: callbacks=\(afterSkip.count) \(describe(afterSkip)) webView.url=\(host.webView.url?.absoluteString ?? "nil") canGoBack=\(host.webView.canGoBack) backItems=\(host.webView.backForwardList.backList.map { $0.url.absoluteString })")
        var marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
        var bootstrap = try await pageBootstrap()
        print("W2-OBSERVE skip-link: marker=\(marker ?? "nil") bootstrap=\(bootstrap.connectionId)/\(bootstrap.generation) host=\(host.currentConnection.map { "\($0.id)/\($0.generation)" } ?? "nil") events=\(events.value.dropFirst(registryEventsBefore).map { "\($0.type)/\($0.generation)/\($0.jsonDetail)" })")
        XCTAssertEqual(marker, "document-1", "the skip link keeps the document")
        XCTAssertEqual(bootstrap.connectionId, first.id)
        XCTAssertEqual(host.currentConnection, first)

        // 2. Back to the fragment-less URL, through history.
        seen = decisions.count
        _ = try await eval("history.back(); true")
        try await waitForPage("the fragment to be dropped", "location.href === '\(entry)'")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let afterBack = decisions[seen...]
        print("W2-OBSERVE back: callbacks=\(afterBack.count) \(describe(afterBack)) webView.url=\(host.webView.url?.absoluteString ?? "nil") canGoForward=\(host.webView.canGoForward)")
        marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
        bootstrap = try await pageBootstrap()
        print("W2-OBSERVE back: marker=\(marker ?? "nil") bootstrap=\(bootstrap.connectionId)/\(bootstrap.generation) host=\(host.currentConnection.map { "\($0.id)/\($0.generation)" } ?? "nil") events=\(events.value.dropFirst(registryEventsBefore).map { "\($0.type)/\($0.generation)/\($0.jsonDetail)" })")
        let readAfterBack = try await rawPost("""
        { v: 1, requestId: "\(UUID().uuidString.lowercased())", connectionId: "\(bootstrap.connectionId)", generation: \(bootstrap.generation), operation: "workspace.read", payload: { workspaceHandle: "\(store.workspaceHandle)" } }
        """)
        print("W2-OBSERVE back: workspace.read with the page's bootstrap -> \(readAfterBack.prefix(160))")
        XCTAssertEqual(marker, "document-1", "history.back() over a fragment keeps the document")
        XCTAssertEqual(bootstrap.connectionId, first.id)
        XCTAssertEqual(host.currentConnection, first, "no generation was spent on a same-document traversal")
        XCTAssertTrue(readAfterBack.contains("\"outcome\":\"ok\""), readAfterBack)
        XCTAssertFalse(events.value.contains { if case .hostConnection(_, _, let state, _) = $0 { return state == .revoked } else { return false } }, "\(events.value)")

        // 3. Forward again, through history.
        seen = decisions.count
        _ = try await eval("history.forward(); true")
        try await waitForPage("the fragment to come back", "location.hash === '#desk-main'")
        try await Task.sleep(nanoseconds: 500_000_000)
        let afterForward = decisions[seen...]
        print("W2-OBSERVE forward: callbacks=\(afterForward.count) \(describe(afterForward)) webView.url=\(host.webView.url?.absoluteString ?? "nil")")
        marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
        bootstrap = try await pageBootstrap()
        XCTAssertEqual(marker, "document-1")
        XCTAssertEqual(bootstrap.connectionId, first.id)
        XCTAssertEqual(host.currentConnection, first)
        let readAfterForward = try await rawPost(envelope(first, operation: "host.capabilities"))
        XCTAssertTrue(readAfterForward.contains("\"outcome\":\"ok\""), readAfterForward)
        let shellStillUp = try await eval("document.querySelector('.application-shell') !== null && document.querySelector('main.recovery-page') === null") as? Bool
        XCTAssertEqual(shellStillUp, true)
    }

    /// What a history step must leave behind when WebKit keeps the live
    /// document: the same document (its marker), its bootstrap still the
    /// host's one live connection (no documentless connection), nothing
    /// revoked or issued, a working read, the shell up, and every policy
    /// callback WebKit delivered a same-document allow.
    private func assertKeptLiveDocument(_ connection: HostConnection, marker expected: String, since eventsBefore: Int,
                                        decisionsSince decisionsBefore: Int, _ step: String) async throws {
        let marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertEqual(marker, expected, "\(step): WebKit kept the live document")
        let bootstrap = try await pageBootstrap()
        XCTAssertEqual(bootstrap.connectionId, connection.id, "\(step): the page's bootstrap")
        XCTAssertEqual(host.currentConnection, connection, "\(step): no generation was spent")
        XCTAssertEqual(registry.activeConnectionCount, 1, "\(step): one live connection, the page's own")
        XCTAssertEqual(registry.check(connection.id, generation: connection.generation), .valid, step)
        XCTAssertEqual(events.value.count, eventsBefore, "\(step): nothing revoked or issued: \(events.value.dropFirst(eventsBefore).map { "\($0.type)/\($0.generation)" })")
        XCTAssertEqual(decisions[decisionsBefore...].filter { $0.decision != .allowSameDocument }.count, 0, "\(step): \(describe(decisions[decisionsBefore...]))")
        let read = try await rawPost(readEnvelope(connectionId: connection.id, generation: connection.generation))
        XCTAssertTrue(read.contains("\"outcome\":\"ok\""), "\(step): \(read.prefix(200))")
        let shellStillUp = try await eval("document.querySelector('.application-shell') !== null && document.querySelector('main.recovery-page') === null") as? Bool
        XCTAssertEqual(shellStillUp, true, "\(step): the page never saw a closed connection")
    }

    /// F2 (round 2 of the W2 review), on real WebKit, the reviewer's exact
    /// sequence: the skip link, then a new document at the fragment-less URL
    /// (`location.href`), then native `goBack()` to the earlier document's
    /// fragment entry. WebKit does not load that document: the item differs
    /// from the live document only by its fragment, so it scrolls the live
    /// document, and the policy must agree (`allowSameDocument`, compared
    /// against the URL the host tracked, which the moved back/forward item
    /// and `webView.url` no longer give). Before the fix the policy began
    /// generation 3 for a document that never came: the live document was
    /// revoked and a connection stayed live with no document.
    ///
    /// Then the reverse. WebKit drops the new document's own fragment-less
    /// entry when it scrolls (observed: nothing to go forward to), so
    /// `goForward()` back to it is a no-op; going back again to the fragment
    /// entry, forward to WebKit's replacement entry, back to the first,
    /// fragment-less entry and forward again all keep the same live document
    /// and its connection, whether WebKit asks the policy or traverses in
    /// place. A real reload afterwards still begins a fresh document.
    func testHistoryBackToAnEarlierDocumentsFragmentEntryScrollsTheLiveDocument() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let entry = "trueconvo-desk://desk/index.html"
        let clicked = try await eval("(function () { const a = document.querySelector('a.skip-link'); if (!a) return 'missing'; a.click(); return a.getAttribute('href'); })()") as? String
        XCTAssertEqual(clicked, "#desk-main")
        try await waitForPage("the fragment to be applied", "location.hash === '#desk-main'")
        _ = try? await eval("location.href = '\(entry)'")
        let second = try await waitForHandshake(generation: 2)
        XCTAssertNotEqual(first.id, second.id)
        _ = try await eval("window.__trueConvoProofMarker = 'document-2'; true")
        XCTAssertEqual(host.webView.backForwardList.backList.map { $0.url.absoluteString }, [entry, entry + "#desk-main"])
        let eventsBefore = events.value.count
        let refusedBefore = refusedNavigations.count

        // 1. The reviewer's step: native goBack() to document 1's fragment entry.
        var decisionsBefore = decisions.count
        host.webView.goBack()
        try await waitUntil("the history load to be decided") { decisions.count > decisionsBefore }
        try await waitForPage("the live document to scroll to the fragment", "location.hash === '#desk-main'")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let traversal = decisions[decisionsBefore...]
        print("F2 goBack: \(describe(traversal)) webView.url=\(host.webView.url?.absoluteString ?? "nil") back=\(host.webView.backForwardList.backList.map { $0.url.absoluteString }) forward=\(host.webView.backForwardList.forwardList.map { $0.url.absoluteString }) events=\(events.value.dropFirst(eventsBefore).map { "\($0.type)/\($0.generation)" })")
        XCTAssertEqual(traversal.map(\.navigationType), [.backForward])
        XCTAssertEqual(traversal.map(\.decision), [.allowSameDocument], "a history item differing only by its fragment is a scroll of the live document")
        XCTAssertEqual(traversal.first?.targetURL?.absoluteString, entry + "#desk-main")
        XCTAssertEqual(traversal.first?.currentURL?.absoluteString, entry + "#desk-main", "webView.url already names the destination")
        XCTAssertEqual(traversal.first?.currentDocumentURL?.absoluteString, entry, "compared against the live document the host tracked")
        XCTAssertEqual(refusedNavigations.count, refusedBefore)
        try await assertKeptLiveDocument(second, marker: "document-2", since: eventsBefore, decisionsSince: decisionsBefore, "goBack")

        // 2. The reverse: forward to document 2's own fragment-less entry.
        //    WebKit replaced it while scrolling, so there is none.
        XCTAssertFalse(host.webView.canGoForward, "observed: WebKit drops the fragment-less entry when it scrolls instead (forward=\(host.webView.backForwardList.forwardList.map { $0.url.absoluteString }))")
        decisionsBefore = decisions.count
        host.webView.goForward()
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(decisions.count, decisionsBefore, "a goForward with nothing ahead asks nothing")
        try await assertKeptLiveDocument(second, marker: "document-2", since: eventsBefore, decisionsSince: decisionsBefore, "goForward with nothing ahead")

        // 3. Back to document 1's fragment entry again, forward to WebKit's
        //    replacement entry, back to the first fragment-less entry, and
        //    forward again: one live document throughout.
        let steps: [(String, Bool, String)] = [
            ("goBack to document 1's fragment entry", false, "location.hash === '#desk-main'"),
            ("goForward to WebKit's replacement entry", true, "location.hash === '#desk-main'"),
            ("goBack to document 1's fragment entry again", false, "location.hash === '#desk-main'"),
            ("goBack to the first, fragment-less entry", false, "location.href === '\(entry)'"),
            ("goForward from the fragment-less entry", true, "location.hash === '#desk-main'")
        ]
        for (step, forward, arrived) in steps {
            decisionsBefore = decisions.count
            XCTAssertTrue(forward ? host.webView.canGoForward : host.webView.canGoBack, step)
            if forward { host.webView.goForward() } else { host.webView.goBack() }
            try await waitForPage("\(step) to arrive", arrived)
            try await Task.sleep(nanoseconds: 1_000_000_000)
            print("F2 \(step): callbacks=\(decisions.count - decisionsBefore) \(describe(decisions[decisionsBefore...])) webView.url=\(host.webView.url?.absoluteString ?? "nil") back=\(host.webView.backForwardList.backList.map { $0.url.absoluteString }) forward=\(host.webView.backForwardList.forwardList.map { $0.url.absoluteString })")
            try await assertKeptLiveDocument(second, marker: "document-2", since: eventsBefore, decisionsSince: decisionsBefore, step)
        }

        // A real reload afterwards begins a fresh document as before.
        host.reload()
        let fresh = try await waitForHandshake(after: second.generation)
        XCTAssertNotEqual(fresh.id, second.id)
        let freshBootstrap = try await pageBootstrap()
        XCTAssertEqual(freshBootstrap.connectionId, fresh.id)
        XCTAssertEqual(registry.activeConnectionCount, 1)
        let readWithFresh = try await rawPost(readEnvelope(connectionId: fresh.id, generation: fresh.generation))
        XCTAssertTrue(readWithFresh.contains("\"outcome\":\"ok\""), readWithFresh.prefix(200).description)
    }

    /// F2's other half, on real WebKit: a history load of a genuinely
    /// different document (the bundle root and `index.html` are two
    /// documents) is still a new document: the policy begins a generation,
    /// compared against the live document the host tracked.
    ///
    /// WebKit usually restores such a document from its back/forward cache
    /// instead of loading it, so it does not run the new bootstrap: it comes
    /// back with the one it had, revoked when it was left. Until round 3 of
    /// the review that page showed its closed state while the new
    /// generation's connection stayed live with no document (a recorded
    /// known gap). A restored document commits without a response, which a
    /// loaded one never does; the host now treats that commit as a document
    /// that holds no live connection, revokes the orphan and reloads, so
    /// either way the page on screen ends up a fresh document holding the
    /// one live connection.
    func testHistoryLoadOfADifferentDocumentBeginsANewGeneration() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let entry = "trueconvo-desk://desk/index.html"
        let root = "trueconvo-desk://desk/"
        _ = try await eval("window.__trueConvoProofMarker = 'document-1'; true")
        _ = try? await eval("location.href = '\(root)'")
        let second = try await waitForHandshake(generation: 2)
        XCTAssertNotEqual(first.id, second.id)
        let rootHref = try await eval("location.href") as? String
        XCTAssertEqual(rootHref, root)
        let eventsBefore = events.value.count
        let decisionsBefore = decisions.count

        host.webView.goBack()
        try await waitUntil("the history load to be decided") { decisions.count > decisionsBefore }
        try await waitForPage("the earlier document's URL to be shown", "location.href === '\(entry)'")
        try await Task.sleep(nanoseconds: 2_500_000_000)
        let settled = try await waitForOneWorkingDocument("history load of a different document")
        let traversal = decisions[decisionsBefore...]
        let marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
        print("F2 cross-document goBack: \(describe(traversal)) marker=\(marker ?? "nil") settled=\(settled.id)/\(settled.generation) active=\(registry.activeConnectionCount) events=\(events.value.dropFirst(eventsBefore).map { "\($0.type)/\($0.generation)" })")
        XCTAssertEqual(traversal.first?.navigationType, .backForward)
        XCTAssertEqual(traversal.first?.decision, .allowNewDocument, "a different document through history begins a generation")
        XCTAssertEqual(traversal.first?.targetURL?.absoluteString, entry)
        XCTAssertEqual(traversal.first?.currentDocumentURL?.absoluteString, root, "compared against the live document the host tracked")
        XCTAssertTrue(events.value.contains(.hostConnection(connectionId: second.id, generation: second.generation, state: .revoked, reason: .navigation)),
                      "the document left behind was told")
        XCTAssertEqual(registry.check(second.id, generation: second.generation), .staleGeneration)
        XCTAssertGreaterThan(settled.generation, second.generation)
        XCTAssertNil(marker, "the page on screen is a freshly loaded document, not the restored one")
        let href = try await eval("location.href") as? String
        XCTAssertEqual(href, entry)
        XCTAssertEqual(host.committedDocumentURL?.absoluteString, entry)
    }

    /// F2's boundary, on real WebKit: a history load of an entry without a
    /// fragment is a document load even when its URL equals the live
    /// document's ignoring the live fragment, because WebKit scrolls only
    /// toward a fragment. Document 1 makes `index.html` and `#desk-main`;
    /// document 2 (`location.href`) moves to its own `#desk-main`; going
    /// back to document 1's first entry loads a fresh document, so the
    /// policy must begin a generation for it. Taken for a scroll instead,
    /// the fresh document would run under document 2's still-live bootstrap
    /// without a generation of its own.
    func testHistoryLoadOfAFragmentlessEntryIsANewDocument() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let entry = "trueconvo-desk://desk/index.html"
        _ = try await eval("window.__trueConvoProofMarker = 'document-1'; document.querySelector('a.skip-link').click(); true")
        try await waitForPage("the fragment on document 1", "location.hash === '#desk-main'")
        _ = try? await eval("location.href = '\(entry)'")
        let second = try await waitForHandshake(generation: 2)
        XCTAssertNotEqual(first.id, second.id)
        _ = try await eval("window.__trueConvoProofMarker = 'document-2'; document.querySelector('a.skip-link').click(); true")
        try await waitForPage("the fragment on document 2", "location.hash === '#desk-main'")
        try await waitUntil("the host to track document 2's fragment") { host.committedDocumentURL?.absoluteString == entry + "#desk-main" }
        let target = try XCTUnwrap(host.webView.backForwardList.backList.first)
        XCTAssertEqual(target.url.absoluteString, entry)
        let eventsBefore = events.value.count
        let decisionsBefore = decisions.count

        host.webView.go(to: target)
        let third = try await waitForHandshake(after: second.generation)
        let traversal = decisions[decisionsBefore...]
        print("F2 fragment-less history entry: \(describe(traversal)) events=\(events.value.dropFirst(eventsBefore).map { "\($0.type)/\($0.generation)" })")
        XCTAssertEqual(traversal.map(\.navigationType), [.backForward])
        XCTAssertEqual(traversal.map(\.decision), [.allowNewDocument], "no fragment to scroll to: a document load")
        XCTAssertEqual(traversal.first?.targetURL?.absoluteString, entry)
        XCTAssertEqual(traversal.first?.currentDocumentURL?.absoluteString, entry + "#desk-main", "compared against the live document the host tracked")
        XCTAssertEqual(third.generation, second.generation + 1)
        XCTAssertTrue(events.value.contains(.hostConnection(connectionId: second.id, generation: second.generation, state: .revoked, reason: .navigation)),
                      "the document left behind was told")
        let marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(marker, "WebKit loaded a fresh document")
        let bootstrap = try await pageBootstrap()
        XCTAssertEqual(bootstrap.connectionId, third.id)
        XCTAssertEqual(registry.activeConnectionCount, 1)
        let read = try await rawPost(readEnvelope(connectionId: third.id, generation: third.generation))
        XCTAssertTrue(read.contains("\"outcome\":\"ok\""), read.prefix(200).description)
    }

    /// F2's tracking of same-document changes, on real WebKit: after the
    /// page's own `pushState` the live document's URL is the pushed one. A
    /// fragment change on it keeps the document and its connection, and a
    /// navigation to the URL it replaced is a new document with a fresh
    /// bootstrap. Taking the URL only at commit had both backwards: the
    /// fragment change revoked the live document and left a connection with
    /// no document, and the new document ran without a generation of its own.
    func testSameDocumentURLChangesAreTrackedForTheFragmentRule() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let entry = "trueconvo-desk://desk/index.html"
        let pushed = "trueconvo-desk://desk/?x=1"
        _ = try await eval("window.__trueConvoProofMarker = 'document-1'; history.pushState(null, '', '\(pushed)'); true")
        let eventsBefore = events.value.count
        var decisionsBefore = decisions.count

        _ = try await eval("location.hash = 'a'; true")
        try await waitForPage("the fragment on the pushed URL", "location.href === '\(pushed)#a'")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        print("F2 pushState then hash: \(describe(decisions[decisionsBefore...]))")
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowSameDocument])
        XCTAssertEqual(decisions[decisionsBefore...].first?.currentDocumentURL?.absoluteString, pushed, "the pushed URL is the live document's")
        try await assertKeptLiveDocument(first, marker: "document-1", since: eventsBefore, decisionsSince: decisionsBefore, "hash on the pushed URL")

        decisionsBefore = decisions.count
        _ = try? await eval("location.href = '\(entry)#b'")
        let second = try await waitForHandshake(generation: 2)
        print("F2 href to the replaced URL: \(describe(decisions[decisionsBefore...]))")
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowNewDocument], "index.html is not the live document any more")
        XCTAssertEqual(decisions[decisionsBefore...].first?.currentDocumentURL?.absoluteString, pushed + "#a")
        let marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(marker, "WebKit loaded a new document")
        let bootstrap = try await pageBootstrap()
        XCTAssertEqual(bootstrap.connectionId, second.id)
        XCTAssertEqual(registry.activeConnectionCount, 1)
        let read = try await rawPost(readEnvelope(connectionId: second.id, generation: second.generation))
        XCTAssertTrue(read.contains("\"outcome\":\"ok\""), read.prefix(200).description)
    }

    /// F1 (round 2 of the review), on real WebKit, the reviewer's exact
    /// ordering: load and handshake; lock; an unlock requested; one yield,
    /// so its step is queued; a second lock; the unlock awaited. The second
    /// lock wins: host and store both locked, a reload is cancelled and
    /// issues nothing, and the next unlock reopens both, after which a
    /// reload handshakes and reads. Before the fix the unlock step cleared
    /// the host's flag last: host unlocked over a locked store, the reload
    /// issued a connection against it, and every later `unlock()` was a
    /// no-op that left the store locked for good.
    func testLockDuringAnUnlockStepLeavesHostAndStoreLocked() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        await host.lock()
        XCTAssertTrue(host.isLocked)
        XCTAssertTrue(store.isLocked)

        let unlocking = Task { @MainActor in await host.unlock() }
        await Task.yield()
        await host.lock()
        await unlocking.value
        print("F1 after lock, unlock in flight, lock: host.isLocked=\(host.isLocked) store.isLocked=\(store.isLocked) generation=\(registry.currentGeneration)")
        XCTAssertTrue(host.isLocked, "the later lock wins")
        XCTAssertTrue(store.isLocked, "host and store agree")

        let readyBefore = readyEvents().count
        let decisionsBefore = decisions.count
        host.reload()
        try await waitUntil("the locked reload to be decided") { decisions.count > decisionsBefore }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        print("F1 reload while locked: \(describe(decisions[decisionsBefore...])) active=\(registry.activeConnectionCount)")
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.cancel], "the reload is cancelled")
        XCTAssertEqual(readyEvents().count, readyBefore, "no connection is issued while locked")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
        let lockedBootstrap = try await pageBootstrap()
        XCTAssertEqual(lockedBootstrap.connectionId, first.id, "the locked page keeps its document")

        await host.unlock()
        XCTAssertFalse(host.isLocked, "unlock is not a no-op")
        XCTAssertFalse(store.isLocked, "unlock reopens the store")
        let generation = registry.currentGeneration
        host.reload()
        let fresh = try await waitForHandshake(after: generation)
        XCTAssertNotEqual(fresh.id, first.id)
        let freshBootstrap = try await pageBootstrap()
        XCTAssertEqual(freshBootstrap.connectionId, fresh.id)
        XCTAssertEqual(registry.activeConnectionCount, 1)
        let read = try await rawPost(readEnvelope(connectionId: fresh.id, generation: fresh.generation))
        XCTAssertTrue(read.contains("\"outcome\":\"ok\""), read.prefix(200).description)
    }

    /// F1 on real WebKit, deterministically. The reviewer's ordering above
    /// lands the second lock wherever the scheduler puts it (on one run
    /// inside the unlock step, on another after it), so here the test seam
    /// lands it at each hop of the unlock step in turn: before the step
    /// starts, after its revocation, and after the store reopened. Each time,
    /// on the real view with the pinned page loaded, the later lock wins:
    /// host and store locked, a reload cancelled with nothing issued, and
    /// the next unlock reopens both, after which a reload handshakes and
    /// reads. Before the fix the first two landings left the host unlocked
    /// over a locked store, the reload issued a connection against it, and
    /// `unlock()` stayed a no-op for good.
    func testLockLandingOnEachHopOfAnUnlockStepWinsOnTheRealView() async throws {
        let host = try XCTUnwrap(self.host)
        host.load()
        var live = try await waitForHandshake(generation: 1)
        for landing in [DeskWebViewHost.LifecycleCheckpoint.unlockStepStarted, .unlockStepRevoked, .unlockStepReopened] {
            await host.lock()
            var relock: Task<Void, Never>?
            host.lifecycleCheckpoint = { point in
                guard point == landing, relock == nil else { return }
                let queued = host.lifecycleStepsQueued
                relock = Task { @MainActor in await host.lock() }
                // Let that lock run up to its own suspension: flag set, step queued.
                for _ in 0..<200 where host.lifecycleStepsQueued == queued { await Task.yield() }
            }
            await host.unlock()
            await relock?.value
            host.lifecycleCheckpoint = nil
            print("F1 real view, second lock at \(landing): host.isLocked=\(host.isLocked) store.isLocked=\(store.isLocked) generation=\(registry.currentGeneration)")
            XCTAssertNotNil(relock, "\(landing): the second lock landed")
            XCTAssertTrue(host.isLocked, "\(landing): the later lock wins")
            XCTAssertTrue(store.isLocked, "\(landing): host and store agree")

            let readyBefore = readyEvents().count
            let decisionsBefore = decisions.count
            host.reload()
            try await waitUntil("\(landing): the locked reload to be decided") { decisions.count > decisionsBefore }
            try await Task.sleep(nanoseconds: 500_000_000)
            XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.cancel], "\(landing): \(describe(decisions[decisionsBefore...]))")
            XCTAssertEqual(readyEvents().count, readyBefore, "\(landing): no connection is issued while locked")
            XCTAssertEqual(registry.activeConnectionCount, 0, "\(landing)")
            XCTAssertNil(host.currentConnection, "\(landing)")

            await host.unlock()
            XCTAssertFalse(host.isLocked, "\(landing): unlock is not a no-op")
            XCTAssertFalse(store.isLocked, "\(landing): unlock reopens the store")
            let generation = registry.currentGeneration
            host.reload()
            let fresh = try await waitForHandshake(after: generation)
            XCTAssertNotEqual(fresh.id, live.id)
            let freshBootstrap = try await pageBootstrap()
            XCTAssertEqual(freshBootstrap.connectionId, fresh.id, "\(landing)")
            XCTAssertEqual(registry.activeConnectionCount, 1, "\(landing)")
            let read = try await rawPost(readEnvelope(connectionId: fresh.id, generation: fresh.generation))
            XCTAssertTrue(read.contains("\"outcome\":\"ok\""), "\(landing): \(read.prefix(200))")
            live = fresh
        }
    }

    /// W1 (Codex review of 6052518): a reload while the store is locked must
    /// not issue a connection or bootstrap a document, and unlock alone must
    /// not revive anything. The bootstrap the locked document holds stays
    /// refused after unlock; only a fresh authorized load works again.
    func testConnectionIssuedWhileLockedDoesNotSurviveUnlock() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        await host.lock()
        try await waitUntil("the locked event") {
            events.value.contains(.hostConnection(connectionId: first.id, generation: 1, state: .locked, reason: .lock))
        }
        try await waitForPage("the page to show its closed state",
                              "document.querySelector('main.recovery-page h1')?.textContent === 'Workspace connection closed'")
        XCTAssertTrue(host.isLocked)
        XCTAssertNil(host.currentConnection)
        let readyBefore = readyEvents().count
        let decisionsBefore = decisions.count

        // Reload while locked, the way the page's own "Try loading again" does it.
        _ = try? await eval("location.reload()")
        try await waitUntil("the locked reload to be decided") { decisions.count > decisionsBefore }
        try await Task.sleep(nanoseconds: 2_000_000_000)
        let lockedBootstrap = try await pageBootstrap()
        print("W1 locked reload: decisions=\(describe(decisions[decisionsBefore...])) page bootstrap=\(lockedBootstrap.connectionId)/\(lockedBootstrap.generation) ready events since lock=\(readyEvents().count - readyBefore)")
        XCTAssertEqual(readyEvents().count - readyBefore, 0, "no connection is issued while locked")
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.cancel], "the locked reload is cancelled, not bootstrapped")
        XCTAssertEqual(decisions[decisionsBefore...].map(\.navigationType), [.reload])
        XCTAssertTrue(refusedNavigations.contains { $0?.absoluteString == "trueconvo-desk://desk/index.html" })
        XCTAssertEqual(lockedBootstrap.connectionId, first.id, "the locked page keeps its document and its dead bootstrap")
        XCTAssertNil(host.currentConnection)
        let marker = try await eval("document.querySelector('main.recovery-page h1')?.textContent ?? null") as? String
        XCTAssertEqual(marker, "Workspace connection closed", "the page stays on its closed state")

        // Unlock without another reload: the locked document's bootstrap must not read.
        await host.unlock()
        XCTAssertFalse(host.isLocked)
        XCTAssertNil(host.currentConnection, "unlock bootstraps nothing")
        let readWithLockedBootstrap = try await rawPost(readEnvelope(connectionId: lockedBootstrap.connectionId, generation: lockedBootstrap.generation))
        XCTAssertFalse(readWithLockedBootstrap.contains("\"outcome\":\"ok\""), "a bootstrap from the locked document read after unlock: \(readWithLockedBootstrap.prefix(200))")
        XCTAssertTrue(readWithLockedBootstrap.contains("\"reason\":\"stale-generation\"") || readWithLockedBootstrap.contains("\"reason\":\"unknown-connection\""),
                      readWithLockedBootstrap.prefix(200).description)
        let readWithFirst = try await rawPost(readEnvelope(connectionId: first.id, generation: first.generation))
        XCTAssertFalse(readWithFirst.contains("\"outcome\":\"ok\""), readWithFirst.prefix(200).description)

        // A fresh authorized load handshakes and reads.
        host.reload()
        let fresh = try await waitForHandshake(after: lockedBootstrap.generation)
        XCTAssertNotEqual(fresh.id, lockedBootstrap.connectionId)
        let freshBootstrap = try await pageBootstrap()
        XCTAssertEqual(freshBootstrap.connectionId, fresh.id)
        let readWithFresh = try await rawPost(readEnvelope(connectionId: fresh.id, generation: fresh.generation))
        XCTAssertTrue(readWithFresh.contains("\"outcome\":\"ok\""), readWithFresh.prefix(200).description)
        let stillRefused = try await rawPost(readEnvelope(connectionId: lockedBootstrap.connectionId, generation: lockedBootstrap.generation))
        XCTAssertTrue(stillRefused.contains("\"reason\":\"stale-generation\""), stillRefused.prefix(200).description)
    }

    /// W3 (Codex review of 6052518), through the real handler: a payload
    /// holding two million zeros is refused `payload-too-large` from its
    /// count, before any element is converted, and the host answers the next
    /// ordinary request as before.
    func testOversizeStructuralPayloadIsRefusedPromptlyThroughTheRealHandler() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let requestId = UUID().uuidString.lowercased()
        let started = Date()
        let reply = try await callAsync("""
        const zeros = new Array(2000000).fill(0);
        const env = { v: 1, requestId: "\(requestId)", connectionId: "\(first.id)", generation: \(first.generation), operation: "host.capabilities", payload: { zeros } };
        const t0 = performance.now();
        try { const r = await window.webkit.messageHandlers.trueConvoHost.postMessage(env); return JSON.stringify({ reply: r, ms: performance.now() - t0 }); }
        catch (e) { return "rejected:" + String(e); }
        """) as? String
        let elapsed = Date().timeIntervalSince(started)
        let text = try XCTUnwrap(reply)
        print("W3 real handler: 2,000,000 zeros round trip \(Int(elapsed * 1000)) ms: \(text.prefix(300))")
        XCTAssertTrue(text.contains("\"reason\":\"payload-too-large\""), text.prefix(300).description)
        XCTAssertTrue(text.contains("\"requestId\":\"\""), "refused before the envelope was read: \(text.prefix(300))")
        XCTAssertLessThan(elapsed, 5, "the reply must not wait on a conversion of two million elements")
        let afterwards = try await rawPost(envelope(first, operation: "host.capabilities"))
        XCTAssertTrue(afterwards.contains("\"outcome\":\"ok\""), afterwards.prefix(200).description)
        XCTAssertEqual(host.currentConnection, first)
        XCTAssertFalse(exchanges.contains { if case .transportFailure = $0 { return true } else { return false } }, "\(exchanges)")
    }

    // MARK: Round 3 of the review: navigations WebKit drops or misjudges

    private static let shellUp = "document.querySelector('.application-shell') !== null && document.querySelector('main.recovery-page') === null"

    /// Where every race must end once WebKit is done: one live connection,
    /// the host's current one, carried by the document on screen, which
    /// reads with it and shows the shell, and still does a second later.
    /// Never a revoked page next to a connection no document holds.
    @discardableResult
    private func waitForOneWorkingDocument(_ step: String, timeout: TimeInterval = 15) async throws -> HostConnection {
        func working() async -> (HostConnection?, String) {
            let bootstrap = try? await pageBootstrap()
            let shell = (try? await eval(Self.shellUp)) as? Bool
            let current = host.currentConnection
            let state = "page bootstrap=\(bootstrap.map { "\($0.connectionId.prefix(8))/\($0.generation)" } ?? "nil") host=\(current.map { "\($0.id.prefix(8))/\($0.generation)" } ?? "nil") active=\(registry.activeConnectionCount) shell=\(String(describing: shell)) loading=\(host.webView.isLoading) url=\(host.webView.url?.absoluteString ?? "nil")"
            guard !host.webView.isLoading, let current, let bootstrap, bootstrap.connectionId == current.id, bootstrap.generation == current.generation,
                  registry.activeConnectionCount == 1, registry.check(current.id, generation: current.generation) == .valid, shell == true else {
                return (nil, state)
            }
            return (current, state)
        }
        var last = ""
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let (connection, state) = await working()
            last = state
            if let connection {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                let (again, stateAgain) = await working()
                XCTAssertEqual(again, connection, "\(step): settled, then changed: \(stateAgain)")
                let read = try await rawPost(readEnvelope(connectionId: connection.id, generation: connection.generation))
                XCTAssertTrue(read.contains("\"outcome\":\"ok\""), "\(step): \(read.prefix(200))")
                return connection
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("\(step): never settled on one working document with one live connection: \(last)")
        throw ProofFailure.timeout(step)
    }

    /// Round 3 (both reviewers): a document navigation WebKit drops because
    /// the page asked for another main-frame navigation while the policy's
    /// answer was pending. WebKit keeps one open policy question per frame
    /// and gives no callback for the one it dropped. Before the fix the host
    /// still began the dropped navigation's generation: the live page was
    /// revoked and showed "Workspace connection closed", and the new
    /// connection stayed live with no document (3 of 3 runs for each of
    /// these orderings, reviewer probes B, D, test11a/11b, and C at 0 ms).
    /// Now the host either never begins it (the page keeps its document and
    /// connection) or, when the generation had already begun, revokes the
    /// orphan and reloads, so a fresh document holds the one live connection.
    func testDocumentNavigationDroppedForALaterOneLeavesOneWorkingDocument() async throws {
        host.load()
        var live = try await waitForHandshake(generation: 1)
        let orderings: [(String, () -> Void)] = [
            ("native reload, then the skip link in the same turn", { [unowned self] in
                host.reload()
                host.webView.evaluateJavaScript("document.querySelector('a.skip-link').click(); true", completionHandler: nil)
            }),
            ("native reload, then a stray link the policy cancels, in the same turn", { [unowned self] in
                host.reload()
                host.webView.evaluateJavaScript("location.href = './nope.txt'; true", completionHandler: nil)
            }),
            ("a link to index.html, then location.hash, in one task", { [unowned self] in
                host.webView.evaluateJavaScript("(function () { const a = document.createElement('a'); a.href = 'index.html'; document.body.appendChild(a); a.click(); location.hash = 'x'; return true; })()", completionHandler: nil)
            }),
            ("native reload, then location.hash", { [unowned self] in
                host.reload()
                host.webView.evaluateJavaScript("location.hash = 'y'; true", completionHandler: nil)
            }),
            ("location.reload(), then the skip link on a zero timer", { [unowned self] in
                host.webView.evaluateJavaScript("location.reload(); setTimeout(function () { document.querySelector('a.skip-link').click(); }, 0); true", completionHandler: nil)
            })
        ]
        for (step, race) in orderings {
            _ = try await eval("window.__trueConvoProofMarker = 'kept'; true")
            let decisionsBefore = decisions.count
            race()
            try await Task.sleep(nanoseconds: 2_500_000_000)
            let settled: HostConnection
            do {
                settled = try await waitForOneWorkingDocument(step)
            } catch {
                // Recorded as a failure; recover so the next ordering runs.
                print("ROUND3 dropped navigation, \(step): FAILED \(describe(decisions[decisionsBefore...]))")
                let generation = registry.currentGeneration
                host.reload()
                live = try await waitForHandshake(after: generation)
                continue
            }
            let marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
            print("ROUND3 dropped navigation, \(step): \(describe(decisions[decisionsBefore...])) kept=\(marker == "kept") connection=\(settled.generation) (was \(live.generation))")
            if marker == "kept" {
                XCTAssertEqual(settled, live, "\(step): the kept document kept its connection")
            } else {
                XCTAssertGreaterThan(settled.generation, live.generation, "\(step): a fresh document has a fresh generation")
            }
            live = settled
        }
    }

    /// The same drop, landing after the reload's generation began (the live
    /// page's connection is already revoked, and the page has switched to its
    /// closed screen, so no skip link): held at the step's checkpoint, the
    /// page sets `location.hash`, and WebKit's question about it arrives
    /// before the host answers the reload. WebKit drops the reload. The host
    /// answers it `cancel`, revokes the connection it had issued for it, and
    /// reloads once; the view ends on a fresh document holding the one live
    /// connection. (Reviewer probe K reached this window at 0 to 3 ms.)
    func testDocumentNavigationDroppedAfterItsGenerationBeganIsRecoveredOnTheRealView() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let entry = "trueconvo-desk://desk/index.html"
        _ = try await eval("window.__trueConvoProofMarker = 'kept'; true")
        var dropped: [URL?] = []
        host.onNavigationDropped = { dropped.append($0) }
        var injected = false
        host.lifecycleCheckpoint = { [unowned self] point in
            guard point == .documentStepRevoked, !injected else { return }
            injected = true
            let seen = decisions.count
            host.webView.evaluateJavaScript("location.hash = 'dropped'; true", completionHandler: nil)
            for _ in 0..<300 where decisions.count == seen { try? await Task.sleep(nanoseconds: 10_000_000) }
        }
        let decisionsBefore = decisions.count
        let eventsBefore = events.value.count
        host.reload()
        try await Task.sleep(nanoseconds: 2_500_000_000)
        let settled = try await waitForOneWorkingDocument("reload dropped after its generation began")
        host.lifecycleCheckpoint = nil
        let traversal = decisions[decisionsBefore...]
        print("ROUND3 dropped after begin: \(describe(traversal)) events=\(events.value.dropFirst(eventsBefore).map { "\($0.type)/\($0.generation)" })")
        XCTAssertTrue(injected)
        XCTAssertEqual(Array(traversal.prefix(3)).map(\.navigationType), [.reload, .other, .reload], "the reload, location.hash, then the host's own reload")
        XCTAssertEqual(Array(traversal.prefix(3)).map(\.decision), [.allowNewDocument, .allowSameDocument, .allowNewDocument])
        XCTAssertEqual(dropped.map { $0?.absoluteString }, [entry], "the first reload was reported dropped")
        let marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(marker, "the recovery loaded a fresh document")
        XCTAssertGreaterThanOrEqual(settled.generation, first.generation + 3, "the dropped reload's generation, the recovery's, the fresh document's")
        let issuedForDropped = events.value.dropFirst(eventsBefore).compactMap { event -> String? in
            guard case .hostConnection(let id, let generation, .ready, _) = event, generation == first.generation + 1 else { return nil }
            return id
        }
        XCTAssertEqual(issuedForDropped.count, 1)
        if let orphan = issuedForDropped.first {
            XCTAssertNotEqual(registry.check(orphan, generation: first.generation + 1), .valid, "the dropped reload's connection was revoked")
            XCTAssertTrue(events.value.contains(.hostConnection(connectionId: orphan, generation: first.generation + 1, state: .revoked, reason: .navigation)),
                          "and told so")
        }
    }

    /// Round 3 (lifecycle reviewer): the app asks for a native fragment load
    /// in the instant after a page navigation's response was allowed and
    /// before WebKit reports its commit. `webView.url` already names the
    /// native destination at that commit, so the host used to record it as
    /// the live document, judge the native load a same-document scroll, and
    /// let WebKit's fresh document run on the previous document's still-live
    /// connection (5 of 5 runs). The committed URL now comes from the
    /// navigation's own response.
    func testNativeFragmentLoadRequestedJustBeforeACommitIsANewDocument() async throws {
        let proxy = ForwardingNavigationDelegate(host: host)
        host.webView.navigationDelegate = proxy
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let root = "trueconvo-desk://desk/"
        let target = try XCTUnwrap(URL(string: "trueconvo-desk://desk/index.html#desk-main"))
        _ = try await eval("window.__trueConvoProofMarker = 'document-1'; true")
        proxy.afterMainFrameResponseAllowed = { [unowned self] _ in
            DispatchQueue.main.async { self.host.webView.load(URLRequest(url: target)) }
        }
        let decisionsBefore = decisions.count
        _ = try? await eval("location.href = '\(root)'")
        try await Task.sleep(nanoseconds: 2_500_000_000)
        let settled = try await waitForOneWorkingDocument("native fragment load in the commit window")
        let traversal = decisions[decisionsBefore...]
        print("ROUND3 commit window: \(describe(traversal)) log=\(proxy.log)")
        XCTAssertEqual(traversal.map(\.targetURL?.absoluteString), [root, target.absoluteString])
        XCTAssertEqual(traversal.last?.currentDocumentURL?.absoluteString, root, "judged against the document that committed, not the pending destination")
        XCTAssertEqual(traversal.map(\.decision), [.allowNewDocument, .allowNewDocument])
        XCTAssertGreaterThanOrEqual(settled.generation, first.generation + 2, "each of the two documents began its own generation")
        let href = try await eval("location.href") as? String
        XCTAssertEqual(href, target.absoluteString)
        let loadedAs = try await eval("performance.getEntriesByType('navigation')[0].name") as? String
        XCTAssertEqual(loadedAs, target.absoluteString, "WebKit loaded a fresh document for the native fragment load")
        XCTAssertEqual(host.committedDocumentURL?.absoluteString, target.absoluteString)
    }

    /// Round 3 (history reviewer): a native load of exactly the live URL,
    /// fragment included, is a full load in WebKit (`FrameLoadType::Same`,
    /// marked with the reload-ignoring-cache policy), not a scroll. The
    /// policy used to take it for a fragment navigation, and the fresh
    /// document ran on the replaced document's still-live connection. The
    /// page's own navigation to its identical URL still scrolls.
    func testNativeLoadOfTheIdenticalFragmentURLIsANewDocument() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        let entry = "trueconvo-desk://desk/index.html"
        _ = try await eval("window.__trueConvoProofMarker = 'document-1'; document.querySelector('a.skip-link').click(); true")
        try await waitForPage("the skip link's fragment", "location.hash === '#desk-main'")
        try await waitUntil("the host to track the fragment") { host.committedDocumentURL?.absoluteString == entry + "#desk-main" }

        var decisionsBefore = decisions.count
        _ = try await eval("location.href = location.href; true")
        try await waitForPage("the page's identical navigation", "location.hash === '#desk-main'")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowSameDocument], "the page's own identical navigation scrolls: \(describe(decisions[decisionsBefore...]))")
        try await waitForOneWorkingDocument("page identical navigation")
        let stillFirst = try await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertEqual(stillFirst, "document-1")
        XCTAssertEqual(host.currentConnection, first)

        decisionsBefore = decisions.count
        host.webView.load(URLRequest(url: URL(string: entry + "#desk-main")!))
        let second = try await waitForHandshake(after: first.generation)
        print("ROUND3 native identical load: \(describe(decisions[decisionsBefore...]))")
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowNewDocument])
        let marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(marker, "WebKit loaded a fresh document")
        let bootstrap = try await pageBootstrap()
        XCTAssertEqual(bootstrap.connectionId, second.id)
        try await waitForOneWorkingDocument("native identical load")

        // A fragment-only native load scrolls; the same load again is a reload.
        _ = try await eval("window.__trueConvoProofMarker = 'document-2'; true")
        decisionsBefore = decisions.count
        host.webView.load(URLRequest(url: URL(string: entry + "#other")!))
        try await waitForPage("the native fragment", "location.hash === '#other'")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowSameDocument])
        let kept = try await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertEqual(kept, "document-2")
        XCTAssertEqual(host.currentConnection, second)
        decisionsBefore = decisions.count
        host.webView.load(URLRequest(url: URL(string: entry + "#other")!))
        let third = try await waitForHandshake(after: second.generation)
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowNewDocument])
        let fresh = try await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(fresh)
        let settled = try await waitForOneWorkingDocument("native identical load again")
        XCTAssertEqual(settled, third)
    }

    // MARK: Round 4 of the review: lock, termination, restores, navigations WebKit never starts

    private static let deskEntry = "trueconvo-desk://desk/index.html"
    private static let deskRoot = "trueconvo-desk://desk/"

    /// The locked page as the lock left it: its own document (the marker),
    /// the page's closed screen, nothing live, nothing answered `ok` since
    /// `exchangesBefore`.
    private func assertLockedPageKeptItsDocument(marker expected: String, since exchangesBefore: Int, _ step: String) async throws {
        let marker = try? await eval("window.__trueConvoProofMarker ?? null") as? String
        let heading = try? await eval("document.querySelector('main.recovery-page h1')?.textContent ?? null") as? String
        XCTAssertEqual(marker, expected, "\(step): the locked page keeps its document")
        XCTAssertEqual(heading, "Workspace connection closed", "\(step): the locked page shows its closed state")
        XCTAssertTrue(host.isLocked, step)
        XCTAssertTrue(store.isLocked, step)
        XCTAssertEqual(registry.activeConnectionCount, 0, "\(step): nothing live while locked")
        XCTAssertNil(host.currentConnection, step)
        let okSince = exchanges.dropFirst(exchangesBefore).filter { if case .replied(_, _, _, .ok, _) = $0 { return true } else { return false } }
        XCTAssertTrue(okSince.isEmpty, "\(step): nothing answered ok while locked: \(okSince)")
    }

    /// Unlock, then the app's reload: one working document again.
    @discardableResult
    private func unlockAndReload(_ step: String) async throws -> HostConnection {
        await host.unlock()
        XCTAssertFalse(host.isLocked, step)
        XCTAssertFalse(store.isLocked, step)
        host.reload()
        return try await waitForOneWorkingDocument("\(step): unlock and reload")
    }

    /// R4-LT-1, on real WebKit: a lock requested in the one main-actor turn
    /// between a reload's document step returning and the policy's answer
    /// (here from `onDocumentBegan`). Before the fix the answer was `allow`
    /// with the host locked: WebKit committed a fresh document on the
    /// connection the lock then revoked, and it showed "Workspace
    /// unavailable" instead of the locked page (3 of 3 reviewer runs). Now
    /// the answer is `cancel` and the locked page keeps its document.
    func testLockRequestedJustAfterADocumentStepCancelsThatNavigation() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        _ = try await eval("window.__trueConvoProofMarker = 'locked-page'; true")
        var lockTask: Task<Void, Never>?
        host.onDocumentBegan = { [unowned self] connection in
            guard connection.generation > first.generation, lockTask == nil else { return }
            lockTask = Task { @MainActor in await self.host.lock() }
        }
        let decisionsBefore = decisions.count
        let exchangesBefore = exchanges.count
        let refusedBefore = refusedNavigations.count
        host.reload()
        try await waitUntil("the lock requested from the reload's document step") { lockTask != nil }
        await lockTask?.value
        host.onDocumentBegan = nil
        try await Task.sleep(nanoseconds: 2_000_000_000)
        print("ROUND4 LT-1: \(describe(decisions[decisionsBefore...])) refused=\(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString ?? "nil" })")
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowNewDocument], "decided before the lock")
        XCTAssertEqual(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString }, [Self.deskEntry], "answered cancel once the lock was requested")
        try await assertLockedPageKeptItsDocument(marker: "locked-page", since: exchangesBefore, "LT-1")
        let fresh = try await unlockAndReload("LT-1")
        XCTAssertGreaterThan(fresh.generation, first.generation)
    }

    /// R4-LT-2, on real WebKit: a reload (native, or the page's own
    /// `location.reload()`) answered `allow` while unlocked, then a lock
    /// before WebKit commits it. Before the fix the lock stopped nothing and
    /// allowed the response: the navigation committed while locked and
    /// replaced the locked page with a fresh document on a revoked bootstrap
    /// (9 of 9 reviewer runs). Now the lock stops it, or its response is
    /// refused, and the locked page keeps its document. The documented
    /// exception, a lock landing after WebKit already accepted the response,
    /// still commits; it is checked here for what must hold anyway: nothing
    /// live, nothing answered, and unlock plus reload works.
    func testLockAfterADocumentNavigationWasAllowedKeepsTheLockedDocument() async throws {
        let proxy = ForwardingNavigationDelegate(host: host)
        host.webView.navigationDelegate = proxy
        host.load()
        var live = try await waitForHandshake(generation: 1)
        enum Landing { case afterAllow, afterStart, afterResponse }
        let runs: [(String, Bool, Landing)] = [
            ("native reload, lock right after the allow", false, .afterAllow),
            ("the page's location.reload(), lock right after the allow", true, .afterAllow),
            ("native reload, lock right after the provisional start", false, .afterStart),
            ("the page's location.reload(), lock right after the provisional start", true, .afterStart),
            ("native reload, lock right after the response was accepted (the exception)", false, .afterResponse)
        ]
        for (step, fromPage, landing) in runs {
            _ = try await eval("window.__trueConvoProofMarker = 'locked-page'; true")
            var lockTask: Task<Void, Never>?
            let lockNow: () -> Void = { [unowned self] in lockTask = Task { @MainActor in await self.host.lock() } }
            switch landing {
            case .afterAllow: proxy.afterDocumentActionAllowed = { _ in lockNow() }
            case .afterStart: proxy.afterProvisionalStart = { lockNow() }
            case .afterResponse: proxy.afterMainFrameResponseAllowed = { _ in lockNow() }
            }
            let exchangesBefore = exchanges.count
            proxy.log.removeAll()
            if fromPage {
                host.webView.evaluateJavaScript("location.reload(); true", completionHandler: nil)
            } else {
                host.reload()
            }
            try await waitUntil("\(step): the lock") { lockTask != nil }
            await lockTask?.value
            try await Task.sleep(nanoseconds: 2_000_000_000)
            print("ROUND4 LT-2 \(step): \(proxy.log.joined(separator: " || "))")
            if landing == .afterResponse {
                XCTAssertTrue(host.isLocked, step)
                XCTAssertTrue(store.isLocked, step)
                XCTAssertEqual(registry.activeConnectionCount, 0, "\(step): nothing live while locked")
                XCTAssertNil(host.currentConnection, step)
                let okSince = exchanges.dropFirst(exchangesBefore).filter { if case .replied(_, _, _, .ok, _) = $0 { return true } else { return false } }
                XCTAssertTrue(okSince.isEmpty, "\(step): nothing answered ok while locked: \(okSince)")
            } else {
                try await assertLockedPageKeptItsDocument(marker: "locked-page", since: exchangesBefore, step)
            }
            let fresh = try await unlockAndReload(step)
            XCTAssertGreaterThan(fresh.generation, live.generation, step)
            live = fresh
        }
    }

    /// R4-LT-3, on real WebKit: the content process ends (WebKit's own
    /// `_killWebContentProcessAndResetState`, which reaches the termination
    /// callback as a crash does). Before the fix the view stayed empty for
    /// good: no reload and no signal (implementing the callback turns
    /// WebKit's own reload off). Now the host tells the app and reloads once,
    /// so the view ends on a working document at a later generation; a
    /// second end within `terminationReloadInterval` is left to the app (no
    /// reload loop), and while locked there is no reload at all.
    func testContentProcessTerminationReloadsTheViewOnceAndTellsTheApp() async throws {
        let kill = NSSelectorFromString("_killWebContentProcessAndResetState")
        guard host.webView.responds(to: kill) else { throw XCTSkip("this WebKit has no _killWebContentProcessAndResetState") }
        var terminations = 0
        host.onContentProcessTerminated = { terminations += 1 }
        host.load()
        let first = try await waitForHandshake(generation: 1)

        _ = host.webView.perform(kill)
        let reloaded = try await waitForOneWorkingDocument("after the content process ended", timeout: 20)
        print("ROUND4 LT-3 first end: terminations=\(terminations) generation=\(reloaded.generation)")
        XCTAssertEqual(terminations, 1, "the app was told")
        XCTAssertGreaterThan(reloaded.generation, first.generation)
        XCTAssertEqual(registry.check(first.id, generation: first.generation), .staleGeneration)

        _ = host.webView.perform(kill)
        try await waitUntil("the second termination") { terminations == 2 }
        try await Task.sleep(nanoseconds: 2_000_000_000)
        XCTAssertNil(host.webView.url, "a second end within the interval is not reloaded")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
        host.reload()
        let byTheApp = try await waitForOneWorkingDocument("the app's reload after the second end")
        XCTAssertGreaterThan(byTheApp.generation, reloaded.generation)

        host.terminationReloadInterval = 0
        await host.lock()
        _ = host.webView.perform(kill)
        try await waitUntil("the termination while locked") { terminations == 3 }
        try await Task.sleep(nanoseconds: 2_000_000_000)
        XCTAssertNil(host.webView.url, "no reload while locked")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        try await unlockAndReload("LT-3 locked")
    }

    /// R4-LT-4, on real WebKit: going back to a document WebKit restores
    /// from its back/forward cache makes the host recover (the restored page
    /// holds a revoked bootstrap), and the app loads the bundle root in the
    /// same instant: in `didCommit` itself, or on the next main-queue turn.
    /// Before the fix the recovery's reload, asked for before WebKit had
    /// asked about the app's load, replaced it: the app's load was dropped
    /// and the view ended on a reloaded index.html (6 of 6 reviewer runs).
    /// Now the recovery lets WebKit catch up first, and the app's load wins.
    func testRecoveryAfterARestoredDocumentKeepsTheAppsLoadFromTheSameInstant() async throws {
        let proxy = ForwardingNavigationDelegate(host: host)
        host.webView.navigationDelegate = proxy
        var dropped: [URL?] = []
        host.onNavigationDropped = { dropped.append($0) }
        host.load()
        var live = try await waitForHandshake(generation: 1)
        for (step, sameTurn) in [("the app's load in didCommit itself", true), ("the app's load on the next main-queue turn", false)] {
            if try await eval("location.href") as? String != Self.deskEntry {
                _ = try? await eval("location.href = '\(Self.deskEntry)'")
                live = try await waitForHandshake(after: live.generation)
            }
            _ = try? await eval("location.href = '\(Self.deskRoot)'")
            live = try await waitForHandshake(after: live.generation)
            let restoredBefore = proxy.restoredCommits
            proxy.afterRestoredCommit = { [unowned self] in
                let load: () -> Void = { _ = self.host.webView.load(URLRequest(url: URL(string: Self.deskRoot)!)) }
                if sameTurn { load() } else { DispatchQueue.main.async { load() } }
            }
            dropped.removeAll()
            proxy.log.removeAll()
            host.webView.goBack()
            try await Task.sleep(nanoseconds: 2_500_000_000)
            let settled = try await waitForOneWorkingDocument(step)
            let href = try await eval("location.href") as? String
            print("ROUND4 LT-4 \(step): \(proxy.log.joined(separator: " || ")) dropped=\(dropped.map { $0?.absoluteString ?? "nil" }) href=\(href ?? "nil")")
            XCTAssertEqual(proxy.restoredCommits, restoredBefore + 1, "\(step): WebKit restored index.html from its back/forward cache")
            XCTAssertTrue(dropped.isEmpty, "\(step): the app's load was not replaced: \(dropped)")
            XCTAssertEqual(href, Self.deskRoot, "\(step): the view ends where the app asked")
            XCTAssertGreaterThan(settled.generation, live.generation, step)
            live = settled
        }
    }

    /// R4-H1, on real WebKit: document navigations the host allowed that
    /// WebKit never starts, with no callback: the app's `reload()` then
    /// `stopLoading()` in the same turn, and the page's link to index.html
    /// then `window.stop()` in the same task. Before the fix nothing cleared
    /// the allowed navigation, so the orphan recovery never ran: the live
    /// page stayed revoked next to a connection no document held (3 of 3
    /// reviewer runs each). Now the host notices once WebKit has caught up
    /// and ends on one working document. The reviewer's third case, the
    /// app's fragment-only load with a reload cache policy, is a scroll in
    /// WebKit and now in the policy too: the document and its connection
    /// stay.
    func testAllowedDocumentNavigationsWebKitNeverStartsEndOnOneWorkingDocument() async throws {
        host.load()
        var live = try await waitForHandshake(generation: 1)
        var dropped: [URL?] = []
        host.onNavigationDropped = { dropped.append($0) }
        let orderings: [(String, () -> Void)] = [
            ("native reload, then stopLoading() in the same turn", { [unowned self] in
                host.reload()
                host.webView.stopLoading()
            }),
            ("the page's link to index.html, then window.stop() in the same task", { [unowned self] in
                host.webView.evaluateJavaScript("(function () { const a = document.createElement('a'); a.href = 'index.html'; document.body.appendChild(a); a.click(); window.stop(); return true; })()", completionHandler: nil)
            })
        ]
        for (step, race) in orderings {
            let decisionsBefore = decisions.count
            dropped.removeAll()
            race()
            try await Task.sleep(nanoseconds: 2_500_000_000)
            let settled = try await waitForOneWorkingDocument(step)
            print("ROUND4 H1 \(step): \(describe(decisions[decisionsBefore...])) dropped=\(dropped.map { $0?.absoluteString ?? "nil" }) connection=\(settled.generation) (was \(live.generation))")
            XCTAssertEqual(decisions[decisionsBefore...].first?.decision, .allowNewDocument, step)
            XCTAssertEqual(dropped.first??.absoluteString, Self.deskEntry, "\(step): reported as dropped")
            XCTAssertGreaterThan(settled.generation, live.generation, step)
            live = settled
        }

        let policies: [URLRequest.CachePolicy] = [.reloadIgnoringLocalCacheData, .reloadIgnoringLocalAndRemoteCacheData, .reloadRevalidatingCacheData]
        for (index, cachePolicy) in policies.enumerated() {
            let step = "the app's fragment-only load with cache policy \(cachePolicy.rawValue)"
            _ = try await eval("window.__trueConvoProofMarker = 'kept'; true")
            try await waitUntil("\(step): the live URL tracked") { host.committedDocumentURL?.absoluteString == (try? await eval("location.href")) as? String }
            let decisionsBefore = decisions.count
            host.webView.load(URLRequest(url: URL(string: Self.deskEntry + "#frag\(index)")!, cachePolicy: cachePolicy))
            try await waitForPage("\(step): the fragment", "location.hash === '#frag\(index)'")
            try await Task.sleep(nanoseconds: 1_000_000_000)
            print("ROUND4 H1 \(step): \(describe(decisions[decisionsBefore...]))")
            XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowSameDocument], step)
            let settled = try await waitForOneWorkingDocument(step)
            XCTAssertEqual(settled, live, "\(step): the document kept its connection")
            let marker = try await eval("window.__trueConvoProofMarker ?? null") as? String
            XCTAssertEqual(marker, "kept", step)
        }
    }

    /// R4-H2, on real WebKit: while the page's own navigation to the bundle
    /// root is provisional, the still-live document calls `pushState` and
    /// then sets `location.hash` in one script. WebKit compares with the
    /// pushed URL and scrolls (cancelling the provisional load); the host,
    /// which cannot see same-document changes while the view loads, judges
    /// the hash against the older URL and allows a document load WebKit
    /// never starts. Before the fix the live page stayed revoked with no
    /// recovery (4 of 4 reviewer runs); now the never-started rule recovers
    /// and the view ends on one working document.
    func testFragmentNavigationJudgedAgainstAStaleURLWhileLoadingEndsOnOneWorkingDocument() async throws {
        let proxy = ForwardingNavigationDelegate(host: host)
        host.webView.navigationDelegate = proxy
        host.load()
        let first = try await waitForHandshake(generation: 1)
        _ = try await eval("window.__trueConvoProofMarker = 'document-1'; true")
        proxy.afterProvisionalStart = { [unowned self] in
            host.webView.evaluateJavaScript("history.pushState(null, '', 'index.html?p=2'); location.hash = 'h2'; true", completionHandler: nil)
        }
        let decisionsBefore = decisions.count
        _ = try? await eval("location.href = '\(Self.deskRoot)'")
        try await Task.sleep(nanoseconds: 2_500_000_000)
        let settled = try await waitForOneWorkingDocument("pushState and a hash while the page's navigation is provisional")
        print("ROUND4 H2: \(describe(decisions[decisionsBefore...])) log=\(proxy.log.joined(separator: " || "))")
        XCTAssertEqual(Array(decisions[decisionsBefore...].prefix(2)).map(\.targetURL?.absoluteString),
                       [Self.deskRoot, "trueconvo-desk://desk/index.html?p=2#h2"], "the reviewer's sequence")
        XCTAssertGreaterThan(settled.generation, first.generation)
    }

    /// R5-LT-A and R5-NAV-1, on real WebKit: the content process ends while
    /// a document navigation's decision is still being answered (the app's
    /// reload, or the page's own `location.reload()`). WebKit drops that
    /// question with the process and ignores a late answer. Before the fix
    /// the decision still answered `allow` to the ended page, the
    /// termination's reload stood aside for it, and the drop rules then had
    /// no live orphan to recover: the view stayed empty for good (reviewers:
    /// 3 of 3 runs for each ordering, 8 of 8 with a real SIGKILL). Now the
    /// end of the process drops that decision and the host's reload follows
    /// once it is answered.
    func testContentProcessEndingWhileADocumentDecisionIsPendingStillReloads() async throws {
        let kill = NSSelectorFromString("_killWebContentProcessAndResetState")
        guard host.webView.responds(to: kill) else { throw XCTSkip("this WebKit has no _killWebContentProcessAndResetState") }
        let proxy = ForwardingNavigationDelegate(host: host)
        host.webView.navigationDelegate = proxy
        host.terminationReloadInterval = 0
        var terminations = 0
        var dropped: [URL?] = []
        host.onContentProcessTerminated = { terminations += 1 }
        host.onNavigationDropped = { dropped.append($0) }
        host.load()
        var live = try await waitForHandshake(generation: 1)
        enum Ending { case heldStep, nextTurn, sigkillInPolicy }
        let runs: [(String, Bool, Ending)] = [
            ("the app's reload, its document step held while the process ends", false, .heldStep),
            ("the app's reload, the process ends on the next main-queue turn", false, .nextTurn),
            ("the page's location.reload(), the process ends on the next main-queue turn", true, .nextTurn),
            ("the app's reload, SIGKILL inside WebKit's policy question", false, .sigkillInPolicy),
            ("the page's location.reload(), SIGKILL inside WebKit's policy question", true, .sigkillInPolicy)
        ]
        for (step, fromPage, ending) in runs {
            let before = terminations
            proxy.log.removeAll()
            dropped.removeAll()
            var release: CheckedContinuation<Void, Never>?
            var held = false
            switch ending {
            case .heldStep:
                host.lifecycleCheckpoint = { point in
                    guard point == .documentStepRevoked, !held else { return }
                    held = true
                    await withCheckedContinuation { release = $0 }
                }
            case .nextTurn:
                proxy.afterMainFrameQuestionForwarded = { [unowned self] _ in
                    DispatchQueue.main.async { _ = self.host.webView.perform(kill) }
                }
            case .sigkillInPolicy:
                proxy.afterMainFrameQuestionForwarded = { [unowned self] _ in
                    let pid = (self.host.webView.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value ?? 0
                    if pid > 0 { Darwin.kill(pid, SIGKILL) }
                }
            }
            if fromPage {
                host.webView.evaluateJavaScript("setTimeout(function () { location.reload(); }, 0); true", completionHandler: nil)
            } else {
                host.reload()
            }
            if ending == .heldStep {
                // The host tells the app only after its own step, which is
                // queued behind the held one: wait for WebKit's callback.
                let ended = proxy.processTerminations
                do {
                    try await waitUntil("\(step): the document step held") { release != nil }
                    _ = host.webView.perform(kill)
                    try await waitUntil("\(step): WebKit's termination callback") { proxy.processTerminations == ended + 1 }
                } catch {
                    release?.resume()
                    host.lifecycleCheckpoint = nil
                    throw error
                }
                release?.resume()
                host.lifecycleCheckpoint = nil
            }
            try await waitUntil("\(step): the termination") { terminations == before + 1 }
            proxy.afterMainFrameQuestionForwarded = nil
            let settled = try await waitForOneWorkingDocument(step, timeout: 20)
            print("ROUND5 LT-A \(step): \(proxy.log.joined(separator: " || ")) dropped=\(dropped.map { $0?.absoluteString ?? "nil" }) generation \(live.generation) -> \(settled.generation)")
            XCTAssertEqual(terminations, before + 1, "\(step): the app was told once")
            XCTAssertGreaterThan(settled.generation, live.generation, step)
            XCTAssertEqual(registry.check(live.id, generation: live.generation), .staleGeneration, step)
            live = settled
        }
    }

    /// R5-LT-B, on real WebKit: going back to a document WebKit restores
    /// from its back/forward cache, with a lock landing right after WebKit
    /// reported the restore's provisional start. `stopLoading` does not stop
    /// a restore, and a restore asks no response question, so it commits
    /// while locked: the documented second exception to "the locked page
    /// keeps its document" (reviewers: 3 of 3 runs, native and page
    /// history). Checked for what must hold anyway: the restored page shows
    /// its closed screen (its bootstrap was revoked when it was left),
    /// nothing is live, nothing is answered `ok`, and unlock plus reload
    /// brings one working document. A lock landing before the start still
    /// stops the restore and keeps the locked page.
    func testLockLandingAfterARestoreStartedLetsOnlyTheClosedRestoredPageCommit() async throws {
        let proxy = ForwardingNavigationDelegate(host: host)
        host.webView.navigationDelegate = proxy
        host.load()
        var live = try await waitForHandshake(generation: 1)
        for (step, afterStart) in [("lock right after the restore's allow, before its start", false),
                                   ("lock right after the restore's provisional start (the exception)", true)] {
            if try await eval("location.href") as? String != Self.deskEntry {
                _ = try? await eval("location.href = '\(Self.deskEntry)'")
                live = try await waitForHandshake(after: live.generation)
            }
            _ = try? await eval("location.href = '\(Self.deskRoot)'")
            live = try await waitForHandshake(after: live.generation)
            _ = try await eval("window.__trueConvoProofMarker = 'locked-page'; true")
            var lockTask: Task<Void, Never>?
            let lockNow: () -> Void = { [unowned self] in lockTask = Task { @MainActor in await self.host.lock() } }
            if afterStart { proxy.afterProvisionalStart = { lockNow() } } else { proxy.afterDocumentActionAllowed = { _ in lockNow() } }
            let restoredBefore = proxy.restoredCommits
            let exchangesBefore = exchanges.count
            proxy.log.removeAll()
            host.webView.goBack()
            try await waitUntil("\(step): the lock") { lockTask != nil }
            await lockTask?.value
            try await Task.sleep(nanoseconds: 2_000_000_000)
            print("ROUND5 LT-B \(step): \(proxy.log.joined(separator: " || "))")
            if afterStart {
                XCTAssertEqual(proxy.restoredCommits, restoredBefore + 1, "\(step): WebKit restored index.html while locked")
                let marker = try? await eval("window.__trueConvoProofMarker ?? null") as? String
                let heading = try? await eval("document.querySelector('main.recovery-page h1')?.textContent ?? null") as? String
                XCTAssertNil(marker, "\(step): the restored document replaced the locked one")
                XCTAssertEqual(heading, "Workspace connection closed", "\(step): the restored page shows its closed state")
                XCTAssertTrue(host.isLocked, step)
                XCTAssertTrue(store.isLocked, step)
                XCTAssertEqual(registry.activeConnectionCount, 0, "\(step): nothing live while locked")
                XCTAssertNil(host.currentConnection, step)
                XCTAssertNil(host.documentConnection, "\(step): the restored page holds no connection")
                let okSince = exchanges.dropFirst(exchangesBefore).filter { if case .replied(_, _, _, .ok, _) = $0 { return true } else { return false } }
                XCTAssertTrue(okSince.isEmpty, "\(step): nothing answered ok while locked: \(okSince)")
            } else {
                XCTAssertEqual(proxy.restoredCommits, restoredBefore, "\(step): the restore was stopped")
                try await assertLockedPageKeptItsDocument(marker: "locked-page", since: exchangesBefore, step)
            }
            let fresh = try await unlockAndReload(step)
            XCTAssertGreaterThan(fresh.generation, live.generation, step)
            live = fresh
        }
    }

    /// The same page and connection as before, still answering reads.
    private func assertKeptUnsavedPage(_ live: HostConnection, marker expected: String, _ step: String) async throws {
        let marker = try? await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertEqual(marker, expected, "\(step): the page keeps its document")
        XCTAssertEqual(host.currentConnection, live, step)
        XCTAssertEqual(host.documentConnection, live, step)
        XCTAssertEqual(registry.check(live.id, generation: live.generation), .valid, step)
        XCTAssertEqual(registry.activeConnectionCount, 1, step)
        XCTAssertEqual(registry.currentGeneration, live.generation, "\(step): no generation was spent")
        let read = try await rawPost(readEnvelope(connectionId: live.id, generation: live.generation))
        XCTAssertTrue(read.contains("\"outcome\":\"ok\""), "\(step): \(read.prefix(200))")
    }

    /// R5-NAV-2, on real WebKit: a live page whose `beforeunload` listener
    /// cancels the event, as the Desk's own does while work is unsaved.
    /// WebKit never dispatches `beforeunload` in this view, and the host
    /// revoked the page before it would have, so before the fix the app's
    /// reload and the page's own `location.reload()` replaced the page with
    /// no warning (reviewers: every run). Now the host asks the page first
    /// and, with no confirmation from the app (`confirmLeavingUnsavedWork`
    /// unset), keeps it: same document, same live connection, the
    /// navigation refused.
    func testNavigationAwayFromAPageWithUnsavedWorkKeepsItWithoutTheAppsYes() async throws {
        host.load()
        let live = try await waitForHandshake(generation: 1)
        _ = try await eval("window.__trueConvoProofMarker = 'unsaved'; window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = ''; }); true")
        for (step, fromPage) in [("the app's reload", false), ("the page's location.reload()", true)] {
            let refusedBefore = refusedNavigations.count
            let decisionsBefore = decisions.count
            if fromPage {
                host.webView.evaluateJavaScript("setTimeout(function () { location.reload(); }, 0); true", completionHandler: nil)
            } else {
                host.reload()
            }
            try await waitUntil("\(step): the navigation refused", timeout: 10) { refusedNavigations.count > refusedBefore }
            try await Task.sleep(nanoseconds: 1_500_000_000)
            print("ROUND5 NAV-2 \(step): \(describe(decisions[decisionsBefore...])) refused=\(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString ?? "nil" })")
            XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowNewDocument], step)
            XCTAssertEqual(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString }, [Self.deskEntry], step)
            try await assertKeptUnsavedPage(live, marker: "unsaved", step)
        }
    }

    /// The app's close and quit question, on real WebKit: a fresh Desk page
    /// holds nothing unsaved; a page whose `beforeunload` listener cancels
    /// the event (as the Desk's own does while work is unsaved) does. Asking
    /// asks the app nothing and leaves the page, its document and its
    /// connection as they were. Locked, nothing unsaved.
    func testPageHoldsUnsavedWorkIsNilOnFreshPageAndUnsavedWhenPageCancelsBeforeUnload() async throws {
        let beforeAnyPage = await host.pageHoldsUnsavedWork()
        XCTAssertNil(beforeAnyPage, "no page yet")
        host.load()
        let live = try await waitForHandshake(generation: 1)
        var asked: [URL?] = []
        host.confirmLeavingUnsavedWork = { url, _ in asked.append(url); return false }
        let fresh = await host.pageHoldsUnsavedWork()
        XCTAssertNil(fresh, "a fresh Desk page holds nothing unsaved")

        _ = try await eval("window.__trueConvoProofMarker = 'unsaved'; window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = ''; }); true")
        let unsaved = await host.pageHoldsUnsavedWork()
        XCTAssertEqual(unsaved, .unsaved, "the page cancels beforeunload")
        let again = await host.pageHoldsUnsavedWork()
        XCTAssertEqual(again, .unsaved, "asking twice changes nothing")
        XCTAssertTrue(asked.isEmpty, "the app is not asked: \(asked)")
        XCTAssertTrue(refusedNavigations.isEmpty)
        try await assertKeptUnsavedPage(live, marker: "unsaved", "after asking")

        await host.lock()
        let locked = await host.pageHoldsUnsavedWork()
        XCTAssertNil(locked, "a locked page has nothing the host could keep")
    }

    /// R5-NAV-2 with the Desk's own guard: another writer advances the
    /// invented workspace, so the page's next save is a conflict and the
    /// Desk keeps the attempted work "for this visit" behind its own
    /// `beforeunload` guard. Before the fix the app's reload discarded that
    /// work with no warning (reviewer V4). Now, with no confirmation from
    /// the app, the page and its attempted work stay.
    func testDesksOwnUnsavedWorkGuardKeepsThePageOnTheAppsReload() async throws {
        host.load()
        let live = try await waitForHandshake(generation: 1)
        _ = try await eval("window.__trueConvoProofMarker = 'desk-unsaved'; true")
        try await armDesksOwnUnsavedWorkGuard()
        let sessionsBefore = try await eval(Self.newConversationCount) as? Int
        let refusedBefore = refusedNavigations.count
        host.reload()
        try await waitUntil("the reload refused", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        try await assertKeptUnsavedPage(live, marker: "desk-unsaved", "the Desk's own guard")
        let sessionsAfter = try await eval(Self.newConversationCount) as? Int
        let status = try await eval("document.body.innerText.indexOf('needs attention') >= 0") as? Bool
        XCTAssertEqual(sessionsAfter, sessionsBefore, "the attempted work is still shown")
        XCTAssertEqual(status, true, "the Desk still reports the save that needs attention")

        // The app's yes: the reload goes on, and the person chose to drop
        // the attempted work.
        var asked: [URL?] = []
        host.confirmLeavingUnsavedWork = { url, _ in asked.append(url); return true }
        host.reload()
        _ = try await waitForHandshake(after: live.generation)
        let fresh = try await waitForOneWorkingDocument("the app's yes over the Desk's own guard")
        XCTAssertEqual(asked.map { $0?.absoluteString }, [Self.deskEntry], "the app was asked once")
        XCTAssertGreaterThan(fresh.generation, live.generation)
        let marker = try? await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(marker, "the reload replaced the page")
    }

    /// R5-NAV-2 and W4, the app's answer, on real WebKit: asked once per
    /// navigation away from a page that cancels `beforeunload` (`.unsaved`),
    /// with the navigation's URL; no keeps the page, yes lets the reload
    /// replace it; a page with nothing unsaved is not asked about. A page
    /// too busy to answer within `unsavedWorkCheckTimeout` could not say
    /// what it keeps: before the fix (W4) the reload replaced it unasked and
    /// its marker was gone; now the app is asked (`.noAnswer`), its no keeps
    /// the page and its marker, and only its yes lets the reload go on. The
    /// yes revokes the page's connection at once, but WebKit carries the
    /// reload out only once the page's process is free again: until then the
    /// busy page stays in the view with no live connection (W4-R3). A page
    /// whose process never frees cannot be left by any navigation.
    func testTheAppsAnswerDecidesWhetherAPageWithUnsavedWorkIsLeft() async throws {
        let proxy = ForwardingNavigationDelegate(host: host)
        host.webView.navigationDelegate = proxy
        host.load()
        let live = try await waitForHandshake(generation: 1)
        let guardPage = "window.__trueConvoProofMarker = 'unsaved'; window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = ''; }); true"
        _ = try await eval(guardPage)
        var asked: [URL?] = []
        var reasons: [DeskWebViewHost.UnsavedWorkReason] = []
        var leave = false
        host.confirmLeavingUnsavedWork = { url, reason in asked.append(url); reasons.append(reason); return leave }

        let refusedBefore = refusedNavigations.count
        host.reload()
        try await waitUntil("the app's no: the reload refused", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(asked.map { $0?.absoluteString }, [Self.deskEntry], "the app was asked once")
        XCTAssertEqual(reasons, [.unsaved])
        try await assertKeptUnsavedPage(live, marker: "unsaved", "the app's no")

        leave = true
        asked.removeAll()
        host.reload()
        _ = try await waitForHandshake(after: live.generation)
        let reloaded = try await waitForOneWorkingDocument("the app's yes")
        XCTAssertEqual(asked.map { $0?.absoluteString }, [Self.deskEntry], "the app was asked once")
        var marker = try? await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(marker, "the reload replaced the page")

        asked.removeAll()
        host.reload()
        _ = try await waitForHandshake(after: reloaded.generation)
        let plain = try await waitForOneWorkingDocument("nothing unsaved")
        XCTAssertTrue(asked.isEmpty, "nothing unsaved, nothing asked: \(asked)")

        // A page busy past the timeout, its guard armed: the app is asked,
        // and its no keeps the page, marker and all.
        _ = try await eval(guardPage)
        let busy = "(function () { var end = Date.now() + 4000; while (Date.now() < end) {} return true; })()"
        leave = false
        asked.removeAll()
        reasons.removeAll()
        proxy.afterMainFrameQuestionForwarded = { [unowned self] _ in host.webView.evaluateJavaScript(busy, completionHandler: nil) }
        let refusedBeforeBusy = refusedNavigations.count
        var started = Date()
        host.reload()
        try await waitUntil("a page too busy to answer: the app's no, the reload refused", timeout: 15) { refusedNavigations.count > refusedBeforeBusy }
        print("W4 busy page, the app's no: refused after \(Date().timeIntervalSince(started)) s, asked=\(asked.count) reasons=\(reasons)")
        XCTAssertEqual(asked.map { $0?.absoluteString }, [Self.deskEntry], "no answer from the page, the app was asked once")
        XCTAssertEqual(reasons, [.noAnswer])
        try await assertKeptUnsavedPage(plain, marker: "unsaved", "a page too busy to answer, the app's no")

        // The same busy page, the app's yes: the reload replaces it.
        leave = true
        asked.removeAll()
        reasons.removeAll()
        proxy.afterMainFrameQuestionForwarded = { [unowned self] _ in host.webView.evaluateJavaScript(busy, completionHandler: nil) }
        started = Date()
        host.reload()
        // The yes revoked the busy page's connection, but the page stays in
        // the view until its process is free: nothing commits before the
        // busy loop ends.
        try await waitUntil("a page too busy to answer: the app asked", timeout: 10) { !reasons.isEmpty }
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3.5, "still inside the page's busy loop")
        XCTAssertEqual(registry.check(plain.id, generation: plain.generation), .staleGeneration, "the yes revoked the busy page's connection")
        XCTAssertEqual(host.documentConnection, plain, "the busy page is still the live document")
        _ = try await waitForHandshake(after: plain.generation)
        let reloadedAfter = Date().timeIntervalSince(started)
        let afterHang = try await waitForOneWorkingDocument("a page too busy to answer, the app's yes")
        print("W4 busy page, the app's yes: reloaded after \(reloadedAfter) s, asked=\(asked.count) reasons=\(reasons)")
        XCTAssertGreaterThanOrEqual(reloadedAfter, 3.9, "the reload went on only once the page's process was free")
        XCTAssertEqual(reasons, [.noAnswer], "no answer from the page, the app was asked once")
        XCTAssertGreaterThan(afterHang.generation, plain.generation)
        marker = try? await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(marker, "the reload replaced the busy page")
    }

    /// Makes the live page unable to answer the host's unsaved-work check:
    /// its `beforeunload` listener throws (an invented guard failure)
    /// before it could cancel the event, so the page cannot say whether it
    /// holds unsaved work.
    private func armPageThatCannotAnswer(marker: String) async throws {
        _ = try await eval("window.__trueConvoProofMarker = '\(marker)'; window.addEventListener('beforeunload', function () { throw new Error('invented guard failure'); }); true")
    }

    /// W4, on real WebKit: the page's script fails during the unsaved-work
    /// check (its `beforeunload` listener throws) and the app set no
    /// confirmation. Before the fix a failed check counted as nothing
    /// unsaved: the app's reload and the page's own `location.reload()`
    /// replaced the page unasked. Now both are refused and the page keeps
    /// its document, its connection and its marker.
    func testAPageWhoseUnsavedWorkCheckFailsIsKeptWithoutAConfirmation() async throws {
        host.load()
        let live = try await waitForHandshake(generation: 1)
        try await armPageThatCannotAnswer(marker: "no-answer")
        XCTAssertNil(host.confirmLeavingUnsavedWork)
        for (step, fromPage) in [("the app's reload", false), ("the page's location.reload()", true)] {
            let refusedBefore = refusedNavigations.count
            let decisionsBefore = decisions.count
            if fromPage {
                host.webView.evaluateJavaScript("setTimeout(function () { location.reload(); }, 0); true", completionHandler: nil)
            } else {
                host.reload()
            }
            try await waitUntil("\(step): the navigation refused", timeout: 10) { refusedNavigations.count > refusedBefore }
            try await Task.sleep(nanoseconds: 1_500_000_000)
            XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowNewDocument], step)
            XCTAssertEqual(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString }, [Self.deskEntry], step)
            try await assertKeptUnsavedPage(live, marker: "no-answer", step)
        }
    }

    /// W4, on real WebKit: a page that cannot answer the check, and the
    /// app's no, then a confirmation that throws. Both keep the page; the
    /// app is told the page gave no answer. Before the fix the app was
    /// never asked and the reload replaced the page.
    func testTheAppsNoOrFailureKeepsAPageThatCouldNotAnswer() async throws {
        host.load()
        let live = try await waitForHandshake(generation: 1)
        try await armPageThatCannotAnswer(marker: "no-answer")
        var asked: [String] = []
        host.confirmLeavingUnsavedWork = { url, reason in asked.append("\(url?.absoluteString ?? "nil") \(reason)"); return false }
        var refusedBefore = refusedNavigations.count
        host.reload()
        try await waitUntil("the app's no: the reload refused", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(asked, ["\(Self.deskEntry) noAnswer"])
        try await assertKeptUnsavedPage(live, marker: "no-answer", "the app's no")

        host.confirmLeavingUnsavedWork = { url, reason in asked.append("\(url?.absoluteString ?? "nil") \(reason)"); throw InventedConfirmationFailure() }
        refusedBefore = refusedNavigations.count
        host.reload()
        try await waitUntil("the app's failure: the reload refused", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(asked, ["\(Self.deskEntry) noAnswer", "\(Self.deskEntry) noAnswer"])
        try await assertKeptUnsavedPage(live, marker: "no-answer", "the app's failure")
    }

    /// W4, on real WebKit: the app's explicit yes over a page that cannot
    /// answer the check forces the reload: asked once with `.noAnswer`, a
    /// new generation, the old connection revoked, the page replaced.
    /// Before the fix the app was never asked.
    func testTheAppsYesLeavesAPageThatCouldNotAnswer() async throws {
        host.load()
        let live = try await waitForHandshake(generation: 1)
        try await armPageThatCannotAnswer(marker: "no-answer")
        var asked: [String] = []
        host.confirmLeavingUnsavedWork = { url, reason in asked.append("\(url?.absoluteString ?? "nil") \(reason)"); return true }
        host.reload()
        _ = try await waitForHandshake(after: live.generation)
        let fresh = try await waitForOneWorkingDocument("the app's yes over a page that could not answer")
        XCTAssertEqual(asked, ["\(Self.deskEntry) noAnswer"], "the app was asked once")
        XCTAssertGreaterThan(fresh.generation, live.generation)
        XCTAssertEqual(registry.check(live.id, generation: live.generation), .staleGeneration)
        let marker = try? await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(marker, "the reload replaced the page")
    }

    /// W4, on real WebKit: a lock, a lock undone by an unlock, or a close
    /// arriving while the app is still being asked about a page that could
    /// not answer wins over the app's later yes: the reload is cancelled and
    /// begins nothing. Before the fix the app was never asked: the reload
    /// replaced the page at once.
    func testLockOrCloseWhileTheAppIsAskedCancelsTheNavigation() async throws {
        host.load()
        _ = try await waitForHandshake(generation: 1)
        var pending: CheckedContinuation<Bool, Never>?
        var reasons: [DeskWebViewHost.UnsavedWorkReason] = []
        host.confirmLeavingUnsavedWork = { _, reason in reasons.append(reason); return await withCheckedContinuation { pending = $0 } }

        // A lock: the locked page keeps its document.
        try await armPageThatCannotAnswer(marker: "locked-while-asked")
        let exchangesBefore = exchanges.count
        var refusedBefore = refusedNavigations.count
        host.reload()
        try await waitUntil("the app asked, before the lock", timeout: 10) { pending != nil }
        await host.lock()
        pending?.resume(returning: true)
        pending = nil
        try await waitUntil("the reload refused after the lock", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString }, [Self.deskEntry])
        XCTAssertEqual(reasons, [.noAnswer])
        try await assertLockedPageKeptItsDocument(marker: "locked-while-asked", since: exchangesBefore, "a lock while the app was asked")
        _ = try await unlockAndReload("a lock while the app was asked")

        // A lock and an unlock: the late yes begins nothing either.
        try await armPageThatCannotAnswer(marker: "relocked-while-asked")
        refusedBefore = refusedNavigations.count
        host.reload()
        try await waitUntil("the app asked, before the lock and unlock", timeout: 10) { pending != nil }
        await host.lock()
        await host.unlock()
        let generationAfterUnlock = registry.currentGeneration
        pending?.resume(returning: true)
        pending = nil
        try await waitUntil("the reload refused after the lock and unlock", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString }, [Self.deskEntry])
        XCTAssertEqual(registry.currentGeneration, generationAfterUnlock, "the late yes began no document")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
        let kept = try? await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertEqual(kept, "relocked-while-asked", "the late yes did not replace the page")
        host.reload()
        _ = try await waitForOneWorkingDocument("the app's reload after the unlock")

        // A close: nothing begins.
        try await armPageThatCannotAnswer(marker: "closed-while-asked")
        refusedBefore = refusedNavigations.count
        host.reload()
        try await waitUntil("the app asked, before the close", timeout: 10) { pending != nil }
        await host.close()
        let generationAfterClose = registry.currentGeneration
        pending?.resume(returning: true)
        pending = nil
        try await waitUntil("the reload refused after the close", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(registry.currentGeneration, generationAfterClose, "the late yes began no document")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
        XCTAssertEqual(reasons, [.noAnswer, .noAnswer, .noAnswer])
    }

    /// Codex P3 of eedc29f, on real WebKit: a lock undone by an unlock
    /// while the live page's clean answer is still on its way (held back
    /// through the `unsavedWorkCheck` seam). Before the fix a clean answer
    /// skipped the check that the decision is unchanged, and the document
    /// step compared only the question number, so after the unlock that
    /// older reload began a new generation and replaced the page. Now it is
    /// cancelled and begins nothing, and the app's own reload afterwards
    /// brings one working document. With nothing changed, a held-back clean
    /// answer still lets the reload go on without asking the app.
    func testLockAndUnlockWhileACleanAnswerIsOnItsWayCancelsThatReload() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        var pending: CheckedContinuation<Bool?, Never>?
        var checks = 0
        host.unsavedWorkCheck = { checks += 1; return await withCheckedContinuation { pending = $0 } }
        host.confirmLeavingUnsavedWork = { _, _ in XCTFail("a clean page is left without asking the app"); return false }

        // Nothing changed while the answer was on its way: the reload goes on.
        host.reload()
        try await waitUntil("the page asked, nothing changed", timeout: 10) { pending != nil }
        pending?.resume(returning: false)
        pending = nil
        let live = try await waitForHandshake(after: first.generation)

        // A lock and an unlock while the answer is on its way.
        _ = try await eval("window.__trueConvoProofMarker = 'clean-while-relocked'; true")
        var begun: [HostConnection] = []
        host.onDocumentBegan = { begun.append($0) }
        let refusedBefore = refusedNavigations.count
        let decisionsBefore = decisions.count
        host.reload()
        try await waitUntil("the page asked, before the lock and unlock", timeout: 10) { pending != nil }
        await host.lock()
        await host.unlock()
        let generationAfterUnlock = registry.currentGeneration
        pending?.resume(returning: false)
        pending = nil
        try await waitUntil("the older reload refused after the lock and unlock", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        print("P3 clean answer across a lock and unlock: \(describe(decisions[decisionsBefore...])) refused=\(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString ?? "nil" }) begun=\(begun.map(\.generation))")
        XCTAssertEqual(decisions[decisionsBefore...].map(\.decision), [.allowNewDocument])
        XCTAssertEqual(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString }, [Self.deskEntry])
        XCTAssertTrue(begun.isEmpty, "the older reload began no generation: \(begun)")
        XCTAssertEqual(registry.currentGeneration, generationAfterUnlock, "the late clean answer began no document")
        XCTAssertEqual(registry.activeConnectionCount, 0)
        XCTAssertNil(host.currentConnection)
        let kept = try? await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertEqual(kept, "clean-while-relocked", "the older reload did not replace the page")
        host.onDocumentBegan = nil

        // The app's reload after the unlock: no page holds the current
        // connection, so the page is not asked, and one working document.
        let checksBefore = checks
        host.reload()
        let fresh = try await waitForOneWorkingDocument("the app's reload after the unlock")
        XCTAssertGreaterThan(fresh.generation, generationAfterUnlock)
        XCTAssertGreaterThan(fresh.generation, live.generation)
        XCTAssertEqual(checks, checksBefore, "nothing to ask: the page held no live connection")
    }

    /// P3R-1 (review of 1193f35), on real WebKit: the app asks for a second
    /// reload while the first reload's document step is under way (held
    /// after its generation began, before its connection is issued). WebKit
    /// asks about the second and drops the first. The live page answers
    /// clean (the `unsavedWorkCheck` seam). Before the fix the connection
    /// the first step issued meanwhile counted as a changed decision: the
    /// second reload was cancelled too, and the view stayed on the revoked
    /// page while that connection stayed live with no document holding it,
    /// until the app reloaded again. Now the newer reload replaces the older
    /// step and brings one working document, with no recovery reload.
    func testASecondReloadDuringTheFirstReloadsStepBringsOneWorkingDocument() async throws {
        host.load()
        let first = try await waitForHandshake(generation: 1)
        _ = try await eval("window.__trueConvoProofMarker = 'before-two-reloads'; true")
        host.unsavedWorkCheck = { false }
        host.confirmLeavingUnsavedWork = { _, _ in XCTFail("a clean page is left without asking the app"); return false }
        var dropped: [URL?] = []
        host.onNavigationDropped = { dropped.append($0) }
        var begun: [HostConnection] = []
        host.onDocumentBegan = { begun.append($0) }
        var release: CheckedContinuation<Void, Never>?
        var held = false
        host.lifecycleCheckpoint = { point in
            guard point == .documentStepRevoked, !held else { return }
            held = true
            await withCheckedContinuation { release = $0 }
        }
        let refusedBefore = refusedNavigations.count
        let decisionsBefore = decisions.count
        host.reload()
        do {
            try await waitUntil("the first reload's document step held", timeout: 10) { release != nil }
            host.reload()
            try await waitUntil("WebKit asked about the second reload", timeout: 10) { decisions.count >= decisionsBefore + 2 }
            // Let the second decision reach its own wait: its step, queued
            // behind the held one.
            try await Task.sleep(nanoseconds: 200_000_000)
        } catch {
            host.lifecycleCheckpoint = nil
            release?.resume()
            throw error
        }
        host.lifecycleCheckpoint = nil
        release?.resume()
        let settled = try await waitForOneWorkingDocument("two reloads, the second asked during the first's document step")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let traversal = decisions[decisionsBefore...]
        print("P3R-1 real view: \(describe(traversal)) dropped=\(dropped.map { $0?.absoluteString ?? "nil" }) refused=\(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString ?? "nil" }) begun=\(begun.map(\.generation)) settled=\(settled.generation)")
        XCTAssertEqual(traversal.map(\.navigationType), [.reload, .reload], "the two reloads, and no recovery reload: \(describe(traversal))")
        XCTAssertEqual(traversal.map(\.decision), [.allowNewDocument, .allowNewDocument])
        XCTAssertEqual(dropped.map { $0?.absoluteString }, [Self.deskEntry], "the first reload was dropped")
        XCTAssertEqual(refusedNavigations.count, refusedBefore, "the second reload was not refused")
        XCTAssertEqual(begun.count, 2, "the older step's generation, then the newer reload's")
        XCTAssertEqual(begun.last, settled, "the second reload's document holds the one live connection")
        if let older = begun.first {
            XCTAssertEqual(registry.check(older.id, generation: older.generation), .staleGeneration, "the older step's connection was revoked")
        }
        XCTAssertGreaterThan(settled.generation, first.generation)
        XCTAssertFalse(host.hasOrphanedConnection)
        let marker = try? await eval("window.__trueConvoProofMarker ?? null") as? String
        XCTAssertNil(marker, "a fresh document")
    }

    /// W4-R1, on real WebKit: the classic guards for unsaved work, an
    /// `onbeforeunload` handler that returns a message, a listener that sets
    /// `returnValue` to one, and a handler that returns false. WebKit's own
    /// `BeforeUnloadEvent` counts each as cancelling. The host's check
    /// dispatched a plain `Event`, on which none of them cancels, so before
    /// the fix each read as clean and the app's reload replaced the page
    /// unasked, its marker gone (reviewers: every run). Now each keeps the
    /// page without a confirmation, and the app is told it holds unsaved
    /// work (`.unsaved`) and its no keeps the page.
    func testClassicBeforeUnloadGuardsKeepThePageUnlessTheAppConfirms() async throws {
        host.load()
        let live = try await waitForHandshake(generation: 1)
        let guards = [
            ("onbeforeunload returns a message", "window.onbeforeunload = function () { return 'invented unsaved'; };"),
            ("a listener sets returnValue to a message",
             "window.__trueConvoProofGuard = function (e) { e.returnValue = 'invented unsaved'; }; window.addEventListener('beforeunload', window.__trueConvoProofGuard);"),
            ("onbeforeunload returns false", "window.onbeforeunload = function () { return false; };"),
        ]
        for (guardName, arm) in guards {
            _ = try await eval("""
            window.onbeforeunload = null;
            if (window.__trueConvoProofGuard) { window.removeEventListener('beforeunload', window.__trueConvoProofGuard); }
            window.__trueConvoProofGuard = null;
            window.__trueConvoProofMarker = 'classic-guard';
            \(arm)
            true
            """)
            host.confirmLeavingUnsavedWork = nil
            var refusedBefore = refusedNavigations.count
            host.reload()
            try await waitUntil("\(guardName), no confirmation: the reload refused", timeout: 10) { refusedNavigations.count > refusedBefore }
            try await Task.sleep(nanoseconds: 1_000_000_000)
            XCTAssertEqual(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString }, [Self.deskEntry], guardName)
            try await assertKeptUnsavedPage(live, marker: "classic-guard", "\(guardName), no confirmation")

            var asked: [String] = []
            host.confirmLeavingUnsavedWork = { url, reason in asked.append("\(url?.absoluteString ?? "nil") \(reason)"); return false }
            refusedBefore = refusedNavigations.count
            host.reload()
            try await waitUntil("\(guardName), the app's no: the reload refused", timeout: 10) { refusedNavigations.count > refusedBefore }
            try await Task.sleep(nanoseconds: 1_000_000_000)
            XCTAssertEqual(asked, ["\(Self.deskEntry) unsaved"], "\(guardName): the app was asked once")
            try await assertKeptUnsavedPage(live, marker: "classic-guard", "\(guardName), the app's no")
        }
    }

    /// W4-R2, on real WebKit: a page whose own capturing `error` listener
    /// stops every later one, and whose `beforeunload` listener throws. The
    /// host noticed the throw through an `error` listener it added only when
    /// the check ran, after the page's own, so before the fix the page's
    /// listener hid it: the check read clean, the app was never asked (even
    /// with a confirmation set) and the reload replaced the page. Now the
    /// host's listener is registered at document start, ahead of any of the
    /// page's: the app is told the page gave no answer and its no keeps the
    /// page; with no confirmation, the page's own `location.reload()` is
    /// refused too.
    func testAPageHidingErrorsFromLaterListenersStillCannotAnswer() async throws {
        host.load()
        let live = try await waitForHandshake(generation: 1)
        _ = try await eval("window.addEventListener('error', function (e) { e.stopImmediatePropagation(); }, true); true")
        try await armPageThatCannotAnswer(marker: "errors-hidden")
        var asked: [String] = []
        host.confirmLeavingUnsavedWork = { url, reason in asked.append("\(url?.absoluteString ?? "nil") \(reason)"); return false }
        var refusedBefore = refusedNavigations.count
        host.reload()
        try await waitUntil("the app's no: the reload refused", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(asked, ["\(Self.deskEntry) noAnswer"], "the app was asked once")
        try await assertKeptUnsavedPage(live, marker: "errors-hidden", "the app's no")

        host.confirmLeavingUnsavedWork = nil
        refusedBefore = refusedNavigations.count
        host.webView.evaluateJavaScript("setTimeout(function () { location.reload(); }, 0); true", completionHandler: nil)
        try await waitUntil("no confirmation, the page's location.reload(): refused", timeout: 10) { refusedNavigations.count > refusedBefore }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(refusedNavigations.dropFirst(refusedBefore).map { $0?.absoluteString }, [Self.deskEntry])
        try await assertKeptUnsavedPage(live, marker: "errors-hidden", "no confirmation")
    }

    private static let newConversationCount = "document.body.innerText.split('New conversation').length - 1"

    /// Makes the Desk hold unsaved work behind its own `beforeunload`
    /// guard: another (invented) writer advances the workspace, then the
    /// page's "New session" save meets a conflict.
    private func armDesksOwnUnsavedWorkGuard() async throws {
        let cancelsBeforeUnload = """
        (function () {
          var e = document.createEvent('BeforeUnloadEvent');
          e.initEvent('beforeunload', false, true);
          window.dispatchEvent(e);
          return e.defaultPrevented || e.returnValue !== '';
        })()
        """
        let armedBefore = try await eval(cancelsBeforeUnload) as? Bool
        XCTAssertEqual(armedBefore, false, "nothing unsaved yet")
        let current = try store.read()
        var advanced = current.record
        advanced["revision"] = .number(Double(current.revision + 1))
        _ = try store.commit(CommitAttempt(requestId: UUID(), payloadHash: "invented-external-writer", expectedRevision: current.revision,
                                           recordRevision: current.revision + 1, record: advanced, deliveryId: nil))
        let clicked = try await eval("""
        (function () {
          var b = Array.from(document.querySelectorAll('button')).find(function (x) { return x.textContent.trim() === 'New session' && !x.getAttribute('aria-label'); })
               || Array.from(document.querySelectorAll('button')).find(function (x) { return x.getAttribute('aria-label') === 'New session'; });
          if (!b) return 'missing';
          b.click();
          return 'clicked';
        })()
        """) as? String
        XCTAssertEqual(clicked, "clicked")
        try await waitForPage("the Desk to report the failed save", "document.body.innerText.indexOf('needs attention') >= 0", timeout: 10)
        let armed = try await eval(cancelsBeforeUnload) as? Bool
        XCTAssertEqual(armed, true, "the Desk's own guard cancels beforeunload now")
    }

    private enum ProofFailure: Error { case timeout(String) }
}

/// Forwards every navigation-delegate call to the host unchanged, logs the
/// order, and lets a test act at chosen instants: right after the host
/// returned from a main-frame navigation question (a document decision is
/// then still being answered), right after a document
/// navigation was answered `allow` (answered later than the call itself, as
/// only a document allow is), right after a provisional start, right after
/// the main-frame response policy was answered `allow` (the instant before
/// WebKit commits and reports `didCommit`), and right after the commit of a
/// document WebKit restored from its back/forward cache (no main-frame
/// response since its start).
@MainActor
private final class ForwardingNavigationDelegate: NSObject, WKNavigationDelegate {
    let host: DeskWebViewHost
    var afterMainFrameQuestionForwarded: ((URL?) -> Void)?
    var afterDocumentActionAllowed: ((URL?) -> Void)?
    var afterProvisionalStart: (() -> Void)?
    var afterMainFrameResponseAllowed: ((URL?) -> Void)?
    var afterRestoredCommit: (() -> Void)?
    var log: [String] = []
    private(set) var restoredCommits = 0
    private(set) var processTerminations = 0
    private var mainFrameResponseSinceStart = false
    private var forwarded: WKNavigationDelegate { host }
    init(host: DeskWebViewHost) { self.host = host }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        let url = navigationAction.request.url
        let mainFrame = navigationAction.targetFrame?.isMainFrame == true
        var returned = false
        log.append("ask \(navigationAction.navigationType.rawValue) \(url?.absoluteString ?? "nil")")
        host.webView(webView, decidePolicyFor: navigationAction, preferences: preferences) { [weak self] policy, preferences in
            decisionHandler(policy, preferences)
            guard let self else { return }
            self.log.append("answer \(policy == .allow ? "allow" : "cancel") \(url?.absoluteString ?? "nil")")
            if mainFrame, policy == .allow, returned, let hook = self.afterDocumentActionAllowed {
                self.afterDocumentActionAllowed = nil
                hook(url)
            }
        }
        returned = true
        if mainFrame, let hook = afterMainFrameQuestionForwarded {
            afterMainFrameQuestionForwarded = nil
            hook(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let url = navigationResponse.response.url
        let mainFrame = navigationResponse.isForMainFrame
        if mainFrame { mainFrameResponseSinceStart = true }
        host.webView(webView, decidePolicyFor: navigationResponse) { [weak self] policy in
            decisionHandler(policy)
            self?.log.append("response \(url?.absoluteString ?? "nil") \(policy == .allow ? "allow" : "cancel")")
            if mainFrame, policy == .allow, let hook = self?.afterMainFrameResponseAllowed {
                self?.afterMainFrameResponseAllowed = nil
                hook(url)
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        log.append("start")
        mainFrameResponseSinceStart = false
        forwarded.webView?(webView, didStartProvisionalNavigation: navigation)
        if let hook = afterProvisionalStart {
            afterProvisionalStart = nil
            hook()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log.append("fail \((error as NSError).code)")
        forwarded.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        let restored = !mainFrameResponseSinceStart
        log.append("commit \(webView.url?.absoluteString ?? "nil")\(restored ? " (restored)" : "")")
        forwarded.webView?(webView, didCommit: navigation)
        if restored {
            restoredCommits += 1
            if let hook = afterRestoredCommit {
                afterRestoredCommit = nil
                hook()
            }
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        forwarded.webView?(webView, navigationAction: navigationAction, didBecome: download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        forwarded.webView?(webView, navigationResponse: navigationResponse, didBecome: download)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log.append("terminated")
        processTerminations += 1
        forwarded.webViewWebContentProcessDidTerminate?(webView)
    }
}
