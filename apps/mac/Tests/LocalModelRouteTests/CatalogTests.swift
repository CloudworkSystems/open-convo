import XCTest
@testable import LocalModelRoute

final class CatalogTests: XCTestCase {
    private func parse(_ rows: [[String: Any]]) -> LocalCatalog {
        OllamaCatalog.parse(try! JSONSerialization.data(withJSONObject: Invented.tags(rows)))
    }

    func testListsChatModelsSortedByCodePointWithCloudModelsNeverLocal() {
        let catalog = parse([
            Invented.model("invented-small:7b", digest: Invented.digestA),
            Invented.model("invented-cloud:cloud", digest: Invented.digestB, remote: true),
            Invented.model("Invented-Upper:1b", digest: Invented.digestC),
            Invented.model("invented-remote:9b", digest: Invented.digestC, remote: true),
            Invented.model("invented-suffix:cloud", digest: Invented.digestC),
        ])
        guard case .ready(let entries) = catalog else { return XCTFail("\(catalog)") }
        XCTAssertEqual(entries.map(\.name), ["Invented-Upper:1b", "invented-cloud:cloud", "invented-remote:9b",
                                             "invented-small:7b", "invented-suffix:cloud"])
        XCTAssertEqual(entries.map(\.isLocal), [true, false, false, true, false])
        let small = entries[3]
        XCTAssertEqual(small.model, "invented-small:7b@\(Invented.digestA)")
        XCTAssertEqual([small.id, small.label, small.executionHost], ["ollama-local", "invented-small:7b", "this-mac"])
    }

    func testLeavesOutEmbeddingModelsBadDigestsAndNativeAliasesButNotLookalikes() {
        let catalog = parse([
            Invented.model("invented-embed:1b", digest: Invented.digestA, capabilities: ["embedding"]),
            Invented.model("invented-short:1b", digest: "a1b2c3"),
            Invented.model("invented-upper-digest:1b", digest: Invented.digestA.uppercased()),
            ["name": "invented-no-caps:1b", "digest": Invented.digestA],
            Invented.model("open-convo-run-71abcdef000040008abc000000000001:pin", digest: Invented.digestA),
            Invented.model("open-convo-run-backup:latest", digest: Invented.digestB),
        ])
        guard case .ready(let entries) = catalog else { return XCTFail("\(catalog)") }
        XCTAssertEqual(entries.map(\.name), ["open-convo-run-backup:latest"])
    }

    func testTooManyModelsIsTooLargeNeverACutOffList() {
        let rows = (0...LocalRoute.maxEntries).map { Invented.model(String(format: "invented-m%04d:1b", $0), digest: Invented.digestA) }
        XCTAssertEqual(parse(rows), .unavailable(.catalogTooLarge))
        XCTAssertEqual(parse(Array(rows.dropLast())).entryCount, LocalRoute.maxEntries)
    }

    func testMalformedListsAreUnreadable() {
        for body in ["", "[]", "{}", "{\"models\":{}}", "{\"models\":[{\"digest\":\"x\"}]}", "{\"models\":[{\"name\":\"  \"}]}"] {
            XCTAssertEqual(OllamaCatalog.parse(Data(body.utf8)), .unavailable(.catalogUnreadable), body)
        }
        let duplicate = [Invented.model("invented-a:1b", digest: Invented.digestA), Invented.model("invented-a:1b", digest: Invented.digestB)]
        XCTAssertEqual(parse(duplicate), .unavailable(.catalogUnreadable))
    }

    func testAliasFormatIsExact() {
        let runId = "71abcdef-0000-4000-8abc-000000000001"
        XCTAssertEqual(OllamaAlias.name(forRunId: runId), "open-convo-run-71abcdef00004000" + "8abc000000000001:pin")
        XCTAssertTrue(OllamaAlias.isAlias(OllamaAlias.name(forRunId: runId)!))
        XCTAssertNil(OllamaAlias.name(forRunId: runId.uppercased()))
        XCTAssertNil(OllamaAlias.name(forRunId: "71abcdef-0000-1000-8abc-000000000001"))
        for name in ["open-convo-run-backup:latest", "open-convo-run-71abcdef000040008abc000000000001:latest",
                     "open-convo-run-71abcdef000040008abc000000000001:pin\n", "x-open-convo-run-71abcdef000040008abc000000000001:pin",
                     "open-convo-run-71abcdef000010008abc000000000001:pin"] {
            XCTAssertFalse(OllamaAlias.isAlias(name), name)
        }
    }
}

extension LocalCatalog {
    var entryCount: Int? { if case .ready(let entries) = self { return entries.count }; return nil }
}
