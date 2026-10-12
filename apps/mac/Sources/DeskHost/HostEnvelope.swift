import Foundation

/// The seven v1 operations, then the five participant operations
/// (`docs/desk-native-participant-contract.md` section 2). Anything else is
/// `unknown-operation`, and so is a participant name unless the decoder was
/// asked to accept it: the pinned page codec refuses a capabilities list it
/// does not know, so page and host gain these together or not at all.
public enum HostOperation: String, Codable, CaseIterable, Sendable {
    case capabilities = "host.capabilities"
    case workspaceRead = "workspace.read"
    case workspaceCommitProof = "workspace.commitProof"
    case dictationBindDraft = "dictation.bindDraft"
    case dictationUnbindDraft = "dictation.unbindDraft"
    case workspaceReconcile = "workspace.reconcile"
    case dictationReceipt = "dictation.receipt"
    case participantAvailability = "participant.availability"
    case participantStart = "participant.start"
    case participantStop = "participant.stop"
    case participantStatus = "participant.status"
    case participantEvents = "participant.events"

    /// The list `host.capabilities` advertises: the five current page
    /// operations first, then the two read-only extensions. A host without
    /// participants lists exactly these.
    public static let advertised: [HostOperation] = [
        .capabilities, .workspaceRead, .workspaceCommitProof, .dictationBindDraft, .dictationUnbindDraft,
        .workspaceReconcile, .dictationReceipt
    ]

    /// The list a participant host advertises, in the contract's order: the
    /// seven, then the five participant operations. The page enables
    /// participants only when all five are listed.
    public static let participantAdvertised: [HostOperation] = advertised + [
        .participantAvailability, .participantStart, .participantStop, .participantStatus, .participantEvents
    ]

    /// The participant lane. These never touch the workspace barrier; a
    /// host without participants refuses them as unknown names.
    public var isParticipant: Bool {
        switch self {
        case .participantAvailability, .participantStart, .participantStop, .participantStatus, .participantEvents:
            return true
        case .capabilities, .workspaceRead, .workspaceCommitProof, .dictationBindDraft, .dictationUnbindDraft,
             .workspaceReconcile, .dictationReceipt:
            return false
        }
    }
}

public enum HostOutcome: String, Codable, Sendable {
    case ok
    case refused
    case conflict
    /// The host cannot say whether the work happened. Nonterminal: the
    /// workspace mutation barrier stays held until `workspace.reconcile`
    /// resolves the original request. For `workspace.read`: the record is
    /// visible but not yet confirmed durable, so it is not served and the
    /// page must not treat the workspace as loaded or saved. Carries base
    /// fields only.
    case unknown
}

/// The fixed reason enum: v1's twenty-four, then the participant contract's
/// eight (section 12). Never free text, never private content. Thirty-two
/// values; adding one is a contract change.
public enum HostRefusal: String, Codable, CaseIterable, Sendable {
    case unknownConnection = "unknown-connection"
    case staleGeneration = "stale-generation"
    case unknownOperation = "unknown-operation"
    /// Not JSON, not an object, not UTF-8 (UTF-16 and UTF-32 bytes included),
    /// an object whose keys would collapse, nested deeper than
    /// `JSONValue.maxNestingDepth` containers (refused before parsing, nothing
    /// echoed), a non-object payload, a bad `generation`, or a malformed
    /// selection in `dictation.bindDraft`.
    case malformedEnvelope = "malformed-envelope"
    case unknownField = "unknown-field"
    case unsupportedVersion = "unsupported-version"
    /// The envelope exceeds `ProofLimits.envelopeBytes` or the record exceeds
    /// `ProofLimits.recordBytes`.
    case payloadTooLarge = "payload-too-large"
    case textTooLarge = "text-too-large"
    case payloadMismatch = "payload-mismatch"
    case mutationOutstanding = "mutation-outstanding"
    /// A requestId, connectionId, bindingId, deliveryId, targetRequestId,
    /// sessionId or workspaceHandle that is missing or not in its agreed form.
    case invalidIdentity = "invalid-identity"
    case invalidRevision = "invalid-revision"
    case revisionNotAdvanced = "revision-not-advanced"
    case revisionMismatch = "revision-mismatch"
    case storeMissing = "store-missing"
    /// Unreadable store state, or a store write that failed with nothing
    /// applied (the fixed enum has no separate write-failure reason).
    case storeCorrupt = "store-corrupt"
    case storeLocked = "store-locked"
    case unknownHandle = "unknown-handle"
    case unknownBinding = "unknown-binding"
    case bindingStale = "binding-stale"
    case duplicateDelivery = "duplicate-delivery"
    case unknownDelivery = "unknown-delivery"
    /// `workspace.reconcile` asked about an undispatched id while another
    /// request holds the barrier; nothing is released.
    case unknownRequest = "unknown-request"
    case locked = "locked"
    /// A commit's `participantRun` names a run its record lacks, or holds
    /// twice.
    case runNotFound = "run-not-found"
    /// Commit: the run is not in its exact prepared form. Start: the run was
    /// stopped before it started.
    case runNotPrepared = "run-not-prepared"
    /// The claim, ids, participant or input hash differ from the record,
    /// the run entry or the pin at prepare.
    case runMismatch = "run-mismatch"
    /// The run or message ids are already known, or another request started
    /// or is starting the run.
    case duplicateRun = "duplicate-run"
    /// Never prepared (a preparing commit not yet durable included), or
    /// introduced without its claim.
    case unknownRun = "unknown-run"
    /// Availability failed at start.
    case participantUnavailable = "participant-unavailable"
    /// Another run is starting or live, or any run is `cleanup-pending`.
    case participantBusy = "participant-busy"
    /// The run was prepared for a participant identity native no longer pins.
    case participantChanged = "participant-changed"
}

/// Correlation fields echoed back on every reply, refused envelopes included.
public struct HostEcho: Equatable, Sendable {
    public var requestId: String
    public var connectionId: String
    public var generation: Int
    public var operation: String

    public init(requestId: String = "", connectionId: String = "", generation: Int = 0, operation: String = "") {
        self.requestId = requestId
        self.connectionId = connectionId
        self.generation = generation
        self.operation = operation
    }
}

public struct HostRequestRejection: Error, Equatable, Sendable {
    public let refusal: HostRefusal
    public let echo: HostEcho

    public init(_ refusal: HostRefusal, echo: HostEcho = HostEcho()) {
        self.refusal = refusal
        self.echo = echo
    }
}

/// A validated request. Only the envelope is checked here; the payload is an
/// object whose contents each operation inspects later.
public struct HostRequest: Equatable, Sendable {
    public static let envelopeKeys: Set<String> = ["v", "requestId", "connectionId", "generation", "operation", "payload"]
    /// Longest `requestId` or `operation` string echoed on a refused envelope;
    /// valid values are far shorter. Anything longer is echoed as empty.
    public static let maxEchoedStringBytes = 64
    public static let maxConnectionIdBytes = 128

    /// Canonical lowercase UUIDv4, so the value and its string agree.
    public let requestId: UUID
    public let connectionId: String
    public let generation: Int
    public let operation: HostOperation
    public let payload: [String: JSONValue]

    public init(requestId: UUID, connectionId: String, generation: Int, operation: HostOperation, payload: [String: JSONValue]) {
        self.requestId = requestId
        self.connectionId = connectionId
        self.generation = generation
        self.operation = operation
        self.payload = payload
    }

    public var requestIdString: String { requestId.canonicalString }

    public var echo: HostEcho {
        HostEcho(requestId: requestIdString, connectionId: connectionId, generation: generation, operation: operation.rawValue)
    }

    /// Hash of the operation plus canonical payload. Same request identity with
    /// a different hash is a changed payload and is refused.
    public var payloadHash: String {
        PayloadHash.hex(of: .object(["operation": .string(operation.rawValue), "payload": .object(payload)]))
    }

    /// Strict envelope validation with precise refusal reasons.
    /// `acceptsParticipant` is true only for a participant host. While it is
    /// false a `participant.*` name is refused exactly as an unknown name is,
    /// at the same step (before the envelope-key check) and with the same
    /// echo, so a v1 host answers byte for byte as before.
    public init(validating value: JSONValue, acceptsParticipant: Bool = false) throws {
        guard case .object(let fields) = value else { throw HostRequestRejection(.malformedEnvelope) }
        var echo = HostEcho()
        if let requestId = fields["requestId"]?.stringValue, requestId.utf8.count <= Self.maxEchoedStringBytes {
            echo.requestId = requestId
        }
        if let connectionId = fields["connectionId"]?.stringValue, connectionId.utf8.count <= Self.maxConnectionIdBytes {
            echo.connectionId = connectionId
        }
        if let generation = fields["generation"]?.safeIntegerValue { echo.generation = generation }
        if let operation = fields["operation"]?.stringValue, operation.utf8.count <= Self.maxEchoedStringBytes {
            echo.operation = operation
        }

        guard fields["v"]?.safeIntegerValue == DeskHost.protocolVersion else {
            throw HostRequestRejection(.unsupportedVersion, echo: echo)
        }
        guard let requestId = fields["requestId"]?.canonicalUUIDv4Value else {
            throw HostRequestRejection(.invalidIdentity, echo: echo)
        }
        guard let connectionId = fields["connectionId"]?.stringValue, !connectionId.isEmpty,
              connectionId.utf8.count <= Self.maxConnectionIdBytes else {
            throw HostRequestRejection(.invalidIdentity, echo: echo)
        }
        guard let generation = fields["generation"]?.safeIntegerValue else {
            throw HostRequestRejection(.malformedEnvelope, echo: echo)
        }
        guard let operationName = fields["operation"]?.stringValue, let operation = HostOperation(rawValue: operationName),
              acceptsParticipant || !operation.isParticipant else {
            throw HostRequestRejection(.unknownOperation, echo: echo)
        }
        guard Set(fields.keys).isSubset(of: Self.envelopeKeys) else {
            throw HostRequestRejection(.unknownField, echo: echo)
        }
        guard let payload = fields["payload"]?.objectValue else {
            throw HostRequestRejection(.malformedEnvelope, echo: echo)
        }
        self.init(requestId: requestId, connectionId: connectionId, generation: generation, operation: operation, payload: payload)
    }

    /// Bytes in, validated request out. Size, UTF-8 and nesting depth are
    /// checked before any JSON parsing so an oversize, binary or too-deep blob
    /// is refused cheaply, with nothing echoed. The UTF-8 check here is not
    /// the one that keeps the parser honest: ASCII in UTF-16 is valid UTF-8
    /// byte for byte, so `JSONValue.decode` refuses the NUL bytes such input
    /// carries before it scans or parses anything. `acceptsParticipant` is
    /// as for `init(validating:acceptsParticipant:)`.
    public static func decode(_ data: Data, acceptsParticipant: Bool = false) throws -> HostRequest {
        guard data.count <= ProofLimits.envelopeBytes else { throw HostRequestRejection(.payloadTooLarge) }
        guard String(data: data, encoding: .utf8) != nil else { throw HostRequestRejection(.malformedEnvelope) }
        let value: JSONValue
        do {
            value = try JSONValue.decode(data)
        } catch {
            throw HostRequestRejection(.malformedEnvelope)
        }
        return try HostRequest(validating: value, acceptsParticipant: acceptsParticipant)
    }

    public var jsonValue: JSONValue {
        .object([
            "v": .number(Double(DeskHost.protocolVersion)),
            "requestId": .string(requestIdString),
            "connectionId": .string(connectionId),
            "generation": .number(Double(generation)),
            "operation": .string(operation.rawValue),
            "payload": .object(payload)
        ])
    }

    /// Canonical wire bytes, as the page's `JSON.stringify` would produce
    /// modulo key order.
    public func canonicalData() -> Data { jsonValue.canonicalData() }
}

/// `Decodable` is a v1 reader: it never accepts a participant name, so a
/// participant request encodes but does not decode back through `Codable`.
/// A participant host reads requests with `decode(_:acceptsParticipant:)` or
/// `init(validating:acceptsParticipant:)`, never through a `Decoder`.
extension HostRequest: Codable {
    public init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        do {
            try self.init(validating: value)
        } catch let rejection as HostRequestRejection {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: decoder.codingPath,
                debugDescription: rejection.refusal.rawValue
            ))
        }
    }

    public func encode(to encoder: Encoder) throws {
        try jsonValue.encode(to: encoder)
    }
}

/// Every reply the host sends: the five correlation fields, `outcome`, and
/// exactly the fields the outcome variant adds (`reason`, `revision`,
/// `record`, `capabilities`, `bindingId`, `targetRequestId`, `original`,
/// `deliveryId`, `commitRequestId`). `unknown` adds nothing.
public struct HostResponse: Equatable, Sendable {
    public static let baseKeys: Set<String> = ["v", "requestId", "connectionId", "generation", "operation", "outcome"]

    public let requestId: String
    public let connectionId: String
    public let generation: Int
    public let operation: String
    public let outcome: HostOutcome
    public let fields: [String: JSONValue]

    public init(echo: HostEcho, outcome: HostOutcome, fields: [String: JSONValue] = [:]) {
        precondition(Set(fields.keys).isDisjoint(with: Self.baseKeys), "outcome fields never shadow the base fields")
        self.requestId = echo.requestId
        self.connectionId = echo.connectionId
        self.generation = echo.generation
        self.operation = echo.operation
        self.outcome = outcome
        self.fields = fields
    }

    public static func ok(_ echo: HostEcho, _ fields: [String: JSONValue] = [:]) -> HostResponse {
        HostResponse(echo: echo, outcome: .ok, fields: fields)
    }

    public static func refused(_ reason: HostRefusal, echo: HostEcho) -> HostResponse {
        HostResponse(echo: echo, outcome: .refused, fields: ["reason": .string(reason.rawValue)])
    }

    public static func conflict(_ echo: HostEcho, currentRevision: Int) -> HostResponse {
        HostResponse(echo: echo, outcome: .conflict, fields: [
            "revision": .number(Double(currentRevision)),
            "reason": .string(HostRefusal.revisionMismatch.rawValue)
        ])
    }

    public static func unknown(_ echo: HostEcho) -> HostResponse {
        HostResponse(echo: echo, outcome: .unknown)
    }

    public var echo: HostEcho { HostEcho(requestId: requestId, connectionId: connectionId, generation: generation, operation: operation) }

    public var reason: HostRefusal? { fields["reason"]?.stringValue.flatMap(HostRefusal.init(rawValue:)) }
    public var revision: Int? { fields["revision"]?.safeIntegerValue }
    public var record: [String: JSONValue]? { fields["record"]?.objectValue }
    public var capabilities: [String: JSONValue]? { fields["capabilities"]?.objectValue }
    public var bindingId: UUID? { fields["bindingId"]?.canonicalUUIDv4Value }
    public var deliveryId: UUID? { fields["deliveryId"]?.canonicalUUIDv4Value }
    public var commitRequestId: UUID? { fields["commitRequestId"]?.canonicalUUIDv4Value }
    public var targetRequestId: UUID? { fields["targetRequestId"]?.canonicalUUIDv4Value }
    public var original: [String: JSONValue]? { fields["original"]?.objectValue }

    public var jsonValue: JSONValue {
        var object = fields
        object["v"] = .number(Double(DeskHost.protocolVersion))
        object["requestId"] = .string(requestId)
        object["connectionId"] = .string(connectionId)
        object["generation"] = .number(Double(generation))
        object["operation"] = .string(operation)
        object["outcome"] = .string(outcome.rawValue)
        return .object(object)
    }

    /// Canonical JSON bytes (sorted keys, no whitespace).
    public func canonicalData() -> Data { jsonValue.canonicalData() }

    /// Reads a reply back from its JSON object (tests and the glue's logs).
    public init(validating value: JSONValue) throws {
        guard case .object(var object) = value, object["v"]?.safeIntegerValue == DeskHost.protocolVersion,
              let requestId = object["requestId"]?.stringValue, let connectionId = object["connectionId"]?.stringValue,
              let generation = object["generation"]?.safeIntegerValue, let operation = object["operation"]?.stringValue,
              let outcome = object["outcome"]?.stringValue.flatMap(HostOutcome.init(rawValue:)) else {
            throw JSONValueError.malformed
        }
        for key in Self.baseKeys { object.removeValue(forKey: key) }
        self.init(echo: HostEcho(requestId: requestId, connectionId: connectionId, generation: generation, operation: operation),
                  outcome: outcome, fields: object)
    }
}
