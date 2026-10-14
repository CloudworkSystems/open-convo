import ArchiveProtection
import Darwin
import DeskHost
import Foundation
import XCTest

/// Step 2, PR 5: the kill-and-reopen proof, with invented data only.
///
/// `ProtectionProofHost` writes through the real protected stores and prints
/// a line after each write returns. Each round it is killed with SIGKILL at
/// a random moment (no chance to clean up, as with a force quit, a crash or
/// a power cut of the process), then this test reopens what it left and
/// checks:
/// - everything it acknowledged is there, and the store or archive opens;
/// - nothing is damaged (every sealed file and history line opens);
/// - the invented words never appear in the clear anywhere on disk.
/// The same folders and keys are reused across rounds, as a restart would.
final class KillAndReopenProofTests: XCTestCase {
    static let marker = Data("invented-proof-word".utf8)
    /// Rounds per store; `PROOF_ROUNDS` raises it (scripts/protection-proof.sh).
    static let rounds = Int(ProcessInfo.processInfo.environment["PROOF_ROUNDS"] ?? "") ?? 12

    private var base: URL!
    private var keysFolder: URL { base.appendingPathComponent("keys", isDirectory: true) }

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("kill-reopen-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: keysFolder, withIntermediateDirectories: true)
        guard FileManager.default.isExecutableFile(atPath: Self.hostPath) else {
            throw XCTSkip("ProtectionProofHost isn't built next to the tests: \(Self.hostPath)")
        }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    static var hostPath: String {
        Bundle(for: KillAndReopenProofTests.self).bundleURL.deletingLastPathComponent()
            .appendingPathComponent("ProtectionProofHost").path
    }

    // MARK: The Desk store

    func testTheDeskStoreKeepsEveryAcknowledgedCommitThroughKills() throws {
        let store = base.appendingPathComponent("store", isDirectory: true)
        var highest = 0
        for round in 1...Self.rounds {
            let lines = try runAndKill(mode: "desk", folder: store)
            let committed = lines.compactMap { line -> Int? in
                guard line.hasPrefix("committed ") else { return nil }
                return Int(line.dropFirst("committed ".count))
            }
            highest = max(highest, committed.max() ?? 0)

            let reopened = try ProofStore(directory: store, keys: InventedFileKeys(folder: keysFolder))
            defer { reopened.close() }
            XCTAssertEqual(reopened.status, .ready, "round \(round)")
            let record = try reopened.read()
            XCTAssertGreaterThanOrEqual(record.revision, highest, "round \(round): an acknowledged commit was lost")
            if record.revision > 0 {
                XCTAssertEqual(record.record["label"], .string("invented-proof-word \(record.revision)"), "round \(round)")
            }
            try assertNoPlaintext(under: store, round: round)
        }
        XCTAssertGreaterThan(highest, Self.rounds, "the writer made real progress")
    }

    // MARK: Dictation words

    func testTheArchiveKeepsEveryAcknowledgedWriteThroughKills() throws {
        let root = base.appendingPathComponent("archive", isDirectory: true)
        var acknowledged: [String] = []
        var archiveId: UUID?
        for round in 1...Self.rounds {
            let lines = try runAndKill(mode: "archive", folder: root)
            acknowledged += lines.filter { $0.hasPrefix("wrote ") }.map { String($0.dropFirst("wrote ".count)) }

            guard let seal = ArchiveKeyCustody.open(root: root, keys: InventedFileKeys(folder: keysFolder)).seal else {
                return XCTFail("round \(round): the archive's key didn't open")
            }
            if let archiveId { XCTAssertEqual(seal.archiveId, archiveId, "round \(round): the same archive") }
            archiveId = seal.archiveId
            let files = ArchiveFiles(root: root)

            let history = root.appendingPathComponent("history.jsonl")
            let text = String(decoding: try Data(contentsOf: history), as: UTF8.self)
            var ids = Set<String>()
            var order: [String] = []
            for line in text.split(separator: "\n") {
                guard case .opened(let data) = files.readLine(line, in: history, seal: seal),
                      let object = try JSONSerialization.jsonObject(with: data) as? [String: String],
                      let id = object["id"] else {
                    return XCTFail("round \(round): a history line doesn't open")
                }
                ids.insert(id)
                order.append(id)
            }
            for id in acknowledged {
                XCTAssertTrue(ids.contains(id), "round \(round): history lost \(id)")
                let transcript = root.appendingPathComponent("transcripts/\(id).md")
                guard case .opened = files.read(transcript, seal: seal) else {
                    return XCTFail("round \(round): transcript \(id) doesn't open")
                }
            }
            if let newest = acknowledged.last {
                guard case .opened(let latest) = files.read(root.appendingPathComponent("latest-transcript.md"), seal: seal) else {
                    return XCTFail("round \(round): the latest copy doesn't open")
                }
                // It must hold the newest acknowledged write or a later one
                // (a write the kill cut off before it was acknowledged), never
                // an earlier one (Codex on #36).
                let latestId = String(decoding: latest, as: UTF8.self)
                    .replacingOccurrences(of: "# latest invented-proof-word ", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard let latestPosition = order.firstIndex(of: latestId), let newestPosition = order.firstIndex(of: newest) else {
                    return XCTFail("round \(round): the latest copy names \(latestId), which history doesn't hold")
                }
                XCTAssertGreaterThanOrEqual(latestPosition, newestPosition, "round \(round): the latest copy rolled back")
            }
            try assertNoPlaintext(under: root, round: round)
        }
        XCTAssertGreaterThan(acknowledged.count, Self.rounds, "the writer made real progress")
    }

    // MARK: Kept recordings

    func testRecordingsLeftMidCaptureAreSealedAtTheNextLaunch() throws {
        let root = base.appendingPathComponent("archive", isDirectory: true)
        let folder = root.appendingPathComponent("recordings", isDirectory: true)
        var acknowledged: [String] = []
        for round in 1...Self.rounds {
            let lines = try runAndKill(mode: "recording", folder: root)
            acknowledged += lines.filter { $0.hasPrefix("sealed ") }.map { String($0.dropFirst("sealed ".count)) }

            // What the app does at launch.
            guard let seal = ArchiveKeyCustody.open(root: root, keys: InventedFileKeys(folder: keysFolder)).seal else {
                return XCTFail("round \(round): the archive's key didn't open")
            }
            let recordings = SealedRecordings(files: ArchiveFiles(root: root), temporaryRoot: base.appendingPathComponent("opened"))
            recordings.reconcilePending(in: folder, seal: seal)

            let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
            for name in names where !name.hasPrefix(".") {
                XCTAssertTrue(name.hasSuffix(".sealed"), "round \(round): \(name) is left in the clear")
                XCTAssertNotNil(recordings.data(of: folder.appendingPathComponent(name), seal: seal), "round \(round): \(name) doesn't open")
            }
            for name in acknowledged {
                XCTAssertTrue(names.contains(name + ".sealed"), "round \(round): lost \(name)")
            }
            let pending = (try? FileManager.default.contentsOfDirectory(atPath: folder.appendingPathComponent(".pending").path)) ?? []
            XCTAssertEqual(pending.filter { !$0.hasPrefix(".") }, [], "round \(round): markers cleared")
            try assertNoPlaintext(under: root, round: round)
        }
        XCTAssertGreaterThan(acknowledged.count, Self.rounds, "the writer made real progress")
    }

    // MARK: Helpers

    /// Starts the writer, lets it run for a random moment after it is ready,
    /// kills it with SIGKILL and returns every line it printed.
    private func runAndKill(mode: String, folder: URL) throws -> [String] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: Self.hostPath)
        process.arguments = [mode, folder.path, keysFolder.path]
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        let collected = Collected()
        output.fileHandleForReading.readabilityHandler = { handle in collected.append(handle.availableData) }
        try process.run()

        let readyBy = Date().addingTimeInterval(10)
        while !collected.text.contains("ready"), process.isRunning, Date() < readyBy { usleep(2_000) }
        guard process.isRunning else {
            let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            throw ProofError.writerStopped(message)
        }
        usleep(UInt32.random(in: 30_000...250_000))
        kill(process.processIdentifier, SIGKILL)
        process.waitUntilExit()
        output.fileHandleForReading.readabilityHandler = nil
        collected.append(output.fileHandleForReading.readDataToEndOfFile())
        XCTAssertEqual(process.terminationReason, .uncaughtSignal, "the writer was killed, not stopped by an error")
        return collected.text.split(separator: "\n").map(String.init)
    }

    private func assertNoPlaintext(under folder: URL, round: Int) throws {
        guard let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) else { return }
        for case let url as URL in walker {
            guard (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { continue }
            let data = try Data(contentsOf: url)
            XCTAssertNil(data.range(of: Self.marker), "round \(round): invented words in the clear in \(url.lastPathComponent)")
        }
    }

    enum ProofError: Error { case writerStopped(String) }

    private final class Collected: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        func append(_ more: Data) { lock.lock(); data.append(more); lock.unlock() }
        var text: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
    }
}

/// The writer's invented file-backed keys, read back here. Test-only.
final class InventedFileKeys: KeyProvider, @unchecked Sendable {
    let folder: URL
    init(folder: URL) { self.folder = folder }

    func existingKey(for storeId: UUID) throws -> StoreKey? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(storeId.uuidString + ".key")) else { return nil }
        return StoreKey(storeId: storeId, material: data, custody: "invented-file-test-only")
    }

    func createKey(for storeId: UUID) throws -> StoreKey {
        throw KeyProviderError.unavailable // only the writer makes keys
    }
}
