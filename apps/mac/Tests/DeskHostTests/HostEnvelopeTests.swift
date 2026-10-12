import Foundation
import Testing
@testable import DeskHost

@Suite("Envelope validation")
struct HostEnvelopeTests {
    @Test("A well-formed envelope decodes, re-encodes and hashes deterministically")
    func validEnvelopeRoundTrips() throws {
        let requestId = UUID()
        let data = envelopeJSON([
            "requestId": "\"\(requestId.canonicalString)\"",
            "operation": "\"workspace.commitProof\"",
            "payload": "{\"workspaceHandle\":\"h\",\"expectedRevision\":4,\"record\":{\"revision\":5,\"b\":[1,2.5,\"x\"],\"a\":null}}"
        ])
        let request = try HostRequest.decode(data)
        #expect(request.requestId == requestId)
        #expect(request.operation == .workspaceCommitProof)
        #expect(request.generation == 0)
        #expect(request.payload["expectedRevision"]?.safeIntegerValue == 4)
        let reencoded = try JSONEncoder().encode(request)
        #expect(try JSONDecoder().decode(HostRequest.self, from: reencoded) == request)
        #expect(try HostRequest.decode(reencoded).payloadHash == request.payloadHash)
        #expect(try HostRequest.decode(request.canonicalData()) == request)

        let shuffled = JSONValue.object(["record": .object(["a": .null, "b": .array([.number(1), .number(2.5), .string("x")])])])
        let ordered = JSONValue.object(["record": .object(["b": .array([.number(1), .number(2.5), .string("x")]), "a": .null])])
        #expect(shuffled.canonicalData() == ordered.canonicalData())
        #expect(String(decoding: ordered.canonicalData(), as: UTF8.self) == "{\"record\":{\"a\":null,\"b\":[1,2.5,\"x\"]}}")
        #expect(PayloadHash.hex(of: shuffled) == PayloadHash.hex(of: ordered))
        #expect(PayloadHash.hex(of: shuffled) != PayloadHash.hex(of: .object(["record": .object(["a": .null])])))
    }

    @Test("Each envelope defect is refused with its own fixed reason", arguments: [
        ("not json", HostRefusal.malformedEnvelope),
        ("[]", .malformedEnvelope),
        ("{\"v\":1}", .invalidIdentity),
        (String(decoding: envelopeJSON(["v": "2"]), as: UTF8.self), .unsupportedVersion),
        (String(decoding: envelopeJSON(["v": "\"1\""]), as: UTF8.self), .unsupportedVersion),
        (String(decoding: envelopeJSON(["requestId": "\"not-a-uuid\""]), as: UTF8.self), .invalidIdentity),
        (String(decoding: envelopeJSON(["requestId": "\"6ba7b810-9dad-11d1-80b4-00c04fd430c8\""]), as: UTF8.self), .invalidIdentity),
        (String(decoding: envelopeJSON(["requestId": "\"61ABCDEF-0000-4000-8ABC-000000000001\""]), as: UTF8.self), .invalidIdentity),
        (String(decoding: envelopeJSON(["requestId": "42"]), as: UTF8.self), .invalidIdentity),
        (String(decoding: envelopeJSON(["connectionId": "\"\""]), as: UTF8.self), .invalidIdentity),
        (String(decoding: envelopeJSON(dropping: ["connectionId"]), as: UTF8.self), .invalidIdentity),
        (String(decoding: envelopeJSON(["generation": "-1"]), as: UTF8.self), .malformedEnvelope),
        (String(decoding: envelopeJSON(["generation": "1.5"]), as: UTF8.self), .malformedEnvelope),
        (String(decoding: envelopeJSON(["generation": "9007199254740992"]), as: UTF8.self), .malformedEnvelope),
        (String(decoding: envelopeJSON(["generation": "\"0\""]), as: UTF8.self), .malformedEnvelope),
        (String(decoding: envelopeJSON(["operation": "\"provider.run\""]), as: UTF8.self), .unknownOperation),
        (String(decoding: envelopeJSON(["operation": "\"dictation.deliverFinal\""]), as: UTF8.self), .unknownOperation),
        (String(decoding: envelopeJSON(["operation": "\"workspace.read \""]), as: UTF8.self), .unknownOperation),
        (String(decoding: envelopeJSON(dropping: ["operation"], extra: ["op": "\"host.capabilities\""]), as: UTF8.self), .unknownOperation),
        (String(decoding: envelopeJSON(extra: ["path": "\"/Users/someone\""]), as: UTF8.self), .unknownField),
        (String(decoding: envelopeJSON(["payload": "[]"]), as: UTF8.self), .malformedEnvelope),
        (String(decoding: envelopeJSON(["payload": "\"text\""]), as: UTF8.self), .malformedEnvelope),
        (String(decoding: envelopeJSON(dropping: ["payload"]), as: UTF8.self), .malformedEnvelope)
    ])
    func refusesDefect(json: String, expected: HostRefusal) {
        #expect(throws: HostRequestRejection.self) { try HostRequest.decode(Data(json.utf8)) }
        do {
            _ = try HostRequest.decode(Data(json.utf8))
        } catch let rejection as HostRequestRejection {
            #expect(rejection.refusal == expected, "\(json)")
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }

    @Test("Oversize and non-UTF-8 bytes are refused before parsing, and a partial envelope is still echoed")
    func refusesOversizeAndBinaryRequests() {
        let oversize = Data(repeating: UInt8(ascii: " "), count: ProofLimits.envelopeBytes + 1)
        do { _ = try HostRequest.decode(oversize); Issue.record("accepted oversize") } catch {
            #expect((error as? HostRequestRejection)?.refusal == .payloadTooLarge)
        }
        let binary = Data([0x7B, 0xFF, 0xFE, 0x7D])
        do { _ = try HostRequest.decode(binary); Issue.record("accepted binary") } catch {
            #expect((error as? HostRequestRejection)?.refusal == .malformedEnvelope)
        }

        let partial = envelopeJSON(["operation": "\"shell.run\"", "requestId": "\"abc\"", "generation": "7"])
        do {
            _ = try HostRequest.decode(partial)
        } catch let rejection as HostRequestRejection {
            #expect(rejection.refusal == .invalidIdentity)
            #expect(rejection.echo == HostEcho(requestId: "abc", connectionId: "invented-connection", generation: 7, operation: "shell.run"))
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }

    @Test("Safe integers stop at 2^53 - 1; native ids are canonical lowercase v4; record ids keep their case")
    func numericAndIdentityBounds() {
        #expect(JSONValue.number(9_007_199_254_740_991).safeIntegerValue == 9_007_199_254_740_991)
        #expect(JSONValue.number(9_007_199_254_740_992).safeIntegerValue == nil)
        #expect(JSONValue.number(-1).safeIntegerValue == nil)
        #expect(JSONValue.number(2.5).safeIntegerValue == nil)
        #expect(JSONValue.string("3").safeIntegerValue == nil)

        let id = UUID()
        #expect(JSONValue.string(id.canonicalString).canonicalUUIDv4Value == id)
        #expect(JSONValue.string(id.uuidString).canonicalUUIDv4Value == nil, "uppercase is not canonical")
        #expect(UUID.canonicalV4("6ba7b810-9dad-11d1-80b4-00c04fd430c8") == nil, "version 1 is not a native id")
        #expect(UUID.canonicalV4("61abcdef-0000-4000-cabc-000000000001") == nil, "variant must be RFC 4122")
        #expect(JSONValue.string("A1000000-0000-1000-8000-000000000001").recordIdValue == "A1000000-0000-1000-8000-000000000001")
        #expect(JSONValue.string("52abcdef-0000-4000-8abc-000000000001").recordIdValue == "52abcdef-0000-4000-8abc-000000000001")
        #expect(JSONValue.string("00000000-0000-0000-0000-000000000000").recordIdValue == nil, "the nil UUID is not a record id")
        #expect(JSONValue.string("A1000000-0000-6000-8000-000000000001").recordIdValue == nil, "version 6 is outside the agreed 1-5")
        #expect(JSONValue.string("").opaqueStringValue == nil)
        #expect(JSONValue.object(["k": .array([.string("abc"), .object(["longer-key": .string("x")])])]).longestTextItemBytes == 10)
    }

    @Test("Selections count UTF-16 units and may not split a surrogate pair")
    func selectionBounds() {
        let text = "Before 😀 after"
        #expect(text.utf16.count == 15)
        #expect(TextSelection(start: 7, end: 9).isValid(in: text), "the whole emoji")
        #expect(TextSelection(start: 0, end: 15).isValid(in: text))
        #expect(TextSelection(start: 15, end: 15).isValid(in: text))
        #expect(!TextSelection(start: 8, end: 9).isValid(in: text), "starts inside the pair")
        #expect(!TextSelection(start: 7, end: 8).isValid(in: text), "ends inside the pair")
        #expect(!TextSelection(start: 9, end: 7).isValid(in: text))
        #expect(!TextSelection(start: 0, end: 16).isValid(in: text))
        #expect(!TextSelection(start: -1, end: 0).isValid(in: text))
    }

    @Test("The reply echoes the request id exactly as written; oversize identity strings are not echoed")
    func echoPreservesIdentityBytes() throws {
        let id = UUID().canonicalString
        let request = try HostRequest.decode(envelopeJSON(["requestId": "\"\(id)\""]))
        #expect(request.echo.requestId == id)
        #expect(HostResponse.ok(request.echo).requestId == id)
        #expect(try JSONDecoder().decode(HostRequest.self, from: JSONEncoder().encode(request)).echo.requestId == id)

        let long = String(repeating: "a", count: 1_000)
        do {
            _ = try HostRequest.decode(envelopeJSON(["requestId": "\"\(long)\"", "connectionId": "\"\(long)\"", "operation": "\"\(long)\"", "generation": "3"]))
            Issue.record("accepted an oversize identity")
        } catch let rejection as HostRequestRejection {
            #expect(rejection.refusal == .invalidIdentity)
            #expect(rejection.echo == HostEcho(requestId: "", connectionId: "", generation: 3, operation: ""))
        }
    }

    @Test("Object keys that differ in bytes but compare equal in Swift are refused, never collapsed")
    func refusesCollapsingKeys() throws {
        let precomposed = "\u{00E9}"
        let decomposed = "e\u{0301}"
        #expect(precomposed == decomposed, "Swift sees one key")
        #expect(Array(precomposed.utf8) != Array(decomposed.utf8), "JavaScript sees two")
        let ambiguous = "{\"record\":{\"\(precomposed)\":1,\"\(decomposed)\":2}}"
        do {
            _ = try HostRequest.decode(envelopeJSON(["payload": ambiguous]))
            Issue.record("accepted a payload that would lose an entry")
        } catch let rejection as HostRequestRejection {
            #expect(rejection.refusal == .malformedEnvelope)
        }
        let distinct = try HostRequest.decode(envelopeJSON(["payload": "{\"record\":{\"\(precomposed)\":1,\"e\":2}}"]))
        #expect(distinct.payload["record"]?.objectValue?.count == 2)

        #expect(throws: JSONValueError.duplicateKey) { try JSONValue.decode(Data("{\"\(precomposed)\":1,\"\(decomposed)\":2}".utf8)) }
        #expect(throws: JSONValueError.duplicateKey) { try JSONValue.decode(Data("[{\"ok\":{\"\(precomposed)\":1,\"\(decomposed)\":2}}]".utf8)) }
        #expect(try JSONValue.decode(Data("[1,true,false,null,\"x\",{\"a\":{\"b\":2.5}},0,1]".utf8))
                == .array([.number(1), .bool(true), .bool(false), .null, .string("x"), .object(["a": .object(["b": .number(2.5)])]), .number(0), .number(1)]))
        #expect(throws: JSONValueError.malformed) { try JSONValue.decode(Data("1e400".utf8)) }
        #expect(throws: JSONValueError.malformed) { try JSONValue.decode(Data("{".utf8)) }
        #expect(try JSONValue.decode(Data("\"solo\"".utf8)) == .string("solo"))
    }

    @Test("Replies carry exactly the base fields plus their variant's fields, and round-trip through canonical bytes")
    func responseShapes() throws {
        let echo = HostEcho(requestId: UUID().canonicalString, connectionId: "c", generation: 2, operation: "workspace.commitProof")
        let conflict = HostResponse.conflict(echo, currentRevision: 9)
        let text = String(decoding: conflict.canonicalData(), as: UTF8.self)
        #expect(text.hasPrefix("{\"connectionId\":\"c\",\"generation\":2,\"operation\":\"workspace.commitProof\",\"outcome\":\"conflict\",\"reason\":\"revision-mismatch\",\"requestId\":\""))
        #expect(text.hasSuffix("\",\"revision\":9,\"v\":1}"))
        #expect(try HostResponse(validating: JSONValue.decode(conflict.canonicalData())) == conflict)
        #expect(conflict.reason == .revisionMismatch)
        #expect(conflict.revision == 9)

        let unknown = HostResponse.unknown(echo)
        #expect(Set(unknown.jsonValue.objectValue!.keys) == HostResponse.baseKeys)
        let refused = HostResponse.refused(.locked, echo: echo)
        #expect(Set(refused.jsonValue.objectValue!.keys) == HostResponse.baseKeys.union(["reason"]))
        let ok = HostResponse.ok(echo, ["revision": .number(1), "record": .object(["revision": .number(1)])])
        #expect(try HostResponse(validating: JSONValue.decode(ok.canonicalData())) == ok)
        #expect(ok.record == ["revision": .number(1)])
        #expect(HostRefusal.allCases.count == 32, "the fixed reason enum has exactly the agreed values: v1's 24 and the participant 8")
        #expect(HostRefusal.allCases.map(\.rawValue).sorted() == [
            "binding-stale", "duplicate-delivery", "duplicate-run", "invalid-identity", "invalid-revision", "locked",
            "malformed-envelope", "mutation-outstanding", "participant-busy", "participant-changed", "participant-unavailable",
            "payload-mismatch", "payload-too-large", "revision-mismatch", "revision-not-advanced", "run-mismatch", "run-not-found",
            "run-not-prepared", "stale-generation", "store-corrupt", "store-locked", "store-missing", "text-too-large",
            "unknown-binding", "unknown-connection", "unknown-delivery", "unknown-field", "unknown-handle", "unknown-operation",
            "unknown-request", "unknown-run", "unsupported-version"
        ])
    }

    static let participantNames = ["participant.availability", "participant.start", "participant.stop", "participant.status", "participant.events"]

    @Test("The seven stay the advertised list; a participant host lists twelve in the contract's order")
    func advertisedLists() {
        #expect(HostOperation.advertised.map(\.rawValue) == [
            "host.capabilities", "workspace.read", "workspace.commitProof", "dictation.bindDraft", "dictation.unbindDraft",
            "workspace.reconcile", "dictation.receipt"
        ])
        #expect(HostOperation.participantAdvertised.map(\.rawValue) == HostOperation.advertised.map(\.rawValue) + Self.participantNames)
        #expect(HostOperation.allCases.filter(\.isParticipant).map(\.rawValue) == Self.participantNames)
        #expect(HostOperation.advertised.allSatisfy { !$0.isParticipant })
    }

    @Test("Without the flag a participant name is an unknown operation, at the same step and with the same echo, extra envelope key or not",
          arguments: HostEnvelopeTests.participantNames)
    func participantNamesRefusedByDefault(name: String) throws {
        let requestId = UUID().canonicalString
        let overrides = ["requestId": "\"\(requestId)\"", "operation": "\"\(name)\"", "generation": "3"]
        let expected = HostRequestRejection(.unknownOperation, echo: HostEcho(requestId: requestId, connectionId: "invented-connection",
                                                                              generation: 3, operation: name))
        for data in [envelopeJSON(overrides), envelopeJSON(overrides, extra: ["path": "\"/Users/someone\""])] {
            #expect(throws: expected) { try HostRequest.decode(data) }
            #expect(throws: expected) { try HostRequest.decode(data, acceptsParticipant: false) }
            #expect(throws: expected) { try HostRequest(validating: JSONValue.decode(data)) }
            #expect(throws: DecodingError.self) { try JSONDecoder().decode(HostRequest.self, from: data) }
        }
    }

    @Test("With the flag a participant name decodes; the envelope's own checks still apply after it",
          arguments: HostEnvelopeTests.participantNames)
    func participantNamesDecodeWhenAccepted(name: String) throws {
        let requestId = UUID()
        let data = envelopeJSON(["requestId": "\"\(requestId.canonicalString)\"", "operation": "\"\(name)\"",
                                 "payload": "{\"runId\":\"\(UUID().canonicalString)\"}"])
        let request = try HostRequest.decode(data, acceptsParticipant: true)
        #expect(request.operation.rawValue == name)
        #expect(request.operation.isParticipant)
        #expect(request.requestId == requestId)
        #expect(request.payload.keys.sorted() == ["runId"])
        #expect(try HostRequest.decode(request.canonicalData(), acceptsParticipant: true) == request)
        #expect(try HostRequest(validating: request.jsonValue, acceptsParticipant: true) == request)
        let encoded = try JSONEncoder().encode(request)
        #expect(throws: DecodingError.self, "Decodable is a v1 reader and never accepts a participant name") {
            try JSONDecoder().decode(HostRequest.self, from: encoded)
        }

        let extra = envelopeJSON(["operation": "\"\(name)\""], extra: ["path": "\"/Users/someone\""])
        let extraEcho = try #require(Self.echo(of: extra))
        #expect(throws: HostRequestRejection(.unknownField, echo: extraEcho)) { try HostRequest.decode(extra, acceptsParticipant: true) }
        let listPayload = envelopeJSON(["operation": "\"\(name)\"", "payload": "[]"])
        let listEcho = try #require(Self.echo(of: listPayload))
        #expect(throws: HostRequestRejection(.malformedEnvelope, echo: listEcho)) { try HostRequest.decode(listPayload, acceptsParticipant: true) }
    }

    @Test("The flag changes nothing for the seven v1 operations, refusals included", arguments: HostOperation.advertised)
    func flagLeavesV1Alone(operation: HostOperation) throws {
        let name = "\"\(operation.rawValue)\""
        let accepted = envelopeJSON(["operation": name])
        #expect(try HostRequest.decode(accepted, acceptsParticipant: true) == HostRequest.decode(accepted))
        let refused: [(HostRefusal, Data)] = [
            (.unknownField, envelopeJSON(["operation": name], extra: ["path": "\"/Users/someone\""])),
            (.malformedEnvelope, envelopeJSON(["operation": name, "payload": "[]"])),
            (.unsupportedVersion, envelopeJSON(["operation": name, "v": "2"])),
            (.malformedEnvelope, envelopeJSON(["operation": name], dropping: ["generation"])),
            (.invalidIdentity, envelopeJSON(["operation": name, "requestId": "\"not-a-uuid\""]))
        ]
        for (reason, data) in refused {
            let off = Self.decoded(data, acceptsParticipant: false)
            #expect(off.rejection?.refusal == reason)
            #expect(Self.decoded(data, acceptsParticipant: true) == off, "\(reason.rawValue)")
        }
    }

    @Test("The flag changes nothing for a name no host knows, extra envelope key or not")
    func flagLeavesUnknownNamesAlone() {
        for name in ["host.shutdown", "participant.unknown", "Participant.start", "participant.start ", "participant", ""] {
            let operation = "\"\(name)\""
            for data in [envelopeJSON(["operation": operation]), envelopeJSON(["operation": operation], extra: ["path": "\"/tmp\""])] {
                let off = Self.decoded(data, acceptsParticipant: false)
                #expect(off.rejection?.refusal == .unknownOperation, "\(name)")
                #expect(off.rejection?.echo.operation == name)
                #expect(Self.decoded(data, acceptsParticipant: true) == off, "\(name)")
            }
        }
    }

    /// The byte path's answer, success or refusal, as one comparable value.
    private static func decoded(_ data: Data, acceptsParticipant: Bool) -> Result<HostRequest, HostRequestRejection> {
        do {
            return .success(try HostRequest.decode(data, acceptsParticipant: acceptsParticipant))
        } catch let rejection as HostRequestRejection {
            return .failure(rejection)
        } catch {
            Issue.record("a refusal is always a HostRequestRejection: \(error)")
            return .failure(HostRequestRejection(.malformedEnvelope))
        }
    }

    /// The echo a refused envelope carries, read the way the decoder reads it.
    private static func echo(of data: Data) -> HostEcho? {
        guard let fields = try? JSONValue.decode(data).objectValue else { return nil }
        return HostEcho(requestId: fields["requestId"]?.stringValue ?? "", connectionId: fields["connectionId"]?.stringValue ?? "",
                        generation: fields["generation"]?.safeIntegerValue ?? 0, operation: fields["operation"]?.stringValue ?? "")
    }
}

private extension Result where Failure == HostRequestRejection {
    var rejection: HostRequestRejection? {
        if case .failure(let rejection) = self { return rejection }
        return nil
    }
}
