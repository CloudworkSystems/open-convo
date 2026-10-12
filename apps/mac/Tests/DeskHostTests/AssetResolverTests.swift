import Foundation
import Testing
@testable import DeskHost

private struct BundleFixture {
    let root: URL
    let bundle: URL
    let files = FileManager.default
    let indexBytes = Data("<!doctype html><title>invented desk</title>".utf8)
    let scriptBytes = Data("console.log('invented');".utf8)
    let resolver: AssetResolver

    init() throws {
        root = files.temporaryDirectory.appendingPathComponent("AssetResolverTests-\(UUID().uuidString)", isDirectory: true)
        bundle = root.appendingPathComponent("desk-bundle", isDirectory: true)
        try files.createDirectory(at: bundle.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try files.createDirectory(at: bundle.appendingPathComponent("folder"), withIntermediateDirectories: true)
        try indexBytes.write(to: bundle.appendingPathComponent("index.html"))
        try scriptBytes.write(to: bundle.appendingPathComponent("assets/app.js"))
        try Data("not served".utf8).write(to: bundle.appendingPathComponent("secret.txt"))
        try Data("outside".utf8).write(to: root.appendingPathComponent("outside.txt"))
        try files.createSymbolicLink(at: bundle.appendingPathComponent("link.html"), withDestinationURL: bundle.appendingPathComponent("index.html"))
        try files.createSymbolicLink(at: bundle.appendingPathComponent("linked"), withDestinationURL: bundle.appendingPathComponent("assets"))
        try files.createSymbolicLink(at: bundle.appendingPathComponent("escape.txt"), withDestinationURL: root.appendingPathComponent("outside.txt"))
        let manifest = try BundleManifest(assets: [
            .init(path: "index.html", mediaType: "text/html"),
            .init(path: "assets/app.js", mediaType: "text/javascript"),
            .init(path: "link.html", mediaType: "text/html"),
            .init(path: "linked/app.js", mediaType: "text/javascript"),
            .init(path: "escape.txt", mediaType: "text/plain"),
            .init(path: "folder", mediaType: "text/plain"),
            .init(path: "missing.css", mediaType: "text/css")
        ])
        resolver = AssetResolver(manifest: manifest, bundleDirectory: bundle)
    }

    func clean() { try? files.removeItem(at: root) }
}

@Suite("Bundled asset resolution")
struct AssetResolverTests {
    @Test("Listed regular files resolve to their bytes and media type")
    func listedFilesResolve() throws {
        let fixture = try BundleFixture()
        defer { fixture.clean() }
        let index = try #require(try fixture.resolver.read(URL(string: "trueconvo-desk://desk/index.html")!))
        #expect(index.data == fixture.indexBytes)
        #expect(index.mediaType == "text/html")
        let script = try #require(try fixture.resolver.read(URL(string: "TRUECONVO-DESK://Desk/assets/app.js?v=3#top")!))
        #expect(script.data == fixture.scriptBytes)
        #expect(script.mediaType == "text/javascript")
        #expect(try fixture.resolver.read(URL(string: "trueconvo-desk://desk/secret.txt")!) == nil)
    }

    @Test("Traversal, unlisted, absolute, symlinked and foreign requests are refused", arguments: [
        ("trueconvo-desk://desk/../outside.txt", AssetRefusal.traversal),
        ("trueconvo-desk://desk/assets/../index.html", .traversal),
        ("trueconvo-desk://desk/%2e%2e/outside.txt", .traversal),
        ("trueconvo-desk://desk/assets%2F..%2Findex.html", .traversal),
        ("trueconvo-desk://desk/./index.html", .traversal),
        ("trueconvo-desk://desk/assets//app.js", .traversal),
        ("trueconvo-desk://desk/", .unlisted),
        ("trueconvo-desk://desk", .unlisted),
        ("trueconvo-desk://desk//etc/hosts", .absolutePath),
        ("trueconvo-desk://desk/secret.txt", .unlisted),
        ("trueconvo-desk://desk/Index.html", .unlisted),
        ("trueconvo-desk://desk/index.html/", .traversal),
        ("trueconvo-desk://desk/link.html", .symlink),
        ("trueconvo-desk://desk/linked/app.js", .symlink),
        ("trueconvo-desk://desk/escape.txt", .symlink),
        ("trueconvo-desk://desk/folder", .notRegularFile),
        ("trueconvo-desk://desk/missing.css", .missing),
        ("trueconvo-desk://other/index.html", .wrongHost),
        ("trueconvo-desk:///index.html", .wrongHost),
        ("trueconvo-desk://user@desk/index.html", .wrongHost),
        ("file:///etc/hosts", .wrongScheme),
        ("https://desk/index.html", .wrongScheme)
    ])
    func refuses(url: String, expected: AssetRefusal) throws {
        let fixture = try BundleFixture()
        defer { fixture.clean() }
        let request = try #require(URL(string: url))
        #expect(fixture.resolver.resolve(request) == .refused(expected), "\(url)")
        #expect(try fixture.resolver.read(request) == nil)
    }

    @Test("A manifest cannot list absolute, traversing or empty paths")
    func manifestRefusesBadPaths() {
        for path in ["/etc/hosts", "../outside.txt", "assets/../index.html", "", "a//b", "a/./b", "back\\slash", "nul\u{0}byte"] {
            #expect(throws: BundleManifestError.invalidAssetPath(path)) { try BundleManifest(assets: [.init(path: path, mediaType: "text/plain")]) }
        }
        let json = Data("{\"assets\":[{\"path\":\"index.html\",\"mediaType\":\"text/html\"}]}".utf8)
        let manifest = try? JSONDecoder().decode(BundleManifest.self, from: json)
        #expect(manifest?.scheme == DeskHost.assetScheme)
        #expect(manifest?.host == "desk")
        let bad = Data("{\"assets\":[{\"path\":\"/index.html\",\"mediaType\":\"text/html\"}]}".utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(BundleManifest.self, from: bad) }
    }
}
