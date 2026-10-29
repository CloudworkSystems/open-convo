import Foundation

/// Identity forms from the v1 agreement.
///
/// - Native-issued ids (requestId, bindingId, deliveryId, targetRequestId,
///   dictationDeliveryId) are canonical: lowercase, RFC 4122 version 4.
/// - Existing DeskState record ids (sessionId and the ids inside a record) are
///   RFC 4122 versions 1 to 5 and keep their case; the host never rewrites
///   them. `A1000000-0000-1000-8000-000000000001` stays uppercase.
/// - `connectionId` and `workspaceHandle` are opaque host-issued strings.
public extension UUID {
    /// Lowercase form, the only form the host writes for ids it issues.
    var canonicalString: String { uuidString.lowercased() }

    /// Parses a canonical lowercase UUIDv4 string; any other case, version
    /// or variant is nil.
    static func canonicalV4(_ string: String) -> UUID? {
        guard string.utf8.count == 36, string == string.lowercased(), let uuid = UUID(uuidString: string),
              uuid.rfc4122Version == 4, uuid.isRFC4122Variant else { return nil }
        return uuid
    }

    /// True for an RFC 4122 version 1 to 5 id in either case.
    static func isRecordId(_ string: String) -> Bool {
        guard string.utf8.count == 36, let uuid = UUID(uuidString: string), uuid.isRFC4122Variant else { return false }
        return (1...5).contains(uuid.rfc4122Version)
    }

    var rfc4122Version: Int { Int(uuid.6 >> 4) }
    var isRFC4122Variant: Bool { uuid.8 & 0xC0 == 0x80 }
}

/// The one rule for comparing an opaque host-issued handle, such as
/// `workspaceHandle`, with the one the host holds (participant contract
/// section 18, item 5): the same UTF-8 bytes. Swift's own `String ==` is
/// canonical equivalence, which calls "\u{00E9}" and "e\u{0301}", or "K" and
/// the Kelvin sign U+212A, equal; a handle that is only canonically
/// equivalent is another handle. Handles are never normalized, on the way in
/// or in storage. Today's `ws-<uuid>` handles are ASCII, where the two
/// comparisons agree.
public enum OpaqueHandle {
    public static func same(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf8.elementsEqual(rhs.utf8)
    }
}

/// A selection inside a draft, in UTF-16 code units (what the page's
/// `String.length` and `selectionStart` count). Byte limits elsewhere count
/// UTF-8; the two never mix.
public struct TextSelection: Codable, Equatable, Sendable {
    public let start: Int
    public let end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }

    /// `0 <= start <= end <= text.utf16.count`, and neither offset splits a
    /// surrogate pair (a whole emoji is selectable; half of one is refused).
    /// Swift strings cannot carry an unpaired surrogate, so a payload that
    /// contained one was already replaced or refused while decoding.
    public func isValid(in text: String) -> Bool {
        let units = Array(text.utf16)
        guard start >= 0, end >= start, end <= units.count else { return false }
        func splits(_ offset: Int) -> Bool {
            guard offset > 0, offset < units.count else { return false }
            return UTF16.isLeadSurrogate(units[offset - 1]) && UTF16.isTrailSurrogate(units[offset])
        }
        return !splits(start) && !splits(end)
    }

    public var jsonValue: JSONValue {
        .object(["start": .number(Double(start)), "end": .number(Double(end))])
    }
}
