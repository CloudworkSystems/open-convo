import DeskHost
import Foundation
import LocalModelRoute
import ParticipantCoordinator
import ParticipantProcess
import TrueConvoIdentity

/// Step 3 PR 4b: the one place the app builds a participant lane.
///
/// In plain words: True Convo Test gets a lane that talks to Ollama on this
/// Mac (contract section 20) and, from the Claude Code adapter's PR 4b, to
/// Claude Code through `ClaudeConversation`: section 17's owner is the
/// Claude entry's availability and run claims, with the first-trial input
/// bound, and the launcher is the production one. The real True Convo app
/// gets no lane at all, exactly as before. Without a `ClaudeConversation`
/// (its folders could not be made) the Claude entry still travels first on
/// the wire (section 20.2 requires it) and is never available: shipping
/// availability, always `overflow-unverified`, no owner, and a launcher that
/// refuses every launch.
public enum LocalConversationLane {
    /// The Desk session's lane factory for `identity`: the local route in
    /// True Convo Test only, nil (no lane) for every other identity, the real
    /// app included. Nothing here runs until the Desk first opens.
    /// `claude` is the launch's Claude entry (`ClaudeConversation.make`).
    public static func factory(for identity: AppIdentity,
                               claude: ClaudeConversation? = nil) -> (@MainActor () -> any DeskParticipantLane)? {
        guard turnsOn(for: identity) else { return nil }
        return { makeCoordinator(route: OllamaClient(), launchId: UUID().uuidString.lowercased(), claude: claude) }
    }

    /// Whether the local route is on for `identity`: the test copy only.
    static func turnsOn(for identity: AppIdentity) -> Bool {
        identity.kind == .test && identity.bundleIdentifier == AppIdentity.testBundleIdentifier
    }

    /// The Claude Code entry: the off-Mac pin of contract section 21.1, with
    /// the model the owner chose for the adapter's PR 3c (October 29, 2026).
    /// Available only through `ClaudeConversation`'s two gates.
    static let claudePin = ParticipantPin(id: "claude-code", label: "Claude", model: "claude-sonnet-5-5",
                                          executionHost: "anthropic")!

    /// The coordinator the factory builds, with `route` as the local route
    /// (the real `OllamaClient` at the fixed loopback base in the app; a
    /// scripted route in tests).
    static func makeCoordinator(route: any LocalRouteLaunching, launchId: String,
                                claude: ClaudeConversation? = nil) -> ParticipantCoordinator {
        ParticipantCoordinator(configuration: configuration(route: route, launchId: launchId, claude: claude))
    }

    /// With `claude`: section 17's owner as availability and run claims, its
    /// first-trial input bound, and `claude`'s launcher. Without: shipping
    /// availability and a launcher that refuses.
    static func configuration(route: any LocalRouteLaunching, launchId: String,
                              claude: ClaudeConversation?) -> ParticipantCoordinator.Configuration {
        guard let claude else {
            return ParticipantCoordinator.Configuration(
                hostConfiguration: ParticipantHostConfiguration(pin: claudePin, localRoute: route),
                availability: CheckedAvailability(checker: ShippingAvailability()),
                launchId: launchId, clock: SystemParticipantClock(), executor: BackgroundMutationExecutor(),
                launcher: ClaudeNotConnected(), log: SystemParticipantLog())
        }
        return ParticipantCoordinator.Configuration(
            hostConfiguration: ParticipantHostConfiguration(pin: claudePin, inputBound: ParticipantLimits.firstTrialInputBound, localRoute: route),
            confirmationOwner: claude.owner,
            launchId: launchId, clock: SystemParticipantClock(), executor: BackgroundMutationExecutor(),
            launcher: claude.launcher, log: SystemParticipantLog())
    }
}

/// The Claude Code side of the lane when it is not connected: every launch
/// is refused, so nothing is spawned. Without a `ClaudeConversation` it is
/// unreachable behind availability (a start's step 13 recheck answers
/// `participant-unavailable` first), the second barrier. With one, it stands
/// in for the production launcher until section 16's run records the init
/// values that launcher expects (`ClaudeConversation.recordedInit`).
struct ClaudeNotConnected: ParticipantLaunching {
    struct Refused: Error, Equatable {}

    var cliVersion: String { ParticipantCommandLine.pinnedCLIVersion }

    func launch(_ request: ParticipantLaunchRequest) throws -> any ParticipantRunning {
        throw Refused()
    }
}
