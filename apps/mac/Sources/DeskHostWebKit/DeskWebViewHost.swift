import DeskHost
import Foundation
import WebKit

/// Pure navigation policy for the privileged Desk view, so it can be tested
/// without a web view. Only a main-frame navigation to a document the bundle
/// serves (`servesDocument`: an HTML asset it lists, as the scheme handler
/// would answer) on the bundle's own scheme and host is allowed; new windows
/// (no target frame), subframes, downloads, every other scheme, and a closed
/// view are cancelled. Checking the document before allowing matters because
/// allowing gives up the live connection: a stray in-bundle link to a 404 or
/// a font would otherwise revoke the session for a response WebKit then
/// refuses to show.
///
/// A fragment navigation on the live document is allowed without a new
/// document generation, because WebKit keeps the document (and its
/// bootstrap). The rule is WebKit's own (`FrameLoader`'s
/// `shouldPerformFragmentNavigation`): the destination has a fragment
/// (possibly empty), equals the live document's URL ignoring it, and the
/// navigation is not a reload. WebKit counts two loads as reloads here: a
/// reload proper, and the app loading exactly the URL the view shows,
/// fragment included (`FrameLoadType::Same`). The second arrives as `other`
/// and is told apart by the request's cache policy, which WebKit sets to
/// `reloadIgnoringLocalCacheData` for it (observed: 1 for the native load of
/// the identical URL, 0 for the page's own navigation to its identical URL,
/// which scrolls, and for a native load differing only by fragment). WebKit
/// reports an app-built request's reload cache policies (1, 4 and 5) as 1
/// too, and still scrolls when such a request differs from the live URL
/// only by its fragment (it is a `Standard` load to WebKit; observed in
/// round 4), so that cache policy marks a document load only for exactly
/// the live URL. History loads are no exception: a
/// `backForward` action to an item that differs from the live document only
/// by its fragment scrolls the live document, whichever document made the
/// item. The live document's URL is the one the host tracks itself
/// (`DeskWebViewHost.committedDocumentURL`), never `webView.url` or the
/// back/forward list at decision time: for a native load or a history
/// traversal both already name the destination when the policy is asked.
///
/// Observed on the pinned Desk build in a headless `WKWebView` (2026-10-09,
/// `HeadlessDeskProofTests`): the page's skip link, `location.hash`, and a
/// native load differing only by fragment each arrive here (`linkActivated`
/// or `other`) and keep the document; `location.href` to the fragment-less
/// URL arrives as `other` and loads a new document; `history.back()`,
/// `history.forward()` and native `goBack()` between entries of one document
/// never arrive here at all, WebKit traverses in place; native `goBack()`
/// from that new document to the earlier document's fragment entry arrives
/// as `backForward` and scrolls the new document (WebKit then drops the new
/// document's own entry, so there is nothing to go forward to); and a
/// `backForward` to a different URL is a different document. (WebKit then
/// restores that document from its back/forward cache when it has it,
/// without running the new bootstrap; the host notices and reloads it, see
/// `DeskWebViewHost`.)
///
/// Form submissions are treated as document loads (WebKit would scroll for
/// a GET submission to the same URL; the Desk's policy forbids forms). That
/// is the safe direction: a new document wrongly taken for a fragment scroll
/// would run under the old bootstrap, while a scroll wrongly taken for a
/// document load only revokes a connection a fresh load gets back. WebKit
/// decides a fragment navigation without waiting for an answer that is not
/// given at once, so it scrolls and never starts the document load the host
/// allowed; the host notices that and reloads once (see `DeskWebViewHost`,
/// navigations WebKit never starts).
///
/// While the host is locked no document navigation is allowed: a reload or
/// new document would need a connection and bootstrap, which must not be
/// issued while locked (the join contract: unlock requires a fresh document
/// and bootstrap, host-enforced). The locked page keeps its document (but
/// for the two exceptions `DeskWebViewHost` names); a fragment navigation
/// on it stays harmless and allowed.
public enum DeskNavigationPolicy {
    public enum Decision: Equatable, Sendable {
        case cancel
        /// Allow, starting a new document generation first.
        case allowNewDocument
        /// Allow a same-document (fragment) navigation; nothing changes.
        case allowSameDocument
    }

    public static func decide(url: URL?, currentDocumentURL: URL?, targetsMainFrame: Bool, isDownload: Bool,
                              navigationType: WKNavigationType, cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy,
                              scheme: String, host: String, closed: Bool, locked: Bool,
                              servesDocument: (URL) -> Bool = { _ in true }) -> Decision {
        guard !closed, targetsMainFrame, !isDownload, let url else { return .cancel }
        guard url.scheme?.lowercased() == scheme.lowercased(), url.host?.lowercased() == host.lowercased() else { return .cancel }
        if isFragmentNavigation(to: url, from: currentDocumentURL, navigationType: navigationType, cachePolicy: cachePolicy) {
            return .allowSameDocument
        }
        guard !locked, servesDocument(url) else { return .cancel }
        return .allowNewDocument
    }

    /// WebKit's rule for staying in the document: a fragment on the
    /// destination, the live document's URL otherwise, and not a reload
    /// (nor the app's load of the identical URL, see above); history
    /// traversals included. Form submissions are document loads here (see
    /// above).
    static func isFragmentNavigation(to url: URL, from current: URL?, navigationType: WKNavigationType,
                                     cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy) -> Bool {
        switch navigationType {
        case .reload, .formSubmitted, .formResubmitted: return false
        case .linkActivated, .other:
            if cachePolicy == .reloadIgnoringLocalCacheData, let current, url.absoluteString == current.absoluteString { return false }
        case .backForward: break
        @unknown default: return false
        }
        guard url.fragment != nil, let current else { return false }
        return equalIgnoringFragment(url, current)
    }

    static func equalIgnoringFragment(_ a: URL, _ b: URL) -> Bool {
        guard var first = URLComponents(url: a, resolvingAgainstBaseURL: false),
              var second = URLComponents(url: b, resolvingAgainstBaseURL: false) else { return false }
        first.fragment = nil
        second.fragment = nil
        return first.url?.absoluteString == second.url?.absoluteString
    }
}

/// Builds and owns the privileged `WKWebView` that shows the bundled Desk:
/// non-persistent data store, the `trueconvo-desk` scheme handler, the
/// `trueConvoHost` reply handler and the document-start bootstrap script,
/// JavaScript on, nothing else. Its delegates allow only main-frame
/// navigation to a document within the bundle, cancel every other
/// navigation, new window, download and panel, and disable link previews.
///
/// Lifecycle, in `DeskHostProtocol` terms:
/// - every allowed document navigation (first load, reload, the page's own
///   "Try loading again") begins a new generation, issues a new connection
///   and replaces the bootstrap user script before the navigation proceeds
///   (after the unsaved-work check below, when it leaves a live page);
/// - `lock()` marks the host locked at once, then has the protocol push
///   `host.connection` `locked` to the live connection and refuse the store;
///   the page closes its runtime on that event, and the invalidated
///   connection can never be used again. While locked, no document
///   navigation is allowed and no connection is issued: a reload is
///   cancelled, the locked page keeps its document. That includes a
///   document navigation allowed just before the lock: a decision whose
///   answer was still pending is answered `cancel`, one allowed but not yet
///   at its response is stopped (`stopLoading`), and its main-frame
///   response is refused while locked, so WebKit fails it and the locked
///   document stays. There are two exceptions, each a closed page that is
///   never issued anything; unlock and a reload bring a fresh document as
///   usual. A document whose response WebKit had already accepted when the
///   lock arrived (a window of well under a millisecond) commits on the
///   bootstrap the lock revoked and shows the page's "Workspace
///   unavailable" screen. And a document WebKit restores from its
///   back/forward cache, once WebKit reported its provisional start, is not
///   stopped by `stopLoading` and asks no response question (observed in
///   round 5, R5-LT-B): it commits while locked and replaces the locked
///   page with that older document, which shows its "Workspace connection
///   closed" screen on the bootstrap revoked when it was left;
/// - `unlock()` begins a new generation, so anything that could have been
///   issued while locked is revoked and every envelope of the locked
///   document is stale, then reopens the store. It bootstraps nothing: a
///   fresh document (`reload()`) is the only way to a new connection, as the
///   contract requires. The newest request wins: an unlock acts only if no
///   `lock()` was requested after it (`lockEpoch`, checked after each hop of
///   its step), so a lock landing while an unlock is in flight leaves host
///   and store locked, and the next `unlock()` reopens both. An unlock with
///   nothing locked does nothing;
/// - `close()` stops loading, closes the protocol (which pushes `revoked`
///   with reason `shutdown`), shuts the message handler, removes it and the
///   user scripts from the content controller, and detaches the event sink.
///   The delegates stay installed: the document is still alive in the view,
///   and with no delegate WebKit would allow any navigation, so the policy
///   keeps cancelling everything (`closed`) for as long as the view exists.
///
/// Every one of those steps runs on the main actor, one after another
/// (`serialized`): a document's generation, issuance and bootstrap can never
/// interleave with another document's, nor with lock, unlock or close, even
/// though each protocol call is its own suspension. WebKit may ask about a
/// second navigation while the first decision is pending; the second then
/// waits, begins the next generation, and the first connection is revoked
/// before anything can use it.
///
/// Navigations WebKit drops. WebKit keeps one open policy question per
/// frame and says nothing when it drops one (observed on the pinned build:
/// no provisional start, failure or commit follows). Observed: a later
/// main-frame navigation question, or a new-window question, drops the main
/// frame's question still unanswered (a subframe question does not); and a
/// later main-frame navigation also stops a document navigation the host
/// allowed that WebKit has not started yet (had it started, WebKit reports
/// the start before the next question). A main-frame response question is
/// taken as dropping an unanswered one too (not observed: WebKit fails a
/// provisional load before it asks about the next navigation). A dropped
/// document navigation begins no generation when the host sees the drop in
/// time, and is answered `cancel` either way: moot for WebKit, and it makes
/// the host's view true even where the drop was only assumed.
///
/// Navigations WebKit never starts. WebKit can also take the host's `allow`
/// and start nothing, with no callback at all: when it decided a fragment
/// navigation itself (it does not wait for an answer that is not given at
/// once, and scrolls), when the app calls `stopLoading()` in the same turn
/// as the navigation, or when the page calls `window.stop()` (observed in
/// round 4, R4-H1). WebKit starts an allowed navigation asynchronously,
/// within milliseconds (observed 0.5 to 5 ms), and nothing it offers is
/// ordered after that start: a JavaScript round trip to the page's process
/// sent right after the answer came back first in every observed load (60
/// of 60), and two in a row still did on the first load and on every reload
/// after an unlock (7 of 7). So after answering
/// `allow` the host waits twice for WebKit to catch up (half a second, then
/// a JavaScript round trip, so time the page's process spent busy does not
/// count) and, if that navigation has still not started, treats it as
/// dropped.
///
/// Which connection the live document holds. The host follows each
/// document navigation it allowed from the answer to its provisional start
/// and its commit (or failure), and records the connection whose bootstrap
/// the committed document runs. A document WebKit restores from its
/// back/forward cache commits without a response (every document the scheme
/// handler serves has one) and keeps the bootstrap it had, revoked when it
/// was left; a load that starts without the host's allow holds no
/// connection of its own. Whenever nothing more is in flight and the current
/// connection is not the live document's (a dropped navigation that had
/// already begun its generation, a provisional load that failed, a restored
/// document), that connection belongs to no document and the live page's
/// own was revoked: the host revokes the orphan and reloads once, so the
/// view ends on a fresh document holding the one live connection. Before
/// reloading it lets WebKit catch up, so a navigation the app or page asked
/// for in the same instant reaches the policy first and is not replaced by
/// the reload (R4-LT-4); if such a navigation is in flight, or a document
/// holding the current connection committed meanwhile, there is no reload.
/// If that reload is itself lost before a healthy commit, the host only
/// revokes, and the app's next `reload()` is left to fix the view.
///
/// Same-document URL changes the live document makes while the view loads
/// another navigation are not seen until the view settles (WebKit reports
/// the provisional URL meanwhile), so a fragment navigation in that window
/// can be judged against a stale URL and taken for a document load. WebKit
/// scrolls instead; the navigation never starts and is recovered as above
/// (R4-H2).
///
/// When the content process ends (a crash, a memory kill), the page and its
/// connection are gone: the host revokes, tells the app
/// (`onContentProcessTerminated`) and, unless locked or closed, reloads the
/// view once. Every navigation question the ended process had asked goes
/// with it, and WebKit ignores a later answer (observed in round 5: an
/// `allow` given after the end starts nothing). So a document decision
/// still being answered is dropped (it begins nothing, or the connection
/// issued for it is revoked), and the reload does not wait for it (nor for
/// the app's answer about unsaved work on the ended page); it waits only
/// for a navigation the new process asked about, or a load already under
/// way, to end, and a document holding the current connection committing
/// meanwhile makes it unneeded (R5-LT-A).
/// Implementing the termination callback turns off WebKit's own
/// reload after a crash, so the host does it: at most once per
/// `terminationReloadInterval`, so a page that keeps ending its process
/// leaves the view empty instead of reloading in a loop. While locked it
/// does not reload; unlock requires a fresh document from the app anyway.
///
/// Unsaved work. The Desk keeps unsaved work behind a `beforeunload`
/// listener that cancels the event. WebKit never dispatches `beforeunload`
/// in this view (only to a client that can show its confirmation panel,
/// which WebKit's public API does not offer), and the host's document step
/// would revoke the page before WebKit did, which makes the Desk clear its
/// unconfirmed edits. So before a document navigation away from a page
/// that holds the current connection, the host dispatches a cancelable
/// `beforeunload` event in the page itself, from its own script world. It
/// is a real `BeforeUnloadEvent`, so the page's listeners answer as they
/// would WebKit's own: it is cancelled by `preventDefault()`, by an
/// `onbeforeunload` handler returning anything (a message, an empty one,
/// false), or by a listener setting `returnValue` to a message (W4-R1).
/// Only a page that answers without cancelling it is left without asking.
/// A page that cancels it holds unsaved work; a page that gives no answer
/// may (a script error, a listener that throws, an unexpected value, no
/// answer within `unsavedWorkCheckTimeout` from a busy page, its content
/// process ending during the check). A listener's throw is seen by an
/// `error` listener the host registers in its own world at the start of
/// every document, ahead of any of the page's own, so the page cannot hide
/// it (W4-R2). One throw stays out of its sight: a listener whose function
/// was made by another frame's script reports its throw to that frame, and
/// reads as not cancelling (the pinned Desk registers no such listener).
/// For a page that cancels or gives no answer the host asks the app
/// (`confirmLeavingUnsavedWork`, saying which), and without the app's yes
/// the navigation is cancelled and the page keeps its document, its
/// connection and its work (R5-NAV-2, W4). A yes counts only while the
/// decision is still the one WebKit waits on and no lock (even one undone
/// since) or close came meanwhile; once any did, the app is not asked at
/// all. A clean answer counts on the same terms: one that comes back after
/// any of them begins nothing, so a reload asked for before a lock never
/// begins a document after the unlock (Codex P3 of eedc29f); the app's own
/// reload after the unlock does. A connection issued meanwhile changes
/// nothing: only a document step issues one, and a later question drops
/// this decision anyway, so it came from an older navigation's step that
/// was under way when WebKit asked, and this newer navigation replaces it
/// as above (P3R-1). A yes revokes
/// the page's connection at once, but WebKit carries the navigation out
/// only once the page's content process is free: a page still busy stays
/// in the view, holding no live connection, until it frees (W4-R3). A
/// page whose process never frees cannot be left by any navigation, and
/// WebKit offers no public way to end its process; only replacing the web
/// view helps. The host's own reloads never meet the check: they follow a
/// revocation (an orphaned connection, a restored document) or the end of
/// the content process, when the page has no work left to keep.
@MainActor
public final class DeskWebViewHost: NSObject {
    public let webView: WKWebView
    public let hostProtocol: DeskHostProtocol
    public let messageHandler: HostMessageHandler
    public let eventSink: WebKitHostEventSink
    public let schemeHandler: DeskAssetSchemeHandler
    /// The launch's participant lane, given only with a participant host
    /// (plan S11; inactive: the app gives none). The message handler hands
    /// it `participant.*`, and each of its lifecycle steps comes before the
    /// host's own (participant contract section 14, S10 reading 1):
    /// `lockNow()` before the lock step, `unlock(ifNoLockSince:)` after the
    /// unlock step, and `beginShutdown(quitting:)` before the close step,
    /// which then runs the host's `revokeForShutdown()`, the lane's
    /// `finishShutdown(quitting:)` and the host's `closeStore()`. Without a
    /// lane, lock, unlock and close are exactly as before.
    ///
    /// The transport drops what has gone stale: with a lane or without
    /// (Codex's S10 carried requirement 3 and S11 ruling (a)), the message
    /// handler drops an answer whose asking connection is gone by the time
    /// it is ready, or that is ready once this host is locked or closed;
    /// with a lane also one whose request came before a lock, window close
    /// or quit began at the lane (its `lifecycleEpoch` moved). With a lane
    /// the event sink delivers a participant event only to the live document's
    /// own valid connection while this host is neither locked nor closed
    /// (`deliversParticipantEvent(connectionId:generation:)`).
    public let participantLane: (any ParticipantLane)?
    /// The lane's `unlock(ifNoLockSince:)` the last unlock step queued, for
    /// the app to wait on before it loads a fresh document (S9 ruling c:
    /// the page's first commit then finds the lane unlocked, so the writes
    /// it held go first). Never awaited inside the step. Nil without a lane.
    /// `unlock(laneEpoch:)` also returns the one it queued, if any.
    public private(set) var laneUnlock: Task<Void, Never>?
    public private(set) var currentConnection: HostConnection?
    public private(set) var isClosed = false
    /// Set by `lock()` before anything else happens; cleared only by the
    /// unlock step that answers the newest lock request (`lockEpoch`). The
    /// policy cancels document navigations while it is set.
    public private(set) var isLocked = false
    /// Counts `lock()` requests: the one record an unlock step decides from.
    /// An unlock remembers the epoch it was requested in and acts only while
    /// it is still the newest, so a lock requested after it always wins.
    private var lockEpoch = 0
    /// The URL of the document live in the view, as the host itself saw it:
    /// recorded at `didCommit` from the committing navigation itself (the
    /// URL of its main-frame response, or of the history item WebKit
    /// restored), never from `webView.url`, which already names a native
    /// load or history step the app requested in the instant before the
    /// commit arrived. Recorded again whenever the view settles (stops
    /// loading, or changes URL while not loading), which is how same-document
    /// changes reach it: a fragment navigation, `pushState`, `replaceState`,
    /// a same-document history traversal. Nil before the first commit and
    /// once the content process is gone. The navigation policy's fragment
    /// rule compares against this.
    public private(set) var committedDocumentURL: URL?
    private var settledDocumentObservations: [NSKeyValueObservation] = []

    /// A document navigation the host allowed, followed until it commits or
    /// fails: the connection whose bootstrap was installed for it (nil for
    /// a load that started without the host's allow), its URL, WebKit's
    /// navigation object once it started, and the URL of its main-frame
    /// response if it had one.
    private struct DocumentNavigation {
        /// Tells one allowed navigation from the next.
        var id = 0
        let connection: HostConnection?
        let url: URL?
        var navigation: AnyObject?
        var responseURL: URL?
    }
    /// Main-frame navigation, new-window and main-frame response questions
    /// WebKit has asked, as a counter: an unanswered document decision is
    /// dropped once it moves on. The end of a content process counts as one
    /// more: it drops every question that process asked.
    private var policyQuestions = 0
    /// Document decisions not answered yet, by question number.
    private var undecidedDocuments: Set<Int> = []
    /// Questions numbered up to this one were asked by a content process
    /// that has since ended: WebKit ignores their answers, and a document
    /// decision among them can begin nothing more (see the type's comment).
    private var questionsOfEndedProcesses = 0
    /// Answered `allow`, not started yet.
    private var allowedDocument: DocumentNavigation?
    /// Started, not committed or failed yet.
    private var provisionalDocument: DocumentNavigation?
    /// The connection whose bootstrap the live document runs, as far as the
    /// host knows; nil when it holds none (or none the host issued).
    private(set) var documentConnection: HostConnection?
    /// Set when a recovery reloads the view; cleared by a healthy commit.
    private var recoveryReloadPending = false
    private var allowedDocuments = 0
    /// When the host last reloaded the view after a content-process
    /// termination (system uptime).
    private var lastTerminationReload: TimeInterval?
    /// The shortest time between two reloads after content-process
    /// terminations; a second termination sooner leaves the view empty.
    var terminationReloadInterval: TimeInterval = 30
    /// A termination's reload not done yet: it waits for a navigation the
    /// new process asked about, or a load under way, to end (see the
    /// type's comment).
    private var terminationReloadPending = false

    /// Called after each new document's connection and bootstrap are in
    /// place and the navigation is allowed to proceed.
    public var onDocumentBegan: ((HostConnection) -> Void)?
    /// Called for every cancelled navigation or new-window request.
    public var onNavigationRefused: ((URL?) -> Void)?
    /// Called when WebKit dropped a document navigation the policy had
    /// allowed (`onNavigationDecided` reported `allowNewDocument` for it),
    /// before or after its generation began; see the type's comment.
    public var onNavigationDropped: ((URL?) -> Void)?
    /// Called for every main-frame policy decision with what WebKit
    /// reported and what the policy decided; identities and URLs only, for
    /// the host's log and for the headless proofs.
    public var onNavigationDecided: ((NavigationDecision) -> Void)?
    /// Called once the host has revoked the connection of a page whose
    /// content process ended, before the host's own reload (if any; see
    /// the type's comment). Not called once the host is closed.
    public var onContentProcessTerminated: (() -> Void)?
    /// Asked, with the navigation's URL and the reason, before a document
    /// navigation (the app's reload or load, or the page's own) replaces a
    /// live page that may hold unsaved work: one that cancels a
    /// `beforeunload` event (`.unsaved`) or gives no answer (`.noAnswer`;
    /// see the type's comment). `true` lets the navigation go on, and
    /// whatever the page held is lost; `false` or a thrown error keeps the
    /// page and cancels the navigation (`onNavigationRefused`). Unset, the
    /// page is kept: no navigation silently discards work, and a page that
    /// cannot answer is never left without the app's yes. A yes over a page
    /// whose process is still busy takes effect only once it is free (see
    /// the type's comment). The navigation waits for the answer; if WebKit
    /// drops it meanwhile (another navigation, the end of the content
    /// process), or a lock (even one undone by an unlock since) or close
    /// arrives, the answer changes nothing. So the app may be asked again
    /// before it answered: only the newest question still matters.
    public var confirmLeavingUnsavedWork: (@MainActor (URL?, UnsavedWorkReason) async throws -> Bool)?

    /// Why the app is asked before a navigation leaves the live page.
    public enum UnsavedWorkReason: Equatable, Sendable {
        /// The page cancelled `beforeunload`: it holds unsaved work.
        case unsaved
        /// The page gave no answer (see the type's comment): it may hold
        /// unsaved work and could not say.
        case noAnswer
    }

    /// One policy callback as WebKit reported it, and the decision taken.
    public struct NavigationDecision: Equatable, Sendable {
        public let navigationType: WKNavigationType
        /// The document the navigation started from, as WebKit reports it.
        public let sourceURL: URL?
        public let targetURL: URL?
        /// `webView.url` at the moment of the decision (already the
        /// destination for a native load or history traversal).
        public let currentURL: URL?
        /// The live document's URL the policy compared against
        /// (`DeskWebViewHost.committedDocumentURL`); nil before the first
        /// commit. Not `webView.url` nor the back/forward list's current
        /// item: for a native load or a history traversal both already name
        /// the destination when the policy is asked.
        public let currentDocumentURL: URL?
        public let decision: DeskNavigationPolicy.Decision
    }

    private var manifest: BundleManifest { schemeHandler.responder.resolver.manifest }
    /// The last lifecycle step queued; the next one runs after it.
    private var lifecycle: Task<Void, Never>?

    /// Test seam: the points inside lifecycle steps where, in production, a
    /// step is suspended (queued behind earlier steps, or on a protocol hop)
    /// and other calls can land. Nil outside tests, and then no step
    /// suspends at a checkpoint.
    enum LifecycleCheckpoint: Equatable, Sendable {
        case lockStepStarted, lockStepLocked
        case unlockStepStarted, unlockStepRevoked, unlockStepReopened
        case documentStepRevoked
        case closeStepStarted
    }
    var lifecycleCheckpoint: ((LifecycleCheckpoint) async -> Void)?
    /// Test seam: what a recovery does instead of reloading the view. Nil
    /// outside tests, and then it calls `reload()`.
    var recoveryReload: (() -> Void)?
    /// Test seam: how the host waits for WebKit to catch up with what was
    /// asked of it so far. Nil outside tests, and then `catchUpDelay`
    /// followed by a JavaScript round trip to the page's process.
    var webKitCatchUp: ((@escaping @MainActor () -> Void) -> Void)?
    /// See `afterWebKitCatchesUp`.
    static let catchUpDelay: UInt64 = 500_000_000
    /// Test seam: what the host does instead of asking the live page
    /// whether it cancels `beforeunload`: `true` it did (unsaved), `false`
    /// it answered and did not (clean), nil it gave no answer (unknown).
    /// Nil outside tests.
    var unsavedWorkCheck: (@MainActor () async -> Bool?)?
    /// See `liveUnsavedWork`.
    static let unsavedWorkCheckTimeout: UInt64 = 2_000_000_000
    /// Counts lifecycle steps queued so far, so a test can tell that a call
    /// has queued its step.
    private(set) var lifecycleStepsQueued = 0

    /// `participantLane` goes with a participant `hostProtocol` and only
    /// with one (`HostMessageHandler` stops on any other pairing).
    public init(hostProtocol: DeskHostProtocol, resolver: AssetResolver, eventSink: WebKitHostEventSink, frame: CGRect = .zero,
                participantLane: (any ParticipantLane)? = nil) {
        self.hostProtocol = hostProtocol
        self.eventSink = eventSink
        self.participantLane = participantLane
        schemeHandler = DeskAssetSchemeHandler(resolver: resolver)
        messageHandler = HostMessageHandler(hostProtocol: hostProtocol, expectedScheme: resolver.manifest.scheme,
                                            expectedHost: resolver.manifest.host, participantLane: participantLane)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: resolver.manifest.scheme)
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsAirPlayForMediaPlayback = false
        if #available(macOS 12.3, *) { configuration.preferences.isElementFullscreenEnabled = false }
        // WebKit on macOS 11 and later has no plug-in support at all; the
        // deprecated `plugInsEnabled` switch is not touched.
        let controller = WKUserContentController()
        controller.addScriptMessageHandler(messageHandler, contentWorld: .page, name: HostMessageHandler.name)
        controller.addUserScript(Self.errorCountUserScript)
        configuration.userContentController = controller

        webView = WKWebView(frame: frame, configuration: configuration)
        super.init()
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        messageHandler.attach(to: webView)
        // Every answer, with a lane or without, is checked against this
        // host's state when it is ready (S11 ruling (a); `HostMessageHandler`).
        messageHandler.deliversAnswers = { [weak self] in
            guard let self else { return false }
            return !self.isClosed && !self.isLocked
        }
        if participantLane == nil {
            eventSink.attach(to: webView)
        } else {
            eventSink.attach(to: webView) { [weak self] connectionId, generation in
                self?.deliversParticipantEvent(connectionId: connectionId, generation: generation) ?? false
            }
        }
        // WebKit changes both on the main thread.
        settledDocumentObservations = [
            webView.observe(\.url) { [weak self] view, _ in MainActor.assumeIsolated { self?.recordSettledDocument(of: view) } },
            webView.observe(\.isLoading) { [weak self] view, _ in MainActor.assumeIsolated { self?.recordSettledDocument(of: view) } }
        ]
    }

    public var entryURL: URL { schemeHandler.responder.entryURL }

    /// Loads the entry document. The navigation policy begins the document
    /// generation before the load proceeds; while locked it cancels instead.
    /// A live page holding unsaved work, or unable to say, is kept unless
    /// the app confirms leaving it (`confirmLeavingUnsavedWork`).
    public func load() {
        guard !isClosed else { return }
        webView.load(URLRequest(url: entryURL))
    }

    /// Reloads the view, or loads the entry document when it shows none. A
    /// live page holding unsaved work, or unable to say, is kept unless the
    /// app confirms leaving it (`confirmLeavingUnsavedWork`).
    public func reload() {
        guard !isClosed else { return }
        if webView.url == nil { load() } else { webView.reload() }
    }

    public func lock() async {
        await lock(laneLockedByCaller: false)
    }

    /// The same lock, for an owner that already ran the lane's `lockNow()`
    /// for this same lock request, synchronously, before this call (the
    /// Desk session does, in every state: section 14, S11 reading 3). Then
    /// the lane is not locked a second time here, so its epoch moves once
    /// per lock request: an unlock whose owner check began after this
    /// request is refused only by a lock requested after that, even when
    /// this host step runs later, in a task (S11 reading 4).
    public func lock(laneLockedByCaller: Bool) async {
        guard !isClosed else { return }
        isLocked = true
        lockEpoch += 1
        // The lane's lock first, here and now (section 14, S10 reading 1):
        // its runs are sent `stop` and its pushes end before v1's `locked`,
        // with no await before it and no step queued for it. A caller that
        // locked it already did so before calling.
        if !laneLockedByCaller { participantLane?.lockNow() }
        // No reload after a content-process termination, now or after the
        // unlock: unlock requires a fresh document from the app.
        terminationReloadPending = false
        // A document navigation allowed before the lock must not bring a
        // document now. Stopped before its response, WebKit keeps the
        // locked document; once its response was accepted, stopping would
        // only leave a half-loaded document, so it is left to commit (see
        // the type's comment). Its response is refused while locked anyway.
        // A back/forward-cache restore WebKit has started is not stopped by
        // this and commits (the type's comment again, R5-LT-B).
        if allowedDocument != nil || (provisionalDocument.map { $0.responseURL == nil } ?? false) {
            webView.stopLoading()
        }
        await serialized { [self] in
            await checkpoint(.lockStepStarted)
            await hostProtocol.lock()
            currentConnection = nil
            await checkpoint(.lockStepLocked)
        }
        await Self.settleMainQueue()
    }

    /// Verified unlock is the app's job before calling this. Nothing is
    /// bootstrapped here; the caller loads a fresh document afterwards.
    /// Idempotent: with nothing locked, or once a newer `lock()` was
    /// requested, the step does nothing, and a later `unlock()` still works.
    /// With a lane, its unlock is judged by the epoch read at this call's
    /// entry (see `unlock(laneEpoch:)`).
    public func unlock() async {
        await unlock(laneEpoch: nil)
    }

    /// The same unlock. With a lane, once the step reopened the store it
    /// queues the lane's `unlock(ifNoLockSince:)` and returns it (never
    /// awaited here). `laneEpoch` is the lane's lock epoch read when the
    /// owner check for this unlock began (the Desk session passes it); nil
    /// reads it here, at this call's entry, for a caller whose check is its
    /// own business. The lane then unlocks only if no lock came anywhere
    /// from that read through the host's step and the lane's own unlock
    /// (S11 reading 4).
    @discardableResult
    public func unlock(laneEpoch: Int?) async -> Task<Void, Never>? {
        guard !isClosed else { return nil }
        let epoch = lockEpoch
        // The lane applies its unlock only if no `lockNow()` came since this
        // (`unlock(ifNoLockSince:)`).
        let laneEpoch = laneEpoch ?? participantLane?.lockEpoch
        return await serialized { [self] () -> Task<Void, Never>? in
            await checkpoint(.unlockStepStarted)
            guard answersNewestLock(epoch) else { return nil }
            // Revoke whatever could have been issued while locked (nothing,
            // by the policy; this is the guarantee, not the expectation) and
            // make every envelope of the locked document stale.
            await hostProtocol.beginGeneration()
            currentConnection = nil
            await checkpoint(.unlockStepRevoked)
            guard answersNewestLock(epoch) else { return nil }
            await hostProtocol.unlock()
            await checkpoint(.unlockStepReopened)
            // A lock requested during that hop wins: its own step runs next
            // and locks the store again, and the host stays marked locked.
            // Nothing suspends between this check and clearing the flag.
            guard answersNewestLock(epoch) else { return nil }
            isLocked = false
            // Then the lane's unlock (S10 reading 1), queued and never
            // awaited here: this step gains no hop, and a lock requested
            // after `laneEpoch` was read, before or after this point, still
            // wins in the lane, by its epoch.
            guard let participantLane, let laneEpoch else { return nil }
            let queued = Task.detached { await participantLane.unlock(ifNoLockSince: laneEpoch) }
            laneUnlock = queued
            return queued
        }
    }

    /// Whether a participant event for this connection may be delivered to
    /// the view now (the sink asks on the main thread, at delivery): the
    /// host is open and unlocked, it is the current connection, the live
    /// document holds it, and it is still valid for the current generation.
    /// Anything else is a push for a document that is gone or not yet
    /// committed, dropped rather than handed to whatever the view shows.
    func deliversParticipantEvent(connectionId: String, generation: Int) -> Bool {
        guard !isClosed, !isLocked, let currentConnection, currentConnection.id == connectionId,
              currentConnection.generation == generation, documentConnection == currentConnection else { return false }
        return hostProtocol.checkConnection(connectionId, generation: generation) == .valid
    }

    /// Whether an unlock requested at `epoch` may still act: the host is
    /// open and locked, and no `lock()` was requested since.
    private func answersNewestLock(_ epoch: Int) -> Bool {
        !isClosed && isLocked && lockEpoch == epoch
    }

    /// Window close (`quitting` false) or the app's quit (true; it matters
    /// only with a participant lane). With a lane: the lane's
    /// `beginShutdown(quitting:)` at once, then one step running the host's
    /// `revokeForShutdown()`, the lane's `finishShutdown(quitting:)` (at
    /// most the one overall bound, Codex Q33) and the host's `closeStore()`,
    /// in that order (section 14, S10 reading 1). The lane's detach is its
    /// owner's, after this returns. Without a lane, exactly
    /// `DeskHostProtocol.close()`.
    public func close(quitting: Bool = false) async {
        guard !isClosed else { return }
        isClosed = true
        // The lane's step first, with no await before it: its pushes end
        // before v1's `revoked`, every run is sent `stop`, and its one bound
        // begins.
        participantLane?.beginShutdown(quitting: quitting)
        webView.stopLoading()
        let participantLane = self.participantLane
        await serialized { [self] in
            await checkpoint(.closeStepStarted)
            guard let participantLane else {
                await hostProtocol.close()
                return
            }
            await hostProtocol.revokeForShutdown()
            _ = await participantLane.finishShutdown(quitting: quitting)
            await hostProtocol.closeStore()
        }
        // Let the `revoked` push reach the page before the handler goes.
        await Self.settleMainQueue()
        messageHandler.shutDown()
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: HostMessageHandler.name, contentWorld: .page)
        controller.removeAllUserScripts()
        eventSink.detach()
        currentConnection = nil
    }

    // MARK: Document generations

    /// New generation, new connection, fresh bootstrap script, as one
    /// lifecycle step. The previous user scripts are replaced (the bootstrap
    /// and the host's error count, `errorCountScript`, are the only ones).
    /// Nil, and nothing issued that stays live, when the host is locked or
    /// closed: a lock or close that arrived while the step was in flight has
    /// its own step queued next, which revokes the connection before any
    /// document could carry it. Nil, and nothing
    /// begun, when `wanted` says no by the time the step runs (WebKit
    /// dropped the navigation while the step was queued, or the state its
    /// decision depends on changed: see `decideNavigation`).
    func beginDocument(while wanted: @escaping () -> Bool = { true }) async -> HostConnection? {
        await serialized { [self] in
            guard !isClosed, !isLocked, wanted() else { return nil }
            await hostProtocol.beginGeneration()
            await checkpoint(.documentStepRevoked)
            let connection = await hostProtocol.issueConnection()
            guard !isClosed, !isLocked, let script = try? HostBootstrapScript(connection: connection) else { return nil }
            let controller = webView.configuration.userContentController
            controller.removeAllUserScripts()
            controller.addUserScript(Self.errorCountUserScript)
            controller.addUserScript(WKUserScript(source: script.source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
            currentConnection = connection
            onDocumentBegan?(connection)
            return connection
        }
    }

    /// Runs `step` after every lifecycle step queued before it has finished.
    private func serialized<Result: Sendable>(_ step: @escaping @MainActor () async -> Result) async -> Result {
        let previous = lifecycle
        let task = Task { @MainActor () -> Result in
            await previous?.value
            return await step()
        }
        lifecycle = Task { @MainActor in _ = await task.value }
        lifecycleStepsQueued += 1
        return await task.value
    }

    private func checkpoint(_ point: LifecycleCheckpoint) async {
        guard let lifecycleCheckpoint else { return }
        await lifecycleCheckpoint(point)
    }

    // MARK: Dropped navigations and orphaned connections

    /// Nothing in flight could still bring a document: no document decision
    /// unanswered (but those a content process that has since ended asked:
    /// such a decision begins nothing more, as its step finds the question
    /// gone, and a step already under way is followed by the termination's
    /// own revocation), none allowed and not started, none provisional.
    private var documentNavigationsSettled: Bool {
        undecidedDocuments.allSatisfy { $0 <= questionsOfEndedProcesses } && allowedDocument == nil && provisionalDocument == nil
    }

    /// A live connection that no document holds, with nothing in flight that
    /// could still bring one: the live document's own was revoked when it
    /// began.
    var hasOrphanedConnection: Bool {
        guard let currentConnection else { return false }
        return currentConnection != documentConnection && documentNavigationsSettled
    }

    /// Revokes an orphaned connection and reloads the view, once per healthy
    /// commit (see the type's comment). Locked and closed hosts have their
    /// own steps for every connection.
    private func recoverIfOrphaned() {
        guard !isClosed, !isLocked, hasOrphanedConnection else { return }
        Task { @MainActor in
            let revoked = await self.serialized { [self] () -> Bool in
                guard !isClosed, !isLocked, hasOrphanedConnection else { return false }
                await hostProtocol.beginGeneration()
                currentConnection = nil
                return true
            }
            guard revoked else { return }
            // A navigation requested in the same instant (the app's load
            // right after a restored commit) reaches the policy first, and
            // then needs no reload on top of it.
            self.afterWebKitCatchesUp { self.reloadIfStillWithoutADocument() }
        }
    }

    /// The live document holds the current connection: the healthy state,
    /// and the one page that can hold unsaved work.
    private var livePageHoldsCurrentConnection: Bool {
        currentConnection != nil && documentConnection == currentConnection
    }

    private func reloadIfStillWithoutADocument() {
        guard !isClosed, !isLocked, documentNavigationsSettled, !livePageHoldsCurrentConnection, !recoveryReloadPending else { return }
        recoveryReloadPending = true
        if let recoveryReload { recoveryReload() } else { reload() }
    }

    /// Runs `then` once WebKit has had time to act on everything the host
    /// asked of it so far: `catchUpDelay` (half a second; WebKit asks about
    /// a requested navigation, and starts an allowed one, within
    /// milliseconds), then a JavaScript round trip to the page's process, so
    /// that a page busy running script, or a main thread busy elsewhere,
    /// does not count as time WebKit had. A round trip alone is not enough:
    /// WebKit reports an allowed navigation's start asynchronously, often
    /// after it (see the type's comment).
    private func afterWebKitCatchesUp(_ then: @escaping @MainActor () -> Void) {
        if let webKitCatchUp {
            webKitCatchUp(then)
            return
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.catchUpDelay)
            guard let self else { return }
            self.webView.evaluateJavaScript("0", in: nil, in: .defaultClient) { _ in then() }
        }
    }

    /// An allowed document navigation WebKit has not started after catching
    /// up twice was dropped without a callback (see the type's comment).
    private func dropIfNeverStarted(_ id: Int) {
        afterWebKitCatchesUp { [weak self] in
            guard let self, self.allowedDocument?.id == id else { return }
            self.afterWebKitCatchesUp { [weak self] in
                guard let self, let allowed = self.allowedDocument, allowed.id == id else { return }
                self.allowedDocument = nil
                self.onNavigationDropped?(allowed.url)
                self.recoverIfOrphaned()
                self.reloadAfterTerminationWhenSettled()
            }
        }
    }

    // MARK: Unsaved work

    /// What the live page said when asked whether it holds unsaved work.
    enum UnsavedWorkAnswer: Equatable, Sendable {
        /// It answered and did not cancel `beforeunload`.
        case clean
        /// It cancelled `beforeunload`.
        case unsaved
        /// No answer (see the type's comment).
        case unknown
    }

    /// What a document decision depends on, as it was when WebKit asked:
    /// the question's number and the lock epoch. Not the current
    /// connection: one issued meanwhile is an older navigation's, which this
    /// newer one replaces (see the type's comment, P3R-1).
    private struct DecisionState: Equatable {
        let question: Int
        let lockEpoch: Int
    }

    /// The decision is still the one WebKit waits on, and nothing locked
    /// (even if unlocked since) or closed meanwhile.
    private func unchanged(since state: DecisionState) -> Bool {
        !isClosed && !isLocked && DecisionState(question: policyQuestions, lockEpoch: lockEpoch) == state
    }

    /// Whether a document navigation away from the live page must leave it
    /// alone. Only a page that answered clean is left without asking; one
    /// that cancelled `beforeunload` or gave no answer is left only on the
    /// app's yes (`confirmLeavingUnsavedWork`; unset, a no or a thrown error
    /// keeps the page). Every answer counts only while the decision has not
    /// changed since WebKit asked (`unchanged(since:)`): once it changed, a
    /// clean answer leaves the page alone too, the app is not asked, and a
    /// yes counts only if it still has not.
    private func livePageKeepsUnsavedWork(leavingFor url: URL?, unchangedSince state: DecisionState) async -> Bool {
        let reason: UnsavedWorkReason
        switch await liveUnsavedWork() {
        case .clean: return !unchanged(since: state)
        case .unsaved: reason = .unsaved
        case .unknown: reason = .noAnswer
        }
        guard let confirmLeavingUnsavedWork, unchanged(since: state) else { return true }
        let leave = (try? await confirmLeavingUnsavedWork(url, reason)) == true
        return !(leave && unchanged(since: state))
    }

    /// Whether the live page may still hold unsaved work, for the app's own
    /// close and quit questions. The page holding the current connection is
    /// asked exactly as the navigation check asks it (see the type's
    /// comment): `.unsaved` when it cancels `beforeunload`, `.noAnswer`
    /// when it gives no answer (a script error, a listener that threw, an
    /// unexpected value, no answer within `unsavedWorkCheckTimeout`, its
    /// content process ending), and nil only when it answered clean. So a
    /// page that cannot answer is never reported as holding nothing. Nil as
    /// well when there is nothing the app could lose: the host is closed or
    /// locked, no live page holds the current connection (only that page
    /// can hold work; a locked or revoked page has already dropped it), or a
    /// lock (even one undone since) or close landed while the page was asked
    /// (its own step drops the page's work). Asks the app nothing, spends no
    /// generation and changes nothing in the page.
    public func pageHoldsUnsavedWork() async -> UnsavedWorkReason? {
        guard !isClosed, !isLocked, livePageHoldsCurrentConnection else { return nil }
        let epoch = lockEpoch
        let answer = await liveUnsavedWork()
        guard !isClosed, !isLocked, lockEpoch == epoch else { return nil }
        switch answer {
        case .clean: return nil
        case .unsaved: return .unsaved
        case .unknown: return .noAnswer
        }
    }

    /// Asks the live page, from the host's own script world, whether it
    /// cancels a `beforeunload` event (`beforeUnloadCheck`). No page in the
    /// view counts as clean: there is nothing to lose, and evaluating would
    /// only start an empty one. A script error, an unexpected value (a
    /// listener that threw, or a document without the host's error count),
    /// no answer within `unsavedWorkCheckTimeout` (a busy page) or the
    /// content process ending first is no answer.
    private func liveUnsavedWork() async -> UnsavedWorkAnswer {
        if let unsavedWorkCheck {
            switch await unsavedWorkCheck() {
            case true?: return .unsaved
            case false?: return .clean
            case nil: return .unknown
            }
        }
        guard webView.url != nil else { return .clean }
        let answer = FirstAnswer<UnsavedWorkAnswer>()
        return await withCheckedContinuation { continuation in
            answer.continuation = continuation
            webView.evaluateJavaScript(Self.beforeUnloadCheck, in: nil, in: .defaultClient) { result in
                answer.give(Self.unsavedWorkAnswer(from: result))
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: Self.unsavedWorkCheckTimeout)
                answer.give(.unknown)
            }
        }
    }

    /// Reads `beforeUnloadCheck`'s result: only a JavaScript boolean (a
    /// CFBoolean here, never a number WebKit would also turn into a Bool)
    /// is an answer; an error or any other value is none.
    static func unsavedWorkAnswer(from result: Result<Any, Error>) -> UnsavedWorkAnswer {
        guard case .success(let value) = result, let flag = value as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else {
            return .unknown
        }
        return flag.boolValue ? .unsaved : .clean
    }

    /// Dispatches a cancelable `beforeunload` event in the page and returns
    /// whether a listener cancelled it. The event is a real
    /// `BeforeUnloadEvent`, and it counts as cancelled when WebKit's own
    /// navigation would ask to confirm leaving a page the person clicked
    /// into: cancelled, or given a `returnValue` message (W4-R1). The host
    /// asks whether or not there was a click. A plain `Event` would ignore a
    /// handler's returned message and read a listener's `returnValue` as the
    /// legacy flag. If none cancelled it but one threw (the host's error
    /// count, `errorCountScript`, moved during the dispatch), it could not
    /// say what it keeps: the check returns a string, read as no answer, as
    /// it does when the count is missing or the event cannot be made. It
    /// does not throw itself, because a throw from this world is also
    /// reported to the page's own `error` listeners.
    static let beforeUnloadCheck = """
        (function () {
          var reported = window.\(errorCountName);
          if (typeof reported !== 'function') return 'no answer';
          var e;
          try {
            e = document.createEvent('BeforeUnloadEvent');
            e.initEvent('beforeunload', false, true);
          } catch (error) { return 'no answer'; }
          var before = reported();
          window.dispatchEvent(e);
          if (e.defaultPrevented || e.returnValue !== '') return true;
          return reported() !== before ? 'no answer' : false;
        })()
        """

    /// The function, in the host's script world only, that returns how many
    /// errors the document has reported.
    static let errorCountName = "__trueConvoHostErrorsReported"

    /// Counts every error the document reports, from the host's own script
    /// world (the page can neither see nor replace the count there). Run at
    /// the start of every document, before any of the page's own script,
    /// so its capturing `error` listener on the window is the first one: a
    /// page listener that stops the event's propagation runs after it and
    /// cannot hide an error from the host (W4-R2).
    static let errorCountScript = """
        (function () {
          var reported = 0;
          window.addEventListener('error', function () { reported += 1; }, true);
          Object.defineProperty(window, '\(errorCountName)', { value: function () { return reported; } });
        })();
        """

    private static var errorCountUserScript: WKUserScript {
        WKUserScript(source: errorCountScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient)
    }

    // MARK: Policy, as values

    /// One navigation-action policy question, reduced to what the host
    /// reads from WebKit's objects.
    struct NavigationQuestion {
        enum Target: Equatable { case mainFrame, subframe, newWindow }
        var url: URL?
        var navigationType: WKNavigationType
        var target: Target
        var isDownload = false
        var cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy
        var sourceURL: URL?
        var currentURL: URL?
    }

    /// Decides one navigation-action question and answers it through
    /// `answer`, at once or after the document step.
    func decideNavigation(_ question: NavigationQuestion, answer: @escaping (WKNavigationActionPolicy) -> Void) {
        if question.target != .subframe { policyQuestions += 1 }
        let asked = policyQuestions
        let currentDocumentURL = committedDocumentURL
        let decision = DeskNavigationPolicy.decide(
            url: question.url,
            currentDocumentURL: currentDocumentURL,
            targetsMainFrame: question.target == .mainFrame,
            isDownload: question.isDownload,
            navigationType: question.navigationType,
            cachePolicy: question.cachePolicy,
            scheme: manifest.scheme,
            host: manifest.host,
            closed: isClosed,
            locked: isLocked,
            servesDocument: schemeHandler.responder.servesDocument(at:)
        )
        onNavigationDecided?(NavigationDecision(navigationType: question.navigationType, sourceURL: question.sourceURL,
                                                targetURL: question.url, currentURL: question.currentURL,
                                                currentDocumentURL: currentDocumentURL, decision: decision))
        switch decision {
        case .cancel:
            onNavigationRefused?(question.url)
            answer(.cancel)
        case .allowSameDocument:
            answer(.allow)
        case .allowNewDocument:
            undecidedDocuments.insert(asked)
            // Only a page holding the current connection can hold unsaved
            // work (see the type's comment).
            let leavesLivePage = livePageHoldsCurrentConnection
            let state = DecisionState(question: asked, lockEpoch: lockEpoch)
            // The document step begins only while the decision is the one
            // WebKit asked: the question is still the one it waits on, and
            // no lock, even one undone by an unlock since, came meanwhile
            // (Codex P3 of eedc29f; the app's own reload after the unlock
            // brings the document). Leaving the live page, the page's answer
            // (or the app's yes) holds on the same terms. The connection is
            // not compared: an older document step still under way when
            // WebKit asked may issue one meanwhile, and this newer
            // navigation replaces it (P3R-1).
            Task { @MainActor in
                let keepsWork = leavesLivePage ? await self.livePageKeepsUnsavedWork(leavingFor: question.url, unchangedSince: state) : false
                let connection = keepsWork ? nil : await self.beginDocument { self.unchanged(since: state) }
                self.undecidedDocuments.remove(asked)
                guard self.policyQuestions == asked else {
                    // WebKit asked another question first and dropped this
                    // one, or the content process that asked it ended.
                    self.onNavigationDropped?(question.url)
                    answer(.cancel)
                    self.recoverIfOrphaned()
                    self.reloadAfterTerminationWhenSettled()
                    return
                }
                // A page keeping its unsaved work keeps its document (also
                // when a lock or close came while the app was asked); a
                // lock or close requested after the step returned (its own
                // step is queued and revokes the connection) wins here too.
                // If an older document step ended while this decision was
                // pending, the connection it issued belongs to no document,
                // and its own recovery waited for this decision (P3R-1).
                guard let connection, !self.isLocked, !self.isClosed else {
                    self.onNavigationRefused?(question.url)
                    answer(.cancel)
                    self.recoverIfOrphaned()
                    self.reloadAfterTerminationWhenSettled()
                    return
                }
                self.allowedDocuments += 1
                let id = self.allowedDocuments
                self.allowedDocument = DocumentNavigation(id: id, connection: connection, url: question.url)
                answer(.allow)
                self.dropIfNeverStarted(id)
            }
        }
        // A later main-frame navigation (the page's or the app's) stops the
        // one allowed before it that has not started (WebKit reports a start
        // before the next question).
        if question.target == .mainFrame, let stopped = allowedDocument {
            allowedDocument = nil
            onNavigationDropped?(stopped.url)
            recoverIfOrphaned()
        }
    }

    /// Decides one response question. While locked a main-frame response
    /// (of a document navigation allowed before the lock) is refused, so
    /// WebKit fails that load and the locked document stays.
    func decideResponse(url: URL?, isForMainFrame: Bool, canShowMIMEType: Bool) -> WKNavigationResponsePolicy {
        if isForMainFrame { policyQuestions += 1 }
        guard !isClosed, !isLocked, isForMainFrame, canShowMIMEType,
              url?.scheme?.lowercased() == manifest.scheme, url?.host?.lowercased() == manifest.host else {
            onNavigationRefused?(url)
            return .cancel
        }
        provisionalDocument?.responseURL = url
        return .allow
    }

    /// WebKit started a provisional load: the document navigation allowed
    /// last, or one the host never allowed as a document.
    func documentNavigationStarted(_ navigation: AnyObject?) {
        var started = allowedDocument ?? DocumentNavigation(connection: nil, url: nil)
        allowedDocument = nil
        started.navigation = navigation
        provisionalDocument = started
    }

    func documentNavigationFailed(_ navigation: AnyObject?) {
        guard let provisional = provisionalDocument, provisional.navigation === navigation else { return }
        provisionalDocument = nil
        recoverIfOrphaned()
        reloadAfterTerminationWhenSettled()
    }

    func documentCommitted(_ navigation: AnyObject?, viewURL: URL?) {
        let committed = provisionalDocument.flatMap { $0.navigation === navigation ? $0 : nil }
        provisionalDocument = nil
        if let committed {
            committedDocumentURL = committed.responseURL ?? committed.url ?? viewURL
            // No response: restored from the back/forward cache, with the
            // bootstrap it had when it was left, which no longer holds.
            documentConnection = committed.responseURL == nil ? nil : committed.connection
        } else {
            committedDocumentURL = viewURL
            documentConnection = nil
        }
        if livePageHoldsCurrentConnection {
            recoveryReloadPending = false
            terminationReloadPending = false
        }
        recoverIfOrphaned()
    }

    /// While the view is not loading, `webView.url` is the live document's
    /// own URL, same-document changes included; while it is, the URL may be
    /// a pending or provisional destination and is left to `didCommit`
    /// (same-document changes in that window are missed; see the type's
    /// comment, R4-H2).
    private func recordSettledDocument(of view: WKWebView) {
        guard !view.isLoading else { return }
        committedDocumentURL = view.url
        // A termination's reload waiting for a load to end; not from inside
        // WebKit's own change notification.
        if terminationReloadPending {
            Task { @MainActor [weak self] in self?.reloadAfterTerminationWhenSettled() }
        }
    }

    /// Queues behind everything the event sink already queued on the main
    /// thread, so a lifecycle push is dispatched before the caller continues.
    static func settleMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}

extension DeskWebViewHost: WKNavigationDelegate {
    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences,
                        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        preferences.allowsContentJavaScript = true
        let target: NavigationQuestion.Target = navigationAction.targetFrame.map { $0.isMainFrame ? .mainFrame : .subframe } ?? .newWindow
        decideNavigation(NavigationQuestion(url: navigationAction.request.url, navigationType: navigationAction.navigationType, target: target,
                                            isDownload: navigationAction.shouldPerformDownload, cachePolicy: navigationAction.request.cachePolicy,
                                            sourceURL: (navigationAction.value(forKey: "sourceFrame") as? WKFrameInfo)?.request.url,
                                            currentURL: webView.url)) { policy in
            decisionHandler(policy, preferences)
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(decideResponse(url: navigationResponse.response.url, isForMainFrame: navigationResponse.isForMainFrame,
                                       canShowMIMEType: navigationResponse.canShowMIMEType))
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        documentNavigationStarted(navigation)
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        documentNavigationFailed(navigation)
    }

    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        documentCommitted(navigation, viewURL: webView.url)
    }

    public func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.cancel(nil)
    }

    public func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.cancel(nil)
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page is gone with its connection: revoke now so no late
        // request is honored. There is no document to scroll either, until
        // the next commit, and nothing in flight survives the process: the
        // questions it asked go with it, counted as one more question, so a
        // document decision still being answered begins nothing or ends as
        // dropped (R5-LT-A). Nothing else brings the view back
        // (implementing this method turns WebKit's own reload off), so the
        // host reloads it once.
        committedDocumentURL = nil
        allowedDocument = nil
        provisionalDocument = nil
        documentConnection = nil
        policyQuestions += 1
        questionsOfEndedProcesses = policyQuestions
        Task { @MainActor in
            await self.serialized { [self] in
                guard !isClosed else { return }
                await hostProtocol.beginGeneration()
                currentConnection = nil
            }
            guard !self.isClosed else { return }
            self.onContentProcessTerminated?()
            self.reloadAfterTermination()
        }
    }

    /// Once per `terminationReloadInterval`; not while locked or closed. It
    /// waits while a navigation the new process asked about is in flight
    /// (its drop or failure comes back here) and while a load is under way
    /// (the app's own; its end comes back here); a document holding the
    /// current connection committing meanwhile makes it unneeded.
    private func reloadAfterTermination() {
        terminationReloadPending = true
        reloadAfterTerminationWhenSettled()
    }

    private func reloadAfterTerminationWhenSettled() {
        guard terminationReloadPending else { return }
        guard !isClosed, !isLocked else {
            terminationReloadPending = false
            return
        }
        guard documentNavigationsSettled, !webView.isLoading else { return }
        terminationReloadPending = false
        let now = ProcessInfo.processInfo.systemUptime
        if let last = lastTerminationReload, now - last < terminationReloadInterval { return }
        lastTerminationReload = now
        if let recoveryReload { recoveryReload() } else { reload() }
    }
}

extension DeskWebViewHost: WKUIDelegate {
    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        onNavigationRefused?(navigationAction.request.url)
        return nil
    }

    public func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                        completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    public func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                        completionHandler: @escaping (Bool) -> Void) {
        completionHandler(false)
    }

    public func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        completionHandler(nil)
    }

    public func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                        completionHandler: @escaping ([URL]?) -> Void) {
        completionHandler(nil)
    }
}

/// Resumes a continuation once, with the first answer given.
@MainActor
private final class FirstAnswer<Value> {
    var continuation: CheckedContinuation<Value, Never>?

    func give(_ value: Value) {
        continuation?.resume(returning: value)
        continuation = nil
    }
}
