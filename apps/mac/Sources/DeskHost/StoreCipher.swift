import CryptoKit
import Foundation

/// Step 2, PR 2: the Desk store's files are authenticated ciphertext.
///
/// AES-256-GCM with a fresh random nonce on every write (CryptoKit draws it).
/// Each file is bound to its store and its role through the associated data
/// (`open-convo.desk-store/v1/<store id>/<purpose>`), so a file copied from
/// another store, or one store file moved into another's place (an attempted
/// record standing in for the state), fails to open just like a flipped byte,
/// a truncated file or the wrong key. Nothing is ever decrypted
/// leniently: any failure is `unreadable`, and the store reports it as
/// corrupt; it never resets or rewrites.
///
/// On disk: the 8-byte header `TCDESK1\n`, then nonce (12), ciphertext and
/// tag (16). The header is not secret and not authenticated: it only marks
/// the layout, and a file without it is refused before any decryption.
///
/// The workspace marker stays plaintext: it holds only the store's id, its
/// handle and the format version, which are needed to find the key.
struct StoreCipher: Sendable {
    static let header = Data("TCDESK1\n".utf8)
    static let nonceLength = 12
    static let tagLength = 16
    /// AES-256: exactly 32 bytes. CryptoKit would accept 16 or 24 and run
    /// AES-128 or AES-192, so any other length is refused here.
    static let keyLength = 32

    enum Purpose: Sendable {
        case state
        case attempted(UUID)

        var label: String {
            switch self {
            case .state: return "state"
            case .attempted(let requestId): return "attempted/" + requestId.canonicalString
            }
        }
    }

    enum Failure: Error, Equatable, Sendable {
        /// Not this layout, or did not authenticate under this key and purpose.
        case unreadable
        /// The cipher could not seal (never expected).
        case sealFailed
        /// The key is not 32 bytes.
        case wrongKeyLength
    }

    let workspaceId: UUID
    private let key: SymmetricKey

    init(material: Data, workspaceId: UUID) throws {
        guard material.count == Self.keyLength else { throw Failure.wrongKeyLength }
        key = SymmetricKey(data: material)
        self.workspaceId = workspaceId
    }

    private func associatedData(_ purpose: Purpose) -> Data {
        Data("open-convo.desk-store/v1/\(workspaceId.canonicalString)/\(purpose.label)".utf8)
    }

    func seal(_ plaintext: Data, as purpose: Purpose) throws -> Data {
        let box: AES.GCM.SealedBox
        do { box = try AES.GCM.seal(plaintext, using: key, authenticating: associatedData(purpose)) } catch {
            throw Failure.sealFailed
        }
        guard let combined = box.combined else { throw Failure.sealFailed }
        return Self.header + combined
    }

    func open(_ sealed: Data, as purpose: Purpose) throws -> Data {
        let headerLength = Self.header.count
        guard sealed.count >= headerLength + Self.nonceLength + Self.tagLength,
              sealed.prefix(headerLength) == Self.header else { throw Failure.unreadable }
        do {
            let box = try AES.GCM.SealedBox(combined: Data(sealed.dropFirst(headerLength)))
            return try AES.GCM.open(box, using: key, authenticating: associatedData(purpose))
        } catch {
            throw Failure.unreadable
        }
    }
}

extension ProofStore {
    /// Test seam: `state.json`'s plaintext, for tests that inspect it or
    /// damage it on purpose. Throws when the file does not open.
    func plainStateForTesting() throws -> Data {
        try cipher.open(Data(contentsOf: stateURL), as: .state)
    }

    /// Test seam: seals `plaintext` as this store's state and writes it in
    /// place (not atomically), standing in for a hand-edited or damaged file
    /// that still opens under the key.
    func writePlainStateForTesting(_ plaintext: Data) throws {
        try cipher.seal(plaintext, as: .state).write(to: stateURL)
    }

    /// Test seam: an attempted record's plaintext.
    func plainAttemptedForTesting(_ requestId: UUID) throws -> Data {
        let url = attemptedDirectory.appendingPathComponent("\(requestId.canonicalString).json")
        return try cipher.open(Data(contentsOf: url), as: .attempted(requestId))
    }
}
