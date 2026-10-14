import CryptoKit
import Foundation

/// Step 2, PR 4: dictation words on disk are authenticated ciphertext.
///
/// AES-256-GCM with a fresh random nonce on every write (CryptoKit draws it),
/// under the archive's own 32-byte key (`ArchiveKeyCustody`). Each sealed
/// file or history line is bound to its archive and its place through the
/// associated data (`open-convo.archive/v1/<archive id>/<purpose>`), where the
/// purpose is the file's path inside the archive folder. A file moved into
/// another file's place, copied from another archive, flipped, truncated or
/// sealed under another key fails to open; nothing is ever opened leniently.
///
/// On disk the sealed bytes are written as text, so a sealed file opened by
/// hand says what it is instead of showing noise:
/// - a sealed file is the line `fileHeader`, then the base64 of nonce (12),
///   ciphertext and tag (16), then a newline;
/// - a sealed history line is `linePrefix` followed by the same base64.
/// The header and prefix are not secret and not authenticated: they only mark
/// the layout, and anything without them is plaintext from before this step.
public struct ArchiveSeal: Sendable {
    public static let fileHeader = "TCARCH1 This file is encrypted by True Convo. Open it from the app.\n"
    public static let linePrefix = "TCARCH1:"
    static let nonceLength = 12
    static let tagLength = 16
    /// AES-256 only: CryptoKit would quietly run AES-128 or AES-192 on a
    /// 16- or 24-byte key, so any other length is refused.
    public static let keyLength = 32

    public enum Failure: Error, Equatable, Sendable {
        /// Not this layout, or did not authenticate under this key and purpose.
        case unreadable
        /// The cipher could not seal (never expected).
        case sealFailed
        /// The key is not 32 bytes.
        case wrongKeyLength
    }

    public let archiveId: UUID
    private let key: SymmetricKey

    public init(material: Data, archiveId: UUID) throws {
        guard material.count == Self.keyLength else { throw Failure.wrongKeyLength }
        key = SymmetricKey(data: material)
        self.archiveId = archiveId
    }

    private func associatedData(_ purpose: String) -> Data {
        Data("open-convo.archive/v1/\(archiveId.uuidString.lowercased())/\(purpose)".utf8)
    }

    private func sealedBase64(_ plaintext: Data, purpose: String) throws -> String {
        let box: AES.GCM.SealedBox
        do { box = try AES.GCM.seal(plaintext, using: key, authenticating: associatedData(purpose)) } catch {
            throw Failure.sealFailed
        }
        guard let combined = box.combined else { throw Failure.sealFailed }
        return combined.base64EncodedString()
    }

    private func open(base64: String, purpose: String) throws -> Data {
        guard let combined = Data(base64Encoded: base64),
              combined.count >= Self.nonceLength + Self.tagLength else { throw Failure.unreadable }
        do {
            let box = try AES.GCM.SealedBox(combined: combined)
            return try AES.GCM.open(box, using: key, authenticating: associatedData(purpose))
        } catch {
            throw Failure.unreadable
        }
    }

    // MARK: Files

    /// Whether `stored` is a sealed file (by its header alone).
    public static func isSealedFile(_ stored: Data) -> Bool {
        stored.starts(with: Data(fileHeader.utf8))
    }

    public func sealFile(_ plaintext: Data, purpose: String) throws -> Data {
        Data((Self.fileHeader + (try sealedBase64(plaintext, purpose: purpose)) + "\n").utf8)
    }

    public func openFile(_ stored: Data, purpose: String) throws -> Data {
        let header = Data(Self.fileHeader.utf8)
        guard stored.starts(with: header) else { throw Failure.unreadable }
        var body = String(decoding: stored.dropFirst(header.count), as: UTF8.self)
        // Exactly one trailing newline is the layout; nothing else may follow.
        guard body.hasSuffix("\n") else { throw Failure.unreadable }
        body.removeLast()
        guard !body.contains("\n") else { throw Failure.unreadable }
        return try open(base64: body, purpose: purpose)
    }

    // MARK: History lines

    /// Whether one history line (without its newline) is sealed.
    public static func isSealedLine<S: StringProtocol>(_ line: S) -> Bool {
        line.hasPrefix(linePrefix)
    }

    /// One sealed history line, without a newline.
    public func sealLine(_ plaintext: Data, purpose: String) throws -> String {
        Self.linePrefix + (try sealedBase64(plaintext, purpose: purpose))
    }

    public func openLine<S: StringProtocol>(_ line: S, purpose: String) throws -> Data {
        guard line.hasPrefix(Self.linePrefix) else { throw Failure.unreadable }
        return try open(base64: String(String(line).dropFirst(Self.linePrefix.count)), purpose: purpose)
    }
}
