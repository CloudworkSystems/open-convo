import Foundation
import Security

/// Step 2, PR 1: the Desk store's real key, held in the Mac's Keychain.
///
/// One generic-password item per store: service `<app's Keychain service>.desk-store-key`
/// (so True Convo and True Convo Test never share a key, and the Desk keys
/// never mix with the cloud API keys), account = the store's id. The item is
/// never synchronized to iCloud and is usable only on this Mac, after it is
/// unlocked (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`).
///
/// The custody rules are the same as the placeholder's:
/// - a key is created only for a brand-new store, and an existing item is
///   never replaced (`keyExists`);
/// - a missing item reads as "no key", so an existing store refuses to open
///   (`ProofStoreError.keyMissing`); nothing is regenerated over saved work;
/// - an item that is unreadable or the wrong size is reported
///   (`unavailable`), never repaired or replaced;
/// - key material never appears in a response, a log, a file or an error.
///
/// The app's Desk uses this provider since step 2, PR 2b
/// (`DeskSession.Storage.keychain`), for the one store it reopens on every
/// run; the store's files are ciphertext under it (step 2, PR 2).
public final class KeychainKeyProvider: KeyProvider, @unchecked Sendable {
    public static let custody = "keychain-this-device-only"
    /// Key size in bytes (256-bit, for AES-GCM or ChaChaPoly).
    public static let keyLength = 32

    /// The Keychain service for Desk store keys under an app's service.
    public static func service(appKeychainService: String) -> String {
        appKeychainService + ".desk-store-key"
    }

    public let service: String
    private let items: KeychainItems
    private let lock = NSLock()

    public init(service: String, items: KeychainItems = SystemKeychainItems()) {
        self.service = service
        self.items = items
    }

    public func existingKey(for storeId: UUID) throws -> StoreKey? {
        lock.lock()
        defer { lock.unlock() }
        let data: Data?
        do { data = try items.read(service: service, account: storeId.uuidString) } catch {
            throw KeyProviderError.unavailable
        }
        guard let data else { return nil }
        guard data.count == Self.keyLength else { throw KeyProviderError.unavailable }
        return StoreKey(storeId: storeId, material: data, custody: Self.custody)
    }

    public func createKey(for storeId: UUID) throws -> StoreKey {
        lock.lock()
        defer { lock.unlock() }
        let account = storeId.uuidString
        let present: Data?
        do { present = try items.read(service: service, account: account) } catch {
            throw KeyProviderError.unavailable
        }
        guard present == nil else { throw KeyProviderError.keyExists }
        var material = Data(count: Self.keyLength)
        let status = material.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, Self.keyLength, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw KeyProviderError.unavailable }
        do {
            try items.add(service: service, account: account, data: material)
        } catch KeychainItemsError.duplicate {
            throw KeyProviderError.keyExists
        } catch {
            throw KeyProviderError.unavailable
        }
        return StoreKey(storeId: storeId, material: material, custody: Self.custody)
    }
}

/// The two Keychain calls the provider makes. Tests use an in-memory stand-in
/// so `swift test` never touches the owner's Keychain.
public protocol KeychainItems: Sendable {
    /// The item's data, or nil when there is no such item.
    func read(service: String, account: String) throws -> Data?
    /// Adds a new item; throws `duplicate` rather than replacing one.
    func add(service: String, account: String, data: Data) throws
}

public enum KeychainItemsError: Error, Equatable, Sendable {
    case duplicate
    /// A Keychain status other than success, not-found or duplicate.
    case status(Int32)
}

/// The Mac's Keychain. Items are this-device-only and never synchronized.
public struct SystemKeychainItems: KeychainItems {
    public static let label = "True Convo Desk store key"

    public init() {}

    public func read(service: String, account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { throw KeychainItemsError.status(status) }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainItemsError.status(status)
        }
    }

    public func add(service: String, account: String, data: Data) throws {
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: Self.label,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess: return
        case errSecDuplicateItem: throw KeychainItemsError.duplicate
        default: throw KeychainItemsError.status(status)
        }
    }
}
