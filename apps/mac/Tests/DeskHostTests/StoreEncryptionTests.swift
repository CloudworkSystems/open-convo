import Foundation
import Testing
@testable import DeskHost

/// A provider that answers every store with one fixed invented key, standing
/// in for a Keychain that hands back the wrong key.
private struct FixedKeyProvider: KeyProvider {
    let material: Data
    func existingKey(for storeId: UUID) throws -> StoreKey? { StoreKey(storeId: storeId, material: material, custody: "invented-fixed") }
    func createKey(for storeId: UUID) throws -> StoreKey { StoreKey(storeId: storeId, material: material, custody: "invented-fixed") }
}

@Suite("Desk store encryption")
struct StoreEncryptionTests {
    private let marker = "invented-plaintext-marker-7f3a"

    private func attempt(_ requestId: UUID = UUID(), expected: Int, revision: Int, label: String) -> CommitAttempt {
        CommitAttempt(requestId: requestId, payloadHash: "h-\(requestId.canonicalString)", expectedRevision: expected,
                      recordRevision: revision, record: inventedRecord(label, revision: revision), deliveryId: nil)
    }

    private func rawState(_ store: ProofStore) throws -> Data { try Data(contentsOf: store.stateURL) }

    @Test("The state and attempted records on disk are ciphertext; the marker keeps only ids")
    func filesAreCiphertext() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        defer { store.close() }
        #expect(try store.commit(attempt(expected: 0, revision: 1, label: marker)) == .committed(revision: 1))
        let loserId = UUID()
        guard case .conflict(_, let attemptedURL) = try store.commit(attempt(loserId, expected: 0, revision: 1, label: marker + "-loser")) else {
            Issue.record("expected a conflict")
            return
        }
        for raw in [try rawState(store), try Data(contentsOf: attemptedURL)] {
            #expect(raw.prefix(StoreCipher.header.count) == StoreCipher.header)
            #expect(raw.range(of: Data(marker.utf8)) == nil, "no plaintext on disk")
            #expect(raw.range(of: Data("revision".utf8)) == nil)
        }
        #expect(String(decoding: try store.plainStateForTesting(), as: UTF8.self).contains(marker), "it opens under the key")
        #expect(String(decoding: try store.plainAttemptedForTesting(loserId), as: UTF8.self).contains(marker + "-loser"))
        let markerText = String(decoding: try Data(contentsOf: store.markerURL), as: UTF8.self)
        #expect(!markerText.contains(marker))
    }

    @Test("Every write uses a fresh nonce, so the same state never seals to the same bytes")
    func freshNonce() throws {
        let cipher = try StoreCipher(material: Data(repeating: 1, count: 32), workspaceId: UUID())
        let plain = Data("{\"invented\":true}".utf8)
        let a = try cipher.seal(plain, as: .state)
        let b = try cipher.seal(plain, as: .state)
        #expect(a != b)
        #expect(try cipher.open(a, as: .state) == plain)
        #expect(try cipher.open(b, as: .state) == plain)
    }

    @Test("A store reopened under the right key reads back what was committed")
    func reopenRoundTrip() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try store.commit(attempt(expected: 0, revision: 1, label: marker)) == .committed(revision: 1))
        store.close()
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        let record = try reopened.read()
        #expect(record.revision == 1)
        #expect(record.record["label"] == .string(marker))
    }

    @Test("Wrong key, flipped byte, truncation, plaintext, another store's file or a moved attempted record: corrupt, left in place, never reset")
    func damageIsReportedNotReset() throws {
        enum Damage: CaseIterable { case wrongKey, flippedByte, truncated, plaintext, otherStore, attemptedInPlace, emptyFile }
        for damage in Damage.allCases {
            let fixture = try DeskHostFixture()
            defer { fixture.clean() }
            let keys = FixedKeyProvider(material: Data(repeating: 9, count: 32))
            let store = try ProofStore(directory: fixture.storeDirectory, keys: keys)
            #expect(try store.commit(attempt(expected: 0, revision: 1, label: marker)) == .committed(revision: 1))
            let loserId = UUID()
            _ = try store.commit(attempt(loserId, expected: 0, revision: 1, label: "loser"))
            store.close()

            var reopenKeys: KeyProvider = keys
            var bytes = try rawState(store)
            switch damage {
            case .wrongKey:
                reopenKeys = FixedKeyProvider(material: Data(repeating: 8, count: 32))
            case .flippedByte:
                bytes[bytes.count - 20] ^= 0x01
            case .truncated:
                bytes = bytes.prefix(bytes.count - 1)
            case .plaintext:
                bytes = try store.plainStateForTesting()
            case .otherStore:
                let otherDirectory = fixture.directory.appendingPathComponent("other", isDirectory: true)
                let other = try ProofStore(directory: otherDirectory, keys: keys)
                bytes = try Data(contentsOf: other.stateURL)
                other.close()
            case .attemptedInPlace:
                bytes = try Data(contentsOf: store.attemptedDirectory.appendingPathComponent("\(loserId.canonicalString).json"))
            case .emptyFile:
                bytes = Data()
            }
            try bytes.write(to: store.stateURL)

            let reopened = try ProofStore(directory: fixture.storeDirectory, keys: reopenKeys)
            #expect(reopened.status == .corrupt, "\(damage)")
            #expect(throws: ProofStoreError.corrupt) { try reopened.read() }
            #expect(throws: ProofStoreError.corrupt) { try reopened.commit(attempt(expected: 1, revision: 2, label: "after")) }
            reopened.close()
            #expect(try Data(contentsOf: store.stateURL) == bytes, "\(damage): the file is left exactly as found")
        }
    }

    @Test("Only a 32-byte key builds the cipher; a store given another length refuses before writing")
    func keyLengthEnforced() throws {
        for length in [0, 16, 24, 31, 33, 64] {
            #expect(throws: StoreCipher.Failure.wrongKeyLength) { try StoreCipher(material: Data(count: length), workspaceId: UUID()) }
        }
        #expect(throws: Never.self) { try StoreCipher(material: Data(count: 32), workspaceId: UUID()) }

        // Fresh store: refused before any file is written.
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let short = FixedKeyProvider(material: Data(repeating: 4, count: 16))
        #expect(throws: ProofStoreError.keyRefused) { try ProofStore(directory: fixture.storeDirectory, keys: short) }
        #expect(!FileManager.default.fileExists(atPath: fixture.storeDirectory.appendingPathComponent("state.json").path))
        #expect(!FileManager.default.fileExists(atPath: fixture.storeDirectory.appendingPathComponent("workspace.json").path))

        // Existing store: refused, its files untouched.
        let good = FixedKeyProvider(material: Data(repeating: 4, count: 32))
        let store = try ProofStore(directory: fixture.storeDirectory, keys: good)
        let before = try Data(contentsOf: store.stateURL)
        store.close()
        #expect(throws: ProofStoreError.keyRefused) { try ProofStore(directory: fixture.storeDirectory, keys: short) }
        #expect(try Data(contentsOf: store.stateURL) == before)
        let reopened = try ProofStore(directory: fixture.storeDirectory, keys: good)
        #expect(reopened.status == .ready, "the refused open released the lock")
        reopened.close()
    }

    @Test("A state file left without its marker (provisioning cut off) is set aside, never deleted, and the store starts fresh")
    func interruptedProvisioningRecovers() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let first = try fixture.makeStore()
        let firstId = first.workspaceId
        let orphan = try Data(contentsOf: first.stateURL)
        first.close()
        // The crash: state.json was published, workspace.json never was.
        try FileManager.default.removeItem(at: first.markerURL)

        let fresh = try fixture.makeStore()
        defer { fresh.close() }
        #expect(fresh.status == .ready)
        #expect(fresh.workspaceId != firstId, "a new store")
        let names = try FileManager.default.contentsOfDirectory(atPath: fixture.storeDirectory.path)
        let aside = names.filter { $0.hasPrefix(ProofStore.unprovisionedStatePrefix) }
        #expect(aside.count == 1)
        #expect(try Data(contentsOf: fixture.storeDirectory.appendingPathComponent(aside[0])) == orphan, "kept byte for byte")
    }

    @Test("Without a marker, anything but a plain state file is still refused")
    func orphanThatIsNotAFileRefuses() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let first = try fixture.makeStore()
        first.close()
        try FileManager.default.removeItem(at: first.markerURL)
        try FileManager.default.removeItem(at: first.stateURL)
        try FileManager.default.createDirectory(at: first.stateURL, withIntermediateDirectories: false)
        #expect(throws: ProofStoreError.corruptState) { try fixture.makeStore() }
    }

    @Test("Opening under a purpose other than the one sealed fails")
    func purposeIsBound() throws {
        let cipher = try StoreCipher(material: Data(repeating: 3, count: 32), workspaceId: UUID())
        let id = UUID()
        let sealed = try cipher.seal(Data("{}".utf8), as: .attempted(id))
        #expect(throws: StoreCipher.Failure.unreadable) { try cipher.open(sealed, as: .state) }
        #expect(throws: StoreCipher.Failure.unreadable) { try cipher.open(sealed, as: .attempted(UUID())) }
        #expect(try cipher.open(sealed, as: .attempted(id)) == Data("{}".utf8))
    }
}
