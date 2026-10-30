import DeskHost
import Foundation
import WebKit

/// The `trueConvoHost` script message handler. The page calls
/// `window.webkit.messageHandlers.trueConvoHost.postMessage(envelope)` with a
/// plain object and gets a promise: a contract refusal resolves with the
/// protocol's reply object, a transport failure rejects with one short fixed
/// string that never carries request content. Only an object body from the
/// main frame of the one web view this handler was attached to, served from
/// the bundle's own scheme and host, reaches the protocol.
///
/// WebKit calls the handler on the main thread and retains it through the
/// user content controller; `shutDown()` makes every later message a
/// transport failure, including replies still in flight.
///
/// With a participant lane (plan S11; nothing in the app gives one),
/// `participant.*` is handed to the lane, decoded, before
/// `DeskHostProtocol.handle`, so it never waits behind the workspace actor
/// (participant contract section 3). The lane runs v1's preflight itself
/// against its attached stack's registry, as `ParticipantLane` requires of a
/// lane reached without `HostRouter` (which stays test-only, Codex Q1). A
/// `workspace.commitProof` that passes v1's preflight first waits for the
/// lane's one bounded pass of the participant writes it owes, as
/// `HostRouter` does (S9 ruling c).
///
/// Stale replies (Codex's S10 carried requirement 3, with a lane; S11
/// ruling (a), without one). A request admitted while the connection it
/// names is valid gets its answer only if, when the answer is ready
/// (checked on the main thread just before the reply is handed to WebKit),
/// all of these still hold: that connection is valid for the current
/// generation; with a lane, the lane's `lifecycleEpoch` has not moved, so
/// no lock, window close or quit began at the lane since admission, even
/// while the host's own step is still to run (the Desk session runs it in
/// a task); and the host is neither locked nor closed (`deliversAnswers`).
/// Otherwise native drops the answer: the promise gets only the
/// content-free transport failure and the observer sees `staleReply`. So
/// nothing such an answer held (a `workspace.read` record or an
/// availability answer included) can reach another document, be taken for
/// a fresh one, or reach the page once a lock or close began. A request
/// that named a connection already gone gets v1's preflight refusal, as
/// before (from the lane or the host, after its hop), which carries only
/// that request's own identifiers and a reason.
///
/// Without a lane (the app as shipped) the same check runs on every v1
/// reply, with the host's lock and close state and no lane epoch. Its
/// safety argument is native's own check, not WebKit's disposal: after a
/// reload WebKit may still run the old document's promise callback with
/// `window` then the new document's (observed once in a headless
/// `WKWebView`; participant contract section 3).
public final class HostMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    public static let name = "trueConvoHost"
    /// The one error string a rejected promise carries.
    public static let transportError = "host-transport-failure"

    private let hostProtocol: DeskHostProtocol
    /// Given exactly when `hostProtocol` is a participant host.
    private let participantLane: (any ParticipantLane)?
    private let expectedScheme: String
    private let expectedHost: String
    private weak var expectedWebView: WKWebView?
    private var isShutDown = false
    /// Asked on the main thread when an answer is ready, whether the host
    /// still takes answers (neither locked nor closed). Set by
    /// `DeskWebViewHost`, with a lane or without; nil takes them.
    var deliversAnswers: (@MainActor () -> Bool)?
    /// Test seam: awaited on the main thread once an answer is ready and
    /// before it is checked, so a test can hold a computed answer (nil:
    /// nothing runs).
    var answerWillBeChecked: (@MainActor (HostRequest) async -> Void)?

    /// Observed on the main thread after each message, for the host's log
    /// and for tests. Never carries payload content.
    public var observer: ((HostExchange) -> Void)?

    /// `participantLane` must be given exactly when `hostProtocol` is a
    /// participant host, so the capabilities list, the decoder and the lane
    /// always agree; anything else is a wiring mistake and stops here.
    public init(hostProtocol: DeskHostProtocol, expectedScheme: String, expectedHost: String,
                participantLane: (any ParticipantLane)? = nil) {
        precondition((participantLane != nil) == hostProtocol.acceptsParticipant,
                     "a participant lane goes with a participant host, and only with one")
        self.hostProtocol = hostProtocol
        self.participantLane = participantLane
        self.expectedScheme = expectedScheme.lowercased()
        self.expectedHost = expectedHost.lowercased()
    }

    /// The one web view whose main frame may talk to this handler.
    public func attach(to webView: WKWebView) {
        expectedWebView = webView
    }

    public var isAttached: Bool { expectedWebView != nil }
    public var hasShutDown: Bool { isShutDown }

    public func shutDown() {
        isShutDown = true
        expectedWebView = nil
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                                      replyHandler: @escaping (Any?, String?) -> Void) {
        let source = HostMessageSource(
            handlerName: message.name,
            isMainFrame: message.frameInfo.isMainFrame,
            isExpectedWebView: expectedWebView != nil && message.webView === expectedWebView,
            originScheme: message.frameInfo.securityOrigin.protocol,
            originHost: message.frameInfo.securityOrigin.host
        )
        let body: NSDictionary
        switch HostMessageGate.admit(body: message.body, source: source, expectedScheme: expectedScheme,
                                     expectedHost: expectedHost, shutDown: isShutDown) {
        case .refused(let failure):
            observer?(.transportFailure(failure))
            replyHandler(nil, Self.transportError)
            return
        case .admitted(let dictionary):
            body = dictionary
        }

        let request: HostRequest
        switch HostRequestPipeline.decode(body, acceptsParticipant: hostProtocol.acceptsParticipant) {
        case .refused(let refusal):
            observer?(.replied(refusal))
            replyHandler(JSONBridge.foundationObject(from: refusal.jsonValue), nil)
            return
        case .request(let validated):
            request = validated
        }

        let hostProtocol = self.hostProtocol
        let participantLane = self.participantLane
        // Whether the asking document's connection is valid now, at
        // admission, and with a lane its lifecycle epoch now. Only an answer
        // admitted live can go stale before it is ready.
        let admittedLive = hostProtocol.checkConnection(request.connectionId, generation: request.generation) == .valid
        let admittedEpoch = participantLane?.lifecycleEpoch
        Task { @MainActor [weak self] in
            let response: HostResponse
            if let participantLane, request.operation.isParticipant {
                response = await participantLane.handle(request)
            } else {
                // A commit first waits for the lane's one bounded pass of
                // the participant writes it owes (S9 ruling c); with no
                // lane, or for any other request, there is no hop.
                if let participantLane, request.operation.waitsForOwedParticipantWrites {
                    await participantLane.reconcileBeforeStoreWork(ahead: request, host: hostProtocol)
                }
                response = await hostProtocol.handle(request)
            }
            if let hold = self?.answerWillBeChecked { await hold(request) }
            guard let self, !self.isShutDown else {
                replyHandler(nil, Self.transportError)
                return
            }
            // On the main thread, in the same turn as the reply. A new
            // document is allowed only on this thread, after its generation
            // revoked this connection; a lock or close moves the lane's
            // epoch on this thread before its host step; so an answer that
            // passes here goes to the document that asked, before any lock
            // or close began.
            if admittedLive, !self.stillDeliverable(request, admittedEpoch: admittedEpoch) {
                self.observer?(.transportFailure(.staleReply))
                replyHandler(nil, Self.transportError)
                return
            }
            self.observer?(.replied(response))
            replyHandler(JSONBridge.foundationObject(from: response.jsonValue), nil)
        }
    }

    /// On the main thread when an answer is ready: whether its request's
    /// connection is still valid for the current generation, with a lane the
    /// lane's `lifecycleEpoch` is the one read at admission, and the host
    /// still takes answers.
    @MainActor
    private func stillDeliverable(_ request: HostRequest, admittedEpoch: Int?) -> Bool {
        guard hostProtocol.checkConnection(request.connectionId, generation: request.generation) == .valid,
              participantLane?.lifecycleEpoch == admittedEpoch else { return false }
        return deliversAnswers?() ?? true
    }
}
