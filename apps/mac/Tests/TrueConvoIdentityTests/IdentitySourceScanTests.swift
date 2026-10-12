import Foundation
import XCTest

/// The app target has no unit tests of its own, so these read its source to
/// check that every place that once spelled out the real app's settings
/// domain, Keychain service, archive folder or Desk folder now takes it from
/// `AppIdentity`. Reading source files only; nothing is run.
final class IdentitySourceScanTests: XCTestCase {
    private var sourcesRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // TrueConvoIdentityTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // true-convo-mac
            .appendingPathComponent("Sources", isDirectory: true)
    }

    /// Quoted literals that only `Sources/TrueConvoIdentity` may contain.
    private let identityLiterals = [
        "\"com.trueconvo.voice-cursor\"",
        "\"com.trueconvo.voice-cursor.test\"",
        "\".tca-dictate\"",
        "\".tca-dictate-test\"",
    ]

    /// Known, deliberate exceptions, each with its reason.
    private let allowed: [String: String] = [
        // The set of ids a saved fix may never target. It names the real id so
        // a fix never targets True Convo itself; the running copy's id (the
        // test copy's, in True Convo Test) is added at run time. Unchanged so
        // the real app behaves exactly as before.
        "CorrectionMemory/CorrectionLesson.swift": "\"com.trueconvo.voice-cursor\"",
    ]

    func testOnlyTheIdentityModuleSpellsOutTheIdentityNames() throws {
        let files = try swiftFiles()
        XCTAssertGreaterThan(files.count, 20, "the scan found the sources")
        var found: [String] = []
        let rootPath = sourcesRoot.resolvingSymlinksInPath().path + "/"
        for file in files {
            let path = file.resolvingSymlinksInPath().path
            XCTAssertTrue(path.hasPrefix(rootPath), path)
            let relative = String(path.dropFirst(rootPath.count))
            if relative.hasPrefix("TrueConvoIdentity/") { continue }
            let text = try String(contentsOf: file, encoding: .utf8)
            for literal in identityLiterals where text.contains(literal) {
                if allowed[relative] == literal { continue }
                found.append("\(relative): \(literal)")
            }
        }
        XCTAssertEqual(found, [], "these should read AppIdentity instead")
    }

    func testEachTouchpointReadsTheIdentity() throws {
        let checks: [(String, String)] = [
            ("VoiceCursorMac/main.swift", "UserDefaults(suiteName: AppIdentity.current.settingsDomain)"),
            ("VoiceCursorMac/main.swift", "private static let service = AppIdentity.current.keychainService"),
            ("VoiceCursorMac/main.swift", "AppIdentity.current.archiveRoot(home: FileManager.default.homeDirectoryForCurrentUser)"),
            ("VoiceCursorMac/main.swift", "DeskPaths.standard(identity: AppIdentity.current)"),
            ("VoiceCursorMac/main.swift", "guard AppIdentity.current.mayChangeSystemDefaultInput else {"),
            ("VoiceCursorMac/main.swift", "guard AppIdentity.current.mayRegisterLoginItem else {"),
            ("VoiceCursorMac/main.swift", "AppIdentity.current.shouldWarnRealAppStarted(before: lastRunningBundleIdentifiers, after: running)"),
            ("VoiceCursorMac/main.swift", "!AppIdentity.current.isOtherTrueConvoCopy(bundleIdentifier: application.bundleIdentifier)"),
            ("VoiceCursorMac/FirstRunChecklist.swift", "window.title = \"\\(AppIdentity.current.displayName) First Run\""),
            ("DeskWindowKit/DeskPaths.swift", "public static let appFolderName = AppIdentity.release.applicationSupportFolderName"),
            ("ParticipantProcess/ParticipantLog.swift", "Logger(subsystem: AppIdentity.current.logSubsystem"),
        ]
        for (file, expected) in checks {
            let text = try String(contentsOf: sourcesRoot.appendingPathComponent(file), encoding: .utf8)
            XCTAssertTrue(text.contains(expected), "\(file) should contain: \(expected)")
        }
    }

    func testTheLoginItemIsRegisteredOnlyBehindTheIdentityCheck() throws {
        let text = try String(contentsOf: sourcesRoot.appendingPathComponent("VoiceCursorMac/main.swift"), encoding: .utf8)
        // One place registers a login item, and it is the menu action that
        // refuses in the test copy before it gets there.
        XCTAssertEqual(text.components(separatedBy: "service.register()").count - 1, 1)
        let toggle = try XCTUnwrap(text.range(of: "@objc private func toggleOpenAtLogin() {"))
        let guardLine = try XCTUnwrap(text.range(of: "guard AppIdentity.current.mayRegisterLoginItem else {", range: toggle.upperBound..<text.endIndex))
        let register = try XCTUnwrap(text.range(of: "service.register()", range: toggle.upperBound..<text.endIndex))
        XCTAssertLessThan(guardLine.lowerBound, register.lowerBound)
        XCTAssertFalse(text.contains("SMAppService.loginItem"), "no helper login items")
    }

    /// The real app is menu-bar-only (`LSUIElement`), and macOS does not post
    /// the launch notification for such apps. So the test copy watches the
    /// running-app list itself, starting at launch, and never relies on that
    /// notification.
    func testTheRealAppIsWatchedThroughTheRunningAppList() throws {
        let text = try String(contentsOf: sourcesRoot.appendingPathComponent("VoiceCursorMac/main.swift"), encoding: .utf8)
        let watcher = try XCTUnwrap(text.range(of: "private func watchForRealAppIfTestCopy() {"))
        let body = String(text[watcher.upperBound...].prefix(800))
        XCTAssertTrue(body.contains("guard AppIdentity.current.isTest else { return }"))
        XCTAssertTrue(body.contains("checkWhetherRealAppStarted(trigger: \"launch\")"))
        XCTAssertTrue(body.contains("NSWorkspace.shared.observe(\\.runningApplications"))
        XCTAssertFalse(text.contains("NSWorkspace.didLaunchApplicationNotification"))
        XCTAssertTrue(text.contains("watchForRealAppIfTestCopy()\n    }"), "called at the end of applicationDidFinishLaunching")

        let data = try Data(contentsOf: sourcesRoot.deletingLastPathComponent().appendingPathComponent("Packaging/Info.plist"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        XCTAssertEqual(plist["LSUIElement"] as? Bool, true, "if this changes, the reason above no longer holds")
    }

    /// True Convo Test checks its archive folder first thing at launch
    /// (Codex review F1): it is the first top-level statement in main.swift,
    /// before the OpenAI smoke option and before the app delegate (whose
    /// launch sweeps temporary recordings and writes the run log) is made.
    /// The check returns at once in the real app, never writes the run log
    /// or uses `Archive`, and uses the same home folder as `Archive.root`.
    ///
    /// main.swift runs its top-level statements, and the starting values of
    /// its top-level `let` and `var`, in file order wherever they sit. So
    /// every line before the call that starts at the left edge must be a
    /// comment, a closing brace, an import, an attribute or a declaration of
    /// a type, extension or function. (main.swift has no multi-line string
    /// or block comment that could start a line at the left edge.)
    func testTheTestArchiveIsCheckedFirstAtLaunch() throws {
        let main = try String(contentsOf: sourcesRoot.appendingPathComponent("VoiceCursorMac/main.swift"), encoding: .utf8)
        let call = "TestArchiveLaunchCheck.quitIfTestArchiveIsNotItsOwn()"
        XCTAssertEqual(main.components(separatedBy: call).count - 1, 1, "called once")
        let callAt = try XCTUnwrap(main.range(of: "\n" + call + "\n"), "called at the top level")
        let smokeAt = try XCTUnwrap(main.range(of: "\nOpenAIRealtimeSmoke.runIfRequested()\n"))
        let delegateAt = try XCTUnwrap(main.range(of: "\nlet delegate = AppDelegate()\n"))
        XCTAssertLessThan(callAt.lowerBound, smokeAt.lowerBound)
        XCTAssertLessThan(callAt.lowerBound, delegateAt.lowerBound)
        // Nothing at the top level runs before the check.
        let declaration = try NSRegularExpression(pattern: #"\A(\}|//|/\*|import\s|#(if|elseif|else|endif)\b|(@\w+(\([^)]*\))?\s+)*((private|fileprivate|internal|public|open|final|indirect|nonisolated)\s+)*(class|struct|enum|extension|protocol|func|typealias|actor)\s|@\w+(\([^)]*\))?\s*\z)"#)
        var leftEdgeLines = 0
        for line in main[..<callAt.lowerBound].split(separator: "\n", omittingEmptySubsequences: true) {
            guard let first = line.first, !first.isWhitespace else { continue }
            leftEdgeLines += 1
            let text = String(line)
            XCTAssertNotNil(declaration.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), "runs before the check: \(line)")
        }
        XCTAssertGreaterThan(leftEdgeLines, 100, "the scan read main.swift's declarations")
        // The scan itself catches a statement or a stored value placed
        // between two declarations higher up in main.swift.
        for planted in ["Archive.sweepTemporaryAudio()", "let early = RunLog.self", "private var x = 1", "_ = Archive.root", "@MainActor let y = 2"] {
            XCTAssertNil(declaration.firstMatch(in: planted, range: NSRange(planted.startIndex..., in: planted)), planted)
        }
        // Archive.root, every archive path's start, uses the same home folder
        // as the check.
        XCTAssertTrue(main.contains("""
            static var root: URL {
                AppIdentity.current.archiveRoot(home: FileManager.default.homeDirectoryForCurrentUser)
            }
        """), "Archive.root is AppIdentity.current.archiveRoot(home: the user's home folder)")

        let check = try String(contentsOf: sourcesRoot.appendingPathComponent("VoiceCursorMac/TestArchiveLaunchCheck.swift"), encoding: .utf8)
        let function = try XCTUnwrap(check.range(of: "static func quitIfTestArchiveIsNotItsOwn() {\n"))
        XCTAssertTrue(check[function.upperBound...].hasPrefix("        guard AppIdentity.current.isTest else { return }\n"),
                      "the real app returns before anything else")
        XCTAssertTrue(check.contains("TestArchiveBoundary.check(identity: AppIdentity.current, home: FileManager.default.homeDirectoryForCurrentUser)"))
        XCTAssertTrue(check.contains("guard case .refused(let refusal) = verdict else { return }"))
        XCTAssertTrue(check.contains("exit(EXIT_FAILURE)"))
        let code = check.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
        for pattern in ["\\bRunLog\\b", "\\bArchive\\.", "\\bAppDelegate\\b", "\\bSettings\\."] {
            XCTAssertNil(code.range(of: pattern, options: .regularExpression), "the refusal never uses \(pattern)")
        }
    }

    /// `DeskPaths.appFolderName` is always the real app's folder name. Code
    /// that runs in True Convo Test must use a `DeskPaths` value's
    /// `appFolder`, so the static name is declared and never used in Sources.
    func testTheRealAppsDeskFolderNameIsNeverUsedInTheApp() throws {
        var uses: [String] = []
        let rootPath = sourcesRoot.resolvingSymlinksInPath().path + "/"
        for file in try swiftFiles() {
            let text = try String(contentsOf: file, encoding: .utf8)
            let count = text.components(separatedBy: "appFolderName").count - 1
            if count > 0 {
                uses.append("\(String(file.resolvingSymlinksInPath().path.dropFirst(rootPath.count))): \(count)")
            }
        }
        XCTAssertEqual(uses, ["DeskWindowKit/DeskPaths.swift: 1"], "only its declaration")
    }

    private func swiftFiles() throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(at: sourcesRoot, includingPropertiesForKeys: nil) else { return [] }
        return enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }
}
