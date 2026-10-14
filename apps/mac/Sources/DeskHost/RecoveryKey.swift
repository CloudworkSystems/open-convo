import CryptoKit
import Security
import Foundation

/// Step 2, PR 3: the recovery key.
///
/// One random 256-bit secret the owner writes down. The store keeps only a
/// copy of its own key sealed under it (`recovery-key.sealed`), never the
/// recovery key itself, so a wiped Keychain or a replacement Mac can open
/// the store again when the owner types it in. The key is shown as 55
/// characters of Crockford base32 in groups of five; the last two bytes are
/// a checksum, so a mistyped key is caught before any decryption.
///
/// Never printed, logged or written: `description` is redacted, and only
/// `displayText` (for the one screen that shows it) spells it out.
public struct RecoveryKey: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public static let secretLength = 32
    static let checksumLength = 2
    static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    public static let characterCount = 55
    public static let groupLength = 5

    /// The 32 secret bytes.
    let secret: Data

    init(secret: Data) {
        precondition(secret.count == Self.secretLength)
        self.secret = secret
    }

    /// A fresh random recovery key.
    public static func generate() throws -> RecoveryKey {
        var bytes = Data(count: secretLength)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, secretLength, $0.baseAddress!) }
        guard status == errSecSuccess else { throw RecoveryError.randomUnavailable }
        return RecoveryKey(secret: bytes)
    }

    public var description: String { "RecoveryKey(redacted)" }
    public var debugDescription: String { description }

    /// The key as the owner writes it down: 11 groups of 5, joined by dashes.
    public var displayText: String {
        let chars = Self.encode(secret + Self.checksum(secret))
        return stride(from: 0, to: chars.count, by: Self.groupLength).map { start in
            String(chars[start..<min(start + Self.groupLength, chars.count)])
        }.joined(separator: "-")
    }

    /// Reads a typed key: case, spaces and dashes don't matter, and O, I and
    /// L read as 0, 1 and 1. Anything else, the wrong length or a failed
    /// checksum is `malformedRecoveryKey`.
    public init(typed text: String) throws {
        var values: [UInt8] = []
        for character in text.uppercased() {
            switch character {
            case " ", "-", "\n", "\t": continue
            case "O": values.append(0)
            case "I", "L": values.append(1)
            default:
                guard let index = Self.alphabet.firstIndex(of: character) else { throw RecoveryError.malformedRecoveryKey }
                values.append(UInt8(index))
            }
        }
        guard values.count == Self.characterCount else { throw RecoveryError.malformedRecoveryKey }
        let bytes = Self.decode(values, byteCount: Self.secretLength + Self.checksumLength)
        let secret = bytes.prefix(Self.secretLength)
        guard bytes.suffix(Self.checksumLength) == Self.checksum(Data(secret)) else { throw RecoveryError.malformedRecoveryKey }
        self.init(secret: Data(secret))
    }

    static func checksum(_ secret: Data) -> Data {
        Data(SHA256.hash(data: Data("open-convo.recovery-check/v1".utf8) + secret).prefix(checksumLength))
    }

    static func encode(_ data: Data) -> [Character] {
        var out: [Character] = []
        var buffer = 0
        var bits = 0
        for byte in data {
            buffer = (buffer << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                out.append(alphabet[(buffer >> bits) & 31])
            }
            buffer &= (1 << bits) - 1
        }
        if bits > 0 { out.append(alphabet[(buffer << (5 - bits)) & 31]) }
        return out
    }

    static func decode(_ values: [UInt8], byteCount: Int) -> Data {
        var out = Data()
        var buffer = 0
        var bits = 0
        for value in values {
            buffer = (buffer << 5) | Int(value)
            bits += 5
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((buffer >> bits) & 0xFF))
            }
            buffer &= (1 << bits) - 1
        }
        return out.prefix(byteCount)
    }

    /// The key that seals the store key's copy: HKDF-SHA256 of the secret,
    /// salted with the store's id, so one recovery key's copy for one store
    /// says nothing about another.
    func wrappingKey(for workspaceId: UUID) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret),
                               salt: Data(workspaceId.canonicalString.utf8),
                               info: Data("open-convo.desk-recovery/v1".utf8), outputByteCount: 32)
    }
}

public enum RecoveryError: Error, Equatable, Sendable {
    /// The typed key is not a recovery key (wrong length, characters or checksum).
    case malformedRecoveryKey
    /// The store holds no recovery copy of its key.
    case noRecoveryCopy
    /// The recovery copy did not open under this key (another key, or the
    /// copy was changed). Nothing was imported.
    case wrongRecoveryKey
    /// The store's folder or marker could not be read.
    case storeUnreadable
    case randomUnavailable
}

/// A key provider that can take back a store key recovered from its copy.
/// Like `createKey`, it refuses to replace a key it already holds.
public protocol KeyImporting: KeyProvider {
    func importKey(_ material: Data, for storeId: UUID) throws -> StoreKey
}

/// The sealed copy's layout: `TCRECV1\n`, then nonce, ciphertext and tag.
enum RecoveryCopy {
    static let fileName = "recovery-key.sealed"
    static let header = Data("TCRECV1\n".utf8)

    static func associatedData(_ workspaceId: UUID) -> Data {
        Data("open-convo.desk-recovery/v1/\(workspaceId.canonicalString)".utf8)
    }

    static func seal(storeKey material: Data, under recovery: RecoveryKey, workspaceId: UUID) throws -> Data {
        let box: AES.GCM.SealedBox
        do {
            box = try AES.GCM.seal(material, using: recovery.wrappingKey(for: workspaceId), authenticating: associatedData(workspaceId))
        } catch { throw RecoveryError.randomUnavailable }
        guard let combined = box.combined else { throw RecoveryError.randomUnavailable }
        return header + combined
    }

    static func open(_ sealed: Data, under recovery: RecoveryKey, workspaceId: UUID) throws -> Data {
        guard sealed.count > header.count + 28, sealed.prefix(header.count) == header else { throw RecoveryError.wrongRecoveryKey }
        do {
            let box = try AES.GCM.SealedBox(combined: Data(sealed.dropFirst(header.count)))
            let material = try AES.GCM.open(box, using: recovery.wrappingKey(for: workspaceId),
                                            authenticating: associatedData(workspaceId))
            guard material.count == StoreCipher.keyLength else { throw RecoveryError.wrongRecoveryKey }
            return material
        } catch {
            throw RecoveryError.wrongRecoveryKey
        }
    }
}
