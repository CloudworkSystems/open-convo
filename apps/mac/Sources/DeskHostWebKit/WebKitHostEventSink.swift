import DeskHost
import Foundation
import WebKit

/// Pushes each host event to the page as `new CustomEvent("trueconvo-host",
/// {detail})` on `window`, in the page content world, main frame only. The
/// detail is `HostEvent.jsonDetail` handed to `callAsyncJavaScript` as an
/// argument value; the function body below is a constant and never contains
/// event content. The protocol calls `push` from inside its actor on any
/// thread, so every WebKit call hops to the main thread first.
///
/// `push` runs the observer on the pushing thread and hands the event to
/// the main thread asynchronously: it never waits on the main thread, takes
/// no lock and never calls back into the participant lane. It must not:
/// the lane's lock and close steps run on the main thread and wait for a
/// participant push under way to return from here (participant contract
/// section 8, Codex's S10 ruling 3). The observer given at `init` must keep
/// to the same rule.
///
/// Stale participant pushes (Codex's S10 carried requirement 3). A
/// `participant.event` is handed over at push time to the connections valid
/// then, but delivered later, on the main thread, to whatever document the
/// view shows by then. So when the owning host attached a participant
/// delivery check (`DeskWebViewHost`, with a participant lane only), each
/// participant event is delivered only if that check passes at delivery
/// time: its connection and generation are still the live document's own
/// valid connection, while that host is neither locked nor closed.
/// Otherwise it is dropped, never handed to a new document; the
/// coordinator keeps it, and the new document pages it by sequence.
/// Lifecycle and dictation events are delivered as before: the host's
/// protocol actor pushes them in step with its own generation changes
/// (`revoked` and `locked` to the connection it is revoking, `ready` to the
/// one it just issued, a dictation final to its bound draft's connection
/// once checked valid), so the main queue runs each ahead of the document
/// step that follows it.
public final class WebKitHostEventSink: HostEventSink, @unchecked Sendable {
    /// The fixed function body. `detail` is the one argument.
    public static let dispatchFunctionBody = #"window.dispatchEvent(new CustomEvent("trueconvo-host", { detail: detail }));"#
    public static let eventName = "trueconvo-host"

    private let lock = NSLock()
    private weak var target: WKWebView?
    /// Asked on the main thread for each participant event, just before it
    /// is delivered; nil delivers every event, as without a lane.
    private var participantDelivery: (@MainActor (_ connectionId: String, _ generation: Int) -> Bool)?
    private let observer: (@Sendable (HostEvent) -> Void)?
    /// Test seam: told, on the main thread, of each participant event the
    /// delivery check dropped. Identifiers only.
    var onParticipantEventDropped: (@MainActor (_ connectionId: String, _ generation: Int) -> Void)?

    /// `observer` sees every pushed event on the pushing thread, before the
    /// main-thread hop; for the host's log and for tests. It must return
    /// promptly, never wait on the main thread and never call the
    /// participant lane (see the type's comment).
    public init(observer: (@Sendable (HostEvent) -> Void)? = nil) {
        self.observer = observer
    }

    /// `participantDelivery`, given by a host with a participant lane only,
    /// decides on the main thread whether a participant event for a
    /// connection may still be delivered (see the type's comment).
    public func attach(to webView: WKWebView, participantDelivery: (@MainActor (_ connectionId: String, _ generation: Int) -> Bool)? = nil) {
        lock.lock()
        defer { lock.unlock() }
        target = webView
        self.participantDelivery = participantDelivery
    }

    public func detach() {
        lock.lock()
        defer { lock.unlock() }
        target = nil
        participantDelivery = nil
    }

    private var current: (target: WKWebView?, participantDelivery: (@MainActor (_ connectionId: String, _ generation: Int) -> Bool)?) {
        lock.lock()
        defer { lock.unlock() }
        return (target, participantDelivery)
    }

    public func push(_ event: HostEvent) {
        observer?(event)
        DispatchQueue.main.async { [self] in
            let (target, participantDelivery) = current
            guard let webView = target else { return }
            if case .participantEvent(let connectionId, let generation, _) = event, let participantDelivery {
                let delivers = MainActor.assumeIsolated { participantDelivery(connectionId, generation) }
                guard delivers else {
                    MainActor.assumeIsolated { onParticipantEventDropped?(connectionId, generation) }
                    return
                }
            }
            let detail = JSONBridge.foundationObject(from: event.jsonDetail)
            webView.callAsyncJavaScript(Self.dispatchFunctionBody, arguments: ["detail": detail], in: nil, in: .page) { _ in
                // One-way delivery: a page that is gone or mid-navigation
                // simply does not receive the event.
            }
        }
    }
}
