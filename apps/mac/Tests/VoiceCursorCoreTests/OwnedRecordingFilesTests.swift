import Foundation
import Testing
@testable import VoiceCursorCore

private struct OwnedRecordingFixture {
    let directory: URL
    let files = FileManager.default
    let bytes = Data("invented fixture bytes, not a recording".utf8)

    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("OwnedRecordingFilesTests-\(UUID().uuidString)", isDirectory: true)
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func url(_ name: String) -> URL { directory.appendingPathComponent(name) }
    func write(_ urls: URL...) throws { for url in urls { try bytes.write(to: url) } }
    func clean() { try? files.removeItem(at: directory) }
}

private final class FailingRecordingFileManager: FileManager, @unchecked Sendable {
    var blocked: Set<URL> = []

    override func removeItem(at url: URL) throws {
        if blocked.contains(url.standardizedFileURL) {
            throw NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError)
        }
        try super.removeItem(at: url)
    }
}

@Suite("Current-process recording ownership")
struct OwnedRecordingFilesTests {
    @Test("Finishing an old capture removes its WAV/FLAC only while the next capture stays active")
    func overlappingCapturesStaySeparate() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let first = fixture.url("capture-1.wav")
        let firstOutput = fixture.url("capture-1.flac")
        let next = fixture.url("capture-2.wav")
        let nextOutput = fixture.url("capture-2.flac")
        let ownership = OwnedRecordingFiles()
        #expect(ownership.registerCapture(first, retain: false))
        #expect(ownership.registerOutput(firstOutput, forCapture: first))
        #expect(ownership.registerCapture(next, retain: false))
        #expect(ownership.registerOutput(nextOutput, forCapture: next))
        try fixture.write(first, firstOutput, next, nextOutput)
        #expect(ownership.finishCapture(first).isEmpty)
        #expect(!fixture.files.fileExists(atPath: first.path))
        #expect(!fixture.files.fileExists(atPath: firstOutput.path))
        #expect(!ownership.isOwned(first))
        #expect(!ownership.isOwned(firstOutput))
        #expect(try Data(contentsOf: next) == fixture.bytes)
        #expect(try Data(contentsOf: nextOutput) == fixture.bytes)
        #expect(ownership.isOwned(next))
        #expect(ownership.isOwned(nextOutput))
    }

    @Test("Retaining a capture releases all ownership so a later off shutdown cannot delete retained audio")
    func retainedCaptureIsReleasedUntouched() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let retained = fixture.url("retained.wav")
        let retainedOutput = fixture.url("retained.flac")
        let current = fixture.url("current.wav")
        let ownership = OwnedRecordingFiles()
        #expect(ownership.registerCapture(retained, retain: true))
        #expect(ownership.registerOutput(retainedOutput, forCapture: retained))
        try fixture.write(retained, retainedOutput)
        #expect(ownership.finishCapture(retained).isEmpty)
        #expect(!ownership.isOwned(retained))
        #expect(!ownership.isOwned(retainedOutput))
        #expect(ownership.registerCapture(current, retain: false))
        try fixture.write(current)
        #expect(ownership.shutdown().isEmpty)
        #expect(!fixture.files.fileExists(atPath: current.path))
        #expect(try Data(contentsOf: retained) == fixture.bytes)
        #expect(try Data(contentsOf: retainedOutput) == fixture.bytes)
    }

    @Test("Quit removes registered input and output, leaves unregistered archive files alone, and refuses late writers")
    func shutdownClosesBeforeCleanup() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let input = fixture.url("active.wav")
        let output = fixture.url("active.flac")
        let existing = fixture.url("previous-retained.wav")
        let late = fixture.url("late.wav")
        try fixture.write(existing)
        let ownership = OwnedRecordingFiles()
        #expect(ownership.registerCapture(input, retain: false))
        #expect(ownership.registerOutput(output, forCapture: input))
        try fixture.write(input, output)
        #expect(ownership.shutdown().isEmpty)
        #expect(!fixture.files.fileExists(atPath: input.path))
        #expect(!fixture.files.fileExists(atPath: output.path))
        #expect(try Data(contentsOf: existing) == fixture.bytes)
        #expect(!ownership.isOwned(input))
        #expect(!ownership.isOwned(output))
        #expect(!ownership.registerCapture(late, retain: false))
        #expect(!ownership.registerOutput(late, forCapture: input))
        #expect(ownership.shutdown().isEmpty)
    }

    @Test("Retaining on quit leaves every owned file untouched and still closes registration permanently")
    func retainingShutdownReleasesFiles() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let input = fixture.url("kept.wav")
        let output = fixture.url("kept.flac")
        let ownership = OwnedRecordingFiles()
        #expect(ownership.registerCapture(input, retain: true))
        #expect(ownership.registerOutput(output, forCapture: input))
        try fixture.write(input, output)
        #expect(ownership.shutdown().isEmpty)
        #expect(!ownership.isOwned(input))
        #expect(!ownership.isOwned(output))
        #expect(!ownership.registerCapture(input, retain: true))
        #expect(ownership.shutdown().isEmpty)
        #expect(try Data(contentsOf: input) == fixture.bytes)
        #expect(try Data(contentsOf: output) == fixture.bytes)
    }

    @Test("Failed removal stays owned for quit/repeated-quit retries while successful group members are released")
    func failedDeletionRemainsRetryable() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let input = fixture.url("failed.wav")
        let output = fixture.url("removed.flac")
        let files = FailingRecordingFileManager()
        files.blocked = [input]
        let ownership = OwnedRecordingFiles(fileManager: files)
        #expect(ownership.registerCapture(input, retain: false))
        #expect(ownership.registerOutput(output, forCapture: input))
        try fixture.write(input, output)
        #expect(ownership.finishCapture(input) == [input])
        #expect(ownership.isOwned(input))
        #expect(!ownership.isOwned(output))
        #expect(!fixture.files.fileExists(atPath: output.path))
        #expect(!ownership.registerOutput(output, forCapture: input))
        #expect(!ownership.registerCapture(input, retain: false))
        #expect(!ownership.registerCapture(input, retain: true), "A later Keep choice cannot change a failed discard's original policy.")
        #expect(ownership.retainsCapture(input) == false)
        #expect(ownership.shutdown() == [input])
        #expect(ownership.isOwned(input))
        files.blocked.removeAll()
        #expect(ownership.shutdown().isEmpty)
        #expect(!ownership.isOwned(input))
        #expect(!fixture.files.fileExists(atPath: input.path))
        #expect(!ownership.registerCapture(input, retain: false))
    }

    @Test("Missing files clean up idempotently; unknown groups and cross-capture ownership are refused")
    func registrationKeepsExactCaptureOwnership() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let first = fixture.url("first.wav")
        let second = fixture.url("second.wav")
        let output = fixture.url("first.flac")
        let ownership = OwnedRecordingFiles()
        #expect(!ownership.registerCapture(URL(string: "https://example.invalid/audio.wav")!, retain: false))
        #expect(!ownership.registerCapture(fixture.directory, retain: false))
        #expect(!ownership.registerOutput(output, forCapture: first))
        #expect(ownership.registerCapture(first, retain: false))
        #expect(ownership.registerCapture(first, retain: false))
        #expect(ownership.registerCapture(second, retain: false))
        #expect(ownership.registerOutput(output, forCapture: first))
        #expect(ownership.registerOutput(output, forCapture: first))
        #expect(!ownership.registerOutput(second, forCapture: first))
        #expect(!ownership.registerOutput(output, forCapture: second))
        #expect(!ownership.registerCapture(output, retain: false))
        #expect(ownership.finishCapture(output).isEmpty)
        #expect(ownership.isOwned(first))
        #expect(ownership.isOwned(output))
        #expect(ownership.finishCapture(first).isEmpty)
        #expect(!ownership.isOwned(first))
        #expect(!ownership.isOwned(output))
        #expect(ownership.isOwned(second))
        #expect(ownership.finishCapture(first).isEmpty)
        #expect(ownership.shutdown().isEmpty)
    }

    @Test("An owned path replaced with a directory is not recursively removed during file cleanup")
    func cleanupDoesNotDeleteDirectories() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let directory = fixture.url("existing-directory")
        let ownership = OwnedRecordingFiles()
        #expect(ownership.registerCapture(directory, retain: false))
        try fixture.files.createDirectory(at: directory, withIntermediateDirectories: true)
        let child = directory.appendingPathComponent("kept.wav")
        try fixture.write(child)
        #expect(ownership.shutdown() == [directory])
        #expect(ownership.isOwned(directory))
        #expect(try Data(contentsOf: child) == fixture.bytes)
    }

    @Test("Historical files and live or dangling symlinks cannot become newly owned captures or outputs")
    func existingPathsNeverBecomeOwned() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let historical = fixture.url("previous-retained.wav")
        let historicalOutput = fixture.url("previous-retained.flac")
        let link = fixture.url("linked.wav")
        let dangling = fixture.url("dangling.wav")
        let absentTarget = fixture.url("absent-target.wav")
        try fixture.write(historical, historicalOutput)
        try fixture.files.createSymbolicLink(at: link, withDestinationURL: historical)
        try fixture.files.createSymbolicLink(at: dangling, withDestinationURL: absentTarget)
        let ownership = OwnedRecordingFiles()
        let current = fixture.url("new-capture.wav")
        #expect(ownership.registerCapture(current, retain: false))
        for url in [historical, historicalOutput, link, dangling] {
            #expect(!ownership.registerCapture(url, retain: false))
            #expect(!ownership.registerOutput(url, forCapture: current))
            #expect(!ownership.isOwned(url))
        }
        try fixture.write(current)
        #expect(ownership.shutdown().isEmpty)
        #expect(try Data(contentsOf: historical) == fixture.bytes)
        #expect(try Data(contentsOf: historicalOutput) == fixture.bytes)
        #expect(try fixture.files.destinationOfSymbolicLink(atPath: link.path) == historical.path)
        #expect(try fixture.files.destinationOfSymbolicLink(atPath: dangling.path) == absentTarget.path)
        #expect(!fixture.files.fileExists(atPath: absentTarget.path))
        #expect(!fixture.files.fileExists(atPath: current.path))
    }

    @Test("Concurrent registration and shutdown cannot reopen ownership or affect unregistered files")
    func registrationAndShutdownShareTheLock() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let untouched = fixture.url("unregistered.wav")
        try fixture.write(untouched)
        let ownership = OwnedRecordingFiles()
        let captures = (0..<80).map { fixture.url("concurrent-\($0).wav") }
        DispatchQueue.concurrentPerform(iterations: captures.count + 1) { index in
            if index == captures.count {
                _ = ownership.shutdown()
            } else {
                _ = ownership.registerCapture(captures[index], retain: false)
                _ = ownership.registerOutput(captures[index].deletingPathExtension().appendingPathExtension("flac"), forCapture: captures[index])
            }
        }
        #expect(captures.allSatisfy { !ownership.isOwned($0) })
        #expect(captures.allSatisfy { !ownership.registerCapture($0, retain: false) })
        #expect(ownership.shutdown().isEmpty)
        #expect(try Data(contentsOf: untouched) == fixture.bytes)
    }

    @Test("A recording's start choice survives both later preference directions and cannot be overwritten")
    func recordingStartPolicyIsImmutable() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let suite = "OwnedRecordingFilesTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = DictationPreferences(defaults: defaults)
        let ownership = OwnedRecordingFiles()
        let kept = fixture.url("started-with-keep.wav")
        let keptOutput = fixture.url("started-with-keep.flac")
        preferences.retainAudioForHarvest = true
        #expect(ownership.registerCapture(kept, retain: preferences.retainAudioForHarvest))
        #expect(ownership.registerOutput(keptOutput, forCapture: kept))
        preferences.retainAudioForHarvest = false
        #expect(!ownership.registerCapture(kept, retain: preferences.retainAudioForHarvest))
        #expect(ownership.retainsCapture(kept) == true)
        try fixture.write(kept, keptOutput)
        #expect(ownership.finishCapture(kept).isEmpty)
        #expect(try Data(contentsOf: kept) == fixture.bytes)
        #expect(try Data(contentsOf: keptOutput) == fixture.bytes)

        let temporary = fixture.url("started-with-delete.wav")
        let temporaryOutput = fixture.url("started-with-delete.flac")
        #expect(ownership.registerCapture(temporary, retain: preferences.retainAudioForHarvest))
        #expect(ownership.registerOutput(temporaryOutput, forCapture: temporary))
        preferences.retainAudioForHarvest = true
        #expect(!ownership.registerCapture(temporary, retain: preferences.retainAudioForHarvest))
        #expect(ownership.retainsCapture(temporary) == false)
        try fixture.write(temporary, temporaryOutput)
        #expect(ownership.finishCapture(temporary).isEmpty)
        #expect(!fixture.files.fileExists(atPath: temporary.path))
        #expect(!fixture.files.fileExists(atPath: temporaryOutput.path))
        #expect(ownership.retainsCapture(temporary) == nil)
        #expect(ownership.shutdown().isEmpty)
        #expect(try Data(contentsOf: kept) == fixture.bytes)
    }

    @Test("Quit applies each capture's start choice to active WAVs and converter outputs", arguments: [false, true])
    func mixedPoliciesSurviveShutdown(currentSetting: Bool) throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let suite = "OwnedRecordingFilesTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = DictationPreferences(defaults: defaults)
        let ownership = OwnedRecordingFiles()
        let kept = fixture.url("kept-at-start.wav")
        let keptOutput = fixture.url("kept-at-start.flac")
        let temporary = fixture.url("temporary-at-start.wav")
        let temporaryOutput = fixture.url("temporary-at-start.flac")
        preferences.retainAudioForHarvest = true
        #expect(ownership.registerCapture(kept, retain: preferences.retainAudioForHarvest))
        #expect(ownership.registerOutput(keptOutput, forCapture: kept))
        preferences.retainAudioForHarvest = false
        #expect(ownership.registerCapture(temporary, retain: preferences.retainAudioForHarvest))
        #expect(ownership.registerOutput(temporaryOutput, forCapture: temporary))
        try fixture.write(kept, keptOutput, temporary, temporaryOutput)
        preferences.retainAudioForHarvest = currentSetting
        #expect(ownership.shutdown().isEmpty)
        #expect(ownership.shutdown().isEmpty)
        #expect(try Data(contentsOf: kept) == fixture.bytes)
        #expect(try Data(contentsOf: keptOutput) == fixture.bytes)
        #expect(!fixture.files.fileExists(atPath: temporary.path))
        #expect(!fixture.files.fileExists(atPath: temporaryOutput.path))
        #expect(!ownership.registerCapture(fixture.url("after-quit.wav"), retain: currentSetting))
    }

    @Test("Parent aliases share capture identity without resolving a replaced symlink leaf")
    func parentAliasesKeepExactLeafOwnership() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let parent = fixture.directory.appendingPathComponent("real-parent", isDirectory: true)
        try fixture.files.createDirectory(at: parent, withIntermediateDirectories: true)
        let alias = fixture.directory.appendingPathComponent("alias-parent", isDirectory: true)
        try fixture.files.createSymbolicLink(at: alias, withDestinationURL: parent)
        let original = alias.appendingPathComponent("capture.wav")
        let physical = parent.appendingPathComponent("capture.wav")
        let historical = fixture.url("historical.wav")
        try fixture.write(historical)
        let ownership = OwnedRecordingFiles()
        #expect(ownership.registerCapture(original, retain: false))
        #expect(ownership.isOwned(physical))
        #expect(ownership.retainsCapture(physical) == false)
        // Only the newly registered leaf is removed, even if it later becomes
        // a link. The retained target never becomes owned or eligible.
        try fixture.files.createSymbolicLink(at: physical, withDestinationURL: historical)
        #expect(ownership.isOwned(physical))
        #expect(!ownership.isOwned(historical))
        #expect(ownership.finishCapture(physical).isEmpty)
        #expect(!fixture.files.fileExists(atPath: original.path))
        #expect(try Data(contentsOf: historical) == fixture.bytes)
    }

    @Test("A parent alias redirected after registration cannot redirect cleanup to another file")
    func redirectedParentFailsClosed() throws {
        let fixture = try OwnedRecordingFixture()
        defer { fixture.clean() }
        let parent = fixture.directory.appendingPathComponent("original-parent", isDirectory: true)
        let other = fixture.directory.appendingPathComponent("other-parent", isDirectory: true)
        try fixture.files.createDirectory(at: parent, withIntermediateDirectories: true)
        try fixture.files.createDirectory(at: other, withIntermediateDirectories: true)
        let alias = fixture.directory.appendingPathComponent("parent-alias", isDirectory: true)
        try fixture.files.createSymbolicLink(at: alias, withDestinationURL: parent)
        let original = alias.appendingPathComponent("capture.wav")
        let ownership = OwnedRecordingFiles()
        #expect(ownership.registerCapture(original, retain: false))
        try fixture.write(original, other.appendingPathComponent("capture.wav"))
        try fixture.files.removeItem(at: alias)
        try fixture.files.createSymbolicLink(at: alias, withDestinationURL: other)
        let failures = ownership.shutdown()
        // Foundation may already have standardized the registered alias into
        // its physical path. It can then safely delete the owned original;
        // otherwise the changed alias must fail closed and preserve it.
        if failures.isEmpty {
            #expect(!fixture.files.fileExists(atPath: parent.appendingPathComponent("capture.wav").path))
        } else {
            #expect(try Data(contentsOf: parent.appendingPathComponent("capture.wav")) == fixture.bytes)
        }
        #expect(try Data(contentsOf: other.appendingPathComponent("capture.wav")) == fixture.bytes)
    }
}
