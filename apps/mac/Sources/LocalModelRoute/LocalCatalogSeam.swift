import DeskHost
import Foundation
import ParticipantProcess

// The local route as a participant host reads it (contract section 20.2)
// and starts runs on it (20.4): `OllamaClient` is the host's
// `LocalCatalogReading` and the coordinator's `LocalRouteLaunching`.
// INACTIVE: nothing in the app builds a client or a host configuration that
// names one.

extension OllamaClient: LocalCatalogReading {
    /// `/api/tags`, read afresh, as availability and a preparing commit's
    /// step 5 see it.
    public func localCatalog() async -> LocalCatalogAnswer {
        Self.answer(await catalog())
    }

    /// One entry per listed chat model, in the catalog's order; a model
    /// whose four fields are not valid participant strings has no usable
    /// identity and is left out, as `OllamaCatalog.parse` leaves out an
    /// over-long name.
    static func answer(_ catalog: LocalCatalog) -> LocalCatalogAnswer {
        switch catalog {
        case .unavailable(let reason):
            return .unavailable(reason: reason.rawValue)
        case .ready(let entries):
            return .ready(entries.compactMap { entry in
                ParticipantPin(id: entry.id, label: entry.label, model: entry.model, executionHost: entry.executionHost)
                    .map { LocalCatalogEntry(participant: $0, available: entry.isLocal) }
            })
        }
    }
}

extension OllamaClient: LocalRouteLaunching {
    /// Step 13's bind for the prepared participant (`name@digest`). A
    /// participant that is not a local entry's exact form binds nothing.
    public func bindAlias(_ participant: ParticipantPin, runId: String) async -> LocalAliasBinding {
        guard let entry = Self.entry(participant) else { return .changed }
        switch await bind(entry: entry, runId: runId) {
        case .bound(let alias): return .bound(alias: alias)
        case .changed: return .changed
        case .unavailable: return .unavailable
        }
    }

    public func deleteAlias(runId: String) async {
        guard let alias = OllamaAlias.name(forRunId: runId) else { return }
        await deleteAlias(alias)
    }

    public func sweepAliases(keepingRunIds: Set<String>) async {
        await sweepAliases(keeping: keepingRunIds)
    }

    public func launchLocal(_ request: LocalRunLaunch, clock: any ParticipantClock) -> any ParticipantRunning {
        let context = request.context.map { turn in
            LocalChatTurn(role: turn.role == LocalChatTurn.Role.assistant.rawValue ? .assistant : .user, text: turn.text)
        }
        return LocalChatRun.start(
            LocalChatRequest(identity: request.identity, alias: request.alias, context: context, inputChunks: request.inputChunks,
                             contextBytes: request.contextBytes, inputBytes: request.inputBytes, preparedBytes: request.preparedBytes),
            endpoint: endpoint, clock: clock, limits: .contract)
    }

    /// The catalog entry a local participant names: `ollama-local` on
    /// `this-mac`, `model` exactly its label, `@` and 64 lowercase hex.
    static func entry(_ participant: ParticipantPin) -> LocalModelEntry? {
        let name = participant.label
        let prefix = Array(name.utf8) + [0x40]
        let model = Array(participant.model.utf8)
        guard ParticipantPin.sameBytes(participant.id, LocalRoute.participantId),
              ParticipantPin.sameBytes(participant.executionHost, LocalRoute.executionHost),
              model.starts(with: prefix) else { return nil }
        let digest = String(decoding: model[prefix.count...], as: UTF8.self)
        guard OllamaCatalog.isDigest(digest) else { return nil }
        return LocalModelEntry(name: name, digest: digest, isLocal: true)
    }
}
