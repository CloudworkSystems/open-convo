import DeskHost
import Foundation
import LocalModelRoute
import ParticipantCoordinator
import ParticipantProcess
import TrueConvoIdentity

/// Step 3 PR 4b: the one place the app builds a participant lane.
///
/// In plain words: True Convo Test gets a lane that talks to Ollama on this
/// Mac (contract section 20) and nothing else. The real True Convo app gets
/// no lane at all, exactly as before. The Claude Code entry still travels
/// first on the wire (section 20.2 requires it), but it is never available:
/// availability is `CheckedAvailability(checker: ShippingAvailability())`,
/// always `overflow-unverified`, there is no section 17 confirmation owner,
/// and the launcher behind it refuses every launch, so no paid path exists
/// even if every other check were bypassed. The Desk leaves the Claude entry
/// out of its picker (owner decision, October 16).
public enum LocalConversationLane {
    /// The Desk session's lane factory for `identity`: the local route in
    /// True Convo Test only, nil (no lane) for every other identity, the real
    /// app included. Nothing here runs until the Desk first opens.
    public static func factory(for identity: AppIdentity) -> (@MainActor () -> any DeskParticipantLane)? {
        guard turnsOn(for: identity) else { return nil }
        return { makeCoordinator(route: OllamaClient(), launchId: UUID().uuidString.lowercased()) }
    }

    /// Whether the local route is on for `identity`: the test copy only.
    static func turnsOn(for identity: AppIdentity) -> Bool {
        identity.kind == .test && identity.bundleIdentifier == AppIdentity.testBundleIdentifier
    }

    /// The Claude Code entry: the off-Mac pin of contract section 21.1, with
    /// the model the owner chose for the adapter's PR 3c (October 29, 2026).
    /// Still never available and never offered in the picker: availability
    /// stays shipping's, and the launcher behind it refuses.
    static let claudePin = ParticipantPin(id: "claude-code", label: "Claude", model: "claude-sonnet-5-5",
                                          executionHost: "anthropic")!

    /// The coordinator the factory builds, with `route` as the local route
    /// (the real `OllamaClient` at the fixed loopback base in the app; a
    /// scripted route in tests).
    static func makeCoordinator(route: any LocalRouteLaunching, launchId: String) -> ParticipantCoordinator {
        ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
            hostConfiguration: ParticipantHostConfiguration(pin: claudePin, localRoute: route),
            availability: CheckedAvailability(checker: ShippingAvailability()),
            launchId: launchId, clock: SystemParticipantClock(), executor: BackgroundMutationExecutor(),
            launcher: ClaudeNotConnected(), log: SystemParticipantLog()))
    }
}

/// The Claude Code side of the lane until the adapter is turned on (its PR
/// 4b): every launch is refused, so nothing is spawned. Unreachable behind
/// availability (a start's step 13 recheck answers `participant-unavailable`
/// first); this is the second barrier. The production launcher takes an
/// off-Mac run's context (section 21.3) but is built only in the tests: its
/// init expectation is section 16's values, recorded at the live check.
struct ClaudeNotConnected: ParticipantLaunching {
    struct Refused: Error, Equatable {}

    var cliVersion: String { ParticipantCommandLine.pinnedCLIVersion }

    func launch(_ request: ParticipantLaunchRequest) throws -> any ParticipantRunning {
        throw Refused()
    }
}
