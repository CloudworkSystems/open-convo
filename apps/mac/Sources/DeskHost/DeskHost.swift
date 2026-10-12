import Foundation

/// DeskHost is the native side of the Desk/Mac join proof described in
/// `docs/desk-native-join-contract.md` (v1 wire agreement, October 9). It is
/// pure Swift on purpose: no AppKit, no WebKit, no keystroke synthesis, no
/// network. The app target wraps it in a `WKWebView` message handler later
/// (handler name `trueConvoHost`, bootstrap global `trueConvoHostBootstrap`,
/// DOM event `trueconvo-host`); this module only turns a decoded request into
/// a response, pushes host events through a `HostEventSink`, and keeps the
/// invented proof store honest.
///
/// What it does:
/// - Validates the versioned envelope `{v, requestId, connectionId, generation,
///   operation, payload}` (shape, UTF-8, sizes, canonical identities,
///   safe-integer revisions) and refuses everything else with one of the fixed
///   reasons in `HostRefusal`.
/// - Checks the host-issued connection and the current document generation.
/// - Serves `host.capabilities`, `workspace.read`, `workspace.commitProof`,
///   `workspace.reconcile`, `dictation.bindDraft`, `dictation.unbindDraft` and
///   `dictation.receipt`.
/// - Pushes `dictation.final`, `dictation.receipt` and `host.connection`
///   events to the page through an injectable sink (`HostEvent`).
/// - Keeps one file-backed proof store with an atomic compare-and-commit, a
///   single-writer lock that never follows a link, a write-ahead dispatch
///   receipt log, a ledger of terminal results, never-evicted identity
///   records (id, payload hash, outcome, revision), durable delivery
///   receipts, and a retained copy of every attempted record that lost a
///   revision race. Write failures are reported by stage, and recovery reads
///   the folder rather than trusting memory.
/// - Holds one mutation barrier per workspace until the holder's result
///   reaches a valid connection (its own reply, an exact re-send, or
///   `workspace.reconcile`). A result that is durable but whose connection
///   was revoked is owed to no one: that barrier is released when a fresh
///   document joins, as a restart drops it too. An undecided result keeps
///   its barrier across reconnects and restarts. The holder's own id is
///   never refused as another mutation.
/// - Serves only manifest-listed bundle files through `AssetResolver`.
///
/// What it does not do:
/// - It never validates the Desk's record schema. The record is opaque JSON;
///   only its integer `revision` is read.
/// - It never falls back to browser storage, another folder or a default path
///   under the user's home. The caller passes the proof folder in.
/// - It never resets an established store: missing or unreadable state is
///   reported as `store-missing` / `store-corrupt` and left in place.
/// - It never encrypts. Key custody is a placeholder (`KeyProvider`); see that
///   file for the Keychain slice that replaces it.
/// - It never types, pastes or presses Return. A recording captures its
///   draft at start (`beginRecording`); its final text is pushed once, as
///   literal text, to that captured draft only, or held natively when no
///   draft was bound or the captured one changed; it is never retargeted to
///   a draft bound later. After a lock or close the recording's token is
///   revoked and late text is dropped. The Desk's own commit, carrying the
///   delivery id, is the proof that text was saved.
public enum DeskHost {
    /// Contract version carried in every request and response as `v`.
    public static let protocolVersion = 1

    /// Custom scheme the privileged view loads bundled Desk assets from.
    public static let assetScheme = "trueconvo-desk"
}

/// Agreed proof limits. These are refusal thresholds, not silent truncation,
/// and they are not the final limits for real histories.
public enum ProofLimits {
    /// Serialized workspace record, measured as canonical JSON UTF-8 bytes.
    public static let recordBytes = 1_048_576

    /// Whole request envelope, measured as the bytes received.
    public static let envelopeBytes = 1_114_112

    /// Any single string inside a payload (keys included), in UTF-8 bytes.
    public static let textItemBytes = 65_536

    /// Mutations in flight per workspace. The barrier is per workspace, not per connection.
    public static let outstandingMutations = 1

    /// Largest integer JavaScript represents exactly (2^53 - 1).
    public static let maxSafeInteger = 9_007_199_254_740_991

    /// The `limits` object reported through `host.capabilities`.
    public static var capabilitiesValue: JSONValue {
        .object([
            "recordBytes": .number(Double(recordBytes)),
            "envelopeBytes": .number(Double(envelopeBytes)),
            "textItemBytes": .number(Double(textItemBytes)),
            "outstandingMutations": .number(Double(outstandingMutations))
        ])
    }
}

/// Version strings the host reports through `host.capabilities`. Both are
/// opaque nonempty strings; neither carries a path, key or private text.
public struct HostInfo: Equatable, Sendable {
    public let appVersion: String
    public let hostBuild: String

    public init(appVersion: String, hostBuild: String) {
        precondition(!appVersion.isEmpty && !hostBuild.isEmpty, "capabilities require nonempty version strings")
        self.appVersion = appVersion
        self.hostBuild = hostBuild
    }
}
