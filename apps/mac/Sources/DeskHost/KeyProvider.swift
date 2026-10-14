import Foundation

/// Key custody boundary for the proof store.
///
/// The custody rules every provider keeps:
/// - a key is created only when no store exists yet;
/// - a store whose key is missing refuses to open; nothing is regenerated over
///   saved work and nothing falls back to plaintext or browser storage;
/// - key material never appears in a response, a log or a file.
///
/// The proof store encrypts its state and attempted records under the key
/// (`StoreCipher`, step 2, PR 2). `KeychainKeyProvider` (step 2, PR 1) is the
/// real custody behind this same protocol: a this-device-only Keychain item,
/// never copied to iCloud, never exposed to JavaScript. The app's Desk uses
/// it since step 2, PR 2b; `InventedInMemoryKeyProvider` remains for tests
/// and the per-run storage.
public protocol KeyProvider: Sendable {
    /// The key for an existing store, or nil when none is held.
    func existingKey(for storeId: UUID) throws -> StoreKey?

    /// Creates a key for a brand-new store. Throws `keyExists` rather than
    /// replacing one that is already held.
    func createKey(for storeId: UUID) throws -> StoreKey
}

public struct StoreKey: Equatable, Sendable {
    public let storeId: UUID
    /// Raw key bytes. Do not print, log, encode or compare in a response.
    public let material: Data
    /// Where the key lives. Exposed as `ProofStore.keyCustody` for the app's
    /// own display so a placeholder can never be mistaken for real custody;
    /// it is not on the wire (`host.capabilities` has a fixed key set).
    public let custody: String

    public init(storeId: UUID, material: Data, custody: String) {
        self.storeId = storeId
        self.material = material
        self.custody = custody
    }
}

public enum KeyProviderError: Error, Equatable, Sendable {
    case keyExists
    case unavailable
}

/// PLACEHOLDER. Holds invented keys in memory for the invented-data proof.
/// Keys vanish with the process, so a reopened store in a new process refuses
/// to open exactly as a real store with a missing Keychain item would.
public final class InventedInMemoryKeyProvider: KeyImporting, @unchecked Sendable {
    public static let custody = "invented-in-memory-placeholder"

    private let lock = NSLock()
    private var keys: [UUID: StoreKey] = [:]

    public init() {}

    public func existingKey(for storeId: UUID) throws -> StoreKey? {
        lock.lock()
        defer { lock.unlock() }
        return keys[storeId]
    }

    public func createKey(for storeId: UUID) throws -> StoreKey {
        lock.lock()
        defer { lock.unlock() }
        guard keys[storeId] == nil else { throw KeyProviderError.keyExists }
        var generator = SystemRandomNumberGenerator()
        let material = Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        let key = StoreKey(storeId: storeId, material: material, custody: Self.custody)
        keys[storeId] = key
        return key
    }

    /// Takes back a recovered key; refuses to replace one it holds.
    public func importKey(_ material: Data, for storeId: UUID) throws -> StoreKey {
        lock.lock()
        defer { lock.unlock() }
        guard keys[storeId] == nil else { throw KeyProviderError.keyExists }
        let key = StoreKey(storeId: storeId, material: material, custody: Self.custody)
        keys[storeId] = key
        return key
    }

    /// Test hook: simulates a store whose key is gone.
    public func forgetKey(for storeId: UUID) {
        lock.lock()
        defer { lock.unlock() }
        keys.removeValue(forKey: storeId)
    }

    public var heldKeyCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return keys.count
    }
}
