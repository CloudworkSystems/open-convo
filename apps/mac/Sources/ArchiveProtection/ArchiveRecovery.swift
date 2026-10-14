import CryptoKit
import DeskHost
import Foundation

/// Step 2, PR 4b: the Desk's one recovery key also brings back the
/// dictation archive's key.
///
/// The archive keeps one copy of its key per recovery key, in
/// `recovery/<fingerprint>.sealed` inside the archive folder, so a copy
/// under a new key never disturbs the copy under the key the owner wrote
/// down until the Desk's own new copy is durable. Each copy is AES-256-GCM
/// under a key derived from the recovery key with the archive's id as salt,
/// bound to the archive's id. The recovery key itself is never written.
///
/// It follows the Desk store's lead (`RecoveryCompanion`): sealed before the
/// Desk's copy is replaced, discarded if that replacement fails, earlier
/// copies retired once it is durable, and restored with the same typed key.
/// It never makes an archive key: with no marker or no key held, sealing is
/// a no-op, so the copies under the key that can still restore it stay.
public final class ArchiveRecovery: RecoveryCompanion, @unchecked Sendable {
    public static let folderName = "recovery"
    static let header = Data("TCARCR1\n".utf8)
    static let label = "open-convo.archive-recovery/v1"

    public let root: URL
    private let keys: any KeyImporting
    private let lock = NSLock()
    /// A pairing note was taken back but that removal couldn't be flushed:
    /// until a later flush succeeds, the Desk keeps asking.
    private var pairingUnsynced = false

    public init(root: URL, keys: any KeyImporting) {
        self.root = root
        self.keys = keys
    }

    /// The app's archive key in this Mac's Keychain, as `ArchiveKeyCustody`
    /// opens it.
    public static func inKeychain(root: URL, appKeychainService: String) -> ArchiveRecovery {
        ArchiveRecovery(root: root, keys: KeychainKeyProvider(
            service: ArchiveKeychain.service(appKeychainService: appKeychainService),
            items: SystemKeychainItems(itemLabel: ArchiveKeychain.label)
        ))
    }

    public var folder: URL { root.appendingPathComponent(Self.folderName, isDirectory: true) }

    func copyURL(_ recovery: RecoveryKey) -> URL {
        folder.appendingPathComponent("\(recovery.fingerprint).sealed", isDirectory: false)
    }

    private var markerURL: URL { root.appendingPathComponent(ArchiveKeyCustody.markerName) }

    private func archiveId() -> UUID? {
        if case .present(let id) = ArchiveKeyCustody.readMarker(markerURL) { return id }
        return nil
    }

    // MARK: RecoveryCompanion

    public func seal(under recovery: RecoveryKey) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let id = archiveId(), let key = try keys.existingKey(for: id) else { return }
        let sealed = try Self.seal(key.material, under: recovery, archiveId: id)
        try prepareFolder()
        do {
            try DurableFile.replace(copyURL(recovery), with: sealed)
        } catch {
            // A rename that landed before a failed flush leaves the copy
            // visible: take it back, since this key will never be shown
            // (Codex P1 on #32).
            unlink(copyURL(recovery).path)
            throw error
        }
    }

    public func discard(_ recovery: RecoveryKey) {
        lock.lock()
        defer { lock.unlock() }
        unlink(copyURL(recovery).path)
        try? DurableFile.flushFolder(folder)
    }

    public func retireAllBut(_ recovery: RecoveryKey) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let keep = copyURL(recovery).lastPathComponent
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        // Only once the new copy is in place: otherwise the earlier copies
        // are the only way back.
        guard names.contains(keep) else { return false }
        var allRetired = true
        for name in names where name.hasSuffix(".sealed") && name != keep {
            if unlink(folder.appendingPathComponent(name).path) != 0 && errno != ENOENT { allRetired = false }
        }
        // A failed removal is reported, not hidden (Codex P2 on #32): the
        // key isn't recorded as paired, so the Desk asks for another and
        // the next make retries the removal.
        guard allRetired, (try? DurableFile.flushFolder(folder)) != nil else { return false }
        do {
            try DurableFile.replace(pairedURL, with: Data((recovery.fingerprint + "\n").utf8))
        } catch {
            // A note renamed into place before a failed folder flush could
            // roll back on power loss: take it back so the Desk keeps asking
            // (Codex round 3 on #32).
            unlink(pairedURL.path)
            // The removal must reach the disk too (Codex P1 on #34). If this
            // flush fails as well, this run keeps asking for a new key.
            if (try? DurableFile.flushFolder(folder)) == nil { pairingUnsynced = true }
            return false
        }
        pairingUnsynced = false
        return true
    }

    /// Names the recovery key the archive's copy is paired with: written
    /// only after the Desk's own copy under it is durable and every earlier
    /// copy is gone. A copy without it (one left by a failed make) never
    /// counts as coverage.
    var pairedURL: URL { folder.appendingPathComponent("paired", isDirectory: false) }

    /// Covered means the paired copy is there and it is the only copy. Any
    /// other copy (a rotation that didn't finish, a make whose Desk save
    /// wasn't confirmed) keeps the Desk asking for a new key, and the next
    /// make retries the removal (Codex round 2 on #32).
    private func isFullyPaired() -> Bool {
        guard let data = try? Data(contentsOf: pairedURL), data.count <= 64 else { return false }
        let fingerprint = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard fingerprint.count == 32, fingerprint.allSatisfy({ $0.isHexDigit }) else { return false }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return names.filter { $0.hasSuffix(".sealed") } == ["\(fingerprint).sealed"]
    }

    public func restore(with recovery: RecoveryKey) -> RecoveryCompanionRestore {
        lock.lock()
        defer { lock.unlock() }
        guard let id = archiveId() else { return .notCovered }
        // A key still held is left alone whatever the typed key covers
        // (Codex P2 on #32).
        if (try? keys.existingKey(for: id)) != nil { return .alreadyHeld }
        guard let sealed = try? Data(contentsOf: copyURL(recovery)) else { return .notCovered }
        guard let material = try? Self.open(sealed, under: recovery, archiveId: id) else { return .failed }
        do {
            _ = try keys.importKey(material, for: id)
            return .restored
        } catch KeyProviderError.keyExists {
            return .alreadyHeld
        } catch {
            return .failed
        }
    }

    public var needsRecoveryKey: Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let id = archiveId(), (try? keys.existingKey(for: id)) != nil else { return false }
        if pairingUnsynced {
            guard (try? DurableFile.flushFolder(folder)) != nil else { return true }
            pairingUnsynced = false
        }
        return !isFullyPaired()
    }

    /// Whether the archive's key is gone from this Mac (its marker names a
    /// key the key store doesn't hold): the case a restore is for.
    public var keyIsMissing: Bool {
        guard let id = archiveId() else { return false }
        do { return try keys.existingKey(for: id) == nil } catch { return false }
    }

    public enum TypedRestore: Equatable, Sendable {
        /// Not a recovery key (length, characters or check symbols).
        case malformed
        case done(RecoveryCompanionRestore)
    }

    /// Restores from a typed recovery key (the menu's restore, for when only
    /// the archive's key is gone). The typed text is never logged or kept.
    public func restore(typed text: String) -> TypedRestore {
        guard let recovery = try? RecoveryKey(typed: text) else { return .malformed }
        return .done(restore(with: recovery))
    }

    // MARK: Copy layout: `TCARCR1\n`, then nonce, ciphertext and tag.

    private static func associatedData(_ archiveId: UUID) -> Data {
        Data("\(label)/\(archiveId.uuidString.lowercased())".utf8)
    }

    private static func wrappingKey(_ recovery: RecoveryKey, archiveId: UUID) -> SymmetricKey {
        recovery.derivedKey(salt: Data(archiveId.uuidString.lowercased().utf8), info: label)
    }

    static func seal(_ material: Data, under recovery: RecoveryKey, archiveId: UUID) throws -> Data {
        let box = try AES.GCM.seal(material, using: wrappingKey(recovery, archiveId: archiveId),
                                   authenticating: associatedData(archiveId))
        guard let combined = box.combined else { throw ArchiveSeal.Failure.sealFailed }
        return header + combined
    }

    static func open(_ sealed: Data, under recovery: RecoveryKey, archiveId: UUID) throws -> Data {
        guard sealed.count > header.count + 28, sealed.prefix(header.count) == header else { throw ArchiveSeal.Failure.unreadable }
        let box = try AES.GCM.SealedBox(combined: Data(sealed.dropFirst(header.count)))
        let material = try AES.GCM.open(box, using: wrappingKey(recovery, archiveId: archiveId),
                                        authenticating: associatedData(archiveId))
        guard material.count == ArchiveSeal.keyLength else { throw ArchiveSeal.Failure.unreadable }
        return material
    }

    private func prepareFolder() throws {
        var info = stat()
        if lstat(folder.path, &info) == 0 {
            guard (info.st_mode & S_IFMT) == S_IFDIR else { throw ArchiveKeyCustody.Problem.folderUnusable }
            return
        }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: NSNumber(value: 0o700)])
        try DurableFile.flushFolder(root)
    }
}
