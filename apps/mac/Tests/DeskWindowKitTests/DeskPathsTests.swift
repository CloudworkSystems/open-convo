import Darwin
import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
import XCTest

/// The invented Desk's folders: a private base with a plain marker, one
/// new folder per run, never a symbolic link, never anything removed.
/// Every link, swap and foreign folder here is invented, inside a
/// throwaway temp folder.
final class DeskPathsTests: XCTestCase {
    private var folder: DeskTestFolder!
    private let files = FileManager.default

    override func setUpWithError() throws { folder = try DeskTestFolder() }
    override func tearDownWithError() throws { folder.clean() }

    func testCreates0700BaseWithMarker() throws {
        let paths = folder.paths
        XCTAssertEqual(paths.existingRunFolderNames(), [])
        XCTAssertFalse(files.fileExists(atPath: folder.support.path), "reading creates nothing, not even Application Support")

        let checked = try paths.prepareBase()
        XCTAssertEqual(checked.path, try resolved(paths.base), "the checked path has no alias in it")
        XCTAssertEqual(try posixMode(paths.base), 0o700)
        let marker = paths.base.appendingPathComponent(DeskPaths.markerFileName)
        XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), DeskPaths.markerText)
        XCTAssertEqual(try posixMode(marker), 0o600)

        // Again: nothing changes. A loosened (but not shared-writable) base is made private again.
        try Data("kept".utf8).write(to: paths.base.appendingPathComponent("other.txt"))
        XCTAssertEqual(chmod(paths.base.path, 0o755), 0)
        try paths.prepareBase()
        XCTAssertEqual(try posixMode(paths.base), 0o700)
        XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), DeskPaths.markerText)
        XCTAssertEqual(try Data(contentsOf: paths.base.appendingPathComponent("other.txt")), Data("kept".utf8))
        XCTAssertEqual(DeskPaths.standard()?.base.path.hasSuffix("/Library/Application Support/com.trueconvo.voice-cursor/desk-invented-proof"), true)
        XCTAssertEqual(DeskPaths.standard()?.applicationSupport.path.hasSuffix("/Library/Application Support"), true)
    }

    func testRunFoldersAreUniqueAndOldOnesNeverRemoved() throws {
        let paths = folder.paths
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let first = try paths.makeRunFolder(now: now)
        try Data("invented".utf8).write(to: first.appendingPathComponent("keep.txt"))
        let later = try (0..<5).map { _ in try paths.makeRunFolder(now: now) }
        let all = [first] + later
        XCTAssertEqual(Set(all.map(\.path)).count, 6, "a new folder every time, even within one second")
        let pattern = try NSRegularExpression(pattern: "^run-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$")
        for run in all {
            let name = run.lastPathComponent
            XCTAssertEqual(pattern.numberOfMatches(in: name, range: NSRange(name.startIndex..., in: name)), 1, name)
            XCTAssertEqual(run.deletingLastPathComponent().path, try resolved(paths.base))
            XCTAssertEqual(try posixMode(run), 0o700)
            XCTAssertNoThrow(try paths.validateRunFolder(run))
            XCTAssertNoThrow(try paths.validateRunFolder(paths.base.appendingPathComponent(name, isDirectory: true)), "the as-given path names the same folder")
        }
        XCTAssertEqual(try Data(contentsOf: first.appendingPathComponent("keep.txt")), Data("invented".utf8), "older folders are left alone")
        XCTAssertEqual(paths.existingRunFolderNames(), all.map(\.lastPathComponent).sorted())
    }

    /// `com.trueconvo.voice-cursor` is a link to another folder.
    func testRefusesLinkedAppFolderAndLeavesItsTargetUnchanged() throws {
        let target = try inventedTarget("app-target", inner: DeskPaths.baseFolderName)
        try files.createDirectory(at: folder.support, withIntermediateDirectories: true)
        let link = folder.support.appendingPathComponent(DeskPaths.appFolderName)
        try files.createSymbolicLink(at: link, withDestinationURL: target)
        let before = try treeState(target)

        let paths = folder.paths
        XCTAssertEqual(paths.existingRunFolderNames(), [], "the target's run-looking folder is not listed")
        XCTAssertThrowsError(try paths.prepareBase()) { XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("app")) }
        XCTAssertThrowsError(try paths.makeRunFolder()) { XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("app")) }
        XCTAssertThrowsError(try paths.validateRunFolder(paths.base.appendingPathComponent("run-invented", isDirectory: true))) {
            XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("app"))
        }
        XCTAssertEqual(try treeState(target), before, "the link's target keeps its bytes and permissions")
        XCTAssertEqual(try files.destinationOfSymbolicLink(atPath: link.path), target.path)
    }

    /// `desk-invented-proof` is a link to another folder.
    func testRefusesLinkedBaseAndLeavesItsTargetUnchanged() throws {
        let target = try inventedTarget("base-target", inner: "run-invented")
        let app = folder.support.appendingPathComponent(DeskPaths.appFolderName, isDirectory: true)
        try files.createDirectory(at: app, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try files.createSymbolicLink(at: folder.base, withDestinationURL: target)
        let before = try treeState(target)
        let appBefore = try treeState(app)

        let paths = folder.paths
        XCTAssertEqual(paths.existingRunFolderNames(), [])
        XCTAssertThrowsError(try paths.prepareBase()) { XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("base")) }
        XCTAssertThrowsError(try paths.makeRunFolder()) { XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("base")) }
        XCTAssertThrowsError(try paths.validateRunFolder(target.appendingPathComponent("run-invented"))) {
            XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("base"))
        }
        XCTAssertEqual(try treeState(target), before)
        XCTAssertEqual(try treeState(app), appBefore)
    }

    /// A run folder replaced by a link after it was made.
    func testRefusesLinkedRunFolderAndLeavesItsTargetUnchanged() throws {
        let paths = folder.paths
        let run = try paths.makeRunFolder()
        let target = try inventedTarget("run-target", inner: "attempted")
        try files.removeItem(at: run) // the empty folder this test just made
        try files.createSymbolicLink(at: run, withDestinationURL: target)
        let before = try treeState(target)

        XCTAssertThrowsError(try paths.validateRunFolder(run)) { XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("run")) }
        XCTAssertEqual(paths.existingRunFolderNames(), [run.lastPathComponent], "listing reads names only")
        XCTAssertEqual(try treeState(target), before)

        // A folder outside the base, or not a run folder, is refused by name.
        XCTAssertThrowsError(try paths.validateRunFolder(target)) { XCTAssertEqual($0 as? DeskPaths.Failure, .notAFolder("run")) }
        XCTAssertThrowsError(try paths.validateRunFolder(folder.root.appendingPathComponent("run-elsewhere"))) {
            XCTAssertEqual($0 as? DeskPaths.Failure, .notAFolder("run"))
        }
    }

    /// The app folder or the base is swapped for a link right after it was
    /// checked: the work stays in the checked folder, the swap is caught
    /// before any path is handed on, and the link's target is untouched.
    func testSwapAfterTheCheckIsNotFollowed() throws {
        for (swapped, label) in [(DeskPaths.appFolderName, "app"), (DeskPaths.baseFolderName, "base")] {
            let support = folder.root.appendingPathComponent("home-\(label)/Application Support", isDirectory: true)
            let paths = DeskPaths(applicationSupport: support)
            try paths.prepareBase()
            let target = try inventedTarget("swap-target-\(label)", inner: DeskPaths.baseFolderName)
            let before = try treeState(target)
            let original = swapped == DeskPaths.appFolderName
                ? support.appendingPathComponent(swapped)
                : paths.base
            let moved = original.deletingLastPathComponent().appendingPathComponent("moved-\(label)", isDirectory: true)
            XCTAssertEqual(chmod(paths.base.path, 0o755), 0, "loosened, so a chmod through the link would show")

            XCTAssertThrowsError(try paths.makeRunFolder(now: Date(), afterCheck: {
                try self.files.moveItem(at: original, to: moved)
                try self.files.createSymbolicLink(at: original, withDestinationURL: target)
            })) { XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder(label), label) }

            XCTAssertEqual(try treeState(target), before, "\(label): the swapped-in target keeps its bytes and permissions")
            let checkedBase = swapped == DeskPaths.appFolderName ? moved.appendingPathComponent(DeskPaths.baseFolderName) : moved
            XCTAssertEqual(try posixMode(checkedBase), 0o700, "\(label): the chmod went to the checked folder")
            let left = try files.contentsOfDirectory(atPath: checkedBase.path)
            XCTAssertTrue(left.contains(DeskPaths.markerFileName), "\(label): the marker went to the checked folder")
            XCTAssertEqual(left.filter { $0.hasPrefix(DeskPaths.runFolderPrefix) }.count, 1, "\(label): the run folder went to the checked folder")
        }
    }

    /// A plain file, a shared-writable folder, or another user's folder
    /// where an app-owned folder belongs is refused and left as it was.
    func testRefusesNonFoldersSharedFoldersAndOtherUsersFolders() throws {
        let paths = folder.paths
        let app = folder.support.appendingPathComponent(DeskPaths.appFolderName, isDirectory: true)
        try files.createDirectory(at: folder.support, withIntermediateDirectories: true)

        try Data("x".utf8).write(to: app)
        XCTAssertThrowsError(try paths.prepareBase()) { XCTAssertEqual($0 as? DeskPaths.Failure, .notAFolder("app")) }
        XCTAssertEqual(try Data(contentsOf: app), Data("x".utf8))
        try files.removeItem(at: app)

        try files.createDirectory(at: app, withIntermediateDirectories: false)
        XCTAssertEqual(chmod(app.path, 0o777), 0)
        XCTAssertThrowsError(try paths.makeRunFolder()) { XCTAssertEqual($0 as? DeskPaths.Failure, .openToOthers("app")) }
        XCTAssertEqual(paths.existingRunFolderNames(), [])
        XCTAssertEqual(try posixMode(app), 0o777, "refused, not repaired")
        XCTAssertEqual(try files.contentsOfDirectory(atPath: app.path), [], "nothing made inside")
        XCTAssertEqual(chmod(app.path, 0o700), 0)

        try files.createDirectory(at: paths.base, withIntermediateDirectories: false)
        XCTAssertEqual(chmod(paths.base.path, 0o770), 0)
        XCTAssertThrowsError(try paths.prepareBase()) { XCTAssertEqual($0 as? DeskPaths.Failure, .openToOthers("base")) }
        XCTAssertEqual(try posixMode(paths.base), 0o770)
        XCTAssertEqual(try files.contentsOfDirectory(atPath: paths.base.path), [], "no marker written")
        XCTAssertEqual(chmod(paths.base.path, 0o700), 0)

        let run = try paths.makeRunFolder()
        XCTAssertEqual(chmod(run.path, 0o777), 0)
        XCTAssertThrowsError(try paths.validateRunFolder(run)) { XCTAssertEqual($0 as? DeskPaths.Failure, .openToOthers("run")) }
        XCTAssertEqual(try posixMode(run), 0o777)

        // Another user's folder: a folder owned by someone else cannot be
        // made without admin rights, so the owner rule is checked directly.
        var info = Darwin.stat()
        XCTAssertEqual(lstat(paths.base.path, &info), 0)
        XCTAssertNil(DeskPaths.refusal(forFolder: info, label: "base"))
        XCTAssertEqual(DeskPaths.refusal(forFolder: info, label: "base", owner: geteuid() &+ 1), .notYours("base"))
    }

    func testRefusesLinkedMarker() throws {
        let paths = folder.paths
        try files.createDirectory(at: paths.base, withIntermediateDirectories: true)
        let target = folder.root.appendingPathComponent("marker-target")
        try Data("x".utf8).write(to: target)
        XCTAssertEqual(chmod(target.path, 0o640), 0)
        try files.createSymbolicLink(at: paths.base.appendingPathComponent(DeskPaths.markerFileName), withDestinationURL: target)
        let before = try treeState(target)
        XCTAssertThrowsError(try paths.prepareBase()) { XCTAssertEqual($0 as? DeskPaths.Failure, .unsafeMarker) }
        XCTAssertEqual(try treeState(target), before, "the link's target is untouched")
    }

    /// Aliases above the Application Support folder are the system's (or
    /// the user's) and are allowed: macOS's `/var` and `/tmp`, and a linked
    /// home folder.
    func testAliasesAboveApplicationSupportStillWork() throws {
        let real = try resolved(folder.root)
        let aliasPrefixes = ["/private/var/", "/private/tmp/"]
        let prefix = try XCTUnwrap(aliasPrefixes.first { real.hasPrefix($0) }, "temp folders live under /var or /tmp on macOS: \(real)")
        let systemAlias = "/" + prefix.split(separator: "/")[1]
        XCTAssertEqual(DeskPaths.inspect(systemAlias), .symlink, "\(systemAlias) is the system's alias")
        let aliased = URL(fileURLWithPath: String(real.dropFirst("/private".count)), isDirectory: true)

        var homes = [aliased.appendingPathComponent("alias-home/Application Support", isDirectory: true)]
        let realHome = folder.root.appendingPathComponent("real-home", isDirectory: true)
        try files.createDirectory(at: realHome, withIntermediateDirectories: true)
        let linkedHome = folder.root.appendingPathComponent("linked-home", isDirectory: true)
        try files.createSymbolicLink(at: linkedHome, withDestinationURL: realHome)
        homes.append(linkedHome.appendingPathComponent("Application Support", isDirectory: true))

        for support in homes {
            let paths = DeskPaths(applicationSupport: support)
            let run = try paths.makeRunFolder()
            XCTAssertFalse(run.path.hasPrefix(aliased.path + "/"), "the handed-on path is the resolved one")
            XCTAssertEqual(run.deletingLastPathComponent().path, try resolved(paths.base))
            XCTAssertNoThrow(try paths.validateRunFolder(run))
            XCTAssertEqual(paths.existingRunFolderNames(), [run.lastPathComponent])
            XCTAssertEqual(try posixMode(paths.base), 0o700)
        }
    }

    /// Through the Desk session: a linked app folder keeps the Desk closed
    /// with the plain message, and the link's target is untouched.
    @MainActor
    func testSessionRefusesLinkedAppFolderWithPlainMessage() async throws {
        let target = try inventedTarget("session-target", inner: DeskPaths.baseFolderName)
        try files.createDirectory(at: folder.support, withIntermediateDirectories: true)
        try files.createSymbolicLink(at: folder.support.appendingPathComponent(DeskPaths.appFolderName), withDestinationURL: target)
        let before = try treeState(target)
        let logs = DeskLogCollector()
        let desk = makeSession(folder, bundle: try folder.fixtureBundle(), logs: logs)
        XCTAssertFalse(desk.earlierRunsExisted)
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(desk.state, .unavailable(DeskSession.Message.unsafeFolder))
        XCTAssertEqual(DeskSession.Message.unsafeFolder, "The invented Desk's folder isn't a plain folder, so the Desk stays closed. Nothing was changed.")
        XCTAssertNil(desk.runFolder)
        XCTAssertNil(desk.store)
        XCTAssertTrue(logs.all.contains("desk.open.failed reason=unsafe-folder"))
        XCTAssertEqual(try treeState(target), before)
    }

    // MARK: Helpers

    /// An invented folder (0750) holding an invented file (0640) and an
    /// inner folder (0755) with its own file, to be pointed at by a link.
    private func inventedTarget(_ name: String, inner: String) throws -> URL {
        let target = folder.root.appendingPathComponent(name, isDirectory: true)
        let innerFolder = target.appendingPathComponent(inner, isDirectory: true)
        try files.createDirectory(at: innerFolder, withIntermediateDirectories: true)
        try Data("INVENTED CANARY \(name)\n".utf8).write(to: target.appendingPathComponent("INVENTED-CANARY.txt"))
        try Data("invented inner \(name)\n".utf8).write(to: innerFolder.appendingPathComponent("inner.txt"))
        XCTAssertEqual(chmod(target.appendingPathComponent("INVENTED-CANARY.txt").path, 0o640), 0)
        XCTAssertEqual(chmod(innerFolder.path, 0o755), 0)
        XCTAssertEqual(chmod(target.path, 0o750), 0)
        return target
    }

    private func resolved(_ url: URL) throws -> String {
        guard let pointer = realpath(url.path, nil) else { throw POSIXError(.ENOENT) }
        defer { free(pointer) }
        return String(cString: pointer)
    }
}

/// Every entry at and under `url`, never following a link: its kind,
/// permission bits and owner, and a file's bytes or a link's destination.
func treeState(_ url: URL) throws -> [String: String] {
    var state: [String: String] = [:]
    func visit(_ path: String, _ relative: String) throws {
        var info = Darwin.stat()
        guard lstat(path, &info) == 0 else { throw POSIXError(.ENOENT) }
        let mode = String(info.st_mode & 0o7777, radix: 8)
        switch info.st_mode & S_IFMT {
        case S_IFDIR:
            state[relative] = "folder \(mode) uid=\(info.st_uid)"
            for name in try FileManager.default.contentsOfDirectory(atPath: path) {
                try visit(path + "/" + name, relative + "/" + name)
            }
        case S_IFLNK:
            state[relative] = "link " + (try FileManager.default.destinationOfSymbolicLink(atPath: path))
        case S_IFREG:
            state[relative] = "file \(mode) uid=\(info.st_uid) " + (try Data(contentsOf: URL(fileURLWithPath: path))).base64EncodedString()
        default:
            state[relative] = "other \(mode)"
        }
    }
    try visit(url.path, ".")
    return state
}

/// Where the Desk comes from: the packaged resources, or (DEBUG only) a
/// development folder.
final class DeskBundleLocationTests: XCTestCase {
    private var folder: DeskTestFolder!

    override func setUpWithError() throws { folder = try DeskTestFolder() }
    override func tearDownWithError() throws { folder.clean() }

    func testPackagedNeedsTheDeskFolderItsEntryAndTheManifest() throws {
        let resources = folder.root.appendingPathComponent("Resources", isDirectory: true)
        let desk = resources.appendingPathComponent("Desk", isDirectory: true)
        try FileManager.default.createDirectory(at: desk, withIntermediateDirectories: true)
        XCTAssertNil(DeskBundleLocation.packaged(resourcesURL: resources), "no entry, no manifest")
        try Data("<!doctype html><title>invented</title>".utf8).write(to: desk.appendingPathComponent("index.html"))
        XCTAssertNil(DeskBundleLocation.packaged(resourcesURL: resources), "no manifest")
        let manifest = try DeskHostWebKit.DeskBundleScanner.manifest(forBundleAt: desk)
        try DeskHostWebKit.DeskBundleScanner.write(manifest, to: resources.appendingPathComponent("desk-manifest.json"))
        let location = try XCTUnwrap(DeskBundleLocation.packaged(resourcesURL: resources))
        XCTAssertEqual(location.source, .packaged)
        XCTAssertEqual(try location.makeResolver().manifest, manifest)
        XCTAssertNil(DeskBundleLocation.packaged(resourcesURL: nil))
    }

    func testDevelopmentFolderOnlyInDebugBuilds() throws {
        let fixture = try folder.fixtureBundle()
        let chosen = DeskBundleLocation.current(bundle: Bundle(for: Self.self),
                                                environment: [DeskBundleLocation.environmentKey: fixture.directory.path])
        #if DEBUG
        XCTAssertTrue(DeskBundleLocation.acceptsDevelopmentFolder)
        XCTAssertEqual(chosen, fixture)
        XCTAssertEqual(try chosen?.makeResolver().manifest.assets.map(\.path), ["index.html"])
        #else
        XCTAssertFalse(DeskBundleLocation.acceptsDevelopmentFolder)
        XCTAssertNil(chosen)
        #endif
        XCTAssertNil(DeskBundleLocation.current(bundle: Bundle(for: Self.self), environment: [:]), "the test bundle carries no Desk")
    }
}
