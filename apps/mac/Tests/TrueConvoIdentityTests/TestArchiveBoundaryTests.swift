import Darwin
import Foundation
@testable import TrueConvoIdentity
import VoiceCursorCore
import XCTest

/// True Convo Test refuses an archive folder that is not its own before it
/// uses it (Codex review F1). Every folder here is invented, inside a fresh
/// folder under the temporary folder: an invented home holding an invented
/// "real" archive (`.tca-dictate`, with a canary file and a recognized
/// temporary recording) and the test copy's `.tca-dictate-test`. Nothing
/// outside that folder is read, written or linked to, and the real home,
/// archive, settings and keys are never touched.
///
/// The temporary folder is reached through macOS's `/var` link to
/// `/private/var`, so every case also runs through a legitimate system link
/// above the home folder.
final class TestArchiveBoundaryTests: XCTestCase {
    private var sandbox: URL!
    private var home: URL!
    private var testRoot: URL { home.appendingPathComponent(".tca-dictate-test", isDirectory: true) }
    private var realRoot: URL { home.appendingPathComponent(".tca-dictate", isDirectory: true) }

    private let temporaryRecording = "temporary-recordings/voice-cursor-1700000000.wav"

    override func setUpWithError() throws {
        sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("true-convo-archive-boundary-\(UUID().uuidString)", isDirectory: true)
        home = sandbox.appendingPathComponent("invented-home", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        guard let sandbox else { return }
        // Make folders a case closed to reading removable again, then remove
        // only the invented sandbox (removing a link never touches its target).
        if let enumerator = FileManager.default.enumerator(atPath: sandbox.path) {
            for case let relative as String in enumerator {
                let path = sandbox.path + "/" + relative
                var info = stat()
                if lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR { chmod(path, 0o700) }
            }
        }
        try? FileManager.default.removeItem(at: sandbox)
    }

    // MARK: The finding: a test folder that is a link to the real archive

    func testALinkedTestFolderIsRefusedAndTheRealArchiveKeepsEveryByte() throws {
        for (label, destination) in [("absolute link", realRoot.path), ("relative link", ".tca-dictate")] {
            try makeInventedRealArchive()
            try FileManager.default.createSymbolicLink(atPath: testRoot.path, withDestinationPath: destination)
            let before = snapshot(home)

            let verdict = try launch()

            XCTAssertEqual(verdict, refusal(.symbolicLink, ".tca-dictate-test"), label)
            XCTAssertEqual(snapshot(home), before, "\(label): nothing in the invented home changed, the link included")
            XCTAssertEqual(try String(contentsOf: realRoot.appendingPathComponent("INVENTED-CANARY.txt"), encoding: .utf8), "INVENTED CANARY\n", label)
            XCTAssertTrue(FileManager.default.fileExists(atPath: realRoot.appendingPathComponent(temporaryRecording).path),
                          "\(label): the real temporary recording is still there")
            try reset()
        }
    }

    /// The same launch without the check reaches the invented real archive,
    /// so the case above passes only because of the check.
    func testWithoutTheCheckTheSameLaunchWouldDeleteTheRealRecording() throws {
        try makeInventedRealArchive()
        try FileManager.default.createSymbolicLink(atPath: testRoot.path, withDestinationPath: realRoot.path)

        try launch(skipCheck: true)

        XCTAssertFalse(FileManager.default.fileExists(atPath: realRoot.appendingPathComponent(temporaryRecording).path),
                       "the launch sweep followed the link and deleted the invented real recording")
        XCTAssertTrue(try String(contentsOf: realRoot.appendingPathComponent("voice-cursor.log"), encoding: .utf8)
            .hasSuffix("invented launch line\n"), "and wrote its log line into the invented real log")
    }

    func testABrokenLinkIsRefusedAndNothingIsMadeAtItsTarget() throws {
        let nowhere = sandbox.appendingPathComponent("invented-nowhere", isDirectory: true)
        try FileManager.default.createSymbolicLink(atPath: testRoot.path, withDestinationPath: nowhere.path)
        let before = snapshot(sandbox)

        XCTAssertEqual(try launch(), refusal(.symbolicLink, ".tca-dictate-test"))
        XCTAssertEqual(snapshot(sandbox), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: nowhere.path))
    }

    // MARK: Linked or aliased things inside the test folder

    func testALinkedChildIsRefusedAndItsTargetKeepsEveryByte() throws {
        let children = ["temporary-recordings", "recordings", "transcripts", "corrections", "voice-cursor.log", "history.jsonl"]
        for child in children {
            try makeInventedRealArchive()
            try FileManager.default.createDirectory(at: testRoot, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: realRoot.appendingPathComponent("transcripts"), withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(atPath: testRoot.appendingPathComponent(child).path,
                                                       withDestinationPath: realRoot.appendingPathComponent(child).path)
            let before = snapshot(home)

            XCTAssertEqual(try launch(), refusal(.symbolicLink, ".tca-dictate-test/\(child)"), child)
            XCTAssertEqual(snapshot(home), before, child)
            XCTAssertTrue(FileManager.default.fileExists(atPath: realRoot.appendingPathComponent(temporaryRecording).path), child)
            try reset()
        }
    }

    func testALinkDeeperInsideIsRefused() throws {
        for (folder, name) in [("corrections", "correction-pairs.jsonl"), ("recordings", "voice-cursor-1600000000.wav")] {
            try makeInventedRealArchive()
            try FileManager.default.createDirectory(at: testRoot.appendingPathComponent(folder), withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(atPath: testRoot.appendingPathComponent("\(folder)/\(name)").path,
                                                       withDestinationPath: realRoot.appendingPathComponent("\(folder)/\(name)").path)
            let before = snapshot(home)

            XCTAssertEqual(try launch(), refusal(.symbolicLink, ".tca-dictate-test/\(folder)/\(name)"))
            XCTAssertEqual(snapshot(home), before)
            try reset()
        }
    }

    func testAFinderAliasIsRefused() throws {
        // The test folder itself is an alias of the real archive.
        try makeInventedRealArchive()
        try writeFinderAlias(at: testRoot, to: realRoot)
        var before = snapshot(home)
        XCTAssertEqual(try launch(), refusal(.finderAlias, ".tca-dictate-test"))
        XCTAssertEqual(snapshot(home), before)
        try reset()

        // A folder inside it is an alias of the real one.
        try makeInventedRealArchive()
        try FileManager.default.createDirectory(at: testRoot, withIntermediateDirectories: true)
        try writeFinderAlias(at: testRoot.appendingPathComponent("temporary-recordings"),
                             to: realRoot.appendingPathComponent("temporary-recordings"))
        before = snapshot(home)
        XCTAssertEqual(try launch(), refusal(.finderAlias, ".tca-dictate-test/temporary-recordings"))
        XCTAssertEqual(snapshot(home), before)
    }

    func testAFileSharedWithTheRealArchiveIsRefused() throws {
        try makeInventedRealArchive()
        try FileManager.default.createDirectory(at: testRoot, withIntermediateDirectories: true)
        XCTAssertEqual(link(realRoot.appendingPathComponent("history.jsonl").path, testRoot.appendingPathComponent("history.jsonl").path), 0)
        let before = snapshot(home)

        XCTAssertEqual(try launch(), refusal(.sharedFile, ".tca-dictate-test/history.jsonl"))
        XCTAssertEqual(snapshot(home), before)
    }

    func testSomethingOtherThanPlainFilesAndFoldersIsRefused() throws {
        // The test folder is a plain file.
        try write("invented\n", to: testRoot)
        var before = snapshot(home)
        XCTAssertEqual(try launch(), refusal(.notPlain, ".tca-dictate-test"))
        XCTAssertEqual(snapshot(home), before)
        try reset()

        // A named pipe inside it. (Not at a name the launch opens: a pipe
        // there would make a launch without the check wait forever.)
        try FileManager.default.createDirectory(at: testRoot.appendingPathComponent("transcripts"), withIntermediateDirectories: true)
        XCTAssertEqual(mkfifo(testRoot.appendingPathComponent("transcripts/invented-pipe").path, 0o600), 0)
        before = snapshot(home)
        XCTAssertEqual(try launch(), refusal(.notPlain, ".tca-dictate-test/transcripts/invented-pipe"))
        XCTAssertEqual(snapshot(home), before)
    }

    /// A disk, disk image or network share mounted at the test folder or
    /// inside it looks like a plain folder at the same path; only its disk
    /// (device number) differs. Mounting a real disk is not something a unit
    /// test should do, so the check is given `lstat` with that one item's
    /// device number changed, everything else read from the invented folders.
    func testSomethingMountedAtOrInsideTheFolderIsRefused() throws {
        let mountedItems = [
            ".tca-dictate-test",
            ".tca-dictate-test/temporary-recordings",
            ".tca-dictate-test/corrections",
            ".tca-dictate-test/recordings/voice-cursor-1.wav",
        ]
        for mounted in mountedItems {
            try makeInventedRealArchive()
            try write("INVENTED TEST RIFF\n", to: testRoot.appendingPathComponent(temporaryRecording))
            try write("{}\n", to: testRoot.appendingPathComponent("corrections/correction-pairs.jsonl"))
            try write("INVENTED KEPT RIFF\n", to: testRoot.appendingPathComponent("recordings/voice-cursor-1.wav"))
            let mountedPath = home.path + "/" + mounted
            var seen = false
            let onAnotherDisk: (String, inout stat) -> Int32 = { path, info in
                let result = lstat(path, &info)
                if path == mountedPath {
                    seen = true
                    info.st_dev = info.st_dev &+ 1
                }
                return result
            }
            let before = snapshot(home)

            XCTAssertEqual(try launch(lstatAt: onAnotherDisk), refusal(.outsideFolder, mounted), mounted)
            XCTAssertTrue(seen, "\(mounted) was looked at")
            XCTAssertEqual(snapshot(home), before, "\(mounted): nothing changed, the test copy's own recording included")
            XCTAssertEqual(TestArchiveBoundary.check(identity: .test, home: home, lstatAt: { lstat($0, &$1) }), .ownFolder,
                           "\(mounted): the same folders on one disk are the test copy's own")
            try reset()
        }
    }

    func testAFolderThatCannotBeReadIsRefused() throws {
        try XCTSkipIf(getuid() == 0, "root can read any folder")
        try FileManager.default.createDirectory(at: testRoot.appendingPathComponent("transcripts"), withIntermediateDirectories: true)
        XCTAssertEqual(chmod(testRoot.appendingPathComponent("transcripts").path, 0o000), 0)
        let before = snapshot(home)

        XCTAssertEqual(try launch(), refusal(.cannotCheck, ".tca-dictate-test/transcripts"))
        XCTAssertEqual(snapshot(home), before)
    }

    // MARK: Normal test folders still work

    func testAMissingTestFolderIsMadeAsAPlainFolderOfItsOwn() throws {
        try makeInventedRealArchive()
        let realBefore = snapshot(realRoot)

        XCTAssertEqual(try launch(), .ownFolder)

        var info = stat()
        XCTAssertEqual(lstat(testRoot.path, &info), 0)
        XCTAssertEqual(info.st_mode & S_IFMT, S_IFDIR, "a plain folder, not a link")
        XCTAssertEqual(snapshot(realRoot), realBefore, "the invented real archive keeps every byte")
        XCTAssertEqual(TestArchiveBoundary.check(identity: .test, home: home), .ownFolder, "and it passes at the next launch")
    }

    func testAnIndependentTestArchiveWorksAndItsOwnSweepStillRuns() throws {
        try makeInventedRealArchive()
        try write("INVENTED TEST RIFF\n", to: testRoot.appendingPathComponent(temporaryRecording))
        try write("invented test log\n", to: testRoot.appendingPathComponent("voice-cursor.log"))
        try write("{}\n", to: testRoot.appendingPathComponent("history.jsonl"))
        try write("{}\n", to: testRoot.appendingPathComponent("corrections/correction-pairs.jsonl"))
        try write("INVENTED KEPT RIFF\n", to: testRoot.appendingPathComponent("recordings/voice-cursor-1.wav"))
        try write("invented Finder file\n", to: testRoot.appendingPathComponent("recordings/.DS_Store"))
        let realBefore = snapshot(realRoot)

        XCTAssertEqual(try launch(), .ownFolder)

        XCTAssertFalse(FileManager.default.fileExists(atPath: testRoot.appendingPathComponent(temporaryRecording).path),
                       "the test copy's own leftover temporary recording is swept as before")
        XCTAssertTrue(FileManager.default.fileExists(atPath: testRoot.appendingPathComponent("recordings/voice-cursor-1.wav").path))
        XCTAssertEqual(try String(contentsOf: testRoot.appendingPathComponent("voice-cursor.log"), encoding: .utf8),
                       "invented test log\ninvented launch line\n")
        XCTAssertEqual(snapshot(realRoot), realBefore, "the invented real archive keeps every byte")
    }

    func testMacOSLinksAboveTheHomeFolderAreFine() throws {
        try write("{}\n", to: testRoot.appendingPathComponent("history.jsonl"))

        // macOS keeps temporary folders under /private and reaches them
        // through its /var (or /tmp) link. The home folder given in either
        // form, or resolved, is the same folder.
        let resolvedHome = try XCTUnwrap(realPath(home.path))
        XCTAssertTrue(resolvedHome.hasPrefix("/private/"), resolvedHome)
        let systemLinkForm = String(resolvedHome.dropFirst("/private".count))
        XCTAssertNotEqual(systemLinkForm, resolvedHome)
        XCTAssertEqual(realPath(systemLinkForm), resolvedHome, "\(systemLinkForm) is a system link form of the home folder")
        for form in [home.path, resolvedHome, systemLinkForm] {
            XCTAssertEqual(TestArchiveBoundary.check(identity: .test, home: URL(fileURLWithPath: form, isDirectory: true)), .ownFolder, form)
        }

        // A home folder reached through a link of its own.
        let homeLink = sandbox.appendingPathComponent("invented-home-link")
        try FileManager.default.createSymbolicLink(atPath: homeLink.path, withDestinationPath: home.path)
        XCTAssertEqual(TestArchiveBoundary.check(identity: .test, home: homeLink), .ownFolder)

        // A link at the test folder is still refused through that home link.
        try FileManager.default.removeItem(at: testRoot)
        try makeInventedRealArchive()
        try FileManager.default.createSymbolicLink(atPath: testRoot.path, withDestinationPath: realRoot.path)
        XCTAssertEqual(TestArchiveBoundary.check(identity: .test, home: homeLink), refusal(.symbolicLink, ".tca-dictate-test"))
    }

    // MARK: The real app is never checked

    func testTheRealAppIsNeverChecked() throws {
        try makeInventedRealArchive()
        try FileManager.default.createSymbolicLink(atPath: testRoot.path, withDestinationPath: realRoot.path)
        // The real app's own folder a link too: the real app follows it, as before.
        let movedReal = sandbox.appendingPathComponent("invented-moved-real", isDirectory: true)
        try FileManager.default.moveItem(at: realRoot, to: movedReal)
        try FileManager.default.createSymbolicLink(atPath: realRoot.path, withDestinationPath: movedReal.path)
        let before = snapshot(sandbox)

        let releaseLike: [AppIdentity] = [
            .release,
            AppIdentity.resolve(bundleIdentifier: nil),
            AppIdentity.resolve(bundleIdentifier: "com.trueconvo.voice-cursor"),
            AppIdentity.current,  // unit tests run as the release identity
        ]
        for identity in releaseLike {
            XCTAssertEqual(TestArchiveBoundary.check(identity: identity, home: home), .notChecked)
            // Not even a missing home folder changes that.
            XCTAssertEqual(TestArchiveBoundary.check(identity: identity, home: sandbox.appendingPathComponent("no-such-home")), .notChecked)
        }
        XCTAssertEqual(snapshot(sandbox), before)
        XCTAssertEqual(TestArchiveBoundary.check(identity: .test, home: home), refusal(.symbolicLink, ".tca-dictate-test"),
                       "the same folders are refused for the test copy")
    }

    // MARK: What the owner sees

    func testTheRefusalNamesTheFolderAndSaysTheAppWillQuit() {
        XCTAssertEqual(TestArchiveRefusalMessage.title, "True Convo Test can't use its folder")
        XCTAssertEqual(TestArchiveRefusalMessage.quitButton, "Quit True Convo Test")
        let refused = TestArchiveBoundary.Refusal(problem: .symbolicLink, relativePath: ".tca-dictate-test/temporary-recordings")
        XCTAssertEqual(refused.displayPath, "~/.tca-dictate-test/temporary-recordings")
        let message = TestArchiveRefusalMessage.message(for: refused)
        for words in [
            "True Convo Test keeps its own files in ~/.tca-dictate-test",
            "~/.tca-dictate-test/temporary-recordings is a link to another place.",
            "True Convo Test changed nothing, and it will quit now.",
            "Your real True Convo was not touched.",
            "Ask for help before you move or delete anything in ~/.tca-dictate-test.",
        ] {
            XCTAssertTrue(message.contains(words), words)
        }
        var seen = Set<String>()
        for problem in TestArchiveBoundary.Problem.allCases {
            let text = TestArchiveRefusalMessage.message(for: .init(problem: problem, relativePath: ".tca-dictate-test"))
            XCTAssertTrue(text.contains("~/.tca-dictate-test "), problem.rawValue)
            XCTAssertTrue(seen.insert(text).inserted, "\(problem.rawValue) has its own words")
        }
    }

    // MARK: Helpers

    private func refusal(_ problem: TestArchiveBoundary.Problem, _ relativePath: String) -> TestArchiveBoundary.Verdict {
        .refused(.init(problem: problem, relativePath: relativePath))
    }

    /// What the test copy does at launch, in its order: the check first and,
    /// only if it passes, the launch sweep of temporary recordings (the real
    /// `TemporaryAudioStore`, as `Archive.sweepTemporaryAudio` uses it), a
    /// run-log line (as `RunLog.write`) and the archive folders (as
    /// `Archive.ensureDirectories`). `skipCheck` leaves the check out;
    /// `lstatAt` stands in for `lstat` inside the check.
    @discardableResult
    private func launch(skipCheck: Bool = false, lstatAt: ((String, inout stat) -> Int32)? = nil) throws -> TestArchiveBoundary.Verdict {
        let verdict: TestArchiveBoundary.Verdict
        if skipCheck {
            verdict = .ownFolder
        } else if let lstatAt {
            verdict = TestArchiveBoundary.check(identity: .test, home: home, lstatAt: lstatAt)
        } else {
            verdict = TestArchiveBoundary.check(identity: .test, home: home)
        }
        if case .refused = verdict { return verdict }
        let root = AppIdentity.test.archiveRoot(home: home)
        try TemporaryAudioStore(directory: root.appendingPathComponent("temporary-recordings")).sweep()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let log = root.appendingPathComponent("voice-cursor.log")
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: log)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("invented launch line\n".utf8))
        for folder in ["recordings", "transcripts", "packets", "diagnostics", "provider-comparisons", "harvest-bundles", "corrections"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        return verdict
    }

    /// An invented "real" archive: a canary, a recognized temporary recording,
    /// a retained recording, a run log, history and saved fixes.
    private func makeInventedRealArchive() throws {
        try write("INVENTED CANARY\n", to: realRoot.appendingPathComponent("INVENTED-CANARY.txt"))
        try write("INVENTED REAL RIFF\n", to: realRoot.appendingPathComponent(temporaryRecording))
        try write("INVENTED RETAINED RIFF\n", to: realRoot.appendingPathComponent("recordings/voice-cursor-1600000000.wav"))
        try write("invented real log\n", to: realRoot.appendingPathComponent("voice-cursor.log"))
        try write("{\"invented\":true}\n", to: realRoot.appendingPathComponent("history.jsonl"))
        try write("{\"invented\":true}\n", to: realRoot.appendingPathComponent("corrections/correction-pairs.jsonl"))
    }

    /// Empties the invented home for the next round of a looping case.
    private func reset() throws {
        try FileManager.default.removeItem(at: home)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    }

    private func write(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    private func writeFinderAlias(at alias: URL, to target: URL) throws {
        let bookmark = try target.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
        try URL.writeBookmarkData(bookmark, to: alias)
        let values = try alias.resourceValues(forKeys: [.isAliasFileKey, .isSymbolicLinkKey])
        XCTAssertEqual(values.isAliasFile, true, "the invented alias is a Finder alias")
        XCTAssertEqual(values.isSymbolicLink, false)
    }

    private func realPath(_ path: String) -> String? {
        guard let resolved = Darwin.realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Every entry below `url`: kind and mode, link count, inode, size, link
    /// destination and file contents. Never follows a link.
    private func snapshot(_ url: URL) -> [String] {
        var lines: [String] = []
        func visit(_ path: String, _ relative: String) {
            var info = stat()
            guard lstat(path, &info) == 0 else {
                lines.append("\(relative) absent")
                return
            }
            var line = "\(relative) mode=\(String(info.st_mode, radix: 8)) links=\(info.st_nlink) inode=\(info.st_ino) size=\(info.st_size)"
            switch info.st_mode & S_IFMT {
            case S_IFLNK:
                line += " -> " + ((try? FileManager.default.destinationOfSymbolicLink(atPath: path)) ?? "?")
            case S_IFREG:
                line += " bytes=" + (FileManager.default.contents(atPath: path)?.base64EncodedString() ?? "unreadable")
            case S_IFDIR:
                lines.append(line)
                for child in ((try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []).sorted() {
                    visit(path + "/" + child, relative + "/" + child)
                }
                return
            default:
                break
            }
            lines.append(line)
        }
        visit(url.path, ".")
        return lines
    }
}
