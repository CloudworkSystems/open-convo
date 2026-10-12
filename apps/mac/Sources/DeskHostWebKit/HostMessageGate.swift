import DeskHost
import Foundation

/// Why a posted message never reached the protocol. The page sees only the
/// rejected promise with `HostMessageHandler.transportError`; these names are
/// for the host's own log and tests and carry no request content.
public enum HostTransportFailure: String, Equatable, Sendable {
    case handlerShutDown = "handler-shut-down"
    case wrongHandlerName = "wrong-handler-name"
    case wrongWebView = "wrong-web-view"
    case wrongFrame = "wrong-frame"
    case wrongOrigin = "wrong-origin"
    case notAnObject = "not-an-object"
    /// Not a refusal at the gate: the request was admitted on a live
    /// connection, but by the time its answer was ready that connection was
    /// gone (a reload, navigation, lock, close or crash revoked it), so the
    /// answer was dropped (with a participant lane only; see
    /// `HostMessageHandler`).
    case staleReply = "stale-reply"
}

/// Where a script message came from, as WebKit reports it.
public struct HostMessageSource: Equatable, Sendable {
    public var handlerName: String
    public var isMainFrame: Bool
    public var isExpectedWebView: Bool
    public var originScheme: String?
    public var originHost: String?

    public init(handlerName: String, isMainFrame: Bool, isExpectedWebView: Bool, originScheme: String?, originHost: String?) {
        self.handlerName = handlerName
        self.isMainFrame = isMainFrame
        self.isExpectedWebView = isExpectedWebView
        self.originScheme = originScheme
        self.originHost = originHost
    }
}

/// The transport checks a message passes before its body is even looked at.
/// Pure, so every refusal is unit-testable without a web view.
public enum HostMessageGate {
    public enum Admission {
        case admitted(NSDictionary)
        case refused(HostTransportFailure)
    }

    public static func admit(body: Any?, source: HostMessageSource, expectedScheme: String, expectedHost: String,
                             shutDown: Bool) -> Admission {
        guard !shutDown else { return .refused(.handlerShutDown) }
        guard source.handlerName == HostMessageHandler.name else { return .refused(.wrongHandlerName) }
        guard source.isExpectedWebView else { return .refused(.wrongWebView) }
        guard source.isMainFrame else { return .refused(.wrongFrame) }
        guard source.originScheme?.lowercased() == expectedScheme.lowercased(),
              source.originHost?.lowercased() == expectedHost.lowercased() else { return .refused(.wrongOrigin) }
        guard let dictionary = body as? NSDictionary else { return .refused(.notAnObject) }
        return .admitted(dictionary)
    }
}

/// Turns an admitted object into a validated request, with the same refusal
/// mapping `DeskHostProtocol.handle(data:)` applies to bytes: a graph the
/// bridge cannot carry (including one nested deeper than
/// `JSONBridge.maxNestingDepth`, or text with an unpaired surrogate) is
/// `malformed-envelope` with nothing echoed; an envelope above
/// `ProofLimits.envelopeBytes` is
/// `payload-too-large`, refused early when a lower bound of its canonical
/// bytes (container counts, keys, strings and scalars, charged as the bridge
/// walks) already exceeds the limit, and otherwise measured exactly as
/// canonical JSON (the page's own `JSON.stringify` bytes modulo key order);
/// and every envelope rule keeps its precise reason and echo.
/// While `acceptsParticipant` is false (the default), `participant.*` is
/// `unknown-operation`, exactly as on the byte path. The message handler
/// passes its host's `DeskHostProtocol.acceptsParticipant`, which is true
/// only for a host built with a participant lane.
public enum HostRequestPipeline {
    public enum Decoded: Equatable, Sendable {
        case request(HostRequest)
        case refused(HostResponse)
    }

    public static func decode(_ body: NSDictionary, acceptsParticipant: Bool = false) -> Decoded {
        let value: JSONValue
        do {
            value = try JSONBridge.jsonValue(from: body, byteBudget: ProofLimits.envelopeBytes)
        } catch JSONBridge.BridgeError.tooLarge {
            return .refused(.refused(.payloadTooLarge, echo: HostEcho()))
        } catch {
            return .refused(.refused(.malformedEnvelope, echo: HostEcho()))
        }
        guard value.canonicalData().count <= ProofLimits.envelopeBytes else {
            return .refused(.refused(.payloadTooLarge, echo: HostEcho()))
        }
        do {
            return .request(try HostRequest(validating: value, acceptsParticipant: acceptsParticipant))
        } catch let rejection as HostRequestRejection {
            return .refused(.refused(rejection.refusal, echo: rejection.echo))
        } catch {
            return .refused(.refused(.malformedEnvelope, echo: HostEcho()))
        }
    }
}

/// One message's outcome, for the host's log and for tests. Identities and
/// fixed enum values only: never a payload, record or text.
public enum HostExchange: Equatable, Sendable {
    case transportFailure(HostTransportFailure)
    case replied(operation: String, connectionId: String, generation: Int, outcome: HostOutcome, reason: HostRefusal?)

    public static func replied(_ response: HostResponse) -> HostExchange {
        .replied(operation: response.operation, connectionId: response.connectionId, generation: response.generation,
                 outcome: response.outcome, reason: response.reason)
    }
}
