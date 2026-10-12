import Darwin
@testable import DeskWindowKit
import Foundation
import TrueConvoIdentity
import XCTest

/// The Desk folder follows the running copy's identity: the real app keeps
/// `com.trueconvo.voice-cursor`, True Convo Test gets
/// `com.trueconvo.voice-cursor.test`, and neither ever touches the other's.
/// Every folder here is invented, inside a throwaway temp folder.
final class DeskPathsIdentityTests: XCTestCase {
    private var folder: DeskTestFolder!
    private let files = FileManager.default

    override func setUpWithError() throws { folder = try DeskTestFolder() }
    override func tearDownWithError() throws { folder.clean() }

    func testReleaseIdentityKeepsTodaysDeskFolder() {
        let support = folder.support
        let release = DeskPaths(applicationSupport: support, identity: .release)
        XCTAssertEqual(release, DeskPaths(applicationSupport: support), "the release identity is the default")
        XCTAssertEqual(release.appFolder, "com.trueconvo.voice-cursor")
        XCTAssertEqual(DeskPaths.appFolderName, "com.trueconvo.voice-cursor")
        XCTAssertEqual(release.base.path, support.path + "/com.trueconvo.voice-cursor/desk-invented-proof")
        XCTAssertEqual(release.base.path, folder.base.path)
        XCTAssertEqual(DeskPaths.standard(identity: .release)?.base.path.hasSuffix("/Library/Application Support/com.trueconvo.voice-cursor/desk-invented-proof"), true)
        // Unit tests are not the test copy, so the default stays the real path.
        XCTAssertEqual(DeskPaths.standard(), DeskPaths.standard(identity: .release))
    }

    func testTestIdentityHasItsOwnDeskFolder() {
        let support = folder.support
        let test = DeskPaths(applicationSupport: support, identity: .test)
        XCTAssertEqual(test.appFolder, "com.trueconvo.voice-cursor.test")
        XCTAssertEqual(test.base.path, support.path + "/com.trueconvo.voice-cursor.test/desk-invented-proof")
        XCTAssertNotEqual(test, DeskPaths(applicationSupport: support, identity: .release))
        XCTAssertEqual(DeskPaths.standard(identity: .test)?.base.path.hasSuffix("/Library/Application Support/com.trueconvo.voice-cursor.test/desk-invented-proof"), true)
        XCTAssertFalse(files.fileExists(atPath: support.path), "working out a path creates nothing")
    }

    func testTestCopyNeverReadsOrChangesTheRealDeskFolder() throws {
        // An invented "real" Desk folder with an older run and a canary.
        let real = DeskPaths(applicationSupport: folder.support, identity: .release)
        let realRun = try real.makeRunFolder(now: Date(timeIntervalSince1970: 1_800_000_000))
        try Data("INVENTED REAL CANARY\n".utf8).write(to: realRun.appendingPathComponent("state.json"))
        let realApp = folder.support.appendingPathComponent("com.trueconvo.voice-cursor", isDirectory: true)
        let before = try treeState(realApp)

        let test = DeskPaths(applicationSupport: folder.support, identity: .test)
        XCTAssertEqual(test.existingRunFolderNames(), [], "the real app's run folders are not the test copy's")
        try test.prepareBase()
        let testRun = try test.makeRunFolder(now: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertNoThrow(try test.validateRunFolder(testRun))
        XCTAssertTrue(testRun.path.contains("/com.trueconvo.voice-cursor.test/desk-invented-proof/run-"))
        XCTAssertEqual(test.existingRunFolderNames(), [testRun.lastPathComponent])
        XCTAssertThrowsError(try test.validateRunFolder(realRun), "a real run folder is not the test copy's")

        XCTAssertEqual(try treeState(realApp), before, "the real Desk folder keeps every byte and permission")
        XCTAssertEqual(real.existingRunFolderNames(), [realRun.lastPathComponent])
    }

    func testTestFolderLinkedToTheRealOneIsRefused() throws {
        // If the test copy's folder were a link to the real app's, it is
        // refused before anything is read, made or changed through it.
        let real = DeskPaths(applicationSupport: folder.support, identity: .release)
        try real.prepareBase()
        let realApp = folder.support.appendingPathComponent("com.trueconvo.voice-cursor", isDirectory: true)
        let before = try treeState(realApp)
        try files.createSymbolicLink(at: folder.support.appendingPathComponent("com.trueconvo.voice-cursor.test"), withDestinationURL: realApp)

        let test = DeskPaths(applicationSupport: folder.support, identity: .test)
        XCTAssertEqual(test.existingRunFolderNames(), [])
        XCTAssertThrowsError(try test.prepareBase()) { XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("app")) }
        XCTAssertThrowsError(try test.makeRunFolder()) { XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("app")) }
        XCTAssertEqual(try treeState(realApp), before)
    }
}
