import ArchiveProtection
import DeskHost
import Foundation

// Step 2, PR 5: the kill-and-reopen proof's writer. Test-only, never bundled.
//
// It writes invented data through the real protected stores, as fast as it
// can, and prints one line per write only after that write has returned
// (`committed <n>`, `wrote <id>`, `sealed <name>`). The proof kills it at a
// random moment with SIGKILL, then reopens everything in its own process and
// checks that every printed write survived and nothing is damaged or
// readable.
//
// Keys live in files in a folder the test owns (invented, test-only), so a
// key made by one run is there for the next, as the Keychain would be.
//
//   ProtectionProofHost desk <store-folder> <keys-folder>
//   ProtectionProofHost archive <archive-root> <keys-folder>
//   ProtectionProofHost recording <archive-root> <keys-folder>

/// Invented keys in files, one per id (0600). Test-only.
final class InventedFileKeys: KeyProvider, @unchecked Sendable {
    let folder: URL
    init(folder: URL) { self.folder = folder }

    private func url(_ id: UUID) -> URL { folder.appendingPathComponent(id.uuidString + ".key") }

    func existingKey(for storeId: UUID) throws -> StoreKey? {
        guard let data = try? Data(contentsOf: url(storeId)) else { return nil }
        return StoreKey(storeId: storeId, material: data, custody: "invented-file-test-only")
    }

    func createKey(for storeId: UUID) throws -> StoreKey {
        guard try existingKey(for: storeId) == nil else { throw KeyProviderError.keyExists }
        var generator = SystemRandomNumberGenerator()
        let material = Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let temporary = folder.appendingPathComponent(".\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(atPath: temporary.path, contents: material,
                                             attributes: [.posixPermissions: NSNumber(value: 0o600)]),
              rename(temporary.path, url(storeId).path) == 0 else { throw KeyProviderError.unavailable }
        return StoreKey(storeId: storeId, material: material, custody: "invented-file-test-only")
    }
}

func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("ProtectionProofHost: " + message + "\n").utf8))
    exit(2)
}

let arguments = CommandLine.arguments
guard arguments.count == 4 else { fail("usage: <desk|archive|recording> <folder> <keys-folder>") }
let mode = arguments[1]
let folder = URL(fileURLWithPath: arguments[2], isDirectory: true)
let keys = InventedFileKeys(folder: URL(fileURLWithPath: arguments[3], isDirectory: true))

/// The invented word every write carries; the proof checks it never appears
/// on disk in the clear.
let marker = "invented-proof-word"

switch mode {
case "desk":
    let store: ProofStore
    do { store = try ProofStore(directory: folder, keys: keys) } catch { fail("open: \(error)") }
    // As the app does when the Desk opens (DeskSession.openStack, through
    // DeskHostProtocol.recoverUnresolvedDispatch): a commit a killed run
    // left in flight is withdrawn before anything new is written.
    if let pending = store.unresolvedDispatch {
        do { _ = try store.withdrawUnresolvedDispatch(pending) } catch { fail("recover: \(error)") }
        say("recovered")
    }
    var revision = (try? store.read().revision) ?? 0
    say("ready \(revision)")
    while true {
        let next = revision + 1
        let record: [String: JSONValue] = [
            "revision": .number(Double(next)),
            "label": .string("\(marker) \(next)"),
            "sessions": .array([.object(["id": .string(UUID().uuidString.lowercased()), "draft": .string("\(marker) draft \(next)")])]),
        ]
        let attempt = CommitAttempt(requestId: UUID(), payloadHash: "proof-\(next)", expectedRevision: revision,
                                    recordRevision: next, record: record)
        do {
            guard case .committed(let committed) = try store.commit(attempt) else { fail("commit \(next) not committed") }
            revision = committed
            say("committed \(committed)")
        } catch {
            fail("commit \(next): \(error)")
        }
    }

case "archive":
    guard let seal = ArchiveKeyCustody.open(root: folder, keys: keys).seal else { fail("archive key") }
    let files = ArchiveFiles(root: folder)
    let history = folder.appendingPathComponent("history.jsonl")
    let transcripts = folder.appendingPathComponent("transcripts", isDirectory: true)
    try? FileManager.default.createDirectory(at: transcripts, withIntermediateDirectories: true)
    let start = Int(Date().timeIntervalSince1970 * 1000)
    var index = 0
    say("ready")
    while true {
        index += 1
        let id = "\(start)-\(index)"
        do {
            try files.appendSealedLine(Data("{\"id\":\"\(id)\",\"text\":\"\(marker) \(id)\"}".utf8), to: history, seal: seal)
            try files.writeSealed(Data("# \(marker) \(id)\n".utf8), to: transcripts.appendingPathComponent("\(id).md"), seal: seal)
            try files.writeSealed(Data("# latest \(marker) \(id)\n".utf8), to: folder.appendingPathComponent("latest-transcript.md"), seal: seal)
        } catch {
            fail("write \(id): \(error)")
        }
        say("wrote \(id)")
    }

case "recording":
    let seal = ArchiveKeyCustody.open(root: folder, keys: keys).seal
    let recordingsFolder = folder.appendingPathComponent("recordings", isDirectory: true)
    try? FileManager.default.createDirectory(at: recordingsFolder, withIntermediateDirectories: true)
    let recordings = SealedRecordings(files: ArchiveFiles(root: folder))
    let audio = Data(("RIFF....WAVE " + String(repeating: "\(marker) ", count: 2000)).utf8)
    let start = Int(Date().timeIntervalSince1970 * 1000)
    var index = 0
    say("ready")
    while true {
        index += 1
        let capture = recordingsFolder.appendingPathComponent("\(start)-\(index).wav")
        do {
            try recordings.markPending(capture)
            try audio.write(to: capture)
        } catch {
            fail("capture \(index): \(error)")
        }
        guard case .sealed = recordings.seal(capture, seal: seal) else { fail("seal \(index)") }
        recordings.clearPending(capture)
        say("sealed \(capture.lastPathComponent)")
    }

default:
    fail("unknown mode \(mode)")
}
