import Foundation
import Testing
@testable import DeskHost

@Suite("Recovery key")
struct RecoveryKeyTests {
    private func commit(_ store: ProofStore, label: String, expected: Int, revision: Int) throws -> CommitOutcome {
        try store.commit(CommitAttempt(requestId: UUID(), payloadHash: "h-\(label)", expectedRevision: expected, recordRevision: revision,
                                       record: inventedRecord(label, revision: revision), deliveryId: nil))
    }

    @Test("The written-down form round-trips, forgives case, spaces and look-alike letters, and never prints itself")
    func displayRoundTrip() throws {
        let key = try RecoveryKey.generate()
        let text = key.displayText
        #expect(text.count == RecoveryKey.characterCount + 10, "11 groups of 5 with 10 dashes")
        #expect(text.split(separator: "-").allSatisfy { $0.count == 5 })
        #expect(try RecoveryKey(typed: text) == key)
        #expect(try RecoveryKey(typed: text.lowercased()) == key)
        #expect(try RecoveryKey(typed: text.replacingOccurrences(of: "-", with: " ")) == key)
        let lookAlike = text.replacingOccurrences(of: "0", with: "O").replacingOccurrences(of: "1", with: "l")
        #expect(try RecoveryKey(typed: lookAlike) == key)
        #expect("\(key)" == "RecoveryKey(redacted)")
        #expect(String(reflecting: key) == "RecoveryKey(redacted)")
        #expect(try RecoveryKey.generate() != key)
    }

    @Test("A mistyped key is caught by its shape or checksum before any decryption")
    func malformedKeys() throws {
        let text = try RecoveryKey.generate().displayText
        #expect(throws: RecoveryError.malformedRecoveryKey) { try RecoveryKey(typed: String(text.dropLast())) }
        #expect(throws: RecoveryError.malformedRecoveryKey) { try RecoveryKey(typed: text + "A") }
        #expect(throws: RecoveryError.malformedRecoveryKey) { try RecoveryKey(typed: "U" + text.dropFirst()) }
        // One character changed: the checksum refuses it.
        var chars = Array(text)
        chars[2] = chars[2] == "A" ? "B" : "A"
        #expect(throws: RecoveryError.malformedRecoveryKey) { try RecoveryKey(typed: String(chars)) }
    }

    @Test("Every other last character is refused: only the canonical spelling reads")
    func lastCharacterTypos() throws {
        let key = try RecoveryKey.generate()
        let text = key.displayText
        let last = text.last!
        var accepted: [Character] = []
        for other in RecoveryKey.alphabet where other != last {
            if (try? RecoveryKey(typed: String(text.dropLast()) + String(other))) != nil { accepted.append(other) }
        }
        #expect(accepted.isEmpty, "\(accepted)")
    }

    @Test("Every single mistyped character, anywhere, is refused before decryption")
    func everySingleSubstitutionCaught() throws {
        // Includes Codex's example of a key a 16-bit hash checksum let through.
        var keys = [try RecoveryKey(typed: RecoveryKey(secret: Data(repeating: 0, count: 31) + Data([1])).displayText)]
        for _ in 0..<6 { keys.append(try RecoveryKey.generate()) }
        for key in keys {
            let chars = Array(key.displayText.filter { $0 != "-" })
            #expect(chars.count == RecoveryKey.characterCount)
            for position in chars.indices {
                for other in RecoveryKey.alphabet where other != chars[position] {
                    var typo = chars
                    typo[position] = other
                    #expect(throws: RecoveryError.malformedRecoveryKey, "position \(position)") { try RecoveryKey(typed: String(typo)) }
                }
            }
        }
    }

    @Test("A marker the store itself would refuse (empty handle) refuses the restore and imports nothing")
    func restoreChecksMarkerLikeOpen() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let recovery = try store.makeRecoveryKey().key
        let id = store.workspaceId
        let markerURL = store.markerURL
        store.close()
        fixture.keys.forgetKey(for: id)
        var marker = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: markerURL)) as? [String: Any])
        marker["workspaceHandle"] = ""
        try JSONSerialization.data(withJSONObject: marker).write(to: markerURL)
        #expect(throws: RecoveryError.storeUnreadable) {
            try ProofStore.restoreKey(directory: fixture.storeDirectory, recoveryKey: recovery, into: fixture.keys)
        }
        #expect(fixture.keys.heldKeyCount == 0)
    }

    @Test("A copy renamed into place whose folder flush failed still hands back its key")
    func flushFailureKeepsKey() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let faults = OneShotFault()
        let store = try fixture.makeStore(faults: faults)
        let before = try store.makeRecoveryKey()
        #expect(before.isDurable)
        faults.arm(.directoryFlush, target: store.recoveryCopyURL)
        let made = try store.makeRecoveryKey()
        #expect(!made.isDurable)
        let id = store.workspaceId
        store.close()
        fixture.keys.forgetKey(for: id)
        #expect(throws: RecoveryError.wrongRecoveryKey) { try ProofStore.restoreKey(directory: fixture.storeDirectory, recoveryKey: before.key, into: fixture.keys) }
        #expect(try ProofStore.restoreKey(directory: fixture.storeDirectory, recoveryKey: made.key, into: fixture.keys) == id,
                "the returned key opens the copy the folder shows")
    }

    @Test("With the key gone from the Keychain, the recovery key brings the store back")
    func restoreAfterWipe() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try commit(store, label: "kept", expected: 0, revision: 1) == .committed(revision: 1))
        let recovery = try store.makeRecoveryKey().key
        #expect(store.hasRecoveryCopy)
        let workspaceId = store.workspaceId
        store.close()
        fixture.keys.forgetKey(for: workspaceId)
        #expect(throws: ProofStoreError.keyMissing) { try fixture.makeStore() }

        let typed = try RecoveryKey(typed: recovery.displayText)
        #expect(try ProofStore.restoreKey(directory: fixture.storeDirectory, recoveryKey: typed, into: fixture.keys) == workspaceId)
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        #expect(try reopened.read().record["label"] == .string("kept"))
    }

    @Test("A wrong recovery key, a changed copy or no copy refuses and imports nothing")
    func refusals() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let workspaceId = store.workspaceId
        store.close()
        fixture.keys.forgetKey(for: workspaceId)
        #expect(throws: RecoveryError.noRecoveryCopy) {
            try ProofStore.restoreKey(directory: fixture.storeDirectory, recoveryKey: try RecoveryKey.generate(), into: fixture.keys)
        }

        let other = InventedInMemoryKeyProvider()
        let directory = fixture.directory.appendingPathComponent("second", isDirectory: true)
        let second = try ProofStore(directory: directory, keys: other)
        let right = try second.makeRecoveryKey().key
        let id = second.workspaceId
        second.close()
        other.forgetKey(for: id)
        #expect(throws: RecoveryError.wrongRecoveryKey) {
            try ProofStore.restoreKey(directory: directory, recoveryKey: try RecoveryKey.generate(), into: other)
        }
        #expect(other.heldKeyCount == 0)

        let copy = directory.appendingPathComponent(RecoveryCopy.fileName)
        var bytes = try Data(contentsOf: copy)
        bytes[bytes.count - 1] ^= 0x01
        try bytes.write(to: copy)
        #expect(throws: RecoveryError.wrongRecoveryKey) { try ProofStore.restoreKey(directory: directory, recoveryKey: right, into: other) }
        #expect(other.heldKeyCount == 0)
    }

    @Test("Making a new recovery key retires the old one")
    func remakeRetiresOld() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let first = try store.makeRecoveryKey().key
        let second = try store.makeRecoveryKey().key
        let id = store.workspaceId
        store.close()
        fixture.keys.forgetKey(for: id)
        #expect(throws: RecoveryError.wrongRecoveryKey) { try ProofStore.restoreKey(directory: fixture.storeDirectory, recoveryKey: first, into: fixture.keys) }
        #expect(try ProofStore.restoreKey(directory: fixture.storeDirectory, recoveryKey: second, into: fixture.keys) == id)
    }

    @Test("A key that is still held is never replaced, and an open store can't be restored under")
    func noReplaceNoSecondWriter() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        let recovery = try store.makeRecoveryKey().key
        #expect(throws: ProofStoreError.secondWriter) {
            try ProofStore.restoreKey(directory: fixture.storeDirectory, recoveryKey: recovery, into: fixture.keys)
        }
        let held = try fixture.keys.existingKey(for: store.workspaceId)
        store.close()
        #expect(throws: KeyProviderError.keyExists) {
            try ProofStore.restoreKey(directory: fixture.storeDirectory, recoveryKey: recovery, into: fixture.keys)
        }
        #expect(try fixture.keys.existingKey(for: store.workspaceId) == held)
    }

    @Test("Neither the recovery key nor the store key appears in any file")
    func nothingSecretOnDisk() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try commit(store, label: "x", expected: 0, revision: 1) == .committed(revision: 1))
        let recovery = try store.makeRecoveryKey().key
        let storeKey = store.cipher.material
        store.close()
        let needles = [recovery.secret, Data(recovery.displayText.utf8),
                       Data(recovery.displayText.replacingOccurrences(of: "-", with: "").utf8),
                       storeKey, Data(storeKey.base64EncodedString().utf8)]
        let walker = FileManager.default.enumerator(at: fixture.directory, includingPropertiesForKeys: nil)!
        var scanned = 0
        for case let url as URL in walker {
            guard let bytes = try? Data(contentsOf: url) else { continue }
            scanned += 1
            for needle in needles { #expect(bytes.range(of: needle) == nil, "\(url.lastPathComponent)") }
        }
        #expect(scanned >= 3)
    }

    @Test("Confirmation vouches for one copy only, holds nothing secret, and a new key reads as unconfirmed")
    func confirmationNote() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        #expect(!store.recoveryCopyConfirmed)
        #expect(throws: RecoveryError.noRecoveryCopy) { try store.confirmRecoveryCopy() }
        let first = try store.makeRecoveryKey().key
        #expect(!store.recoveryCopyConfirmed)
        try store.confirmRecoveryCopy()
        #expect(store.recoveryCopyConfirmed)
        let note = try Data(contentsOf: store.recoveryConfirmationURL)
        #expect(note.range(of: first.secret) == nil)
        #expect(note.range(of: Data(first.displayText.utf8)) == nil)
        _ = try store.makeRecoveryKey()
        #expect(!store.recoveryCopyConfirmed, "the note named the old copy")
        #expect(try Data(contentsOf: store.recoveryConfirmationURL) == note, "nothing was deleted or rewritten")
    }

    @Test("A confirmation whose folder flush failed doesn't count until one flushes")
    func unflushedConfirmation() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let faults = OneShotFault()
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        _ = try store.makeRecoveryKey()
        faults.arm(.directoryFlush, target: store.recoveryConfirmationURL)
        faults.failRetries = true
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.confirmRecoveryCopy() }
        #expect(!store.recoveryCopyConfirmed, "visible but not durable: not confirmed")
        #expect(!store.recoveryCopyConfirmed, "still not, while the folder won't flush")
        faults.failRetries = false
        #expect(store.recoveryCopyConfirmed, "a later folder flush makes the note durable")
    }

    @Test("After a reopen, a note whose flush failed counts only once the folder flushes")
    func unflushedConfirmationAcrossReopen() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let faults = OneShotFault()
        let store = try fixture.makeStore(faults: faults)
        _ = try store.makeRecoveryKey()
        faults.arm(.directoryFlush, target: store.recoveryConfirmationURL)
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.confirmRecoveryCopy() }
        store.close()

        // A new process whose folder flush keeps failing: not confirmed.
        let failing = AlwaysFailingFlushRetry()
        let reopened = try fixture.makeStore(faults: failing)
        #expect(!reopened.recoveryCopyConfirmed)
        #expect(failing.asked >= 1)
        reopened.close()

        // One whose flush succeeds: the visible note is now on disk and counts.
        let later = try fixture.makeStore()
        defer { later.close() }
        #expect(later.recoveryCopyConfirmed)
    }

    @Test("Checking confirmation while new keys are made never pairs a new copy with an old note")
    func confirmationCheckIsAtomic() async throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        _ = try store.makeRecoveryKey()
        try store.confirmRecoveryCopy()
        #expect(store.recoveryCopyConfirmed)
        // Each new key leaves the old note naming the old copy: once any
        // remake has landed, no later check may say confirmed.
        let wrongs = await withTaskGroup(of: Int.self) { group -> Int in
            group.addTask {
                for _ in 0..<40 { _ = try? store.makeRecoveryKey() }
                return 0
            }
            group.addTask {
                var wrong = 0
                var sawRemake = false
                for _ in 0..<400 {
                    let before = (try? Data(contentsOf: store.recoveryCopyURL)) ?? Data()
                    let confirmed = store.recoveryCopyConfirmed
                    if sawRemake && confirmed { wrong += 1 }
                    if before != ((try? Data(contentsOf: store.recoveryCopyURL)) ?? Data()) || !confirmed { sawRemake = true }
                }
                return wrong
            }
            return await group.reduce(0, +)
        }
        #expect(wrongs == 0)
        #expect(!store.recoveryCopyConfirmed)
    }

    @Test("The Keychain provider takes a recovered key back once and refuses to replace it")
    func keychainImport() throws {
        let items = FakeKeychainItems()
        let keys = KeychainKeyProvider(service: KeychainKeyProvider.service(appKeychainService: "com.example.invented"), items: items)
        let id = UUID()
        let material = Data(repeating: 5, count: 32)
        #expect(try keys.importKey(material, for: id).material == material)
        #expect(try keys.existingKey(for: id)?.material == material)
        #expect(throws: KeyProviderError.keyExists) { try keys.importKey(Data(repeating: 6, count: 32), for: id) }
        #expect(throws: KeyProviderError.unavailable) { try keys.importKey(Data(count: 16), for: UUID()) }
        #expect(items.count == 1)
    }
}

/// Fails the named stage once, for one target, with EIO.
@Suite("Recovery key companion (step 2, PR 4b)")
struct RecoveryCompanionTests {
    @Test("The companion seals before the Desk's copy is replaced, then retires earlier copies once it is durable")
    func sealsFirstThenRetires() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        let companion = RecordingCompanion(copyURL: store.recoveryCopyURL)
        let made = try store.makeRecoveryKey(companion: companion)
        #expect(made.isDurable)
        #expect(companion.calls == ["seal(desk copy absent)", "retire"])
        #expect(companion.keys.first == made.key && companion.keys.last == made.key)
    }

    @Test("A companion that refuses stops the make: no copy is replaced and no key comes back")
    func refusalReplacesNothing() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        let first = try store.makeRecoveryKey()
        let before = try Data(contentsOf: store.recoveryCopyURL)
        let companion = RecordingCompanion(copyURL: store.recoveryCopyURL, refuses: true)
        #expect(throws: CompanionRefusal.self) { try store.makeRecoveryKey(companion: companion) }
        #expect(try Data(contentsOf: store.recoveryCopyURL) == before)
        #expect(companion.calls == ["seal(desk copy present)"])
        _ = first
    }

    @Test("When the Desk's write fails before its rename, the companion's new copy is discarded")
    func deskFailureDiscards() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let faults = OneShotFault()
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        let companion = RecordingCompanion(copyURL: store.recoveryCopyURL)
        faults.arm(.write, target: store.recoveryCopyURL)
        #expect(throws: (any Error).self) { try store.makeRecoveryKey(companion: companion) }
        #expect(companion.calls == ["seal(desk copy absent)", "discard"])
        #expect(companion.keys.count == 2 && companion.keys[0] == companion.keys[1])
    }

    @Test("A flush failure after the rename keeps earlier companion copies (no retire)")
    func unsyncedKeepsEarlierCopies() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let faults = OneShotFault()
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        let companion = RecordingCompanion(copyURL: store.recoveryCopyURL)
        faults.arm(.directoryFlush, target: store.recoveryCopyURL)
        let made = try store.makeRecoveryKey(companion: companion)
        #expect(!made.isDurable)
        #expect(companion.calls == ["seal(desk copy absent)"])
    }

    @Test("A companion that can't finish retiring makes the key read as not durable, so the owner makes another")
    func unfinishedRetireIsNotDurable() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        let companion = RecordingCompanion(copyURL: store.recoveryCopyURL)
        companion.retireSucceeds = false
        let made = try store.makeRecoveryKey(companion: companion)
        #expect(!made.isDurable)
        #expect(companion.calls == ["seal(desk copy absent)", "retire"])
    }

    @Test("Derived keys and fingerprints depend on the secret and never repeat across keys")
    func derivedKeysAndFingerprints() throws {
        let a = try RecoveryKey.generate()
        let b = try RecoveryKey.generate()
        #expect(a.fingerprint.count == 32)
        #expect(a.fingerprint == (try RecoveryKey(typed: a.displayText)).fingerprint)
        #expect(a.fingerprint != b.fingerprint)
        let raw = { (key: RecoveryKey, salt: String) in key.derivedKey(salt: Data(salt.utf8), info: "t").withUnsafeBytes { Data($0) } }
        #expect(raw(a, "x") != raw(b, "x"))
        #expect(raw(a, "x") != raw(a, "y"))
        #expect(raw(a, "x") != a.wrappingKey(for: UUID()).withUnsafeBytes { Data($0) })
    }
}

private struct CompanionRefusal: Error {}

private final class RecordingCompanion: RecoveryCompanion, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    private var seen: [RecoveryKey] = []
    let copyURL: URL
    let refuses: Bool

    init(copyURL: URL, refuses: Bool = false) {
        self.copyURL = copyURL
        self.refuses = refuses
    }

    var calls: [String] { lock.lock(); defer { lock.unlock() }; return recorded }
    var keys: [RecoveryKey] { lock.lock(); defer { lock.unlock() }; return seen }

    private func note(_ call: String, _ key: RecoveryKey?) {
        lock.lock()
        recorded.append(call)
        if let key { seen.append(key) }
        lock.unlock()
    }

    func seal(under recovery: RecoveryKey) throws {
        let present = FileManager.default.fileExists(atPath: copyURL.path)
        note("seal(desk copy \(present ? "present" : "absent"))", recovery)
        if refuses { throw CompanionRefusal() }
    }
    func discard(_ recovery: RecoveryKey) { note("discard", recovery) }
    var retireSucceeds = true
    func retireAllBut(_ recovery: RecoveryKey) -> Bool { note("retire", recovery); return retireSucceeds }
    func restore(with recovery: RecoveryKey) -> RecoveryCompanionRestore { note("restore", recovery); return .restored }
    var needsRecoveryKey: Bool { false }
}

private final class OneShotFault: AtomicWriteFaults, @unchecked Sendable {
    private let lock = NSLock()
    private var armed: (AtomicWriteStage, URL)?
    private var retriesFail = false
    var failRetries: Bool {
        get { lock.lock(); defer { lock.unlock() }; return retriesFail }
        set { lock.lock(); retriesFail = newValue; lock.unlock() }
    }

    func flushRetryFault(target: URL) -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        return retriesFail ? EIO : nil
    }

    func arm(_ stage: AtomicWriteStage, target: URL) {
        lock.lock()
        defer { lock.unlock() }
        armed = (stage, target.standardizedFileURL)
    }

    func fault(before stage: AtomicWriteStage, target: URL) -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        guard let (armedStage, armedTarget) = armed, armedStage == stage, armedTarget == target.standardizedFileURL else { return nil }
        armed = nil
        return EIO
    }
}

/// Every folder-flush retry fails with EIO; writes pass.
private final class AlwaysFailingFlushRetry: AtomicWriteFaults, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var asked: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
    func fault(before stage: AtomicWriteStage, target: URL) -> Int32? { nil }
    func flushRetryFault(target: URL) -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return EIO
    }
}
