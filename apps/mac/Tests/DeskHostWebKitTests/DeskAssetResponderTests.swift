import DeskHost
import DeskHostWebKit
import Foundation
import XCTest

/// A throwaway bundle with the shapes the pinned Desk build has, plus the
/// things a bundle must never serve.
struct BundleFixture {
    let root: URL
    let bundle: URL
    let files = FileManager.default
    let index = Data("<!doctype html><title>invented</title><div id=root></div>".utf8)

    init(withSymlink: Bool = false, withUnknownExtension: Bool = false, withIndex: Bool = true) throws {
        root = files.temporaryDirectory.appendingPathComponent("DeskHostWebKitTests-\(UUID().uuidString)", isDirectory: true)
        bundle = root.appendingPathComponent("native-dist", isDirectory: true)
        try files.createDirectory(at: bundle.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try files.createDirectory(at: bundle.appendingPathComponent("licenses"), withIntermediateDirectories: true)
        if withIndex { try index.write(to: bundle.appendingPathComponent("index.html")) }
        try Data("console.log(1)".utf8).write(to: bundle.appendingPathComponent("assets/index-abc.js"))
        try Data("body{}".utf8).write(to: bundle.appendingPathComponent("assets/index-abc.css"))
        try Data([0x77, 0x4F, 0x46, 0x32]).write(to: bundle.appendingPathComponent("assets/font-abc.woff2"))
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: bundle.appendingPathComponent("assets/logo-abc.png"))
        try Data("<svg/>".utf8).write(to: bundle.appendingPathComponent("assets/icon.svg"))
        try Data("{}".utf8).write(to: bundle.appendingPathComponent("assets/data.json"))
        try Data("license".utf8).write(to: bundle.appendingPathComponent("licenses/OFL.txt"))
        try Data("outside".utf8).write(to: root.appendingPathComponent("outside.txt"))
        if withSymlink {
            try files.createSymbolicLink(at: bundle.appendingPathComponent("escape.txt"), withDestinationURL: root.appendingPathComponent("outside.txt"))
        }
        if withUnknownExtension {
            try Data("x".utf8).write(to: bundle.appendingPathComponent("assets/map.wasm"))
        }
    }

    func clean() { try? files.removeItem(at: root) }
}

final class DeskAssetResponderTests: XCTestCase {
    private var fixture: BundleFixture!
    private var responder: DeskAssetResponder!

    override func setUpWithError() throws {
        fixture = try BundleFixture()
        let manifest = try DeskBundleScanner.manifest(forBundleAt: fixture.bundle)
        responder = DeskAssetResponder(resolver: AssetResolver(manifest: manifest, bundleDirectory: fixture.bundle))
    }

    override func tearDown() { fixture.clean() }

    private func get(_ url: String, method: String? = "GET") -> AssetReply {
        responder.reply(to: URL(string: url), method: method)
    }

    /// What the navigation policy asks before allowing a new document: only
    /// the root or a listed HTML file that is there right now counts.
    func testServesDocumentOnlyForListedHTMLThatResolves() throws {
        func serves(_ url: String) -> Bool { responder.servesDocument(at: URL(string: url)!) }
        XCTAssertTrue(serves("trueconvo-desk://desk"))
        XCTAssertTrue(serves("trueconvo-desk://desk/"))
        XCTAssertTrue(serves("trueconvo-desk://desk/index.html"))
        XCTAssertTrue(serves("trueconvo-desk://desk/index.html?x=1#top"), "query and fragment are ignored, as the handler ignores them")
        XCTAssertFalse(serves("trueconvo-desk://desk/nope.txt"))
        XCTAssertFalse(serves("trueconvo-desk://desk/assets/"))
        XCTAssertFalse(serves("trueconvo-desk://desk/assets/index-abc.js"), "listed, but not a document")
        XCTAssertFalse(serves("trueconvo-desk://desk/assets/font-abc.woff2"))
        XCTAssertFalse(serves("trueconvo-desk://desk/licenses/OFL.txt"))
        XCTAssertFalse(serves("trueconvo-desk://desk/licenses/../index.html"))
        XCTAssertFalse(serves("https://desk/index.html"))
        XCTAssertFalse(serves("trueconvo-desk://other/index.html"))
        try fixture.files.removeItem(at: fixture.bundle.appendingPathComponent("index.html"))
        XCTAssertFalse(serves("trueconvo-desk://desk/index.html"), "listed but gone: the handler would answer 404")
    }

    func testEntryAndListedFilesAreServedWithTheirTypes() {
        XCTAssertEqual(responder.entryURL.absoluteString, "trueconvo-desk://desk/index.html")
        let index = get("trueconvo-desk://desk/index.html")
        XCTAssertEqual(index.statusCode, 200)
        XCTAssertEqual(index.body, fixture.index)
        XCTAssertEqual(index.headers["Content-Type"], "text/html; charset=utf-8")
        XCTAssertEqual(index.headers["Content-Length"], String(fixture.index.count))
        XCTAssertEqual(index.headers["X-Content-Type-Options"], "nosniff")
        XCTAssertEqual(index.headers["Cache-Control"], "no-store")
        let expectations: [(String, String)] = [
            ("assets/index-abc.js", "text/javascript; charset=utf-8"),
            ("assets/index-abc.css", "text/css; charset=utf-8"),
            ("assets/font-abc.woff2", "font/woff2"),
            ("assets/logo-abc.png", "image/png"),
            ("assets/icon.svg", "image/svg+xml; charset=utf-8"),
            ("assets/data.json", "application/json; charset=utf-8"),
            ("licenses/OFL.txt", "text/plain; charset=utf-8")
        ]
        for (path, type) in expectations {
            let reply = get("trueconvo-desk://desk/\(path)")
            XCTAssertEqual(reply.statusCode, 200, path)
            XCTAssertEqual(reply.headers["Content-Type"], type, path)
            XCTAssertFalse(reply.body.isEmpty, path)
        }
    }

    func testRootPathMeansTheEntryDocument() {
        for root in ["trueconvo-desk://desk", "trueconvo-desk://desk/", "trueconvo-desk://desk/?x=1", "trueconvo-desk://desk/#top"] {
            let reply = get(root)
            XCTAssertEqual(reply.statusCode, 200, root)
            XCTAssertEqual(reply.body, fixture.index, root)
        }
    }

    func testHeadHasHeadersAndNoBody() {
        let reply = get("trueconvo-desk://desk/index.html", method: "HEAD")
        XCTAssertEqual(reply.statusCode, 200)
        XCTAssertEqual(reply.headers["Content-Length"], String(fixture.index.count))
        XCTAssertTrue(reply.body.isEmpty)
        XCTAssertEqual(get("trueconvo-desk://desk/index.html", method: nil).statusCode, 200, "no method means GET")
    }

    func testOtherMethodsAreRefused() {
        for method in ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"] {
            XCTAssertEqual(get("trueconvo-desk://desk/index.html", method: method).statusCode, 405, method)
        }
    }

    func testEverythingElseIsABare404() {
        let refused = [
            "trueconvo-desk://desk/../outside.txt",
            "trueconvo-desk://desk/%2e%2e/outside.txt",
            "trueconvo-desk://desk/assets/..%2Findex.html",
            "trueconvo-desk://desk/./index.html",
            "trueconvo-desk://desk//index.html",
            "trueconvo-desk://desk/assets",
            "trueconvo-desk://desk/assets/",
            "trueconvo-desk://desk/licenses",
            "trueconvo-desk://desk/outside.txt",
            "trueconvo-desk://desk/missing.css",
            "trueconvo-desk://desk/INDEX.HTML",
            "trueconvo-desk://other/index.html",
            "trueconvo-desk://user@desk/index.html",
            "trueconvo-desk://desk:8/index.html",
            "https://desk/index.html",
            "file://\(fixture.bundle.path)/index.html",
            "trueconvo-desk:///index.html"
        ]
        for url in refused {
            let reply = get(url)
            XCTAssertEqual(reply.statusCode, 404, url)
            XCTAssertTrue(reply.body.isEmpty, url)
            XCTAssertNil(reply.headers["Content-Type"], url)
        }
        XCTAssertEqual(responder.reply(to: nil, method: "GET").statusCode, 404)
    }

    func testSymlinkedFileIsNeverServedEvenIfListed() throws {
        let linked = try BundleFixture(withSymlink: true)
        defer { linked.clean() }
        let manifest = try BundleManifest(assets: [
            .init(path: "index.html", mediaType: "text/html"),
            .init(path: "escape.txt", mediaType: "text/plain")
        ])
        let responder = DeskAssetResponder(resolver: AssetResolver(manifest: manifest, bundleDirectory: linked.bundle))
        XCTAssertEqual(responder.reply(to: URL(string: "trueconvo-desk://desk/escape.txt"), method: "GET").statusCode, 404)
        XCTAssertEqual(responder.reply(to: URL(string: "trueconvo-desk://desk/index.html"), method: "GET").statusCode, 200)
    }
}

final class DeskBundleScannerTests: XCTestCase {
    func testScansListableFilesSortedWithMediaTypes() throws {
        let fixture = try BundleFixture()
        defer { fixture.clean() }
        let manifest = try DeskBundleScanner.manifest(forBundleAt: fixture.bundle)
        XCTAssertEqual(manifest.scheme, "trueconvo-desk")
        XCTAssertEqual(manifest.host, "desk")
        XCTAssertEqual(manifest.assets.map(\.path), [
            "assets/data.json", "assets/font-abc.woff2", "assets/icon.svg", "assets/index-abc.css", "assets/index-abc.js",
            "assets/logo-abc.png", "index.html", "licenses/OFL.txt"
        ])
        XCTAssertEqual(manifest.asset(at: "assets/font-abc.woff2")?.mediaType, "font/woff2")
        XCTAssertEqual(manifest.asset(at: "index.html")?.mediaType, "text/html")
        XCTAssertNil(manifest.asset(at: "outside.txt"))
    }

    func testRefusesSymlinksUnknownExtensionsAndMissingEntry() throws {
        let linked = try BundleFixture(withSymlink: true)
        defer { linked.clean() }
        XCTAssertThrowsError(try DeskBundleScanner.manifest(forBundleAt: linked.bundle)) {
            XCTAssertEqual($0 as? DeskBundleScanner.ScanError, .symlink("escape.txt"))
        }
        let unknown = try BundleFixture(withUnknownExtension: true)
        defer { unknown.clean() }
        XCTAssertThrowsError(try DeskBundleScanner.manifest(forBundleAt: unknown.bundle)) {
            XCTAssertEqual($0 as? DeskBundleScanner.ScanError, .unlistableExtension("assets/map.wasm"))
        }
        let noEntry = try BundleFixture(withIndex: false)
        defer { noEntry.clean() }
        XCTAssertThrowsError(try DeskBundleScanner.manifest(forBundleAt: noEntry.bundle)) {
            XCTAssertEqual($0 as? DeskBundleScanner.ScanError, .missingEntry)
        }
        XCTAssertThrowsError(try DeskBundleScanner.manifest(forBundleAt: noEntry.bundle.appendingPathComponent("index.html"))) {
            XCTAssertEqual($0 as? DeskBundleScanner.ScanError, .notADirectory)
        }
    }

    func testWrittenManifestLoadsBack() throws {
        let fixture = try BundleFixture()
        defer { fixture.clean() }
        let manifest = try DeskBundleScanner.manifest(forBundleAt: fixture.bundle)
        let url = fixture.root.appendingPathComponent("desk-manifest.json")
        try DeskBundleScanner.write(manifest, to: url)
        XCTAssertEqual(try BundleManifest.load(from: url), manifest)
    }

    func testMediaTypes() {
        XCTAssertEqual(DeskAssetMediaType.mediaType(forExtension: "HTML"), "text/html")
        XCTAssertEqual(DeskAssetMediaType.mediaType(forExtension: "mjs"), "text/javascript")
        XCTAssertNil(DeskAssetMediaType.mediaType(forExtension: "wasm"))
        XCTAssertNil(DeskAssetMediaType.mediaType(forExtension: ""))
        XCTAssertEqual(DeskAssetMediaType.contentType(for: "font/woff2"), "font/woff2")
        XCTAssertEqual(DeskAssetMediaType.contentType(for: "text/plain"), "text/plain; charset=utf-8")
    }
}
