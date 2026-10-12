import CryptoKit
import Foundation

/// SHA-256 over canonical JSON, as lowercase hex. Used only to tell an exact
/// retry from a changed payload; it is not a secret and not an integrity seal.
public enum PayloadHash {
    public static func hex(of value: JSONValue) -> String {
        SHA256.hash(data: value.canonicalData()).map { String(format: "%02x", $0) }.joined()
    }
}
