import DeskHost
import Foundation

// The local route's start side (contract section 20.4), as the coordinator
// sees it. LocalModelRoute's `OllamaClient` is the real one; the coordinator
// cannot import that module, so the seam lives here, beside
// `ParticipantLaunching`. INACTIVE: nothing in the app builds a host
// configuration that names a local route.

/// A local route that can start runs, not only list models. A host whose
/// `localRoute` is only `LocalCatalogReading` lists local models but never
/// starts one (`participant-changed`, nothing sent).
public protocol LocalRouteLaunching: LocalCatalogReading {
    /// Step 13's digest bind: copy the model to the run's private alias,
    /// then check a fresh catalog shows the alias with the run's exact
    /// digest and no remote marker. Carries no conversation text.
    func bindAlias(_ participant: ParticipantPin, runId: String) async -> LocalAliasBinding
    /// Deletes the run's alias, if it is in the exact generated format.
    /// Best effort: a later sweep removes what this could not.
    func deleteAlias(runId: String) async
    /// Deletes every exact-format alias except those of `keepingRunIds`.
    /// Never any other name.
    func sweepAliases(keepingRunIds: Set<String>) async
    /// Step 15 for a local run: one streaming `/api/chat` request to the
    /// alias, started at once. Never throws: a request that cannot be built
    /// ends the run `failed` `process-error` with nothing sent.
    func launchLocal(_ request: LocalRunLaunch, clock: any ParticipantClock) -> any ParticipantRunning
}

/// How step 13's bind ended (section 20.4).
public enum LocalAliasBinding: Equatable, Sendable {
    /// The alias exists with the run's exact digest: the chat names it.
    case bound(alias: String)
    /// The model moved, vanished or became remote: `participant-changed`.
    case changed
    /// The route went down: `participant-unavailable`.
    case unavailable
}

/// One earlier turn sent as context (section 20.3): `user` or `assistant`.
public struct LocalTurn: Equatable, Sendable {
    public let role: String
    public let text: String

    public init(role: String, text: String) {
        self.role = role
        self.text = text
    }
}

/// What a local start hands the route once its start record is durable.
public struct LocalRunLaunch: Sendable {
    public var identity: ParticipantRunIdentity
    /// The run's alias, from `bindAlias`.
    public var alias: String
    /// Exactly the turns the start just re-resolved and re-hashed.
    public var context: [LocalTurn]
    public var inputChunks: [String]
    /// The prepared entry's counts (sections 6 and 20.5).
    public var contextBytes: Int
    public var inputBytes: Int
    public var preparedBytes: Int

    public init(identity: ParticipantRunIdentity, alias: String, context: [LocalTurn], inputChunks: [String],
                contextBytes: Int, inputBytes: Int, preparedBytes: Int) {
        self.identity = identity
        self.alias = alias
        self.context = context
        self.inputChunks = inputChunks
        self.contextBytes = contextBytes
        self.inputBytes = inputBytes
        self.preparedBytes = preparedBytes
    }
}
