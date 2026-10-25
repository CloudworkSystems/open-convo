import Foundation

/// Device that authored a version stamp. Compared lexicographically, matching
/// the household-lists tie-break.
public struct DeviceID: Hashable, Codable, Sendable, Comparable {
    public var raw: String

    public init(_ raw: String) {
        self.raw = raw
    }

    public static func < (lhs: DeviceID, rhs: DeviceID) -> Bool {
        lhs.raw < rhs.raw
    }
}

/// Total order for a change: logical counter, then wall-clock milliseconds,
/// then device ID. A higher stamp is later. The wall clock never decides
/// ahead of the counter.
public struct VersionStamp: Hashable, Codable, Sendable, Comparable {
    public var counter: UInt64
    public var wallTimeMilliseconds: Int64
    public var deviceID: DeviceID

    public init(counter: UInt64, wallTimeMilliseconds: Int64, deviceID: DeviceID) {
        self.counter = counter
        self.wallTimeMilliseconds = wallTimeMilliseconds
        self.deviceID = deviceID
    }

    public static func < (lhs: VersionStamp, rhs: VersionStamp) -> Bool {
        if lhs.counter != rhs.counter { return lhs.counter < rhs.counter }
        if lhs.wallTimeMilliseconds != rhs.wallTimeMilliseconds {
            return lhs.wallTimeMilliseconds < rhs.wallTimeMilliseconds
        }
        return lhs.deviceID < rhs.deviceID
    }
}

/// One opaque record. The payload is ciphertext to this package: nothing
/// here inspects it except to measure its size.
public struct SyncRecord: Hashable, Codable, Sendable, Equatable {
    public var id: String
    public var type: String
    public var stamp: VersionStamp
    /// Sync metadata, not part of the payload. A purged record stays gone.
    public var purged: Bool
    public var payload: Data

    public init(id: String, type: String, stamp: VersionStamp, purged: Bool, payload: Data) {
        self.id = id
        self.type = type
        self.stamp = stamp
        self.purged = purged
        self.payload = payload
    }
}

public enum PayloadStorage: String, Codable, Sendable, Equatable {
    /// Bytes sit in an ordinary record field.
    case field
    /// Bytes sit in an asset-style attachment. The ordinary field holds a short reference.
    case attachment
}

public struct ZoneName: Hashable, Codable, Sendable, Equatable {
    public var raw: String

    public init(_ raw: String) {
        self.raw = raw
    }

    public static let `private` = ZoneName("private")
}

public enum SyncStatusKind: String, Codable, Sendable, Equatable {
    case synced
    case waiting
    case offline
    case needsAttention
}

public struct SyncStatus: Equatable, Sendable {
    public var kind: SyncStatusKind
    public var reason: String?

    public init(kind: SyncStatusKind, reason: String?) {
        self.kind = kind
        self.reason = reason
    }
}

public enum SyncOrder: Sendable, Equatable {
    case uploadThenFetch
    case fetchThenUpload
}

public struct AppSaveRequest: Sendable {
    public var record: SyncRecord
    /// When true, the app's stored record for this id must become `record`.
    public var replaceLocalRecord: Bool
    public var conflictCopies: [SyncRecord]
    /// Conflict copies the app still has stored and must delete. They stay
    /// in the checkpoint until `confirmConflictCopiesRemoved`.
    public var conflictCopiesToRemove: [SyncRecord]
    /// Checkpoint written before this request. A conflict copy in here is
    /// already durable if the app is being asked to replace its record.
    public var checkpointBeforeRequest: Data

    public init(
        record: SyncRecord,
        replaceLocalRecord: Bool,
        conflictCopies: [SyncRecord],
        checkpointBeforeRequest: Data,
        conflictCopiesToRemove: [SyncRecord] = []
    ) {
        self.record = record
        self.replaceLocalRecord = replaceLocalRecord
        self.conflictCopies = conflictCopies
        self.checkpointBeforeRequest = checkpointBeforeRequest
        self.conflictCopiesToRemove = conflictCopiesToRemove
    }
}

public struct OutboxSnapshot: Equatable, Sendable {
    public var record: SyncRecord
    public var baseChangeTag: String?
    public var basedOnStamp: VersionStamp?
    public var appSaveConfirmed: Bool
    public var isMergeResult: Bool
    /// True when this entry is allowed to upload: the app confirmed the save
    /// and a checkpoint containing the entry has been saved.
    public var uploadable: Bool

    public init(
        record: SyncRecord,
        baseChangeTag: String?,
        basedOnStamp: VersionStamp?,
        appSaveConfirmed: Bool,
        isMergeResult: Bool,
        uploadable: Bool
    ) {
        self.record = record
        self.baseChangeTag = baseChangeTag
        self.basedOnStamp = basedOnStamp
        self.appSaveConfirmed = appSaveConfirmed
        self.isMergeResult = isMergeResult
        self.uploadable = uploadable
    }
}

public enum SyncError: Error, Equatable, Sendable {
    case checkpointRequired
    case checkpointUnreadable
    case deviceIDMismatch(found: DeviceID, expected: DeviceID)
    case invalidRecord(String)
    case notLocalEdit
    case offline
    case connectionDropped
    case tokenExpired
    case fieldTooLarge(bytes: Int, limit: Int)
    case syncDidNotFinish(String)
    /// A save confirmation for an older revision arrived after a newer one.
    case staleRevision
    /// A non-purged edit arrived while this device already holds a purge.
    case recordPurged
}

public enum SyncLimits {
    /// Modelled CloudKit limit: an ordinary record field cannot exceed 1 mebibyte.
    public static let cloudKitFieldLimit = 1_048_576
    /// Left unused so a real adapter can add an encryption nonce, an auth tag,
    /// and record metadata without crossing `cloudKitFieldLimit`.
    public static let inlinePayloadHeadroom = 64 * 1024
    /// Payloads at or under this size travel as ordinary fields. Larger
    /// payloads travel as asset-style attachments.
    public static let inlinePayloadLimit = cloudKitFieldLimit - inlinePayloadHeadroom
}
