import Foundation

struct StoredOutboxEntry: Codable, Equatable {
    var record: SyncRecord
    var baseChangeTag: String?
    var basedOnStamp: VersionStamp?
    var appSaveConfirmed: Bool
    var isMergeResult: Bool
}

struct StoredMemory: Codable, Equatable {
    var lastAcknowledged: VersionStamp?
    var lastSeenChangeTag: String?
    var lastSeenStamp: VersionStamp?
}

/// The checkpoint already kept the losing edit as a conflict copy, and the
/// app had not yet replaced its local record with the cloud winner.
struct PendingReplacement: Codable, Equatable {
    var losingStamp: VersionStamp
    var winnerStamp: VersionStamp
}

struct CheckpointBody: Codable, Equatable {
    var schema: Int
    var deviceID: String
    var logicalCounter: UInt64
    var tokens: [String: Data]
    var outbox: [StoredOutboxEntry]
    var memory: [String: StoredMemory]
    var conflicts: [SyncRecord]
    var pendingReplacements: [String: PendingReplacement]
}

enum CheckpointCodec {
    static let schema = 1

    static func encode(_ body: CheckpointBody) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        do {
            return try encoder.encode(body)
        } catch {
            preconditionFailure("Checkpoint encoding failed")
        }
    }

    static func decode(_ data: Data) throws -> CheckpointBody {
        let decoder = JSONDecoder()
        guard let body = try? decoder.decode(CheckpointBody.self, from: data), body.schema == schema else {
            throw SyncError.checkpointUnreadable
        }
        return body
    }
}
