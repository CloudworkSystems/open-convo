import DeskHost
import Foundation

// The local route as a participant host reads it (contract section 20.2):
// `OllamaClient` is the host's `LocalCatalogReading`. INACTIVE: nothing in
// the app builds a client or a host configuration that names one.

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
