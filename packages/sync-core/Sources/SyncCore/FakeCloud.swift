import Foundation

struct CloudChange: Equatable {
    var record: SyncRecord
    var changeTag: String
    var basedOnStamp: VersionStamp?
}

enum UploadOutcome: Equatable {
    case saved(changeTag: String)
    case alreadyPresent(changeTag: String)
    case conflict(CloudChange)
}

struct UploadRequest {
    var record: SyncRecord
    var baseChangeTag: String?
    var storage: PayloadStorage
    var basedOnStamp: VersionStamp?
}

struct FetchPage {
    var changes: [CloudChange]
    var token: Data
    var more: Bool
}

/// In-memory stand-in for CloudKit's private database: zones, change tokens,
/// optimistic saves, batch limits, expired tokens, dropped connections, the
/// 1 MB ordinary-field limit, and asset-style attachments.
public final class FakeCloud {
    public struct CloudRecord: Equatable, Sendable {
        public var record: SyncRecord
        public var changeTag: String
        public var storage: PayloadStorage
        public var revision: Int
        public var ordinaryField: Data
        public var attachment: Data?
        public var basedOnStamp: VersionStamp?

        public init(
            record: SyncRecord,
            changeTag: String,
            storage: PayloadStorage,
            revision: Int,
            ordinaryField: Data,
            attachment: Data?,
            basedOnStamp: VersionStamp?
        ) {
            self.record = record
            self.changeTag = changeTag
            self.storage = storage
            self.revision = revision
            self.ordinaryField = ordinaryField
            self.attachment = attachment
            self.basedOnStamp = basedOnStamp
        }
    }

    public var uploadBatchLimit: Int = 400
    public var downloadPageLimit: Int = 200
    public var isReachable: Bool = true
    /// After this many new saves in the next upload, the connection drops.
    /// Saves already committed stay committed. The client receives no acks
    /// for that call. One-shot.
    public var dropAfterSuccessfulSaves: Int?
    /// The next upload that commits a new save drops the response after the
    /// save. One-shot.
    public var dropResponseAfterCommit: Bool = false
    /// After this many successful fetch pages, the next fetch drops. One-shot.
    /// Setting it starts the count over, so earlier fetches in this cloud do not count.
    public var failFetchAfterSuccessfulPages: Int? {
        didSet {
            if failFetchAfterSuccessfulPages != nil {
                pagesDelivered = 0
            }
        }
    }

    private var zones: [String: Zone] = [:]
    private var pagesDelivered = 0

    public init() {}

    public func record(_ id: String, zone: ZoneName = .private) -> CloudRecord? {
        guard let stored = zones[zone.raw]?.records[id] else { return nil }
        return stored.inspection
    }

    public func revisionCount(_ id: String, zone: ZoneName = .private) -> Int {
        zones[zone.raw]?.records[id]?.revision ?? 0
    }

    /// Saves a payload as an ordinary field, refusing anything over the
    /// modelled 1 MB CloudKit limit. Used to show the refusal itself.
    public func saveOrdinaryField(_ record: SyncRecord, zone: ZoneName = .private) throws {
        if record.payload.count > SyncLimits.cloudKitFieldLimit {
            throw SyncError.fieldTooLarge(bytes: record.payload.count, limit: SyncLimits.cloudKitFieldLimit)
        }
        _ = try commit(
            UploadRequest(record: record, baseChangeTag: nil, storage: .field, basedOnStamp: nil),
            zone: zoneName(zone),
            forceField: true
        )
    }

    /// Tokens strictly older than the zone's current head stop working.
    /// A client then has to catch up from scratch.
    public func expireTokensBeforeCurrentHead(zone: ZoneName = .private) {
        var state = self.zone(zone)
        state.oldestValidSequence = state.sequence
        zones[zone.raw] = state
    }

    func upload(zone: ZoneName, items: [UploadRequest]) throws -> [UploadOutcome] {
        try ensureReachable()
        let limit = max(1, uploadBatchLimit)
        guard items.count <= limit else {
            throw SyncError.syncDidNotFinish("Upload batch is larger than the cloud's batch limit.")
        }
        var outcomes: [UploadOutcome] = []
        var committed = 0
        for item in items {
            if let budget = dropAfterSuccessfulSaves, budget <= 0 {
                dropAfterSuccessfulSaves = nil
                throw SyncError.connectionDropped
            }
            let outcome = try commit(item, zone: zoneName(zone), forceField: false)
            outcomes.append(outcome)
            if case .saved = outcome {
                committed += 1
                if var budget = dropAfterSuccessfulSaves {
                    budget -= 1
                    dropAfterSuccessfulSaves = budget
                    if budget <= 0 {
                        dropAfterSuccessfulSaves = nil
                        throw SyncError.connectionDropped
                    }
                }
            }
        }
        if dropResponseAfterCommit && committed > 0 {
            dropResponseAfterCommit = false
            throw SyncError.connectionDropped
        }
        return outcomes
    }

    func fetch(zone: ZoneName, since token: Data?, limit: Int) throws -> FetchPage {
        try ensureReachable()
        if let failAfter = failFetchAfterSuccessfulPages, pagesDelivered >= failAfter {
            failFetchAfterSuccessfulPages = nil
            throw SyncError.connectionDropped
        }
        let pageLimit = max(1, limit)
        let name = zoneName(zone)
        let body = try decodeToken(token)
        let page: FetchPage
        switch body {
        case .none:
            page = scratchPage(zone: name, offset: 0, head: nil, limit: pageLimit)
        case .sequence(let sequence):
            page = try incrementalPage(zone: name, after: sequence, limit: pageLimit)
        case .scratch(let offset, let head):
            page = scratchPage(zone: name, offset: offset, head: head, limit: pageLimit)
        }
        pagesDelivered += 1
        return page
    }

    private func ensureReachable() throws {
        if !isReachable { throw SyncError.offline }
    }

    private func zoneName(_ zone: ZoneName) -> String { zone.raw }

    private func zone(_ zone: ZoneName) -> Zone {
        if zones[zone.raw] == nil { zones[zone.raw] = Zone() }
        return zones[zone.raw]!
    }

    private func commit(_ item: UploadRequest, zone name: String, forceField: Bool) throws -> UploadOutcome {
        var state = zones[name] ?? Zone()
        if let existing = state.records[item.record.id] {
            if existing.record.stamp == item.record.stamp {
                return .alreadyPresent(changeTag: existing.changeTag)
            }
            if item.baseChangeTag != existing.changeTag {
                return .conflict(existing.change)
            }
            let stored = try store(item, previous: existing, state: &state, forceField: forceField)
            state.records[item.record.id] = stored
            zones[name] = state
            return .saved(changeTag: stored.changeTag)
        }
        let stored = try store(item, previous: nil, state: &state, forceField: forceField)
        state.records[item.record.id] = stored
        zones[name] = state
        return .saved(changeTag: stored.changeTag)
    }

    private func store(
        _ item: UploadRequest,
        previous: StoredRecord?,
        state: inout Zone,
        forceField: Bool
    ) throws -> StoredRecord {
        let storage = forceField ? PayloadStorage.field : item.storage
        let ordinary: Data
        let attachment: Data?
        switch storage {
        case .field:
            if item.record.payload.count > SyncLimits.cloudKitFieldLimit {
                throw SyncError.fieldTooLarge(
                    bytes: item.record.payload.count,
                    limit: SyncLimits.cloudKitFieldLimit
                )
            }
            ordinary = item.record.payload
            attachment = nil
        case .attachment:
            let reference = Data("asset:\(item.record.id)".utf8)
            if reference.count > SyncLimits.cloudKitFieldLimit {
                throw SyncError.fieldTooLarge(bytes: reference.count, limit: SyncLimits.cloudKitFieldLimit)
            }
            ordinary = reference
            attachment = item.record.payload
        }
        state.sequence += 1
        let tag = "ck-\(state.sequence)"
        let purged = item.record.purged
        let stored = StoredRecord(
            record: item.record,
            changeTag: tag,
            basedOnStamp: item.basedOnStamp,
            storage: storage,
            revision: (previous?.revision ?? 0) + 1,
            ordinaryField: ordinary,
            attachment: purged ? nil : attachment
        )
        state.history.append(HistoricalVersion(
            sequence: state.sequence,
            record: stored.record,
            changeTag: tag,
            basedOnStamp: item.basedOnStamp
        ))
        return stored
    }

    private func incrementalPage(zone name: String, after sequence: Int, limit: Int) throws -> FetchPage {
        let state = zones[name] ?? Zone()
        if sequence < state.oldestValidSequence {
            throw SyncError.tokenExpired
        }
        let pending = state.history.filter { $0.sequence > sequence }
        let slice = Array(pending.prefix(limit))
        let more = pending.count > slice.count
        let newSequence = slice.last?.sequence ?? sequence
        return FetchPage(
            changes: slice.map { $0.change },
            token: encode(.sequence(newSequence)),
            more: more
        )
    }

    private func scratchPage(zone name: String, offset: Int, head frozen: Int?, limit: Int) -> FetchPage {
        let state = zones[name] ?? Zone()
        zones[name] = state
        let head = frozen ?? state.sequence
        let ids = state.records.keys.sorted()
        let slice = Array(ids.dropFirst(offset).prefix(limit))
        let next = offset + slice.count
        let more = next < ids.count
        let token: TokenBody = more ? .scratch(offset: next, head: head) : .sequence(head)
        let changes = slice.compactMap { state.records[$0]?.change }
        return FetchPage(changes: changes, token: encode(token), more: more)
    }

    private func decodeToken(_ data: Data?) throws -> TokenBody? {
        guard let data else { return nil }
        guard let body = try? JSONDecoder().decode(TokenBody.self, from: data) else {
            throw SyncError.tokenExpired
        }
        return body
    }

    private func encode(_ body: TokenBody) -> Data {
        (try? JSONEncoder().encode(body)) ?? Data()
    }
}

private struct Zone {
    var records: [String: StoredRecord] = [:]
    var history: [HistoricalVersion] = []
    var sequence: Int = 0
    var oldestValidSequence: Int = 0
}

private struct StoredRecord {
    var record: SyncRecord
    var changeTag: String
    var basedOnStamp: VersionStamp?
    var storage: PayloadStorage
    var revision: Int
    var ordinaryField: Data
    var attachment: Data?

    var change: CloudChange {
        CloudChange(record: record, changeTag: changeTag, basedOnStamp: basedOnStamp)
    }

    var inspection: FakeCloud.CloudRecord {
        FakeCloud.CloudRecord(
            record: record,
            changeTag: changeTag,
            storage: storage,
            revision: revision,
            ordinaryField: ordinaryField,
            attachment: attachment,
            basedOnStamp: basedOnStamp
        )
    }
}

private struct HistoricalVersion {
    var sequence: Int
    var record: SyncRecord
    var changeTag: String
    var basedOnStamp: VersionStamp?

    var change: CloudChange {
        CloudChange(record: record, changeTag: changeTag, basedOnStamp: basedOnStamp)
    }
}

private enum TokenBody: Codable, Equatable {
    case sequence(Int)
    case scratch(offset: Int, head: Int)
}
