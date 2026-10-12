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
public final class HostMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    public static let name = "trueConvoHost"
    /// The one error string a rejected promise carries.
    public static let transportError = "host-transport-failure"

    private let hostProtocol: DeskHostProtocol
    private let expectedScheme: String
    private let expectedHost: String
    private weak var expectedWebView: WKWebView?
    private var isShutDown = false

    /// Observed on the main thread after each message, for the host's log
    /// and for tests. Never carries payload content.
    public var observer: ((HostExchange) -> Void)?

    public init(hostProtocol: DeskHostProtocol, expectedScheme: String, expectedHost: String) {
        self.hostProtocol = hostProtocol
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
        switch HostRequestPipeline.decode(body) {
        case .refused(let refusal):
            observer?(.replied(refusal))
            replyHandler(JSONBridge.foundationObject(from: refusal.jsonValue), nil)
            return
        case .request(let validated):
            request = validated
        }

        let hostProtocol = self.hostProtocol
        Task { @MainActor [weak self] in
            let response = await hostProtocol.handle(request)
            guard let self, !self.isShutDown else {
                replyHandler(nil, Self.transportError)
                return
            }
            self.observer?(.replied(response))
            replyHandler(JSONBridge.foundationObject(from: response.jsonValue), nil)
        }
    }
}
