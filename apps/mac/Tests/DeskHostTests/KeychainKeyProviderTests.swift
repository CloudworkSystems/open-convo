import Foundation
import Security
import Testing
@testable import DeskHost

/// An in-memory Keychain: the tests never touch the owner's real Keychain
/// (except the opt-in check at the end).
final class FakeKeychainItems: KeychainItems, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    var failReads = false
    var failAdds = false

    private func key(_ service: String, _ account: String) -> String { service + "\u{0}" + account }

    func read(service: String, account: String) throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        if failReads { throw KeychainItemsError.status(-25308) }
        return items[key(service, account)]
    }

    func add(service: String, account: String, data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        if failAdds { throw KeychainItemsError.status(-25308) }
        guard items[key(service, account)] == nil else { throw KeychainItemsError.duplicate }
        items[key(service, account)] = data
    }

    func put(service: String, account: String, data: Data) {
        lock.lock()
        defer { lock.unlock() }
        items[key(service, account)] = data
    }

    func remove(service: String, account: String) {
        lock.lock()
        defer { lock.unlock() }
        items.removeValue(forKey: key(service, account))
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return items.count
    }
}

@Suite("Keychain key custody")
struct KeychainKeyProviderTests {
    let service = KeychainKeyProvider.service(appKeychainService: "com.example.invented")

    @Test("Desk keys get their own service per app, apart from the API keys")
    func servicePerApp() {
        #expect(KeychainKeyProvider.service(appKeychainService: "com.trueconvo.voice-cursor") == "com.trueconvo.voice-cursor.desk-store-key")
        #expect(KeychainKeyProvider.service(appKeychainService: "com.trueconvo.voice-cursor.test") == "com.trueconvo.voice-cursor.test.desk-store-key")
    }

    @Test("A key is created once, read back unchanged, and never replaced")
    func createOnce() throws {
        let items = FakeKeychainItems()
        let keys = KeychainKeyProvider(service: service, items: items)
        let id = UUID()
        #expect(try keys.existingKey(for: id) == nil)
        let made = try keys.createKey(for: id)
        #expect(made.material.count == KeychainKeyProvider.keyLength)
        #expect(made.custody == KeychainKeyProvider.custody)
        #expect(try keys.existingKey(for: id) == made)
        #expect(throws: KeyProviderError.keyExists) { try keys.createKey(for: id) }
        #expect(try keys.existingKey(for: id) == made, "the refused create left the key alone")
        #expect(items.count == 1)
    }

    @Test("Each store gets its own fresh key")
    func distinctKeys() throws {
        let keys = KeychainKeyProvider(service: service, items: FakeKeychainItems())
        let a = try keys.createKey(for: UUID())
        let b = try keys.createKey(for: UUID())
        #expect(a.material != b.material)
    }

    @Test("A Keychain that can't be read or written is reported, never worked around")
    func keychainFailures() throws {
        let items = FakeKeychainItems()
        let keys = KeychainKeyProvider(service: service, items: items)
        let id = UUID()
        items.failAdds = true
        #expect(throws: KeyProviderError.unavailable) { try keys.createKey(for: id) }
        #expect(items.count == 0)
        items.failAdds = false
        _ = try keys.createKey(for: id)
        items.failReads = true
        #expect(throws: KeyProviderError.unavailable) { try keys.existingKey(for: id) }
        #expect(throws: KeyProviderError.unavailable) { try keys.createKey(for: UUID()) }
    }

    @Test("An item of the wrong size is reported, not repaired or replaced")
    func wrongSizeItem() throws {
        let items = FakeKeychainItems()
        let keys = KeychainKeyProvider(service: service, items: items)
        let id = UUID()
        items.put(service: service, account: id.uuidString, data: Data(repeating: 7, count: 5))
        #expect(throws: KeyProviderError.unavailable) { try keys.existingKey(for: id) }
        #expect(throws: KeyProviderError.keyExists) { try keys.createKey(for: id) }
        #expect(try items.read(service: service, account: id.uuidString) == Data(repeating: 7, count: 5))
    }

    @Test("A store whose Keychain item was deleted refuses to open and no key is made")
    func deletedItemRefusesStore() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("KeychainKeyProviderTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let items = FakeKeychainItems()
        let keys = KeychainKeyProvider(service: service, items: items)
        let store = try ProofStore(directory: directory, keys: keys)
        #expect(store.keyCustody == KeychainKeyProvider.custody)
        let workspaceId = store.workspaceId
        store.close()
        let reopened = try ProofStore(directory: directory, keys: keys)
        #expect(reopened.workspaceId == workspaceId, "the kept key reopens the same store")
        reopened.close()
        items.remove(service: service, account: workspaceId.uuidString)
        #expect(throws: ProofStoreError.keyMissing) { try ProofStore(directory: directory, keys: keys) }
        #expect(items.count == 0, "nothing was regenerated")
    }

    @Test("Key material never shows up in an error's description")
    func noMaterialInErrors() throws {
        let items = FakeKeychainItems()
        let keys = KeychainKeyProvider(service: service, items: items)
        let id = UUID()
        let made = try keys.createKey(for: id)
        do { _ = try keys.createKey(for: id) } catch {
            let text = String(describing: error)
            #expect(!text.contains(made.material.base64EncodedString()))
            #expect(!text.contains(made.material.map { String(format: "%02x", $0) }.joined()))
        }
    }

    /// Opt-in: TC_KEYCHAIN_TEST=1 swift test --filter realKeychain. Adds one
    /// invented item to the login Keychain under a throwaway service and
    /// deletes it again.
    @Test("The real Keychain keeps a this-device-only item and refuses a duplicate",
          .enabled(if: ProcessInfo.processInfo.environment["TC_KEYCHAIN_TEST"] == "1"))
    func realKeychain() throws {
        let service = "com.example.invented.keychain-test.\(UUID().uuidString)"
        let id = UUID()
        defer {
            SecItemDelete([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
            ] as CFDictionary)
        }
        let keys = KeychainKeyProvider(service: service)
        #expect(try keys.existingKey(for: id) == nil)
        let made = try keys.createKey(for: id)
        #expect(try keys.existingKey(for: id) == made)
        #expect(throws: KeyProviderError.keyExists) { try keys.createKey(for: id) }
    }
}
