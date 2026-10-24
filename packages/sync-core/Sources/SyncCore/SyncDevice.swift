import Foundation

/// Sync logic for one device, plus the checkpoint it can survive a quit from.
/// The app keeps the record bytes; this type keeps the outbox, the clock,
/// change tokens, and conflict copies.
public final class SyncDevice {
    public let deviceID: DeviceID
    public var wallClockMilliseconds: () -> Int64
    /// Called when the app needs to store a record or a conflict copy.
    /// The handler may confirm saves. It must not call `sync`.
    public var appSaveHandler: ((AppSaveRequest) -> Void)?

    public private(set) var logicalCounter: UInt64
    public private(set) var hasCheckpoint: Bool

    private var online = true
    private var blockedReason: String?
    private var editEpoch = 0
    private var acceptingUploadsThroughEpoch: Int?
    private var lastCheckpoint = Data()
    private var outbox: [Entry] = []
    private var tokens: [String: Data] = [:]
    private var memory: [String: RecordMemory] = [:]
    private var conflicts: [SyncRecord] = []
    private var local: [String: SyncRecord] = [:]
    private var openPage: OpenPage?
    private var merges: [String: MergeFunction] = [:]

    public init(deviceID: DeviceID) {
        self.deviceID = deviceID
        self.logicalCounter = 0
        self.hasCheckpoint = false
        self.wallClockMilliseconds = { 0 }
    }

    public static func restore(from checkpoint: Data) throws -> SyncDevice {
        let body = try CheckpointCodec.decode(checkpoint)
        let device = SyncDevice(deviceID: DeviceID(body.deviceID))
        device.logicalCounter = body.logicalCounter
        device.hasCheckpoint = true
        device.lastCheckpoint = checkpoint
        device.tokens = body.tokens
        device.memory = body.memory.mapValues {
            RecordMemory(
                lastAcknowledged: $0.lastAcknowledged,
                lastSeenChangeTag: $0.lastSeenChangeTag,
                lastSeenStamp: $0.lastSeenStamp
            )
        }
        device.conflicts = body.conflicts
        device.outbox = body.outbox.map {
            Entry(
                record: $0.record,
                baseChangeTag: $0.baseChangeTag,
                basedOnStamp: $0.basedOnStamp,
                appSaveConfirmed: $0.appSaveConfirmed,
                durable: true,
                isMergeResult: $0.isMergeResult,
                epoch: 0
            )
        }
        return device
    }

    public static func restore(from checkpoint: Data, expecting deviceID: DeviceID) throws -> SyncDevice {
        let device = try restore(from: checkpoint)
        guard device.deviceID == deviceID else {
            throw SyncError.deviceIDMismatch(found: device.deviceID, expected: deviceID)
        }
        return device
    }

    public func registerMerge(for type: String, _ merge: @escaping MergeFunction) {
        merges[type] = merge
    }

    public func saveCheckpoint() -> Data {
        hasCheckpoint = true
        for index in outbox.indices {
            outbox[index].durable = true
        }
        let body = CheckpointBody(
            schema: CheckpointCodec.schema,
            deviceID: deviceID.raw,
            logicalCounter: logicalCounter,
            tokens: tokens,
            outbox: outbox.map {
                StoredOutboxEntry(
                    record: $0.record,
                    baseChangeTag: $0.baseChangeTag,
                    basedOnStamp: $0.basedOnStamp,
                    appSaveConfirmed: $0.appSaveConfirmed,
                    isMergeResult: $0.isMergeResult
                )
            },
            memory: memory.mapValues {
                StoredMemory(
                    lastAcknowledged: $0.lastAcknowledged,
                    lastSeenChangeTag: $0.lastSeenChangeTag,
                    lastSeenStamp: $0.lastSeenStamp
                )
            },
            conflicts: conflicts
        )
        let data = CheckpointCodec.encode(body)
        lastCheckpoint = data
        return data
    }

    public func changeToken(for zone: ZoneName = .private) -> Data? {
        tokens[zone.raw]
    }

    public func nextStamp() throws -> VersionStamp {
        guard hasCheckpoint else { throw SyncError.checkpointRequired }
        logicalCounter += 1
        return VersionStamp(
            counter: logicalCounter,
            wallTimeMilliseconds: wallClockMilliseconds(),
            deviceID: deviceID
        )
    }

    public func queueLocalEdit(_ record: SyncRecord) throws {
        guard hasCheckpoint else { throw SyncError.checkpointRequired }
        try validateLocal(record)
        observe(record.stamp)
        editEpoch += 1
        outbox.removeAll { $0.record.id == record.id }
        outbox.append(Entry(
            record: record,
            baseChangeTag: memory[record.id]?.lastSeenChangeTag,
            basedOnStamp: memory[record.id]?.lastSeenStamp,
            appSaveConfirmed: false,
            durable: false,
            isMergeResult: false,
            epoch: editEpoch
        ))
        local[record.id] = record
    }

    public func confirmLocalSave(_ record: SyncRecord) throws {
        guard hasCheckpoint else { throw SyncError.checkpointRequired }
        local[record.id] = record
        if let index = outbox.firstIndex(where: { $0.record.id == record.id && $0.record.stamp == record.stamp }) {
            outbox[index].appSaveConfirmed = true
            outbox[index].record = record
        }
        guard var page = openPage, page.pending[record.id] != nil else { return }
        page.pending[record.id] = nil
        if let tag = page.tags[record.id] {
            var mem = memory[record.id] ?? RecordMemory()
            mem.lastSeenChangeTag = tag
            mem.lastSeenStamp = record.stamp
            memory[record.id] = mem
            page.tags[record.id] = nil
        }
        openPage = page
        if page.sealed && page.pending.isEmpty {
            tokens[page.zone] = page.token
            openPage = nil
        }
    }

    public func confirmConflictCopiesStored(recordIDs: [String]? = nil) {
        if let recordIDs {
            let ids = Set(recordIDs)
            conflicts.removeAll { ids.contains($0.id) }
        } else {
            conflicts.removeAll()
        }
    }

    /// The app hands over every local record after a restart. Queues this
    /// device's unsynced edits, drops queued edits the store doesn't have,
    /// and moves the clock past every stamp it was handed.
    public func reconcile(_ records: [SyncRecord]) throws {
        guard hasCheckpoint else { throw SyncError.checkpointRequired }
        var byID: [String: SyncRecord] = [:]
        for record in records {
            observe(record.stamp)
            byID[record.id] = record
        }
        outbox.removeAll { entry in
            guard let saved = byID[entry.record.id] else { return true }
            return saved.stamp != entry.record.stamp
        }
        local = byID
        for record in byID.values {
            guard record.stamp.deviceID == deviceID else { continue }
            if let acknowledged = memory[record.id]?.lastAcknowledged, record.stamp <= acknowledged {
                continue
            }
            if let index = outbox.firstIndex(where: { $0.record.id == record.id && $0.record.stamp == record.stamp }) {
                outbox[index].appSaveConfirmed = true
                outbox[index].record = record
                continue
            }
            editEpoch += 1
            outbox.append(Entry(
                record: record,
                baseChangeTag: memory[record.id]?.lastSeenChangeTag,
                basedOnStamp: memory[record.id]?.lastSeenStamp,
                appSaveConfirmed: true,
                durable: false,
                isMergeResult: false,
                epoch: editEpoch
            ))
        }
    }

    public func sync(
        with cloud: FakeCloud,
        zone: ZoneName = .private,
        order: SyncOrder = .uploadThenFetch,
        beforeApplyingUploadAcknowledgements: (() -> Void)? = nil
    ) throws {
        guard hasCheckpoint else { throw SyncError.checkpointRequired }
        do {
            switch order {
            case .uploadThenFetch:
                try push(cloud, zone: zone, beforeAcks: beforeApplyingUploadAcknowledgements)
                try pull(cloud, zone: zone)
            case .fetchThenUpload:
                try pull(cloud, zone: zone)
                try push(cloud, zone: zone, beforeAcks: beforeApplyingUploadAcknowledgements)
            }
            online = true
            blockedReason = nil
            _ = saveCheckpoint()
        } catch let error as SyncError {
            switch error {
            case .offline, .connectionDropped:
                online = false
            case .fieldTooLarge:
                blockedReason = "A change is larger than the cloud allows for an ordinary field."
            default:
                break
            }
            _ = saveCheckpoint()
            throw error
        }
    }

    public func status() -> SyncStatus {
        makeStatus(forRecordType: nil)
    }

    public func status(forRecordType type: String) -> SyncStatus {
        makeStatus(forRecordType: type)
    }

    public func conflictCopies() -> [SyncRecord] {
        conflicts
    }

    public func queuedRecords() -> [OutboxSnapshot] {
        outbox.map {
            OutboxSnapshot(
                record: $0.record,
                baseChangeTag: $0.baseChangeTag,
                basedOnStamp: $0.basedOnStamp,
                appSaveConfirmed: $0.appSaveConfirmed,
                isMergeResult: $0.isMergeResult,
                uploadable: $0.appSaveConfirmed && $0.durable
            )
        }
    }

    private func makeStatus(forRecordType type: String?) -> SyncStatus {
        let relevantConflicts = conflicts.filter { record in
            guard let type else { return true }
            return record.type == type
        }
        if !relevantConflicts.isEmpty || (type == nil && blockedReason != nil) {
            let reason = blockedReason ?? "A conflicting edit was kept and needs a look."
            return SyncStatus(kind: .needsAttention, reason: reason)
        }
        if !online {
            return SyncStatus(kind: .offline, reason: "The cloud can't be reached.")
        }
        let waitingOutbox = outbox.contains { entry in
            guard let type else { return true }
            return entry.record.type == type
        }
        let waitingPage = openPage?.pending.values.contains { record in
            guard let type else { return true }
            return record.type == type
        } ?? false
        if waitingOutbox || waitingPage {
            return SyncStatus(kind: .waiting, reason: "Changes are waiting to upload.")
        }
        return SyncStatus(kind: .synced, reason: nil)
    }

    private func push(_ cloud: FakeCloud, zone: ZoneName, beforeAcks: (() -> Void)?) throws {
        _ = saveCheckpoint()
        acceptingUploadsThroughEpoch = editEpoch
        defer { acceptingUploadsThroughEpoch = nil }
        var hookCalled = false
        var spins = 0
        while spins < 32 {
            spins += 1
            let ready = outbox.filter {
                $0.appSaveConfirmed && $0.durable && $0.epoch <= (acceptingUploadsThroughEpoch ?? $0.epoch)
            }
            if ready.isEmpty { return }
            let batch = Array(ready.prefix(max(1, cloud.uploadBatchLimit)))
            let snapshots = batch.map {
                InFlight(id: $0.record.id, stamp: $0.record.stamp, base: $0.baseChangeTag)
            }
            let requests = batch.map {
                UploadRequest(
                    record: $0.record,
                    baseChangeTag: $0.baseChangeTag,
                    storage: storage(for: $0.record.payload),
                    basedOnStamp: $0.basedOnStamp
                )
            }
            let outcomes = try cloud.upload(zone: zone, items: requests)
            if !hookCalled {
                hookCalled = true
                beforeAcks?()
            }
            for (snapshot, outcome) in zip(snapshots, outcomes) {
                switch outcome {
                case .saved(let tag), .alreadyPresent(let tag):
                    acknowledge(snapshot, tag: tag)
                case .conflict(let server):
                    try resolveConflict(snapshot: snapshot, server: server, zone: zone)
                }
            }
            _ = saveCheckpoint()
        }
        throw SyncError.syncDidNotFinish("The upload did not settle.")
    }

    private func pull(_ cloud: FakeCloud, zone: ZoneName) throws {
        if openPage != nil { return }
        var spins = 0
        while spins < 10_000 {
            spins += 1
            let page: FetchPage
            do {
                page = try cloud.fetch(
                    zone: zone,
                    since: tokens[zone.raw],
                    limit: max(1, cloud.downloadPageLimit)
                )
            } catch SyncError.tokenExpired {
                tokens[zone.raw] = nil
                continue
            }
            if page.changes.isEmpty {
                tokens[zone.raw] = page.token
                return
            }
            openPage = OpenPage(zone: zone.raw, token: page.token, pending: [:], tags: [:], sealed: false)
            for change in page.changes {
                try apply(change, zone: zone)
            }
            if var current = openPage {
                current.sealed = true
                openPage = current
                if current.pending.isEmpty {
                    tokens[zone.raw] = current.token
                    openPage = nil
                } else {
                    return
                }
            }
            if !page.more { return }
        }
        throw SyncError.syncDidNotFinish("The download did not settle.")
    }

    private func apply(_ change: CloudChange, zone: ZoneName) throws {
        observe(change.record.stamp)
        let id = change.record.id
        if let index = outbox.firstIndex(where: { $0.record.id == id && $0.record.stamp == change.record.stamp }) {
            acknowledge(InFlight(id: id, stamp: change.record.stamp, base: outbox[index].baseChangeTag), tag: change.changeTag)
            return
        }
        if let current = local[id], current.stamp == change.record.stamp {
            rememberSeen(id: id, stamp: change.record.stamp, tag: change.changeTag)
            return
        }
        if let entry = outbox.first(where: { $0.record.id == id }),
           change.record.stamp.deviceID == deviceID,
           entry.record.stamp.deviceID == deviceID,
           entry.record.stamp > change.record.stamp {
            rememberSeen(id: id, stamp: change.record.stamp, tag: change.changeTag)
            if let index = outbox.firstIndex(where: { $0.record.id == id }),
               outbox[index].baseChangeTag == nil || outbox[index].basedOnStamp == change.record.stamp {
                outbox[index].baseChangeTag = change.changeTag
                outbox[index].basedOnStamp = change.record.stamp
            }
            return
        }
        enqueueUnackedLocalEdit(id: id)
        if holdsPurge(id) || change.record.purged {
            try resolvePurge(change, zone: zone)
            return
        }
        if let entry = outbox.first(where: { $0.record.id == id }) {
            try resolveDivergent(entry: entry, remote: change, zone: zone)
            return
        }
        stageIncoming(change, zone: zone, checkpointFirst: false)
    }

    private func resolveConflict(snapshot: InFlight, server: CloudChange, zone: ZoneName) throws {
        guard let entry = outbox.first(where: { $0.record.id == snapshot.id && $0.record.stamp == snapshot.stamp }) else {
            return
        }
        if entry.record.stamp == server.record.stamp {
            acknowledge(snapshot, tag: server.changeTag)
            return
        }
        try resolveDivergent(entry: entry, remote: server, zone: zone)
    }

    private func resolveDivergent(entry: Entry, remote: CloudChange, zone: ZoneName) throws {
        observe(remote.record.stamp)
        if entry.record.purged || remote.record.purged {
            try resolvePurge(remote, zone: zone)
            return
        }
        if let merge = merges[entry.record.type] {
            try mergeAndStage(entry: entry, remote: remote, merge: merge, zone: zone)
            return
        }
        if entry.record.stamp > remote.record.stamp {
            retainConflict(remote.record)
            if let index = outbox.firstIndex(where: { $0.record.id == entry.record.id && $0.record.stamp == entry.record.stamp }) {
                outbox[index].baseChangeTag = remote.changeTag
            }
            let checkpoint = saveCheckpoint()
            deliver(AppSaveRequest(
                record: entry.record,
                replaceLocalRecord: false,
                conflictCopies: conflicts(for: entry.record.id),
                checkpointBeforeRequest: checkpoint
            ))
            return
        }
        retainConflict(entry.record)
        outbox.removeAll { $0.record.id == entry.record.id }
        let checkpoint = saveCheckpoint()
        stageIncoming(remote, zone: zone, checkpointFirst: true, checkpoint: checkpoint)
    }

    private func mergeAndStage(entry: Entry, remote: CloudChange, merge: MergeFunction, zone: ZoneName) throws {
        let output = merge(entry.record, remote.record)
        observe(entry.record.stamp)
        observe(remote.record.stamp)
        logicalCounter += 1
        let merged = SyncRecord(
            id: entry.record.id,
            type: entry.record.type,
            stamp: VersionStamp(
                counter: logicalCounter,
                wallTimeMilliseconds: wallClockMilliseconds(),
                deviceID: deviceID
            ),
            purged: output.purged,
            payload: output.payload
        )
        if output.purged {
            conflicts.removeAll { $0.id == merged.id }
        }
        outbox.removeAll { $0.record.id == merged.id }
        outbox.append(Entry(
            record: merged,
            baseChangeTag: remote.changeTag,
            basedOnStamp: remote.record.stamp,
            appSaveConfirmed: false,
            durable: false,
            isMergeResult: true,
            epoch: acceptingUploadsThroughEpoch ?? editEpoch
        ))
        let checkpoint = saveCheckpoint()
        stageIncoming(
            CloudChange(record: merged, changeTag: remote.changeTag, basedOnStamp: remote.record.stamp),
            zone: zone,
            checkpointFirst: true,
            checkpoint: checkpoint,
            deliverRecord: merged
        )
    }

    private func resolvePurge(_ change: CloudChange, zone: ZoneName) throws {
        let id = change.record.id
        conflicts.removeAll { $0.id == id }
        let remotePurge = change.record.purged
        let localPurge = holdsPurge(id)
        if remotePurge && !localPurge {
            outbox.removeAll { $0.record.id == id }
            let checkpoint = saveCheckpoint()
            stageIncoming(change, zone: zone, checkpointFirst: true, checkpoint: checkpoint)
            return
        }
        if localPurge && !remotePurge {
            if let index = outbox.firstIndex(where: { $0.record.id == id && $0.record.purged }) {
                outbox[index].baseChangeTag = change.changeTag
            } else if let purge = local[id], purge.purged {
                editEpoch += 1
                outbox.append(Entry(
                    record: purge,
                    baseChangeTag: change.changeTag,
                    basedOnStamp: memory[id]?.lastSeenStamp,
                    appSaveConfirmed: true,
                    durable: false,
                    isMergeResult: false,
                    epoch: acceptingUploadsThroughEpoch ?? editEpoch
                ))
            }
            _ = saveCheckpoint()
            return
        }
        if remotePurge {
            let ours = outbox.first { $0.record.id == id }?.record
            let winner = (ours?.purged == true && ours!.stamp > change.record.stamp) ? ours! : change.record
            if winner.stamp == change.record.stamp {
                outbox.removeAll { $0.record.id == id }
                let checkpoint = saveCheckpoint()
                stageIncoming(change, zone: zone, checkpointFirst: true, checkpoint: checkpoint)
            } else if let index = outbox.firstIndex(where: { $0.record.id == id }) {
                outbox[index].baseChangeTag = change.changeTag
                _ = saveCheckpoint()
            }
        }
    }

    private func stageIncoming(
        _ change: CloudChange,
        zone: ZoneName,
        checkpointFirst: Bool,
        checkpoint: Data? = nil,
        deliverRecord: SyncRecord? = nil
    ) {
        let incoming = deliverRecord ?? change.record
        if !incoming.purged,
           deliverRecord == nil,
           merges[incoming.type] == nil,
           let current = local[incoming.id],
           current.stamp.deviceID == deviceID,
           change.basedOnStamp != current.stamp {
            retainConflict(current)
            let saved = saveCheckpoint()
            deliverSave(incoming, tag: change.changeTag, zone: zone, checkpoint: saved)
            return
        }
        let saved = checkpoint ?? (checkpointFirst ? saveCheckpoint() : lastCheckpoint)
        deliverSave(incoming, tag: change.changeTag, zone: zone, checkpoint: saved)
    }

    private func deliverSave(_ record: SyncRecord, tag: String, zone: ZoneName, checkpoint: Data) {
        if var page = openPage {
            page.pending[record.id] = record
            page.tags[record.id] = tag
            openPage = page
        }
        deliver(AppSaveRequest(
            record: record,
            replaceLocalRecord: true,
            conflictCopies: conflicts(for: record.id),
            checkpointBeforeRequest: checkpoint
        ))
    }

    private func deliver(_ request: AppSaveRequest) {
        appSaveHandler?(request)
    }

    private func acknowledge(_ snapshot: InFlight, tag: String) {
        var mem = memory[snapshot.id] ?? RecordMemory()
        if mem.lastAcknowledged == nil || mem.lastAcknowledged! < snapshot.stamp {
            mem.lastAcknowledged = snapshot.stamp
        }
        if let index = outbox.firstIndex(where: { $0.record.id == snapshot.id }) {
            if outbox[index].record.stamp == snapshot.stamp {
                outbox.remove(at: index)
                mem.lastSeenChangeTag = tag
                mem.lastSeenStamp = snapshot.stamp
            } else if outbox[index].baseChangeTag == snapshot.base {
                outbox[index].baseChangeTag = tag
                outbox[index].basedOnStamp = snapshot.stamp
                mem.lastSeenChangeTag = tag
                mem.lastSeenStamp = snapshot.stamp
            }
        } else {
            mem.lastSeenChangeTag = tag
            mem.lastSeenStamp = snapshot.stamp
        }
        memory[snapshot.id] = mem
    }

    private func rememberSeen(id: String, stamp: VersionStamp, tag: String) {
        var mem = memory[id] ?? RecordMemory()
        mem.lastSeenChangeTag = tag
        mem.lastSeenStamp = stamp
        if stamp.deviceID == deviceID && (mem.lastAcknowledged == nil || mem.lastAcknowledged! < stamp) {
            mem.lastAcknowledged = stamp
        }
        memory[id] = mem
    }

    private func enqueueUnackedLocalEdit(id: String) {
        guard outbox.contains(where: { $0.record.id == id }) == false else { return }
        guard let current = local[id], current.stamp.deviceID == deviceID else { return }
        if let acknowledged = memory[id]?.lastAcknowledged, current.stamp <= acknowledged { return }
        editEpoch += 1
        outbox.append(Entry(
            record: current,
            baseChangeTag: memory[id]?.lastSeenChangeTag,
            basedOnStamp: memory[id]?.lastSeenStamp,
            appSaveConfirmed: true,
            durable: false,
            isMergeResult: false,
            epoch: acceptingUploadsThroughEpoch ?? editEpoch
        ))
    }

    private func holdsPurge(_ id: String) -> Bool {
        if outbox.contains(where: { $0.record.id == id && $0.record.purged }) { return true }
        if let current = local[id], current.purged { return true }
        return false
    }

    private func retainConflict(_ record: SyncRecord) {
        if conflicts.contains(where: { $0.id == record.id && $0.stamp == record.stamp }) { return }
        conflicts.append(record)
    }

    private func conflicts(for id: String) -> [SyncRecord] {
        conflicts.filter { $0.id == id }
    }

    private func validateLocal(_ record: SyncRecord) throws {
        if record.id.isEmpty || record.type.isEmpty {
            throw SyncError.invalidRecord("A record needs an id and a type.")
        }
        if record.stamp.deviceID != deviceID {
            throw SyncError.notLocalEdit
        }
    }

    private func observe(_ stamp: VersionStamp) {
        if stamp.counter > logicalCounter {
            logicalCounter = stamp.counter
        }
    }

    private func storage(for payload: Data) -> PayloadStorage {
        payload.count > SyncLimits.inlinePayloadLimit ? .attachment : .field
    }
}

private struct Entry {
    var record: SyncRecord
    var baseChangeTag: String?
    var basedOnStamp: VersionStamp?
    var appSaveConfirmed: Bool
    var durable: Bool
    var isMergeResult: Bool
    var epoch: Int
}

private struct RecordMemory {
    var lastAcknowledged: VersionStamp?
    var lastSeenChangeTag: String?
    var lastSeenStamp: VersionStamp?
}

private struct OpenPage {
    var zone: String
    var token: Data
    var pending: [String: SyncRecord]
    var tags: [String: String]
    var sealed: Bool
}

private struct InFlight {
    var id: String
    var stamp: VersionStamp
    var base: String?
}
