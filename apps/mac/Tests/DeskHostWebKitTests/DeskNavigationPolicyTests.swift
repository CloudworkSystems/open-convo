import DeskHost
import DeskHostWebKit
import Foundation
import WebKit
import XCTest

final class DeskNavigationPolicyTests: XCTestCase {
    private func decide(_ url: String?, current: String? = nil, mainFrame: Bool = true, download: Bool = false,
                        type: WKNavigationType = .other, cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy,
                        closed: Bool = false, locked: Bool = false,
                        serves: (URL) -> Bool = { _ in true }) -> DeskNavigationPolicy.Decision {
        DeskNavigationPolicy.decide(url: url.flatMap(URL.init(string:)), currentDocumentURL: current.flatMap(URL.init(string:)),
                                    targetsMainFrame: mainFrame, isDownload: download, navigationType: type, cachePolicy: cachePolicy,
                                    scheme: "trueconvo-desk", host: "desk", closed: closed, locked: locked, servesDocument: serves)
    }

    /// Allowing a new document gives up the live connection, so a bundle URL
    /// the handler would not answer with a page (a 404, a font) is cancelled
    /// before that happens. The check is asked only for a real navigation.
    func testBundleURLThatIsNotADocumentIsCancelledBeforeAGenerationIsSpent() {
        var asked: [String] = []
        let notServed: (URL) -> Bool = { asked.append($0.absoluteString); return false }
        XCTAssertEqual(decide("trueconvo-desk://desk/nope.txt", serves: notServed), .cancel)
        XCTAssertEqual(decide("trueconvo-desk://desk/assets/font.woff2", current: "trueconvo-desk://desk/index.html", serves: notServed), .cancel)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", current: "trueconvo-desk://desk/index.html", type: .reload, serves: notServed),
                       .cancel, "a reload of a document the bundle no longer serves")
        XCTAssertEqual(asked, ["trueconvo-desk://desk/nope.txt", "trueconvo-desk://desk/assets/font.woff2", "trueconvo-desk://desk/index.html"])
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#a", current: "trueconvo-desk://desk/index.html", serves: notServed),
                       .allowSameDocument, "the current document is not re-checked for a fragment change")
        XCTAssertEqual(decide("https://example.invalid/", serves: notServed), .cancel)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", closed: true, serves: notServed), .cancel)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", locked: true, serves: notServed), .cancel)
        XCTAssertEqual(asked.count, 3, "foreign, same-document, closed and locked decisions never ask")
    }

    func testOnlyMainFrameBundleNavigationIsAllowed() {
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html"), .allowNewDocument)
        XCTAssertEqual(decide("TRUECONVO-DESK://Desk/"), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", current: "trueconvo-desk://desk/index.html"), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", current: "trueconvo-desk://desk/index.html", type: .reload), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", current: "trueconvo-desk://desk/index.html", type: .backForward), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", current: "trueconvo-desk://desk/index.html", type: .linkActivated), .allowNewDocument)
    }

    func testEverythingElseIsCancelled() {
        XCTAssertEqual(decide(nil), .cancel)
        XCTAssertEqual(decide("https://example.invalid/"), .cancel)
        XCTAssertEqual(decide("file:///etc/hosts"), .cancel)
        XCTAssertEqual(decide("about:blank"), .cancel)
        XCTAssertEqual(decide("javascript:alert(1)"), .cancel)
        XCTAssertEqual(decide("trueconvo-desk://other/index.html"), .cancel)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", mainFrame: false), .cancel, "subframes and new windows")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", download: true), .cancel)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", closed: true), .cancel)
    }

    /// What WebKit was observed to do with the pinned Desk build
    /// (`HeadlessDeskProofTests`, 2026-10-09): a fragment navigation from a
    /// link, from `location.hash` (even to an empty fragment) or from a
    /// native load keeps the document; `location.href` to the fragment-less
    /// URL loads a new document; a history traversal between entries of one
    /// document is done in place without asking the policy at all; a history
    /// load (`backForward`) of an item that differs from the live document
    /// only by its fragment scrolls that document, even when an earlier
    /// document made the item; and a history load of a different URL (the
    /// bundle root against `index.html`) loads that document. WebKit's
    /// fragment rule has two load-type exceptions: a reload, and the app's
    /// load of exactly the live URL (see
    /// `testNativeLoadOfTheIdenticalURLIsADocumentLoad`). The "live
    /// document" is the URL the host tracks, after `pushState` too.
    func testFragmentNavigationOnTheCurrentDocumentKeepsTheGeneration() {
        let current = "trueconvo-desk://desk/index.html"
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#desk-main", current: current, type: .linkActivated), .allowSameDocument, "the skip link")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#desk-main", current: current, type: .other), .allowSameDocument, "location.hash")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#", current: "trueconvo-desk://desk/index.html#desk-main"), .allowSameDocument,
                       "location.hash = '' keeps the document under an empty fragment")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#a", current: "trueconvo-desk://desk/index.html#b"), .allowSameDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#x", current: current, type: .other), .allowSameDocument,
                       "a native load differing only by fragment arrives as .other and keeps the document")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", current: "trueconvo-desk://desk/index.html#a"), .allowNewDocument,
                       "dropping the fragment by script loads a new document (observed); dropping it through history never reaches the policy")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#a", current: current, type: .reload), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#a", current: current, type: .backForward), .allowSameDocument,
                       "a history item differing from the committed document only by its fragment scrolls that document (observed)")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#a", current: "trueconvo-desk://desk/index.html#b", type: .backForward), .allowSameDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", current: "trueconvo-desk://desk/index.html#a", type: .backForward), .allowNewDocument,
                       "a fragment-less item is a document load, whoever made it")
        XCTAssertEqual(decide("trueconvo-desk://desk/other.html#a", current: current, type: .backForward), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#a", current: nil, type: .backForward), .allowNewDocument, "nothing committed yet")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html", current: "trueconvo-desk://desk/", type: .backForward), .allowNewDocument,
                       "a genuinely different document through history (observed: the root and index.html are two documents)")
        XCTAssertEqual(decide("trueconvo-desk://desk/#desk-main", current: "trueconvo-desk://desk/index.html", type: .backForward), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#desk-main", current: "trueconvo-desk://desk/", type: .backForward), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/?x=1#a", current: "trueconvo-desk://desk/?x=1"), .allowSameDocument,
                       "after pushState the live URL is the pushed one (observed)")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#b", current: "trueconvo-desk://desk/?x=1#a"), .allowNewDocument,
                       "and the URL it replaced is another document (observed)")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#a", current: current, type: .formSubmitted), .allowNewDocument,
                       "WebKit never treats a form submission as a fragment navigation")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#a", current: current, type: .formResubmitted), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/other.html#a", current: current), .allowNewDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#a", current: nil), .allowNewDocument)
    }

    /// Round 3 of the review (history reviewer, observed on the pinned
    /// build): the app's load of exactly the live URL, fragment included, is
    /// a full load in WebKit (`FrameLoadType::Same`), and WebKit marks its
    /// request with the reload-ignoring-cache policy (1). The page's own
    /// navigation to its identical URL (`location.href = location.href`, the
    /// skip link twice) has the default policy (0) and scrolls, as does a
    /// native load differing only by fragment. Before the fix the native
    /// identical load was taken for a scroll and the fresh document ran on
    /// the replaced document's still-live connection.
    func testNativeLoadOfTheIdenticalURLIsADocumentLoad() {
        let live = "trueconvo-desk://desk/index.html#desk-main"
        XCTAssertEqual(decide(live, current: live, type: .other, cachePolicy: .reloadIgnoringLocalCacheData), .allowNewDocument,
                       "native load of the identical URL")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#", current: "trueconvo-desk://desk/index.html#", cachePolicy: .reloadIgnoringLocalCacheData),
                       .allowNewDocument, "the identical empty fragment too")
        XCTAssertEqual(decide(live, current: live, type: .other), .allowSameDocument, "the page's own identical navigation")
        XCTAssertEqual(decide(live, current: live, type: .linkActivated), .allowSameDocument, "the skip link again")
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#other", current: live, type: .other), .allowSameDocument,
                       "a native load differing only by fragment")
        XCTAssertEqual(decide(live, current: live, type: .other, cachePolicy: .reloadIgnoringLocalCacheData, locked: true), .cancel,
                       "a document load, so cancelled while locked")
        XCTAssertEqual(decide(live, current: live, type: .backForward, cachePolicy: .reloadIgnoringLocalCacheData), .allowSameDocument,
                       "history loads follow the fragment rule alone")
    }

    /// Round 4 (R4-H1, case a): an app-built request with a reload cache
    /// policy (WebKit reports 1, 4 and 5 all as 1) that differs from the live
    /// URL only by its fragment is a `Standard` load to WebKit, which
    /// scrolls. Taken for a document load, the live document was revoked for
    /// a load WebKit never started. Only exactly the live URL is a reload.
    func testReloadCachePolicyOnAFragmentChangeIsAScroll() {
        let entry = "trueconvo-desk://desk/index.html"
        XCTAssertEqual(decide(entry + "#frag1", current: entry, cachePolicy: .reloadIgnoringLocalCacheData), .allowSameDocument)
        XCTAssertEqual(decide(entry + "#b", current: entry + "#a", cachePolicy: .reloadIgnoringLocalCacheData), .allowSameDocument)
        XCTAssertEqual(decide(entry + "#b", current: entry + "#a", type: .linkActivated, cachePolicy: .reloadIgnoringLocalCacheData), .allowSameDocument)
        XCTAssertEqual(decide(entry + "#a", current: entry + "#a", cachePolicy: .reloadIgnoringLocalCacheData), .allowNewDocument, "exactly the live URL")
        XCTAssertEqual(decide(entry, current: entry, cachePolicy: .reloadIgnoringLocalCacheData), .allowNewDocument, "exactly the live URL, no fragment")
        XCTAssertEqual(decide(entry, current: entry + "#a", cachePolicy: .reloadIgnoringLocalCacheData), .allowNewDocument, "no fragment to scroll to")
        XCTAssertEqual(decide(entry + "#a", current: nil, cachePolicy: .reloadIgnoringLocalCacheData), .allowNewDocument, "no live document")
    }

    /// While locked, nothing that would need a connection and bootstrap is
    /// allowed: a reload or a new document is cancelled without asking the
    /// bundle; the locked page keeps its document, and a fragment change on
    /// it is still harmless.
    func testLockedHostCancelsEveryDocumentNavigationButKeepsTheDocument() {
        let current = "trueconvo-desk://desk/index.html"
        XCTAssertEqual(decide(current, current: current, type: .reload, locked: true), .cancel, "the page's own Try loading again")
        XCTAssertEqual(decide(current, locked: true), .cancel, "a native load")
        XCTAssertEqual(decide("trueconvo-desk://desk/other.html", current: current, type: .linkActivated, locked: true), .cancel)
        XCTAssertEqual(decide(current, current: current, type: .backForward, locked: true), .cancel)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#desk-main", current: current, type: .linkActivated, locked: true), .allowSameDocument)
        XCTAssertEqual(decide("trueconvo-desk://desk/index.html#desk-main", current: current, type: .backForward, locked: true), .allowSameDocument,
                       "a history scroll of the locked document is as harmless as the skip link")
        XCTAssertEqual(decide("https://example.invalid/", locked: true), .cancel)
        XCTAssertEqual(decide(current, current: current, type: .reload, locked: false), .allowNewDocument, "and again once unlocked")
    }
}

final class WebKitHostEventSinkTests: XCTestCase {
    func testDetailsAreObjectsWithTheContractFields() throws {
        let binding = UUID(), delivery = UUID(), commit = UUID()
        let events: [(HostEvent, [String])] = [
            (.hostConnection(connectionId: "c", generation: 2, state: .locked, reason: .lock), ["connectionId", "generation", "reason", "state", "type"]),
            (.dictationFinal(connectionId: "c", generation: 2, bindingId: binding, deliveryId: delivery, text: "hello"),
             ["bindingId", "connectionId", "deliveryId", "generation", "text", "type"]),
            (.dictationReceipt(connectionId: "c", generation: 2, deliveryId: delivery, commitRequestId: commit, revision: 3),
             ["commitRequestId", "connectionId", "deliveryId", "generation", "revision", "type"])
        ]
        for (event, keys) in events {
            let detail = try XCTUnwrap(JSONBridge.foundationObject(from: event.jsonDetail) as? NSDictionary)
            XCTAssertEqual((detail.allKeys as? [String])?.sorted(), keys)
            XCTAssertEqual(detail["type"] as? String, event.type)
            XCTAssertEqual(detail["connectionId"] as? String, "c")
            XCTAssertEqual(detail["generation"] as? Int, 2)
            XCTAssertTrue(JSONSerialization.isValidJSONObject(detail))
        }
    }

    func testFunctionBodyIsAConstantThatDispatchesTheArgument() {
        XCTAssertEqual(WebKitHostEventSink.dispatchFunctionBody,
                       #"window.dispatchEvent(new CustomEvent("trueconvo-host", { detail: detail }));"#)
        XCTAssertEqual(WebKitHostEventSink.eventName, "trueconvo-host")
    }

    func testObserverSeesEveryPushEvenWithoutAWebView() {
        let seen = Locked<[HostEvent]>([])
        let sink = WebKitHostEventSink { event in seen.mutate { $0.append(event) } }
        let event = HostEvent.hostConnection(connectionId: "c", generation: 1, state: .ready, reason: .ready)
        sink.push(event)
        XCTAssertEqual(seen.value, [event])
    }
}
