import Foundation
import XCTest
@testable import SyncCore

final class LocalStore {
    var records: [String: SyncRecord] = [:]

    func save(_ record: SyncRecord) {
        records[record.id] = record
    }

    func all() -> [SyncRecord] {
        records.values.sorted { $0.id < $1.id }
    }
}

final class Peer {
    let cloud: FakeCloud
    var device: SyncDevice
    var store = LocalStore()
    var saves: [SyncRecord] = []
    var failure: Error?
    private var merges: [String: MergeFunction] = [:]
    private var onSave: ((AppSaveRequest) -> Void)?

    init(_ id: String, cloud: FakeCloud) {
        self.cloud = cloud
        device = SyncDevice(deviceID: DeviceID(id))
        device.wallClockMilliseconds = { 1_000 }
        bind()
    }

    func boot() {
        _ = device.saveCheckpoint()
    }

    func merge(_ function: @escaping MergeFunction, type: String = "task-list") {
        merges[type] = function
        device.registerMerge(for: type, function)
    }

    /// Replaces the live device with one restored only from checkpoint bytes.
    func adopt(_ checkpoint: Data) throws {
        let restored = try SyncDevice.restore(from: checkpoint)
        restored.wallClockMilliseconds = device.wallClockMilliseconds
        device = restored
        failure = nil
        for (type, function) in merges {
            device.registerMerge(for: type, function)
        }
        bind()
    }

    func edit(
        _ id: String,
        type: String = "task-list",
        payload: Data,
        purged: Bool = false,
        confirm: Bool = true
    ) throws -> SyncRecord {
        let stamp = try device.nextStamp()
        let record = SyncRecord(id: id, type: type, stamp: stamp, purged: purged, payload: payload)
        if confirm { store.save(record) }
        try device.queueLocalEdit(record)
        if confirm { try device.confirmLocalSave(record) }
        return record
    }

    func sync(
        order: SyncOrder = .uploadThenFetch,
        beforeAcks: (() -> Void)? = nil
    ) throws {
        try device.sync(
            with: cloud,
            order: order,
            beforeApplyingUploadAcknowledgements: beforeAcks
        )
        if let failure { throw failure }
    }

    func holdSaves(_ body: @escaping (AppSaveRequest) -> Void) {
        onSave = body
    }

    func resumeSaves() {
        onSave = nil
    }

    private func bind() {
        device.appSaveHandler = { [weak self] request in
            self?.accept(request)
        }
    }

    private func accept(_ request: AppSaveRequest) {
        if let onSave {
            onSave(request)
            return
        }
        saves.append(request.record)
        guard request.replaceLocalRecord else { return }
        store.save(request.record)
        do {
            try device.confirmLocalSave(request.record)
        } catch {
            failure = error
        }
    }
}

func text(_ value: String) -> Data { Data(value.utf8) }

func payloadText(_ data: Data) -> String { String(decoding: data, as: UTF8.self) }

func syncAll(_ peers: [Peer], rounds: Int = 8) throws {
    for _ in 0..<rounds {
        for peer in peers {
            try peer.sync()
        }
    }
}

func live(_ peer: Peer, _ id: String, file: StaticString = #filePath, line: UInt = #line) -> SyncRecord {
    let record = peer.store.records[id]
    XCTAssertNotNil(record, "missing \(id)", file: file, line: line)
    return record ?? SyncRecord(
        id: id,
        type: "missing",
        stamp: VersionStamp(counter: 0, wallTimeMilliseconds: 0, deviceID: DeviceID("missing")),
        purged: false,
        payload: Data()
    )
}

func higherStamp(_ left: SyncRecord, _ right: SyncRecord) -> MergeOutput {
    let winner = left.stamp >= right.stamp ? left : right
    return MergeOutput(payload: winner.payload, purged: winner.purged)
}

func unionMerge(_ left: SyncRecord, _ right: SyncRecord) -> MergeOutput {
    MergeOutput(payload: bag(tokens(left.payload).union(tokens(right.payload))))
}

func tokens(_ data: Data) -> Set<String> {
    Set(payloadText(data).split(separator: "\n").map(String.init).filter { !$0.isEmpty })
}

func bag(_ values: Set<String>) -> Data {
    text(values.sorted().joined(separator: "\n"))
}

func sample(_ payload: String, counter: UInt64, device: String = "law") -> SyncRecord {
    SyncRecord(
        id: "shared",
        type: "task-list",
        stamp: VersionStamp(counter: counter, wallTimeMilliseconds: 1, deviceID: DeviceID(device)),
        purged: false,
        payload: text(payload)
    )
}

func holds(_ data: Data, peer: Peer) -> Bool {
    if peer.store.records.values.contains(where: { $0.payload == data }) { return true }
    if peer.device.conflictCopies().contains(where: { $0.payload == data }) { return true }
    if peer.device.queuedRecords().contains(where: { $0.record.payload == data }) { return true }
    return false
}
