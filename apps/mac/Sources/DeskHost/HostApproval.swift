import Foundation

/// The owner's approval of sending to a host off the Mac (contract section
/// 21.4, `host-not-approved`): the plan's "Approve Anthropic once" screen,
/// in the app's own window, saved in the protected store and revocable.
///
/// It is native's own: never a page input, never part of the pin, the saved
/// choice or any identity. The page can neither give nor withdraw it, since
/// nothing on the page's wire reaches `ProofStore.approveHost` or
/// `revokeHost`. Only `anthropic`, the one off-Mac host, can be approved.
public struct HostApproval: Codable, Equatable, Sendable {
    /// The one host an approval can name (section 21.1's `executionHost`).
    public static let anthropic = "anthropic"

    public let host: String
    /// When the owner approved it, in the wire's timestamp form.
    public let approvedAt: String

    /// Nil unless `host` is `anthropic` and `approvedAt` is a real
    /// `YYYY-MM-DDTHH:MM:SS.mmmZ` time.
    public init?(host: String, approvedAt: String) {
        guard host == Self.anthropic, WireTimestamp.isValid(approvedAt) else { return nil }
        self.host = host
        self.approvedAt = approvedAt
    }

    private enum CodingKeys: String, CodingKey { case host, approvedAt }

    /// Strict: exactly `{host, approvedAt}` under the rules above, or the
    /// store reads as corrupt.
    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: AnyKey.self).allKeys.map(\.stringValue)
        guard Set(keys) == ["host", "approvedAt"], keys.count == 2 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "approval keys"))
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let approval = HostApproval(host: try container.decode(String.self, forKey: .host),
                                          approvedAt: try container.decode(String.self, forKey: .approvedAt)) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "approval value"))
        }
        self = approval
    }

    private struct AnyKey: CodingKey {
        let stringValue: String
        init?(stringValue: String) { self.stringValue = stringValue }
        var intValue: Int? { nil }
        init?(intValue: Int) { nil }
    }
}

/// Where availability reads the approval (section 21.4). Injected, like the
/// availability checks.
public protocol HostApprovalReading: Sendable {
    /// True when `host` is approved now, false when it is not, nil when the
    /// approval cannot be read (the store is locked, closed, missing or
    /// corrupt): availability then answers `check-failed`, never available.
    func isApproved(host: String) -> Bool?
}

/// No approval: every host is not approved. The default wherever no store
/// is given, so a missing store never reads as approved.
public struct NoHostApproval: HostApprovalReading {
    public init() {}
    public func isApproved(host: String) -> Bool? { false }
}
