import Foundation
import TrueConvoIdentity
import XCTest

/// Which copy is running and the names that follow from it. Only the exact
/// bundle id `com.trueconvo.voice-cursor.test` selects True Convo Test; every
/// other id, and none, keeps the release names byte for byte. Nothing here
/// reads or writes a real setting, Keychain item or folder: paths are made
/// from invented folders and never touched.
final class AppIdentityTests: XCTestCase {
    private let inventedHome = URL(fileURLWithPath: "/invented/home", isDirectory: true)
    private let inventedSupport = URL(fileURLWithPath: "/invented/home/Library/Application Support", isDirectory: true)

    func testOnlyTheExactTestBundleIdSelectsTheTestCopy() {
        XCTAssertEqual(AppIdentity.resolve(bundleIdentifier: "com.trueconvo.voice-cursor.test"), .test)
        XCTAssertEqual(AppIdentity.resolve(bundleIdentifier: AppIdentity.testBundleIdentifier).kind, .test)
        XCTAssertTrue(AppIdentity.test.isTest)
        XCTAssertFalse(AppIdentity.release.isTest)
    }

    func testReleaseUnbundledAndEveryOtherBundleIdKeepTheReleaseIdentity() {
        let others: [String?] = [
            "com.trueconvo.voice-cursor",          // the real app
            nil,                                   // swift run, unbundled tools
            "",
            "com.apple.dt.xctest.tool",            // unit tests
            "com.trueconvo.mac",                   // the planned future id
            "com.trueconvo.voice-cursor.tes",
            "com.trueconvo.voice-cursor.testing",
            "com.trueconvo.voice-cursor.test.extra",
            " com.trueconvo.voice-cursor.test",
            "com.trueconvo.voice-cursor.test ",
            "COM.TRUECONVO.VOICE-CURSOR.TEST",
            "com.trueconvo.voice-cursor-test",
            "True Convo Test",
        ]
        for id in others {
            XCTAssertEqual(AppIdentity.resolve(bundleIdentifier: id), .release, "\(String(describing: id))")
        }
    }

    func testUnitTestsRunAsTheReleaseIdentity() {
        // xctest is not the test copy, so code under test keeps today's names.
        XCTAssertNotEqual(Bundle.main.bundleIdentifier, AppIdentity.testBundleIdentifier)
        XCTAssertEqual(AppIdentity.current, .release)
    }

    func testReleaseValuesAreExactlyTheOnesUsedBefore() {
        let release = AppIdentity.release
        XCTAssertEqual(release.kind, .release)
        XCTAssertEqual(release.bundleIdentifier, "com.trueconvo.voice-cursor")
        XCTAssertEqual(release.displayName, "True Convo")
        XCTAssertEqual(release.executableName, "True Convo")
        XCTAssertEqual(release.appBundleName, "True Convo.app")
        XCTAssertEqual(release.settingsDomain, "com.trueconvo.voice-cursor")
        XCTAssertEqual(release.keychainService, "com.trueconvo.voice-cursor")
        XCTAssertEqual(release.archiveFolderName, ".tca-dictate")
        XCTAssertEqual(release.archiveRoot(home: inventedHome).path, "/invented/home/.tca-dictate")
        XCTAssertEqual(release.applicationSupportFolderName, "com.trueconvo.voice-cursor")
        XCTAssertEqual(release.applicationSupportFolder(in: inventedSupport).path,
                       "/invented/home/Library/Application Support/com.trueconvo.voice-cursor")
        XCTAssertEqual(release.logSubsystem, "com.trueconvo.voice-cursor")
        XCTAssertEqual(release.servicesMenuItemTitle, "Correct With True Convo")
        XCTAssertEqual(release.servicesPortName, "True Convo")
        XCTAssertTrue(release.mayRegisterLoginItem, "the real app still offers Open at Login")
        XCTAssertTrue(release.mayChangeSystemDefaultInput, "the real app still applies a picked input")
    }

    func testTestValuesAreItsOwn() {
        let test = AppIdentity.test
        XCTAssertEqual(test.kind, .test)
        XCTAssertEqual(test.bundleIdentifier, "com.trueconvo.voice-cursor.test")
        XCTAssertEqual(test.displayName, "True Convo Test")
        XCTAssertEqual(test.executableName, "True Convo Test")
        XCTAssertEqual(test.appBundleName, "True Convo Test.app")
        XCTAssertEqual(test.settingsDomain, "com.trueconvo.voice-cursor.test")
        XCTAssertEqual(test.keychainService, "com.trueconvo.voice-cursor.test")
        XCTAssertEqual(test.archiveFolderName, ".tca-dictate-test")
        XCTAssertEqual(test.archiveRoot(home: inventedHome).path, "/invented/home/.tca-dictate-test")
        XCTAssertEqual(test.applicationSupportFolderName, "com.trueconvo.voice-cursor.test")
        XCTAssertEqual(test.applicationSupportFolder(in: inventedSupport).path,
                       "/invented/home/Library/Application Support/com.trueconvo.voice-cursor.test")
        XCTAssertEqual(test.logSubsystem, "com.trueconvo.voice-cursor.test")
        XCTAssertEqual(test.servicesMenuItemTitle, "Correct With True Convo Test")
        XCTAssertEqual(test.servicesPortName, "True Convo Test")
        XCTAssertFalse(test.mayRegisterLoginItem, "the test copy never adds a login item")
        XCTAssertFalse(test.mayChangeSystemDefaultInput, "the test copy never changes the Mac's microphone")
        // The program name stays under the 16-character limit that exact
        // process-name matching (pgrep -x, Activity Monitor) relies on.
        XCTAssertLessThan(test.executableName.utf8.count, 16)
    }

    func testNoTestValueSharesAPlaceWithTheRealApp() {
        let release = AppIdentity.release
        let test = AppIdentity.test
        let pairs: [(String, String, String)] = [
            ("bundle id", release.bundleIdentifier, test.bundleIdentifier),
            ("display name", release.displayName, test.displayName),
            ("program name", release.executableName, test.executableName),
            ("settings domain", release.settingsDomain, test.settingsDomain),
            ("Keychain service", release.keychainService, test.keychainService),
            ("archive folder", release.archiveFolderName, test.archiveFolderName),
            ("Application Support folder", release.applicationSupportFolderName, test.applicationSupportFolderName),
            ("log subsystem", release.logSubsystem, test.logSubsystem),
            ("Services menu item", release.servicesMenuItemTitle, test.servicesMenuItemTitle),
            ("Services port", release.servicesPortName, test.servicesPortName),
        ]
        for (label, real, testValue) in pairs {
            XCTAssertNotEqual(real, testValue, label)
        }
        // Neither archive folder sits inside the other.
        let realArchive = release.archiveRoot(home: inventedHome).path + "/"
        let testArchive = test.archiveRoot(home: inventedHome).path + "/"
        XCTAssertFalse(testArchive.hasPrefix(realArchive))
        XCTAssertFalse(realArchive.hasPrefix(testArchive))
    }

    // MARK: The "True Convo is running" warning, decided without launching anything

    func testTheRealAppNeverWarns() {
        let release = AppIdentity.release
        XCTAssertFalse(release.shouldWarnRealAppIsRunning(runningBundleIdentifiers: ["com.trueconvo.voice-cursor"]))
        XCTAssertFalse(release.shouldWarnRealAppIsRunning(runningBundleIdentifiers: ["com.trueconvo.voice-cursor.test", "com.trueconvo.voice-cursor"]))
        XCTAssertFalse(release.shouldWarnRealAppStarted(before: [], after: ["com.trueconvo.voice-cursor"]))
        XCTAssertFalse(release.shouldWarnRealAppStarted(before: [], after: ["com.trueconvo.voice-cursor.test"]))
        XCTAssertFalse(release.shouldWarnRealAppStarted(before: ["com.apple.finder"], after: ["com.apple.finder", "com.trueconvo.voice-cursor"]))
    }

    func testTheTestCopyWarnsOnlyWhenTheRealAppRuns() {
        let test = AppIdentity.test
        XCTAssertTrue(test.shouldWarnRealAppIsRunning(runningBundleIdentifiers: [
            "com.apple.finder", nil, "com.trueconvo.voice-cursor.test", "com.trueconvo.voice-cursor",
        ]))
        XCTAssertFalse(test.shouldWarnRealAppIsRunning(runningBundleIdentifiers: []))
        XCTAssertFalse(test.shouldWarnRealAppIsRunning(runningBundleIdentifiers: [
            "com.apple.finder", nil, "com.trueconvo.voice-cursor.test", "com.trueconvo.mac", "com.trueconvo.voice-cursor.other",
        ]), "itself, unbundled programs and other ids are no reason to warn")
    }

    /// The running-app list over time, as the test copy sees it (bundle ids
    /// only). The real app is warned about once each time it starts: when it
    /// is already open at launch, and when it appears later, not again while
    /// it stays open, and again after it is quit and opened again.
    func testTheTestCopyWarnsOncePerStartOfTheRealApp() {
        let test = AppIdentity.test
        let others: [String?] = ["com.apple.finder", nil, "com.trueconvo.voice-cursor.test"]
        let withReal = others + ["com.trueconvo.voice-cursor"]
        let timeline: [([String?], Bool, String)] = [
            (others, false, "launch, real app closed"),
            (others + ["com.apple.TextEdit"], false, "another app starts"),
            (withReal + ["com.apple.TextEdit"], true, "the real app starts"),
            (withReal, false, "it stays open while TextEdit quits"),
            (withReal + ["com.apple.Safari"], false, "it stays open while another app starts"),
            (others, false, "it quits"),
            (withReal, true, "it is opened again"),
        ]
        var seen: [String?] = []
        for (running, expected, step) in timeline {
            XCTAssertEqual(test.shouldWarnRealAppStarted(before: seen, after: running), expected, step)
            seen = running
        }
        XCTAssertTrue(test.shouldWarnRealAppStarted(before: [], after: withReal), "already open at launch")
        XCTAssertFalse(test.shouldWarnRealAppStarted(before: [], after: others), "not open at launch")
        XCTAssertFalse(test.shouldWarnRealAppStarted(before: [], after: others + ["com.trueconvo.mac", "com.trueconvo.voice-cursor.other"]))
    }

    func testOnlyTheTestCopySkipsTheRealAppAsAPasteTarget() {
        XCTAssertTrue(AppIdentity.test.isOtherTrueConvoCopy(bundleIdentifier: "com.trueconvo.voice-cursor"))
        for id: String? in [nil, "", "com.trueconvo.voice-cursor.test", "com.apple.TextEdit", "com.trueconvo.mac", "COM.TRUECONVO.VOICE-CURSOR"] {
            XCTAssertFalse(AppIdentity.test.isOtherTrueConvoCopy(bundleIdentifier: id), "\(String(describing: id))")
        }
        // The real app's choice of target is unchanged: nothing extra is skipped.
        for id: String? in [nil, "", "com.trueconvo.voice-cursor", "com.trueconvo.voice-cursor.test", "com.apple.TextEdit"] {
            XCTAssertFalse(AppIdentity.release.isOtherTrueConvoCopy(bundleIdentifier: id), "\(String(describing: id))")
        }
    }

    func testTheWarningOnlyAsksAndPromisesNothingIsDoneToTheRealApp() {
        let text = RealAppRunningWarning.title + "\n" + RealAppRunningWarning.message
        XCTAssertTrue(text.contains("Quit True Convo from its menu bar icon"))
        XCTAssertTrue(text.contains("not the one marked \"Test\""))
        XCTAssertTrue(text.contains("same dictation shortcut"))
        XCTAssertTrue(text.contains("never"))
        XCTAssertEqual(RealAppRunningWarning.okButton, "OK", "one button: the warning offers no action on the real app")
    }

    // MARK: The packaging files say the same names

    private var packageRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // TrueConvoIdentityTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // true-convo-mac
    }

    func testReleaseInfoPlistMatchesTheReleaseIdentity() throws {
        let data = try Data(contentsOf: packageRoot.appendingPathComponent("Packaging/Info.plist"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let release = AppIdentity.release
        XCTAssertEqual(plist["CFBundleIdentifier"] as? String, release.bundleIdentifier)
        XCTAssertEqual(plist["CFBundleName"] as? String, release.displayName)
        XCTAssertEqual(plist["CFBundleDisplayName"] as? String, release.displayName)
        XCTAssertEqual(plist["CFBundleExecutable"] as? String, release.executableName)
        let service = try XCTUnwrap((plist["NSServices"] as? [[String: Any]])?.first)
        XCTAssertEqual((service["NSMenuItem"] as? [String: String])?["default"], release.servicesMenuItemTitle)
        XCTAssertEqual(service["NSPortName"] as? String, release.servicesPortName)
    }

    func testPackagingScriptsTestOptionUsesTheTestIdentity() throws {
        let script = try String(contentsOf: packageRoot.appendingPathComponent("scripts/package_app.sh"), encoding: .utf8)
        let test = AppIdentity.test
        for line in [
            "TEST_APP_NAME=\"\(test.displayName)\"",
            "TEST_EXECUTABLE_NAME=\"\(test.executableName)\"",
            "TEST_BUNDLE_ID=\"\(test.bundleIdentifier)\"",
            "TEST_SERVICES_MENU_ITEM=\"\(test.servicesMenuItemTitle)\"",
            "TEST_SERVICES_PORT_NAME=\"\(test.servicesPortName)\"",
        ] {
            XCTAssertTrue(script.contains("\n\(line)\n"), "package_app.sh should set \(line)")
        }
    }
}
