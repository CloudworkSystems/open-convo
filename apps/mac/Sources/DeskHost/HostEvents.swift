import Foundation

/// Lifecycle state carried by a `host.connection` event.
public enum HostConnectionState: String, Equatable, Sendable {
    case ready
    case locked
    case revoked
}

/// Why a `host.connection` event was pushed. Always present; a short fixed
/// string, never free text.
public enum HostConnectionReason: String, Equatable, Sendable {
    case ready
    case lock
    case navigation
    case shutdown
}

/// Host-to-page events. The WebKit glue dispatches each as a DOM
/// `CustomEvent("trueconvo-host")` whose `detail` is `jsonDetail`, passed as a
/// `callAsyncJavaScript` argument (never string-built code). This module only
/// hands the event to a `HostEventSink`.
public enum HostEvent: Equatable, Sendable {
    /// Literal final dictation for the bound draft, pushed once. The host keeps
    /// no copy of `text` after the push; only the delivery receipt remains.
    case dictationFinal(connectionId: String, generation: Int, bindingId: UUID, deliveryId: UUID, text: String)

    /// The delivery named by `deliveryId` was saved by the durable commit
    /// `commitRequestId` at `revision`. Pushed only after that commit.
    case dictationReceipt(connectionId: String, generation: Int, deliveryId: UUID, commitRequestId: UUID, revision: Int)

    /// Connection lifecycle: `ready` when issued, `locked` on lock, `revoked`
    /// on navigation and shutdown. A locked or revoked connection never
    /// becomes ready again; unlock requires a fresh document and bootstrap.
    case hostConnection(connectionId: String, generation: Int, state: HostConnectionState, reason: HostConnectionReason)

    public var type: String {
        switch self {
        case .dictationFinal: return "dictation.final"
        case .dictationReceipt: return "dictation.receipt"
        case .hostConnection: return "host.connection"
        }
    }

    public var connectionId: String {
        switch self {
        case .dictationFinal(let connectionId, _, _, _, _), .dictationReceipt(let connectionId, _, _, _, _),
             .hostConnection(let connectionId, _, _, _):
            return connectionId
        }
    }

    public var generation: Int {
        switch self {
        case .dictationFinal(_, let generation, _, _, _), .dictationReceipt(_, let generation, _, _, _),
             .hostConnection(_, let generation, _, _):
            return generation
        }
    }

    /// `{type, connectionId, generation, ...fields}`.
    public var jsonDetail: JSONValue {
        var detail: [String: JSONValue] = [
            "type": .string(type),
            "connectionId": .string(connectionId),
            "generation": .number(Double(generation))
        ]
        switch self {
        case .dictationFinal(_, _, let bindingId, let deliveryId, let text):
            detail["bindingId"] = .string(bindingId.canonicalString)
            detail["deliveryId"] = .string(deliveryId.canonicalString)
            detail["text"] = .string(text)
        case .dictationReceipt(_, _, let deliveryId, let commitRequestId, let revision):
            detail["deliveryId"] = .string(deliveryId.canonicalString)
            detail["commitRequestId"] = .string(commitRequestId.canonicalString)
            detail["revision"] = .number(Double(revision))
        case .hostConnection(_, _, let state, let reason):
            detail["state"] = .string(state.rawValue)
            detail["reason"] = .string(reason.rawValue)
        }
        return .object(detail)
    }
}

/// Receives host events. Called from inside the protocol actor on whichever
/// thread runs it (never assume the main thread); a sink that talks to
/// `WKWebView` must hop to the main thread itself. Delivery is one-way: the
/// sink cannot refuse, and `dictation.final` text is handed over exactly once.
public protocol HostEventSink: Sendable {
    func push(_ event: HostEvent)
}
