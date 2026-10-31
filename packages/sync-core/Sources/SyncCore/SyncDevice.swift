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
    /// Called with checkpoint bytes as soon as they are saved, before sync
    /// continues. The host should store them. The callback must not call
    /// `saveCheckpoint` again.
    public var persistCheckpoint: ((Data) -> Void)?
    private var deliveringCheckpoint = false

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
    private var pendingReplacements: [String: PendingReplacement] = [:]
    private var pendingCleanups: [SyncRecord] = []
    private var storedConflictCopies: [SyncRecord] = []
    private var outstandingConflictSaves: [SyncRecord] = []
    /// Outstanding saves restored from a previous process. That process's
    /// callback will not run, so these do not keep a purge cleanup pending.
    private var restoredOutstandingKeys: Set<CopyKey> = []
    private var redeliveringCleanup = false
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
        device.pendingReplacements = body.pendingReplacements
        device.pendingCleanups = body.pendingCleanups
        device.storedConflictCopies = body.storedConflictCopies
        device.outstandingConflictSaves = body.outstandingConflictSaves
        device.restoredOutstandingKeys = Set(body.outstandingConflictSaves.map {
            CopyKey(id: $0.id, stamp: $0.stamp)
        })
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
            conflicts: conflicts,
            pendingReplacements: pendingReplacements,
            pendingCleanups: pendingCleanups,
            storedConflictCopies: storedConflictCopies,
            outstandingConflictSaves: outstandingConflictSaves
        )
        let data = CheckpointCodec.encode(body)
        lastCheckpoint = data
        if !deliveringCheckpoint {
            deliveringCheckpoint = true
            persistCheckpoint?(data)
            deliveringCheckpoint = false
        }
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
        if !record.purged && holdsPurge(record.id) {
            throw SyncError.recordPurged
        }
        let record = withoutPurgedPayload(record)
        let cleanup = record.purged ? stagePurgeCleanup(for: record.id) : []
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
        if !cleanup.isEmpty {
            let checkpoint = saveCheckpoint()
            deliver(AppSaveRequest(
                record: record,
                replaceLocalRecord: false,
                conflictCopies: [],
                checkpointBeforeRequest: checkpoint,
                conflictCopiesToRemove: cleanup
            ))
        }
    }

    public func confirmLocalSave(_ record: SyncRecord) throws {
        guard hasCheckpoint else { throw SyncError.checkpointRequired }
        let record = withoutPurgedPayload(record)
        if confirmationWouldRestoreOlderBytes(record) { throw SyncError.staleRevision }
        local[record.id] = record
        if let pending = pendingReplacements[record.id], record.stamp == pending.winnerStamp {
            pendingReplacements.removeValue(forKey: record.id)
        }
        if let index = outbox.firstIndex(where: { $0.record.id == record.id && $0.record.stamp == record.stamp }) {
            outbox[index].appSaveConfirmed = true
            outbox[index].record = record
        }
        retireFetchedRevisions(for: record)
    }

    /// A newer local or merged record replaces a fetched save the app has
    /// not finished. Leaving that save pending would stop every later download.
    private func retireFetchedRevisions(for record: SyncRecord) {
        guard var page = openPage else { return }
        var changed = false
        for index in page.revisions.indices {
            let pending = page.revisions[index]
            let sameRevision = pending.record.id == record.id && pending.record.stamp == record.stamp
            let superseded = pending.record.id == record.id && pending.record.stamp < record.stamp
            if pending.confirmed || (!sameRevision && !superseded) { continue }
            page.revisions[index].confirmed = true
            changed = true
        }
        guard changed else { return }
        let acceptedOnPage = page.revisions.contains {
            $0.record.id == record.id && $0.record.stamp == record.stamp
        }
        if acceptedOnPage {
            noteConfirmedRevision(record.id, on: page)
        }
        if page.sealed && page.revisions.allSatisfy(\.confirmed) {
            tokens[page.zone] = page.token
            openPage = nil
        } else {
            openPage = page
        }
    }

    /// The app stored these exact conflict copies. A newer copy of the same
    /// record stays unconfirmed until its own request is acknowledged.
    /// This does not confirm that a purge deletion finished.
    public func confirmConflictCopiesStored(_ copies: [SyncRecord]) {
        let named = Set(copies.map { key($0) })
        outstandingConflictSaves.removeAll { named.contains(key($0)) }
        let blocked = pendingCleanups.filter { named.contains(key($0)) }
        let blockedKeys = Set(blocked.map { key($0) })
        for copy in conflicts where named.contains(key(copy)) && !blockedKeys.contains(key(copy)) {
            if !storedConflictCopies.contains(where: { key($0) == key(copy) }) {
                storedConflictCopies.append(copy)
            }
        }
        conflicts.removeAll { named.contains(key($0)) && !blockedKeys.contains(key($0)) }
        // The save finished after a purge and wrote the payload back.
        if !blocked.isEmpty {
            redeliverCleanup(blocked)
        }
    }

    /// The app deleted these exact conflict copies. A copy whose storage
    /// save is still in flight stays pending, so that save cannot recreate
    /// the purged payload with nothing left to delete.
    public func confirmConflictCopiesRemoved(_ copies: [SyncRecord]) {
        let named = Set(copies.map { key($0) })
        let inFlight = Set(outstandingConflictSaves.map { key($0) }).subtracting(restoredOutstandingKeys)
        pendingCleanups.removeAll { named.contains(key($0)) && !inFlight.contains(key($0)) }
        storedConflictCopies.removeAll { named.contains(key($0)) && !inFlight.contains(key($0)) }
        outstandingConflictSaves.removeAll { named.contains(key($0)) && restoredOutstandingKeys.contains(key($0)) }
        restoredOutstandingKeys.subtract(named)
    }

    /// The app hands over every local record after a restart. Queues this
    /// device's unsynced edits, drops queued edits the store doesn't have,
    /// and moves the clock past every stamp it was handed.
    public func reconcile(_ records: [SyncRecord]) throws {
        guard hasCheckpoint else { throw SyncError.checkpointRequired }
        reissueRestoredConflictSaves()
        var byID: [String: SyncRecord] = [:]
        for record in records {
            observe(record.stamp)
            byID[record.id] = record
        }
        let finishedReplacements = pendingReplacements.compactMap { id, pending in
            byID[id]?.stamp == pending.winnerStamp ? id : nil
        }
        for id in finishedReplacements {
            pendingReplacements.removeValue(forKey: id)
        }
        outbox.removeAll { entry in
            if entry.record.purged { return false }
            if let pending = pendingReplacements[entry.record.id], pending.losingStamp == entry.record.stamp {
                return true
            }
            guard let saved = byID[entry.record.id] else { return true }
            return saved.stamp != entry.record.stamp
        }
        local = byID
        for entry in outbox where entry.record.purged && byID[entry.record.id]?.purged != true {
            local[entry.record.id] = entry.record
            let cleanup = stagePurgeCleanup(for: entry.record.id)
            let checkpoint = saveCheckpoint()
            deliver(AppSaveRequest(
                record: entry.record,
                replaceLocalRecord: true,
                conflictCopies: [],
                checkpointBeforeRequest: checkpoint,
                conflictCopiesToRemove: cleanup
            ))
        }
        for record in byID.values {
            if record.purged {
                let cleanup = stagePurgeCleanup(for: record.id)
                if !cleanup.isEmpty {
                    let checkpoint = saveCheckpoint()
                    deliver(AppSaveRequest(
                        record: withoutPurgedPayload(record),
                        replaceLocalRecord: false,
                        conflictCopies: [],
                        checkpointBeforeRequest: checkpoint,
                        conflictCopiesToRemove: cleanup
                    ))
                }
            }
            guard record.stamp.deviceID == deviceID else { continue }
            if !record.purged && holdsPurge(record.id) { continue }
            if let pending = pendingReplacements[record.id], pending.losingStamp == record.stamp {
                continue
            }
            if let acknowledged = memory[record.id]?.lastAcknowledged, record.stamp <= acknowledged {
                continue
            }
            if let index = outbox.firstIndex(where: { $0.record.id == record.id && $0.record.stamp == record.stamp }) {
                outbox[index].appSaveConfirmed = true
                outbox[index].record = withoutPurgedPayload(record)
                continue
            }
            editEpoch += 1
            outbox.append(Entry(
                record: withoutPurgedPayload(record),
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
                // A staged merge is checkpointed but not uploadable until the app
                // confirms the save. Fetching now would merge the same server
                // copy again and replace those bytes.
                if !outbox.contains(where: { $0.isMergeResult && !$0.appSaveConfirmed }) {
                    try pull(cloud, zone: zone)
                }
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
        let relevantCleanups = pendingCleanups.filter { record in
            guard let type else { return true }
            return record.type == type
        }
        if !relevantCleanups.isEmpty {
            return SyncStatus(kind: .needsAttention, reason: "A purged copy still needs to be deleted.")
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
        let waitingPage = openPage?.revisions.contains { revision in
            guard !revision.confirmed else { return false }
            guard let type else { return true }
            return revision.record.type == type
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
        while true {
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
            openPage = OpenPage(zone: zone.raw, token: page.token, revisions: [], sealed: false)
            for change in page.changes {
                observe(change.record.stamp)
            }
            // One page can list several revisions of one record. The app is
            // asked to save only the last of those, so an older save cannot
            // be written last and then skip the newest one.
            var lastIndex: [String: Int] = [:]
            for (index, change) in page.changes.enumerated() {
                lastIndex[change.record.id] = index
            }
            for (index, change) in page.changes.enumerated() where lastIndex[change.record.id] == index {
                try apply(withChainAncestry(change, on: page.changes), zone: zone)
            }
            if var current = openPage {
                current.sealed = true
                openPage = current
                if current.revisions.allSatisfy(\.confirmed) {
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

    /// The app is asked to save only the newest revision on a page. A linear
    /// chain still names each step's parent, so the newest revision's base is
    /// walked back to the stamp that came before this page.
    private func withChainAncestry(_ change: CloudChange, on page: [CloudChange]) -> CloudChange {
        if change.record.purged { return change }
        var stamp = change.basedOnStamp
        var seen: Set<VersionStamp> = [change.record.stamp]
        while let current = stamp, !seen.contains(current) {
            // The chain runs through this device's own copy. That copy is the
            // base, not a step to walk past.
            if local[change.record.id]?.stamp == current { break }
            seen.insert(current)
            guard let earlier = page.last(where: {
                $0.record.id == change.record.id && $0.record.stamp == current && !$0.record.purged
            }) else { break }
            stamp = earlier.basedOnStamp
        }
        if stamp == change.basedOnStamp { return change }
        return CloudChange(record: change.record, changeTag: change.changeTag, basedOnStamp: stamp)
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
        // A scratch fetch after a token expires replays the base this edit
        // was queued against. The matching tag is not a new server edit.
        if let entry = outbox.first(where: { $0.record.id == id }),
           let base = entry.baseChangeTag,
           base == change.changeTag {
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
        // The cloud revision is the next step after the copy this device
        // already holds, including one whose upload response was dropped.
        if remote.basedOnStamp == entry.record.stamp {
            let losing = entry.record.stamp
            outbox.removeAll { $0.record.id == entry.record.id }
            pendingReplacements[entry.record.id] = PendingReplacement(
                losingStamp: losing,
                winnerStamp: remote.record.stamp
            )
            let checkpoint = saveCheckpoint()
            stageIncoming(remote, zone: zone, checkpointFirst: true, checkpoint: checkpoint)
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
        pendingReplacements[entry.record.id] = PendingReplacement(
            losingStamp: entry.record.stamp,
            winnerStamp: remote.record.stamp
        )
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
            payload: output.purged ? Data() : output.payload
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
        let remotePurge = change.record.purged
        let localPurge = holdsPurge(id)
        let cleanup = stagePurgeCleanup(for: id)
        if remotePurge && !localPurge {
            outbox.removeAll { $0.record.id == id }
            let checkpoint = saveCheckpoint()
            stageIncoming(change, zone: zone, checkpointFirst: true, checkpoint: checkpoint, removals: cleanup)
            return
        }
        if localPurge && !remotePurge {
            if let index = outbox.firstIndex(where: { $0.record.id == id && $0.record.purged }) {
                outbox[index].baseChangeTag = change.changeTag
            } else if let purge = local[id], purge.purged {
                editEpoch += 1
                outbox.append(Entry(
                    record: withoutPurgedPayload(purge),
                    baseChangeTag: change.changeTag,
                    basedOnStamp: memory[id]?.lastSeenStamp,
                    appSaveConfirmed: true,
                    durable: false,
                    isMergeResult: false,
                    epoch: acceptingUploadsThroughEpoch ?? editEpoch
                ))
            }
            _ = saveCheckpoint()
            if !cleanup.isEmpty {
                deliver(AppSaveRequest(
                    record: withoutPurgedPayload(local[id] ?? change.record),
                    replaceLocalRecord: false,
                    conflictCopies: [],
                    checkpointBeforeRequest: lastCheckpoint,
                    conflictCopiesToRemove: cleanup
                ))
            }
            return
        }
        if remotePurge {
            let ours = outbox.first { $0.record.id == id }?.record
            let winner = (ours?.purged == true && ours!.stamp > change.record.stamp) ? ours! : change.record
            if winner.stamp == change.record.stamp {
                outbox.removeAll { $0.record.id == id }
                let checkpoint = saveCheckpoint()
                stageIncoming(change, zone: zone, checkpointFirst: true, checkpoint: checkpoint, removals: cleanup)
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
        deliverRecord: SyncRecord? = nil,
        removals: [SyncRecord] = []
    ) {
        let incoming = withoutPurgedPayload(deliverRecord ?? change.record)
        if let pending = pendingReplacements[incoming.id], incoming.stamp == pending.winnerStamp {
            let saved = checkpoint ?? lastCheckpoint
            deliverSave(incoming, tag: change.changeTag, zone: zone, checkpoint: saved, removals: removals)
            return
        }
        if !incoming.purged,
           deliverRecord == nil,
           merges[incoming.type] == nil,
           let current = local[incoming.id],
           current.stamp.deviceID == deviceID,
           change.basedOnStamp != current.stamp {
            retainConflict(current)
            let saved = saveCheckpoint()
            deliverSave(incoming, tag: change.changeTag, zone: zone, checkpoint: saved, removals: removals)
            return
        }
        let saved = checkpoint ?? (checkpointFirst ? saveCheckpoint() : lastCheckpoint)
        deliverSave(incoming, tag: change.changeTag, zone: zone, checkpoint: saved, removals: removals)
    }

    private func deliverSave(
        _ record: SyncRecord,
        tag: String,
        zone: ZoneName,
        checkpoint: Data,
        removals: [SyncRecord] = []
    ) {
        if var page = openPage {
            page.revisions.append(PendingRevision(record: record, tag: tag, confirmed: false))
            openPage = page
        }
        deliver(AppSaveRequest(
            record: record,
            replaceLocalRecord: true,
            conflictCopies: conflicts(for: record.id),
            checkpointBeforeRequest: checkpoint,
            conflictCopiesToRemove: removals
        ))
    }

    private func deliver(_ request: AppSaveRequest) {
        var request = request
        var added = false
        for copy in request.conflictCopies where !outstandingConflictSaves.contains(where: { key($0) == key(copy) }) {
            outstandingConflictSaves.append(copy)
            added = true
        }
        if added {
            request.checkpointBeforeRequest = saveCheckpoint()
        }
        appSaveHandler?(request)
    }

    /// Asks the app again to store conflict copies whose save died with the
    /// previous process. The new request stays outstanding until that save
    /// is confirmed, so a purge cannot forget the payload the save may write.
    private func reissueRestoredConflictSaves() {
        let revived = outstandingConflictSaves.filter { copy in
            restoredOutstandingKeys.contains(key(copy)) && conflicts.contains { key($0) == key(copy) }
        }
        outstandingConflictSaves.removeAll { restoredOutstandingKeys.contains(key($0)) }
        restoredOutstandingKeys.removeAll()
        guard let first = revived.first else { return }
        for copy in revived where !outstandingConflictSaves.contains(where: { key($0) == key(copy) }) {
            outstandingConflictSaves.append(copy)
        }
        let checkpoint = saveCheckpoint()
        deliver(AppSaveRequest(
            record: first,
            replaceLocalRecord: false,
            conflictCopies: revived,
            checkpointBeforeRequest: checkpoint
        ))
    }

    private func redeliverCleanup(_ copies: [SyncRecord]) {
        guard !redeliveringCleanup, let first = copies.first else { return }
        redeliveringCleanup = true
        defer { redeliveringCleanup = false }
        let record = outbox.first { $0.record.id == first.id && $0.record.purged }?.record
            ?? local[first.id].flatMap { $0.purged ? withoutPurgedPayload($0) : nil }
            ?? SyncRecord(id: first.id, type: first.type, stamp: first.stamp, purged: true, payload: Data())
        let checkpoint = saveCheckpoint()
        deliver(AppSaveRequest(
            record: record,
            replaceLocalRecord: false,
            conflictCopies: [],
            checkpointBeforeRequest: checkpoint,
            conflictCopiesToRemove: copies
        ))
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
        if let pending = pendingReplacements[id], pending.losingStamp == current.stamp { return }
        editEpoch += 1
        outbox.append(Entry(
            record: withoutPurgedPayload(current),
            baseChangeTag: memory[id]?.lastSeenChangeTag,
            basedOnStamp: memory[id]?.lastSeenStamp,
            appSaveConfirmed: true,
            durable: false,
            isMergeResult: false,
            epoch: acceptingUploadsThroughEpoch ?? editEpoch
        ))
    }

    private struct CopyKey: Hashable {
        var id: String
        var stamp: VersionStamp
    }

    private func key(_ record: SyncRecord) -> CopyKey {
        CopyKey(id: record.id, stamp: record.stamp)
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

    /// Moves conflict copies for a purged record into a checkpointed cleanup
    /// list. They stay there until the app confirms it deleted them.
    private func stagePurgeCleanup(for id: String) -> [SyncRecord] {
        let removed = conflicts.filter { $0.id == id } + storedConflictCopies.filter { $0.id == id }
        conflicts.removeAll { $0.id == id }
        storedConflictCopies.removeAll { $0.id == id }
        pendingReplacements.removeValue(forKey: id)
        for copy in removed where !pendingCleanups.contains(where: { $0.id == copy.id && $0.stamp == copy.stamp }) {
            pendingCleanups.append(copy)
        }
        return pendingCleanups.filter { $0.id == id }
    }

    /// Last-seen follows the newest fetched revision whose earlier revisions
    /// on this page are already confirmed. A later unsaved revision does not
    /// move it, and does not let the page token advance.
    /// An older revision must not replace a newer one, and must not bring an
/// edit back after a purge that was already saved.
    private func confirmationWouldRestoreOlderBytes(_ record: SyncRecord) -> Bool {
        if let current = local[record.id] {
            if current.purged && !record.purged { return true }
            if current.stamp > record.stamp && !record.purged { return true }
        }
        if let page = openPage,
           page.revisions.contains(where: {
               $0.record.id == record.id && !$0.confirmed && $0.record.stamp > record.stamp
           }) {
            return true
        }
        return false
    }

    private func noteConfirmedRevision(_ id: String, on page: OpenPage) {
        var latest: PendingRevision?
        for revision in page.revisions where revision.record.id == id {
            if !revision.confirmed { break }
            latest = revision
        }
        guard let latest else { return }
        var mem = memory[id] ?? RecordMemory()
        mem.lastSeenChangeTag = latest.tag
        mem.lastSeenStamp = latest.record.stamp
        memory[id] = mem
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

    /// A purge is a marker. Any payload handed in with it is discarded here,
    /// before the bytes can be queued or uploaded.
    private func withoutPurgedPayload(_ record: SyncRecord) -> SyncRecord {
        guard record.purged, !record.payload.isEmpty else { return record }
        var copy = record
        copy.payload = Data()
        return copy
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

private struct PendingRevision {
    var record: SyncRecord
    var tag: String
    var confirmed: Bool
}

private struct OpenPage {
    var zone: String
    var token: Data
    var revisions: [PendingRevision]
    var sealed: Bool
}

private struct InFlight {
    var id: String
    var stamp: VersionStamp
    var base: String?
}
