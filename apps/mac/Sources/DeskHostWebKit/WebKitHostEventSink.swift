import DeskHost
import Foundation
import WebKit

/// Pushes each host event to the page as `new CustomEvent("trueconvo-host",
/// {detail})` on `window`, in the page content world, main frame only. The
/// detail is `HostEvent.jsonDetail` handed to `callAsyncJavaScript` as an
/// argument value; the function body below is a constant and never contains
/// event content. The protocol calls `push` from inside its actor on any
/// thread, so every WebKit call hops to the main thread first.
public final class WebKitHostEventSink: HostEventSink, @unchecked Sendable {
    /// The fixed function body. `detail` is the one argument.
    public static let dispatchFunctionBody = #"window.dispatchEvent(new CustomEvent("trueconvo-host", { detail: detail }));"#
    public static let eventName = "trueconvo-host"

    private let lock = NSLock()
    private weak var target: WKWebView?
    private let observer: (@Sendable (HostEvent) -> Void)?

    /// `observer` sees every pushed event on the pushing thread, before the
    /// main-thread hop; for the host's log and for tests.
    public init(observer: (@Sendable (HostEvent) -> Void)? = nil) {
        self.observer = observer
    }

    public func attach(to webView: WKWebView) {
        lock.lock()
        defer { lock.unlock() }
        target = webView
    }

    public func detach() {
        lock.lock()
        defer { lock.unlock() }
        target = nil
    }

    private var currentTarget: WKWebView? {
        lock.lock()
        defer { lock.unlock() }
        return target
    }

    public func push(_ event: HostEvent) {
        observer?(event)
        DispatchQueue.main.async { [self] in
            guard let webView = currentTarget else { return }
            let detail = JSONBridge.foundationObject(from: event.jsonDetail)
            webView.callAsyncJavaScript(Self.dispatchFunctionBody, arguments: ["detail": detail], in: nil, in: .page) { _ in
                // One-way delivery: a page that is gone or mid-navigation
                // simply does not receive the event.
            }
        }
    }
}
