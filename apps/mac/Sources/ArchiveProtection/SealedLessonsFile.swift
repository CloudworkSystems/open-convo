import CorrectionMemory
import DeskHost
import Foundation

/// The saved word fixes, sealed under the archive's key and bound to the
/// lessons file's place in the archive. A lessons file written before this
/// step is read as it is; the next save replaces it with the sealed file.
public struct SealedLessonsFile: LessonsFileProtection {
    private let seal: ArchiveSeal
    private let purpose: String

    public init(seal: ArchiveSeal, files: ArchiveFiles, lessonsFile: URL) {
        self.seal = seal
        self.purpose = files.purpose(of: lessonsFile)
    }

    public func lessonsJSON(fromStored data: Data) throws -> Data {
        // A damaged header throws like any other damage (Codex P2).
        guard ArchiveSeal.looksSealedFile(data) else { return data }
        return try seal.openFile(data, purpose: purpose)
    }

    public func storedBytes(forLessonsJSON json: Data) throws -> Data {
        try seal.sealFile(json, purpose: purpose)
    }
}

/// The Keychain service that holds archive keys, under an app's service, so
/// True Convo and True Convo Test never share one and they never mix with
/// the Desk store keys or the cloud API keys.
public enum ArchiveKeychain {
    public static func service(appKeychainService: String) -> String {
        appKeychainService + ".archive-key"
    }

    /// The Keychain item's label, as Keychain Access shows it.
    public static let label = "True Convo dictation archive key"
}

extension ArchiveKeyCustody {
    /// The app's archive key in this Mac's Keychain: this-device-only, never
    /// synchronized, readable only while the Mac is unlocked.
    public static func openInKeychain(root: URL, appKeychainService: String) -> Status {
        let keys = KeychainKeyProvider(
            service: ArchiveKeychain.service(appKeychainService: appKeychainService),
            items: SystemKeychainItems(itemLabel: ArchiveKeychain.label)
        )
        return open(root: root, keys: keys)
    }
}
