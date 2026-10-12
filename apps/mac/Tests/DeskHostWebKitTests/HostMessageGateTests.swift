import DeskHost
import DeskHostWebKit
import Foundation
import XCTest

final class HostMessageGateTests: XCTestCase {
    private let good = HostMessageSource(handlerName: "trueConvoHost", isMainFrame: true, isExpectedWebView: true,
                                         originScheme: "trueconvo-desk", originHost: "desk")

    private func admit(_ body: Any?, _ source: HostMessageSource, shutDown: Bool = false) -> HostTransportFailure? {
        switch HostMessageGate.admit(body: body, source: source, expectedScheme: "trueconvo-desk", expectedHost: "desk", shutDown: shutDown) {
        case .admitted: return nil
        case .refused(let failure): return failure
        }
    }

    func testObjectFromTheRightPlaceIsAdmitted() {
        XCTAssertNil(admit(["v": 1], good))
        XCTAssertNil(admit(NSDictionary(), good))
        var upper = good
        upper.originScheme = "TRUECONVO-DESK"
        upper.originHost = "Desk"
        XCTAssertNil(admit([:], upper), "scheme and host compare case-insensitively")
    }

    func testTransportFailuresInOrder() {
        XCTAssertEqual(admit(["v": 1], good, shutDown: true), .handlerShutDown)
        var source = good
        source.handlerName = "trueconvohost"
        XCTAssertEqual(admit(["v": 1], source), .wrongHandlerName)
        source = good
        source.isExpectedWebView = false
        XCTAssertEqual(admit(["v": 1], source), .wrongWebView)
        source = good
        source.isMainFrame = false
        XCTAssertEqual(admit(["v": 1], source), .wrongFrame)
        source = good
        source.originScheme = "https"
        XCTAssertEqual(admit(["v": 1], source), .wrongOrigin)
        source = good
        source.originHost = "other"
        XCTAssertEqual(admit(["v": 1], source), .wrongOrigin)
        source = good
        source.originScheme = nil
        XCTAssertEqual(admit(["v": 1], source), .wrongOrigin)
    }

    func testNonObjectBodiesAreTransportFailures() {
        XCTAssertEqual(admit(nil, good), .notAnObject)
        XCTAssertEqual(admit("{\"v\":1}", good), .notAnObject)
        XCTAssertEqual(admit(42, good), .notAnObject)
        XCTAssertEqual(admit([1, 2], good), .notAnObject)
        XCTAssertEqual(admit(NSNull(), good), .notAnObject)
        XCTAssertEqual(admit(true, good), .notAnObject)
    }
}

final class HostRequestPipelineTests: XCTestCase {
    private func refusal(_ body: NSDictionary) -> HostResponse? {
        if case .refused(let response) = HostRequestPipeline.decode(body) { return response }
        return nil
    }

    func testValidSharedVectorRequestsDecode() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "native-host-v1", withExtension: "json"))
        let fixture = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? NSDictionary)
        let cases = try XCTUnwrap(fixture["cases"] as? [NSDictionary])
        XCTAssertEqual(cases.count, 6)
        for item in cases {
            let request = try XCTUnwrap(item["request"] as? NSDictionary)
            guard case .request(let decoded) = HostRequestPipeline.decode(request) else {
                return XCTFail("vector \(item["name"] ?? "?") should decode")
            }
            XCTAssertEqual(decoded.operation.rawValue, request["operation"] as? String)
            XCTAssertEqual(decoded.connectionId, "51000000-0000-4000-8000-000000000001")
            XCTAssertEqual(decoded.generation, 2)
            XCTAssertEqual(try HostRequest.decode(decoded.canonicalData()), decoded, "same request as the byte path")
        }
    }

    func testRefusalsKeepTheirReasonAndEcho() {
        let unsupported = refusal(["v": 2, "requestId": "r", "operation": "host.capabilities", "generation": 3, "connectionId": "c", "payload": [:]])
        XCTAssertEqual(unsupported?.reason, .unsupportedVersion)
        XCTAssertEqual(unsupported?.requestId, "r")
        XCTAssertEqual(unsupported?.connectionId, "c")
        XCTAssertEqual(unsupported?.generation, 3)
        XCTAssertEqual(unsupported?.operation, "host.capabilities")
        XCTAssertEqual(unsupported?.outcome, .refused)

        let unknown = refusal(["v": 1, "requestId": "61abcdef-0000-4000-8abc-000000000001", "connectionId": "c", "generation": 1,
                               "operation": "host.shutdown", "payload": [:]])
        XCTAssertEqual(unknown?.reason, .unknownOperation)
        XCTAssertEqual(unknown?.operation, "host.shutdown")

        let malformed = refusal(["v": 1, "requestId": "61abcdef-0000-4000-8abc-000000000001", "connectionId": "c", "generation": 1,
                                 "operation": "host.capabilities", "payload": "not an object"])
        XCTAssertEqual(malformed?.reason, .malformedEnvelope)
        XCTAssertEqual(refusal([:])?.reason, .unsupportedVersion)
    }

    func testGraphsTheBridgeRefusesAreMalformedEnvelopes() {
        let withDate = refusal(["v": 1, "when": Date()])
        XCTAssertEqual(withDate?.reason, .malformedEnvelope)
        XCTAssertEqual(withDate?.requestId, "", "nothing echoed from a graph that was never read")
        let withNaN = refusal(["v": 1, "generation": Double.nan])
        XCTAssertEqual(withNaN?.reason, .malformedEnvelope)
    }

    func testOversizeEnvelopeIsPayloadTooLarge() {
        // Two-byte characters: the budget charges one per UTF-16 unit and
        // admits this graph, the exact canonical measure then refuses it.
        let wide = String(repeating: "é", count: ProofLimits.envelopeBytes - 200)
        let big = refusal(["v": 1, "requestId": "61abcdef-0000-4000-8abc-000000000001", "connectionId": "c", "generation": 1,
                           "operation": "host.capabilities", "payload": ["record": wide]])
        XCTAssertEqual(big?.reason, .payloadTooLarge, "measured as canonical JSON after conversion")
        XCTAssertEqual(big?.requestId, "")
        let text = String(repeating: "x", count: ProofLimits.envelopeBytes)
        let bigger = refusal(["v": 1, "requestId": "61abcdef-0000-4000-8abc-000000000001", "connectionId": "c", "generation": 1,
                              "operation": "host.capabilities", "payload": ["record": text]])
        XCTAssertEqual(bigger?.reason, .payloadTooLarge, "the byte budget refuses this one before conversion")
        XCTAssertEqual(bigger?.requestId, "")
    }

    /// W3 (Codex review of 6052518): a payload whose container counts alone
    /// exceed the envelope limit is `payload-too-large` at once, with nothing
    /// echoed, and the next ordinary request decodes as before.
    func testImpossibleContainerCountsArePayloadTooLargeAtOnce() throws {
        let zeros = [NSNumber](repeating: 0, count: 10_000_000) as NSArray
        let body: NSDictionary = ["v": 1, "requestId": "61abcdef-0000-4000-8abc-000000000001", "connectionId": "c", "generation": 1,
                                  "operation": "host.capabilities", "payload": ["zeros": zeros]]
        let started = Date()
        let refused = refusal(body)
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2)
        XCTAssertEqual(refused?.reason, .payloadTooLarge)
        XCTAssertEqual(refused?.requestId, "", "nothing echoed from a graph that was never read")
        let url = try XCTUnwrap(Bundle.module.url(forResource: "native-host-v1", withExtension: "json"))
        let fixture = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? NSDictionary)
        let request = try XCTUnwrap((fixture["cases"] as? [NSDictionary])?.first?["request"] as? NSDictionary)
        guard case .request(let decoded) = HostRequestPipeline.decode(request) else { return XCTFail("the next ordinary request decodes") }
        XCTAssertEqual(decoded.generation, 2)
    }

    /// The two things a page can post as an object that it could never send
    /// as bytes. A graph nested thousands deep used to recurse the host into
    /// a stack overflow before the size check ran; now it is refused at the
    /// bridge's depth limit. (A regression to unbounded recursion shows here
    /// as a crash of the whole test run, not as one failure.)
    func testDeeplyNestedEnvelopeIsMalformedNotACrash() {
        for depth in [JSONBridge.maxNestingDepth, 5_000, 20_000] {
            var nested: Any = NSArray(object: 1)
            for _ in 0..<depth { nested = NSArray(object: nested) }
            let refused = refusal(["v": 1, "requestId": "61abcdef-0000-4000-8abc-000000000001", "payload": nested])
            XCTAssertEqual(refused?.reason, .malformedEnvelope, "depth \(depth)")
            XCTAssertEqual(refused?.requestId, "", "nothing echoed from a graph that was never read (depth \(depth))")
        }
    }

    /// Text with an unpaired surrogate is refused as the contract requires,
    /// in a value or a key, before any of the envelope is read.
    func testUnpairedSurrogateAnywhereIsMalformedEnvelope() {
        let lone = NSString(characters: [0x78, 0xD800, 0x79], length: 3)
        let good = "61abcdef-0000-4000-8abc-000000000001"
        let inPayload = refusal(["v": 1, "requestId": good, "connectionId": "c", "generation": 1, "operation": "workspace.read",
                                 "payload": ["workspaceHandle": lone]])
        XCTAssertEqual(inPayload?.reason, .malformedEnvelope)
        XCTAssertEqual(inPayload?.requestId, "", "not even the request id is echoed")
        let inEnvelope = refusal(["v": 1, "requestId": lone, "connectionId": "c", "generation": 1, "operation": "host.capabilities", "payload": [:]])
        XCTAssertEqual(inEnvelope?.reason, .malformedEnvelope)
        let payload = NSMutableDictionary()
        payload[lone] = "value"
        let inKey = refusal(["v": 1, "requestId": good, "connectionId": "c", "generation": 1, "operation": "workspace.read", "payload": payload])
        XCTAssertEqual(inKey?.reason, .malformedEnvelope)
        XCTAssertEqual(inKey?.requestId, "")
    }

    func testExchangeSummaryCarriesIdentitiesOnly() {
        let echo = HostEcho(requestId: "r", connectionId: "c", generation: 2, operation: "workspace.read")
        let ok = HostResponse.ok(echo, ["record": .object(["private": .string("never summarized")]), "revision": .number(1)])
        XCTAssertEqual(HostExchange.replied(ok), .replied(operation: "workspace.read", connectionId: "c", generation: 2, outcome: .ok, reason: nil))
        let refused = HostResponse.refused(.storeLocked, echo: echo)
        XCTAssertEqual(HostExchange.replied(refused), .replied(operation: "workspace.read", connectionId: "c", generation: 2, outcome: .refused, reason: .storeLocked))
    }
}
