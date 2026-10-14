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

    @Test("With the key gone from the Keychain, the recovery key brings the store back")
    func restoreAfterWipe() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try commit(store, label: "kept", expected: 0, revision: 1) == .committed(revision: 1))
        let recovery = try store.makeRecoveryKey()
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
        let right = try second.makeRecoveryKey()
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
        let first = try store.makeRecoveryKey()
        let second = try store.makeRecoveryKey()
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
        let recovery = try store.makeRecoveryKey()
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
        let recovery = try store.makeRecoveryKey()
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
