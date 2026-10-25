import Foundation
import XCTest
@testable import SyncCore

final class SyncCorePlanTests: XCTestCase {
    func test01ChangeOnAAppearsOnB() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        let note = try a.edit("page-1", type: "conversation-page", payload: text("hello from A"))
        try syncAll([a, b])
        let fetched = live(b, "page-1")
        XCTAssertEqual(fetched.payload, note.payload)
        XCTAssertEqual(fetched.stamp, note.stamp)
        XCTAssertFalse(fetched.purged)
        XCTAssertEqual(a.device.status().kind, .synced)
        XCTAssertEqual(b.device.status().kind, .synced)
    }

    func test02DifferentRecordsBothSurvive() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("shared", payload: text("seed"))
        try syncAll([a, b])
        let fromA = try a.edit("list-a", payload: text("oats"))
        let fromB = try b.edit("list-b", payload: text("rice"))
        try syncAll([a, b])
        XCTAssertEqual(live(a, "list-a").payload, fromA.payload)
        XCTAssertEqual(live(b, "list-a").payload, fromA.payload)
        XCTAssertEqual(live(a, "list-b").payload, fromB.payload)
        XCTAssertEqual(live(b, "list-b").payload, fromB.payload)
        XCTAssertEqual(live(a, "shared").payload, text("seed"))
    }

    func test03MergeWhicheverSyncsFirstIncludingHigherStampSecond() throws {
        for higherSecond in [false, true] {
            for aFirst in [true, false] {
                try assertMerged(aFirst: aFirst, higherSecond: higherSecond)
            }
        }
    }

    func test04HigherStampWinsAndConflictCopySurvivesCheckpoint() throws {
        try assertNoMerge(aHigher: true, fetchFirst: false)
        try assertNoMerge(aHigher: false, fetchFirst: false)
        try assertNoMerge(aHigher: true, fetchFirst: true)
        try assertNoMerge(aHigher: false, fetchFirst: true)
        try assertConflictCopyCheckpoint()
        try assertDestroyAfterReplaceKeepsLoserOnce()
        try assertCrashBeforeReplacementDoesNotRequeue()
    }

    func test05LogicalDeleteThenRestore() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        var merges = 0
        let merge: MergeFunction = { left, right in
            merges += 1
            return higherStamp(left, right)
        }
        a.merge(merge)
        b.merge(merge)
        a.boot()
        b.boot()
        _ = try a.edit("groceries", payload: text("milk"))
        try syncAll([a, b])
        _ = try a.device.nextStamp()
        _ = try a.device.nextStamp()
        let deletion = try a.edit("groceries", payload: text("deleted"))
        let olderEdit = try b.edit("groceries", payload: text("oat milk"))
        XCTAssertGreaterThan(deletion.stamp, olderEdit.stamp)
        try syncAll([a, b])
        XCTAssertGreaterThan(merges, 0)
        XCTAssertEqual(live(a, "groceries").payload, text("deleted"))
        XCTAssertEqual(live(b, "groceries").payload, text("deleted"))
        XCTAssertFalse(live(a, "groceries").purged)
        let restored = try a.edit("groceries", payload: text("milk"))
        try syncAll([a, b])
        XCTAssertEqual(live(a, "groceries").payload, restored.payload)
        XCTAssertEqual(live(b, "groceries").payload, restored.payload)
        XCTAssertFalse(live(b, "groceries").purged)
    }

    func test05bPurgeBeatsHigherStampAndDropsPayload() throws {
        try assertPurge(purgeFirst: true, registerMerge: false)
        try assertPurge(purgeFirst: false, registerMerge: false)
        try assertPurge(purgeFirst: true, registerMerge: true)
    }

    func test06DroppedUploadRetriesWithoutDuplicating() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        for index in 1...4 {
            _ = try a.edit("row-\(index)", payload: text("value-\(index)"))
        }
        cloud.dropAfterSuccessfulSaves = 2
        XCTAssertThrowsError(try a.sync()) { error in
            XCTAssertEqual(error as? SyncError, .connectionDropped)
        }
        XCTAssertEqual(a.device.status().kind, .offline)
        try a.sync()
        try syncAll([a, b])
        for index in 1...4 {
            let id = "row-\(index)"
            XCTAssertEqual(live(b, id).payload, text("value-\(index)"))
            XCTAssertEqual(cloud.revisionCount(id), 1)
        }
        XCTAssertEqual(b.store.records.count, 4)
    }

    func test07CatchUpIncludingExpiredToken() throws {
        let cloud = FakeCloud()
        cloud.downloadPageLimit = 3
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("seed", payload: text("seed"))
        try syncAll([a, b])
        let stale = b.device.saveCheckpoint()
        let seedBeforeCatchUp = try XCTUnwrap(b.store.records["seed"])
        for index in 1...12 {
            _ = try a.edit("item-\(index)", payload: text("n-\(index)"))
        }
        _ = try a.edit("seed", payload: text("seed-updated"))
        _ = try a.edit("item-3", payload: text("n-3-revised"))
        try a.sync()
        let incremental = Peer("phone-b", cloud: cloud)
        try incremental.adopt(stale)
        incremental.store = b.store
        try syncAll([a, incremental])
        let expired = Peer("phone-b", cloud: cloud)
        try expired.adopt(stale)
        expired.store.save(seedBeforeCatchUp)
        cloud.expireTokensBeforeCurrentHead()
        try syncAll([a, expired])
        for peer in [incremental, expired] {
            XCTAssertEqual(live(peer, "seed").payload, text("seed-updated"))
            for index in 1...12 {
                let expected = index == 3 ? "n-3-revised" : "n-\(index)"
                XCTAssertEqual(live(peer, "item-\(index)").payload, text(expected))
            }
        }
    }

    func test08WrongWallClockStillFollowsStamps() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        for _ in 0..<4 { _ = try b.device.nextStamp() }
        a.device.wallClockMilliseconds = { 3_600_000 }
        b.device.wallClockMilliseconds = { 1_000 }
        let fromA = try a.edit("note", payload: text("from the fast clock"))
        let fromB = try b.edit("note", payload: text("from the ahead counter"))
        XCTAssertGreaterThan(fromA.stamp.wallTimeMilliseconds, fromB.stamp.wallTimeMilliseconds)
        XCTAssertGreaterThan(fromB.stamp, fromA.stamp)
        try syncAll([a, b])
        XCTAssertEqual(live(a, "note").payload, fromB.payload)
        XCTAssertEqual(live(b, "note").payload, fromB.payload)
        XCTAssertEqual(live(a, "note").stamp, fromB.stamp)
    }

    func test09PayloadBytesAreUnchanged() throws {
        var bytes = Data([0, 1, 2, 255, 10, 13])
        bytes.append(contentsOf: [0x80, 0x00, 0xff])
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("blob", type: "memory-item", payload: bytes)
        try syncAll([a, b])
        XCTAssertEqual(live(b, "blob").payload, bytes)
        XCTAssertEqual(cloud.record("blob")?.record.payload, bytes)
    }

    func test10StatusThroughASyncCycle() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        XCTAssertEqual(a.device.status().kind, .synced)
        XCTAssertNil(a.device.status().reason)
        _ = try a.edit("list", type: "task-list", payload: text("waiting"))
        XCTAssertEqual(a.device.status().kind, .waiting)
        XCTAssertEqual(a.device.status(forRecordType: "task-list").kind, .waiting)
        XCTAssertEqual(a.device.status(forRecordType: "memory-item").kind, .synced)
        cloud.isReachable = false
        XCTAssertThrowsError(try a.sync()) { error in
            XCTAssertEqual(error as? SyncError, .offline)
        }
        XCTAssertEqual(a.device.status().kind, .offline)
        XCTAssertEqual(a.device.status(forRecordType: "task-list").kind, .offline)
        XCTAssertNotNil(a.device.status().reason)
        cloud.isReachable = true
        try syncAll([a, b])
        XCTAssertEqual(a.device.status().kind, .synced)
        XCTAssertEqual(b.device.status().kind, .synced)
        XCTAssertEqual(live(b, "list").payload, text("waiting"))
    }

    func test11DroppedDownloadResumesFromSavedToken() throws {
        let cloud = FakeCloud()
        cloud.downloadPageLimit = 2
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        for index in 1...6 {
            _ = try a.edit("row-\(index)", payload: text("v-\(index)"))
        }
        try a.sync()
        cloud.failFetchAfterSuccessfulPages = 1
        XCTAssertThrowsError(try b.sync()) { error in
            XCTAssertEqual(error as? SyncError, .connectionDropped)
        }
        XCTAssertEqual(b.store.records.count, 2)
        let partial = b.device.saveCheckpoint()
        let resumed = Peer("phone-b", cloud: cloud)
        try resumed.adopt(partial)
        resumed.store = b.store
        try resumed.device.reconcile(b.store.all())
        try syncAll([resumed])
        XCTAssertEqual(resumed.store.records.count, 6)
        for index in 1...6 {
            XCTAssertEqual(live(resumed, "row-\(index)").payload, text("v-\(index)"))
            XCTAssertEqual(cloud.revisionCount("row-\(index)"), 1)
        }
    }

    func test12FetchedCounterPushesTheNextLocalStamp() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        let high = SyncRecord(
            id: "note",
            type: "memory-item",
            stamp: VersionStamp(counter: 8_000, wallTimeMilliseconds: 50, deviceID: a.device.deviceID),
            purged: false,
            payload: text("far")
        )
        a.store.save(high)
        try a.device.reconcile([high])
        try syncAll([a, b])
        XCTAssertGreaterThanOrEqual(b.device.logicalCounter, 8_000)
        let stamp = try b.device.nextStamp()
        XCTAssertGreaterThan(stamp.counter, high.stamp.counter)
        let edited = SyncRecord(id: "note", type: "memory-item", stamp: stamp, purged: false, payload: text("closer"))
        b.store.save(edited)
        try b.device.queueLocalEdit(edited)
        try b.device.confirmLocalSave(edited)
        try syncAll([a, b])
        XCTAssertEqual(live(a, "note").payload, text("closer"))
        XCTAssertEqual(live(b, "note").stamp, stamp)
        XCTAssertGreaterThan(live(a, "note").stamp, high.stamp)
        XCTAssertEqual(a.device.status().kind, .synced)
        XCTAssertTrue(a.device.conflictCopies().isEmpty)
    }

    func test13CheckpointInTheMiddleOfUploadAndDownload() throws {
        let uploadCloud = FakeCloud()
        let a = Peer("phone-a", cloud: uploadCloud)
        let b = Peer("phone-b", cloud: uploadCloud)
        a.boot()
        b.boot()
        for index in 1...4 {
            _ = try a.edit("up-\(index)", payload: text("u-\(index)"))
        }
        let beforeUpload = try roundTrip(a.device.saveCheckpoint())
        uploadCloud.dropAfterSuccessfulSaves = 2
        XCTAssertThrowsError(try a.sync())
        let recovered = Peer("phone-a", cloud: uploadCloud)
        try recovered.adopt(beforeUpload)
        recovered.store = a.store
        try recovered.device.reconcile(a.store.all())
        try syncAll([recovered, b])
        for index in 1...4 {
            XCTAssertEqual(live(b, "up-\(index)").payload, text("u-\(index)"))
            XCTAssertEqual(uploadCloud.revisionCount("up-\(index)"), 1)
        }

        let downloadCloud = FakeCloud()
        downloadCloud.downloadPageLimit = 2
        let source = Peer("phone-a", cloud: downloadCloud)
        let reader = Peer("phone-b", cloud: downloadCloud)
        source.boot()
        reader.boot()
        for index in 1...4 {
            _ = try source.edit("down-\(index)", payload: text("d-\(index)"))
        }
        try source.sync()
        downloadCloud.failFetchAfterSuccessfulPages = 1
        XCTAssertThrowsError(try reader.sync())
        let midDownload = reader.device.saveCheckpoint()
        let restarted = Peer("phone-b", cloud: downloadCloud)
        try restarted.adopt(midDownload)
        restarted.store = reader.store
        try restarted.device.reconcile(reader.store.all())
        try syncAll([restarted])
        XCTAssertEqual(restarted.store.records.count, 4)
        for index in 1...4 {
            XCTAssertEqual(live(restarted, "down-\(index)").payload, text("d-\(index)"))
            XCTAssertEqual(downloadCloud.revisionCount("down-\(index)"), 1)
        }
    }

    func test14FieldLimitAndAttachments() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        let small = Data(repeating: 7, count: 32)
        let large = Data(repeating: 9, count: SyncLimits.inlinePayloadLimit + 8)
        _ = try a.edit("small", payload: small)
        _ = try a.edit("large", payload: large)
        try syncAll([a, b])
        let smallRecord = try XCTUnwrap(cloud.record("small"))
        let largeRecord = try XCTUnwrap(cloud.record("large"))
        XCTAssertEqual(smallRecord.storage, .field)
        XCTAssertNil(smallRecord.attachment)
        XCTAssertEqual(smallRecord.ordinaryField, small)
        XCTAssertEqual(largeRecord.storage, .attachment)
        XCTAssertEqual(largeRecord.attachment, large)
        XCTAssertLessThanOrEqual(largeRecord.ordinaryField.count, SyncLimits.cloudKitFieldLimit)
        XCTAssertEqual(live(b, "small").payload, small)
        XCTAssertEqual(live(b, "large").payload, large)

        let oversized = SyncRecord(
            id: "too-big",
            type: "memory-item",
            stamp: VersionStamp(counter: 1, wallTimeMilliseconds: 1, deviceID: DeviceID("probe")),
            purged: false,
            payload: Data(count: SyncLimits.cloudKitFieldLimit + 1)
        )
        XCTAssertThrowsError(try cloud.saveOrdinaryField(oversized)) { error in
            guard case SyncError.fieldTooLarge = error else {
                return XCTFail("expected a field-limit error, got \(error)")
            }
        }
        XCTAssertNil(cloud.record("too-big"))
    }

    func test15EditDuringUploadStaysQueued() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        let first = try a.edit("note", payload: text("first"))
        var newer: SyncRecord?
        try a.sync(beforeAcks: {
            do {
                newer = try a.edit("note", payload: text("second"))
            } catch {
                XCTFail("edit during upload failed: \(error)")
            }
            XCTAssertEqual(cloud.record("note")?.record.stamp, first.stamp)
            XCTAssertEqual(a.device.queuedRecords().map { $0.record.payload }, [text("second")])
        })
        let second = try XCTUnwrap(newer)
        XCTAssertEqual(cloud.record("note")?.record.payload, text("first"))
        XCTAssertEqual(a.device.queuedRecords().map(\.record.stamp), [second.stamp])
        try syncAll([a, b])
        XCTAssertEqual(live(b, "note").payload, text("second"))
        XCTAssertEqual(cloud.record("note")?.record.stamp, second.stamp)
        XCTAssertEqual(cloud.revisionCount("note"), 2)
    }

    func test16ThreeDevicesAndMergeLaws() throws {
        let good = MergeLaws.check(unionMerge, samples: [sample("A", counter: 1), sample("B", counter: 2), sample("C", counter: 3)])
        XCTAssertTrue(good.isEmpty, "\(good)")
        let bad = MergeLaws.check({ left, right in
            let x = Int(payloadText(left.payload)) ?? 0
            let y = Int(payloadText(right.payload)) ?? 0
            return MergeOutput(payload: text("\(x - y)"))
        }, samples: [sample("5", counter: 1), sample("3", counter: 2), sample("1", counter: 3)])
        XCTAssertTrue(bad.contains { $0.law == .associative })

        let names = ["A", "B", "C"]
        for order in permutations(names) {
            try assertThreeDeviceOrder(order, replayFirst: true)
        }
        try assertThreeDeviceOrder(["A", "A", "B", "C"], replayFirst: false)
    }

    func test17ReconcileAfterACrash() throws {
        try case17EditSavedBeforeCheckpoint()
        try case17QueuedEntryWithoutLocalRecord()
        try case17PurgeSavedBeforeCheckpoint()
        try case17EditMeetsRemoteChange()
        try case17FetchedCopyIsNotReuploaded()
        try case17LostAcknowledgementIsRecognized()
        try case17HeldFetchIsReplayed()
        try case17FirstCheckpointBeforeAnyEdit()
    }

    func test18RetrySendsTheSameMergeBytes() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        var calls = 0
        let merge: MergeFunction = { left, right in
            calls += 1
            var payload = bag(tokens(left.payload).union(tokens(right.payload)))
            payload.append(UInt8.random(in: 0...255))
            return MergeOutput(payload: payload)
        }
        a.merge(merge)
        b.merge(merge)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        _ = try a.edit("note", payload: text("from-a"))
        _ = try b.edit("note", payload: text("from-b"))
        try b.sync()
        let revisionAfterB = cloud.revisionCount("note")
        cloud.dropResponseAfterCommit = true
        XCTAssertThrowsError(try a.sync()) { error in
            XCTAssertEqual(error as? SyncError, .connectionDropped)
        }
        XCTAssertEqual(calls, 1)
        let saved = try XCTUnwrap(cloud.record("note"))
        XCTAssertEqual(cloud.revisionCount("note"), revisionAfterB + 1)
        try a.sync()
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(cloud.revisionCount("note"), revisionAfterB + 1)
        XCTAssertEqual(cloud.record("note")?.record.payload, saved.record.payload)
        try syncAll([a, b])
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(live(b, "note").payload, saved.record.payload)
        XCTAssertEqual(live(a, "note").payload, saved.record.payload)
    }

    func test19FetchBeforeUploadStillMerges() throws {
        try assertFetchBeforeUploadMerges()
        try assertReconcileKeepsSavedMerge()
        try assertUnsavedMergeIsRebuiltFromTheOldEdit()
    }

    func testDeferredMergeSaveRunsOnce() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        var calls = 0
        var firstPayload: Data?
        a.merge { left, right in
            calls += 1
            var payload = bag(tokens(left.payload).union(tokens(right.payload)))
            payload.append(UInt8.random(in: 0...255))
            if calls == 1 { firstPayload = payload }
            return MergeOutput(payload: payload)
        }
        b.merge { left, right in
            calls += 1
            return unionMerge(left, right)
        }
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        _ = try a.edit("note", payload: text("from-a"))
        _ = try b.edit("note", payload: text("from-b"))
        try b.sync()
        a.holdSaves { _ in }
        try a.sync()
        XCTAssertEqual(calls, 1)
        let staged = try XCTUnwrap(a.device.queuedRecords().first { $0.isMergeResult })
        XCTAssertFalse(staged.appSaveConfirmed)
        XCTAssertFalse(staged.uploadable)
        XCTAssertEqual(staged.record.payload, firstPayload)
        XCTAssertEqual(cloud.record("note")?.record.payload, text("from-b"))
    }

    func testPurgeDropsLeftoverPayloadBytes() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        let secret = text("private note that must not travel")
        _ = try a.edit("page", type: "conversation-page", payload: secret)
        try syncAll([a, b])
        let stamp = try a.device.nextStamp()
        let purge = SyncRecord(
            id: "page",
            type: "conversation-page",
            stamp: stamp,
            purged: true,
            payload: secret
        )
        try a.device.queueLocalEdit(purge)
        let queued = try XCTUnwrap(a.device.queuedRecords().first { $0.record.id == "page" })
        XCTAssertTrue(queued.record.purged)
        XCTAssertTrue(queued.record.payload.isEmpty)
        try a.device.confirmLocalSave(purge)
        XCTAssertTrue(a.device.queuedRecords().first { $0.record.id == "page" }?.record.payload.isEmpty == true)
        try syncAll([a, b])
        let stored = try XCTUnwrap(cloud.record("page"))
        XCTAssertTrue(stored.record.purged)
        XCTAssertTrue(stored.record.payload.isEmpty)
        XCTAssertNotEqual(stored.ordinaryField, secret)
        XCTAssertNil(stored.attachment)
        XCTAssertTrue(live(b, "page").purged)
        XCTAssertTrue(live(b, "page").payload.isEmpty)
        XCTAssertFalse(holds(secret, peer: b))
    }

    func testUploadContinuesPast32Batches() throws {
        let cloud = FakeCloud()
        cloud.uploadBatchLimit = 1
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        for index in 1...40 {
            _ = try a.edit("row-\(index)", payload: text("value-\(index)"))
        }
        try a.sync()
        try b.sync()
        XCTAssertTrue(a.device.queuedRecords().isEmpty)
        for index in 1...40 {
            XCTAssertEqual(live(b, "row-\(index)").payload, text("value-\(index)"))
            XCTAssertEqual(cloud.revisionCount("row-\(index)"), 1)
        }
    }

    func testEachFetchedRevisionIsConfirmedBeforeTheTokenMoves() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let tokenBefore = b.device.changeToken()
        let first = try a.edit("note", payload: text("revision-one"))
        try a.sync()
        let second = try a.edit("note", payload: text("revision-two"))
        try a.sync()
        let third = try a.edit("note", payload: text("revision-three"))
        try a.sync()
        var requests: [AppSaveRequest] = []
        b.holdSaves { requests.append($0) }
        try b.sync()
        XCTAssertEqual(requests.map(\.record.payload), [third.payload])
        XCTAssertNotEqual(requests[0].record.payload, first.payload)
        XCTAssertNotEqual(requests[0].record.payload, second.payload)
        XCTAssertEqual(b.device.changeToken(), tokenBefore)
        XCTAssertThrowsError(try b.device.confirmLocalSave(first)) { error in
            XCTAssertEqual(error as? SyncError, .staleRevision)
        }
        XCTAssertEqual(b.device.changeToken(), tokenBefore)
        XCTAssertEqual(b.store.records["note"]?.payload, text("base"))
        let checkpoint = b.device.saveCheckpoint()
        try b.adopt(checkpoint)
        b.resumeSaves()
        try b.device.reconcile(b.store.all())
        try b.sync()
        XCTAssertEqual(live(b, "note").payload, third.payload)
        XCTAssertNotEqual(b.device.changeToken(), tokenBefore)
    }

    func testOutOfOrderSaveCannotSkipANewerRevision() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let tokenBefore = b.device.changeToken()
        let edit = try a.edit("note", payload: text("edited note"))
        try a.sync()
        let purge = try a.edit("note", payload: edit.payload, purged: true)
        try a.sync()
        var requests: [AppSaveRequest] = []
        b.holdSaves { requests.append($0) }
        try b.sync()
        XCTAssertEqual(requests.count, 1)
        XCTAssertTrue(requests[0].record.purged)
        XCTAssertTrue(requests[0].record.payload.isEmpty)
        b.store.save(requests[0].record)
        try b.device.confirmLocalSave(requests[0].record)
        XCTAssertThrowsError(try b.device.confirmLocalSave(edit)) { error in
            XCTAssertEqual(error as? SyncError, .staleRevision)
        }
        XCTAssertTrue(live(b, "note").purged)
        XCTAssertTrue(live(b, "note").payload.isEmpty)
        XCTAssertNotEqual(b.device.changeToken(), tokenBefore)
        let checkpoint = b.device.saveCheckpoint()
        try b.adopt(checkpoint)
        b.resumeSaves()
        try b.device.reconcile(b.store.all())
        try b.sync()
        XCTAssertTrue(live(b, "note").purged)
        XCTAssertFalse(holds(edit.payload, peer: b))
        XCTAssertEqual(live(b, "note").stamp, purge.stamp)
    }

    func testPurgeCleanupStaysUntilTheAppConfirms() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let fromA = try a.edit("note", payload: text("alpha-secret"))
        for _ in 0..<3 { _ = try b.device.nextStamp() }
        _ = try b.edit("note", payload: text("beta"))
        try b.sync()
        var captured: Data?
        a.holdSaves { request in
            captured = request.checkpointBeforeRequest
        }
        try a.sync(order: .fetchThenUpload)
        let checkpoint = try XCTUnwrap(captured)
        let restored = try SyncDevice.restore(from: checkpoint)
        XCTAssertTrue(restored.conflictCopies().contains { $0.payload == fromA.payload })
        let purge = SyncRecord(
            id: "note",
            type: "task-list",
            stamp: VersionStamp(counter: 9, wallTimeMilliseconds: 1, deviceID: a.device.deviceID),
            purged: true,
            payload: Data()
        )
        a.store.save(purge)
        try a.adopt(checkpoint)
        var notices: [AppSaveRequest] = []
        a.holdSaves { notices.append($0) }
        try a.device.reconcile(a.store.all())
        XCTAssertTrue(notices.contains { $0.conflictCopiesToRemove.contains { $0.payload == fromA.payload } })
        XCTAssertEqual(a.device.status().kind, .needsAttention)
        let kept = a.device.saveCheckpoint()
        notices.removeAll()
        try a.adopt(kept)
        a.holdSaves { notices.append($0) }
        try a.device.reconcile(a.store.all())
        XCTAssertTrue(notices.contains { $0.conflictCopiesToRemove.contains { $0.payload == fromA.payload } })
        a.device.confirmConflictCopiesStored(recordIDs: ["note"])
        let cleared = a.device.saveCheckpoint()
        notices.removeAll()
        try a.adopt(cleared)
        a.holdSaves { notices.append($0) }
        try a.device.reconcile(a.store.all())
        XCTAssertFalse(notices.contains { !$0.conflictCopiesToRemove.isEmpty })
        XCTAssertNotEqual(a.device.status().kind, .needsAttention)
        XCTAssertFalse(holds(fromA.payload, peer: a))
    }

    func testMergeLawsCompareNormalizedContents() throws {
        var nonce: UInt8 = 0
        func seal(_ plain: Data) -> Data {
            nonce &+= 1
            var sealed = plain
            sealed.append(nonce)
            return sealed
        }
        func open(_ sealed: Data) -> Data { sealed.dropLast() }
        let merge: MergeFunction = { left, right in
            let plain = bag(tokens(open(left.payload)).union(tokens(open(right.payload))))
            return MergeOutput(payload: seal(plain))
        }
        let samples = ["A", "B", "C"].enumerated().map { index, name in
            var record = sample(name, counter: UInt64(index + 1))
            record.payload = seal(record.payload)
            return record
        }
        XCTAssertTrue(MergeLaws.check(merge, samples: samples, normalize: open).isEmpty)
        XCTAssertFalse(MergeLaws.check(merge, samples: samples).isEmpty)
    }

    func testPurgeDropsHeldConflictCopies() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let fromA = try a.edit("note", payload: text("alpha-secret"))
        for _ in 0..<3 { _ = try b.device.nextStamp() }
        _ = try b.edit("note", payload: text("beta"))
        try b.sync()
        try a.sync(order: .fetchThenUpload)
        XCTAssertTrue(a.device.conflictCopies().contains { $0.payload == fromA.payload })
        var notices: [AppSaveRequest] = []
        a.holdSaves { notices.append($0) }
        let stamp = try a.device.nextStamp()
        let purge = SyncRecord(
            id: "note",
            type: "task-list",
            stamp: stamp,
            purged: true,
            payload: fromA.payload
        )
        try a.device.queueLocalEdit(purge)
        XCTAssertFalse(a.device.conflictCopies().contains { $0.id == "note" })
        XCTAssertTrue(notices.contains { $0.conflictCopiesToRemove.contains { $0.payload == fromA.payload } })
        XCTAssertEqual(a.device.status().kind, .needsAttention)
        a.device.confirmConflictCopiesStored(recordIDs: ["note"])
        XCTAssertNotEqual(a.device.status().kind, .needsAttention)
        try a.device.confirmLocalSave(purge)
        a.resumeSaves()
        try syncAll([a, b])
        XCTAssertFalse(holds(fromA.payload, peer: a))
        XCTAssertFalse(holds(fromA.payload, peer: b))
        XCTAssertNotEqual(cloud.record("note")?.record.payload, fromA.payload)
        XCTAssertEqual(cloud.record("note")?.attachment, nil)
        XCTAssertTrue(live(b, "note").purged)
        XCTAssertTrue(live(b, "note").payload.isEmpty)
    }
}

extension SyncCorePlanTests {
    private func assertMerged(aFirst: Bool, higherSecond: Bool) throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        var calls = 0
        let merge: MergeFunction = { left, right in
            calls += 1
            return unionMerge(left, right)
        }
        a.merge(merge)
        b.merge(merge)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        if higherSecond && !aFirst {
            for _ in 0..<3 { _ = try a.device.nextStamp() }
        }
        if higherSecond && aFirst {
            for _ in 0..<3 { _ = try b.device.nextStamp() }
        }
        let fromA = try a.edit("note", payload: text("alpha"))
        let fromB = try b.edit("note", payload: text("beta"))
        if aFirst {
            try syncAll([a, b])
        } else {
            try syncAll([b, a])
        }
        XCTAssertGreaterThan(calls, 0)
        let expected = bag(tokens(fromA.payload).union(tokens(fromB.payload)))
        XCTAssertEqual(live(a, "note").payload, expected)
        XCTAssertEqual(live(b, "note").payload, expected)
        XCTAssertNotEqual(live(a, "note").payload, higherStamp(fromA, fromB).payload)
    }

    private func assertNoMerge(aHigher: Bool, fetchFirst: Bool) throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        if aHigher {
            for _ in 0..<3 { _ = try a.device.nextStamp() }
        } else {
            for _ in 0..<3 { _ = try b.device.nextStamp() }
        }
        let fromA = try a.edit("note", payload: text("alpha"))
        let fromB = try b.edit("note", payload: text("beta"))
        let winner = fromA.stamp > fromB.stamp ? fromA : fromB
        let loser = fromA.stamp > fromB.stamp ? fromB : fromA
        if fetchFirst {
            try b.sync()
            try a.sync(order: .fetchThenUpload)
            try syncAll([a, b])
        } else if aHigher {
            try syncAll([a, b])
        } else {
            try syncAll([b, a])
        }
        XCTAssertEqual(live(a, "note").stamp, winner.stamp)
        XCTAssertEqual(live(b, "note").stamp, winner.stamp)
        XCTAssertEqual(live(a, "note").payload, winner.payload)
        let retained = a.device.conflictCopies() + b.device.conflictCopies()
        XCTAssertTrue(retained.contains { $0.stamp == loser.stamp && $0.payload == loser.payload })
        let holding = [a, b].filter { $0.device.status().kind == .needsAttention }
        XCTAssertFalse(holding.isEmpty)
        for peer in holding {
            XCTAssertFalse((peer.device.status().reason ?? "").isEmpty)
            peer.device.confirmConflictCopiesStored()
            XCTAssertEqual(peer.device.status().kind, .synced)
        }
    }

    private func assertConflictCopyCheckpoint() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let fromA = try a.edit("note", payload: text("alpha"))
        for _ in 0..<3 { _ = try b.device.nextStamp() }
        _ = try b.edit("note", payload: text("beta"))
        try b.sync()
        var captured: Data?
        a.holdSaves { request in
            captured = request.checkpointBeforeRequest
            a.store.save(request.record)
            try? a.device.confirmLocalSave(request.record)
        }
        try a.sync(order: .fetchThenUpload)
        let bytes = try XCTUnwrap(captured)
        let early = try SyncDevice.restore(from: bytes)
        XCTAssertTrue(early.conflictCopies().contains { $0.payload == fromA.payload })
        XCTAssertEqual(early.status().kind, .needsAttention)
        XCTAssertNotNil(early.status().reason)
    }

    private func assertDestroyAfterReplaceKeepsLoserOnce() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let fromA = try a.edit("note", payload: text("alpha"))
        for _ in 0..<3 { _ = try b.device.nextStamp() }
        let fromB = try b.edit("note", payload: text("beta"))
        try b.sync()
        var captured: Data?
        var asked = false
        a.holdSaves { request in
            asked = true
            let prior = try? SyncDevice.restore(from: request.checkpointBeforeRequest)
            XCTAssertEqual(a.store.records["note"]?.payload, fromA.payload)
            XCTAssertTrue(prior?.conflictCopies().contains { $0.stamp == fromA.stamp } == true)
            a.store.save(request.record)
            captured = request.checkpointBeforeRequest
        }
        try a.sync(order: .fetchThenUpload)
        XCTAssertTrue(asked)
        XCTAssertEqual(a.store.records["note"]?.payload, fromB.payload)
        let bytes = try XCTUnwrap(captured)
        try a.adopt(bytes)
        try a.device.reconcile(a.store.all())
        let copies = a.device.conflictCopies().filter { $0.payload == fromA.payload }
        XCTAssertEqual(copies.count, 1)
        XCTAssertFalse(a.device.queuedRecords().contains { $0.record.payload == fromA.payload })
        XCTAssertEqual(a.device.status().kind, .needsAttention)
        XCTAssertEqual(a.device.deviceID.raw, "phone-a")
    }

    private func assertCrashBeforeReplacementDoesNotRequeue() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let fromA = try a.edit("note", payload: text("alpha"))
        for _ in 0..<3 { _ = try b.device.nextStamp() }
        let fromB = try b.edit("note", payload: text("beta"))
        try b.sync()
        let revision = cloud.revisionCount("note")
        var captured: Data?
        a.holdSaves { request in
            captured = request.checkpointBeforeRequest
        }
        try a.sync(order: .fetchThenUpload)
        XCTAssertEqual(a.store.records["note"]?.payload, fromA.payload)
        let bytes = try XCTUnwrap(captured)
        try a.adopt(bytes)
        XCTAssertEqual(a.device.deviceID.raw, "phone-a")
        try a.device.reconcile(a.store.all())
        XCTAssertFalse(a.device.queuedRecords().contains { $0.record.id == "note" })
        a.resumeSaves()
        try a.sync()
        XCTAssertEqual(cloud.revisionCount("note"), revision)
        XCTAssertFalse(a.device.queuedRecords().contains { $0.record.id == "note" })
        XCTAssertEqual(live(a, "note").stamp, fromB.stamp)
        XCTAssertEqual(live(a, "note").payload, fromB.payload)
        XCTAssertEqual(a.device.conflictCopies().filter { $0.stamp == fromA.stamp }.count, 1)
        XCTAssertEqual(a.device.status().kind, .needsAttention)
    }

    private func assertPurge(purgeFirst: Bool, registerMerge: Bool) throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        var merges = 0
        if registerMerge {
            let merge: MergeFunction = { left, right in
                merges += 1
                return higherStamp(left, right)
            }
            a.merge(merge)
            b.merge(merge)
        }
        a.boot()
        b.boot()
        _ = try a.edit("groceries", payload: text("milk"))
        try syncAll([a, b])
        let purge = try a.edit("groceries", payload: Data(), purged: true)
        for _ in 0..<5 { _ = try b.device.nextStamp() }
        let edit = try b.edit("groceries", payload: text("secret oats"))
        XCTAssertGreaterThan(edit.stamp, purge.stamp)
        if purgeFirst {
            try a.sync()
            try syncAll([b, a])
        } else {
            try b.sync()
            try syncAll([a, b])
        }
        XCTAssertEqual(merges, 0)
        XCTAssertTrue(live(a, "groceries").purged)
        XCTAssertTrue(live(b, "groceries").purged)
        XCTAssertNotEqual(live(a, "groceries").payload, edit.payload)
        XCTAssertNotEqual(live(b, "groceries").payload, edit.payload)
        XCTAssertFalse(holds(edit.payload, peer: a))
        XCTAssertFalse(holds(edit.payload, peer: b))
        XCTAssertNotEqual(cloud.record("groceries")?.record.payload, edit.payload)
        XCTAssertEqual(cloud.record("groceries")?.attachment, nil)
    }

    private func assertThreeDeviceOrder(_ order: [String], replayFirst: Bool) throws {
        let cloud = FakeCloud()
        let peers = Dictionary(uniqueKeysWithValues: ["A", "B", "C"].map { ($0, Peer($0, cloud: cloud)) })
        for peer in peers.values {
            peer.merge(unionMerge)
            peer.boot()
        }
        _ = try peers["A"]!.edit("note", payload: text("base"))
        try syncAll(Array(peers.values))
        for (name, peer) in peers {
            _ = try peer.edit("note", payload: text(name))
        }
        var seen: [String] = []
        for name in order {
            try peers[name]!.sync()
            seen.append(name)
        }
        try syncAll(Array(peers.values))
        let expected = bag(["A", "B", "C"])
        for peer in peers.values {
            XCTAssertEqual(live(peer, "note").payload, expected, "order \(order)")
        }
        if replayFirst {
            let revision = cloud.revisionCount("note")
            try peers[order[0]]!.sync()
            try syncAll(Array(peers.values))
            XCTAssertEqual(cloud.revisionCount("note"), revision)
            for peer in peers.values {
                XCTAssertEqual(live(peer, "note").payload, expected)
            }
        }
    }

    private func case17EditSavedBeforeCheckpoint() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("kept", payload: text("already synced"))
        try syncAll([a, b])
        let checkpoint = a.device.saveCheckpoint()
        let stamp = try a.device.nextStamp()
        let edit = SyncRecord(id: "note", type: "task-list", stamp: stamp, purged: false, payload: text("saved locally"))
        a.store.save(edit)
        try a.adopt(checkpoint)
        XCTAssertEqual(a.device.deviceID.raw, "phone-a")
        try a.device.reconcile(a.store.all())
        XCTAssertTrue(a.device.queuedRecords().contains { $0.record.stamp == edit.stamp })
        try syncAll([a, b])
        XCTAssertEqual(live(b, "note").payload, edit.payload)
        XCTAssertEqual(live(b, "kept").payload, text("already synced"))
        a.device.wallClockMilliseconds = { 1 }
        let follow = try a.edit("note", payload: text("clock set back"))
        XCTAssertGreaterThan(follow.stamp, edit.stamp)
        XCTAssertLessThan(follow.stamp.wallTimeMilliseconds, edit.stamp.wallTimeMilliseconds)
        try syncAll([a, b])
        XCTAssertEqual(live(b, "note").payload, follow.payload)
    }

    private func case17QueuedEntryWithoutLocalRecord() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        let kept = try a.edit("kept", payload: text("acked"))
        try syncAll([a, b])
        let strayStamp = try a.device.nextStamp()
        let stray = SyncRecord(id: "stray", type: "task-list", stamp: strayStamp, purged: false, payload: text("never stored"))
        try a.device.queueLocalEdit(stray)
        let checkpoint = a.device.saveCheckpoint()
        try a.sync()
        XCTAssertNil(cloud.record("stray"))
        try a.adopt(checkpoint)
        XCTAssertEqual(a.device.deviceID.raw, "phone-a")
        try a.device.reconcile(a.store.all())
        XCTAssertFalse(a.device.queuedRecords().contains { $0.record.id == "stray" })
        try syncAll([a, b])
        XCTAssertNil(cloud.record("stray"))
        XCTAssertNil(b.store.records["stray"])
        XCTAssertEqual(live(a, "kept").payload, kept.payload)
        XCTAssertEqual(live(b, "kept").payload, kept.payload)
        XCTAssertEqual(a.device.status().kind, .synced)
    }

    private func case17PurgeSavedBeforeCheckpoint() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("groceries", payload: text("milk"))
        try syncAll([a, b])
        let checkpoint = a.device.saveCheckpoint()
        let stamp = try a.device.nextStamp()
        let purge = SyncRecord(id: "groceries", type: "task-list", stamp: stamp, purged: true, payload: Data())
        a.store.save(purge)
        try a.adopt(checkpoint)
        try a.device.reconcile(a.store.all())
        XCTAssertTrue(a.device.queuedRecords().contains { $0.record.purged && $0.record.id == "groceries" })
        try a.sync()
        XCTAssertEqual(cloud.record("groceries")?.record.purged, true)
        for _ in 0..<4 { _ = try b.device.nextStamp() }
        let stale = try b.edit("groceries", payload: text("stale edit"))
        XCTAssertGreaterThan(stale.stamp, purge.stamp)
        try syncAll([a, b])
        XCTAssertTrue(live(a, "groceries").purged)
        XCTAssertTrue(live(b, "groceries").purged)
        XCTAssertFalse(holds(stale.payload, peer: a))
        XCTAssertFalse(holds(stale.payload, peer: b))
    }

    private func case17EditMeetsRemoteChange() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.merge(unionMerge)
        b.merge(unionMerge)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let checkpoint = a.device.saveCheckpoint()
        let stamp = try a.device.nextStamp()
        let edit = SyncRecord(id: "note", type: "task-list", stamp: stamp, purged: false, payload: text("from-a"))
        a.store.save(edit)
        let fromB = try b.edit("note", payload: text("from-b"))
        try b.sync()
        try a.adopt(checkpoint)
        try a.device.reconcile(a.store.all())
        try syncAll([a, b])
        let expected = bag(["from-a", "from-b"])
        XCTAssertEqual(live(a, "note").payload, expected)
        XCTAssertEqual(live(b, "note").payload, expected)
        XCTAssertNotEqual(live(b, "note").payload, fromB.payload)
    }

    private func case17FetchedCopyIsNotReuploaded() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        var merges = 0
        a.merge { left, right in
            merges += 1
            return unionMerge(left, right)
        }
        b.merge(unionMerge)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let checkpoint = a.device.saveCheckpoint()
        let fromB = try b.edit("note", payload: text("from-b"))
        try b.sync()
        try a.sync()
        XCTAssertEqual(live(a, "note").payload, fromB.payload)
        let revision = cloud.revisionCount("note")
        try a.adopt(checkpoint)
        XCTAssertEqual(a.device.deviceID.raw, "phone-a")
        try a.device.reconcile(a.store.all())
        try syncAll([a, b])
        XCTAssertEqual(merges, 0)
        XCTAssertEqual(cloud.revisionCount("note"), revision)
        XCTAssertTrue(a.device.queuedRecords().isEmpty)
        XCTAssertEqual(live(a, "note").payload, fromB.payload)
        XCTAssertEqual(live(b, "note").payload, fromB.payload)
    }

    private func case17LostAcknowledgementIsRecognized() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        var merges = 0
        a.merge { _, _ in
            merges += 1
            return MergeOutput(payload: text("should-not-run"))
        }
        a.boot()
        let edit = try a.edit("note", payload: text("once"))
        let checkpoint = a.device.saveCheckpoint()
        cloud.dropResponseAfterCommit = true
        XCTAssertThrowsError(try a.sync())
        XCTAssertEqual(cloud.revisionCount("note"), 1)
        try a.adopt(checkpoint)
        XCTAssertEqual(a.device.deviceID.raw, "phone-a")
        try a.device.reconcile([edit])
        try a.sync()
        XCTAssertEqual(merges, 0)
        XCTAssertEqual(cloud.revisionCount("note"), 1)
        XCTAssertEqual(cloud.record("note")?.record.payload, edit.payload)
        XCTAssertEqual(a.device.status().kind, .synced)
        XCTAssertTrue(a.device.queuedRecords().isEmpty)
    }

    private func case17HeldFetchIsReplayed() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let checkpoint = a.device.saveCheckpoint()
        let fromB = try b.edit("note", payload: text("from-b"))
        try b.sync()
        a.holdSaves { _ in }
        try a.sync()
        XCTAssertEqual(a.store.records["note"]?.payload, text("base"))
        try a.adopt(checkpoint)
        XCTAssertEqual(a.device.deviceID.raw, "phone-a")
        a.resumeSaves()
        try a.device.reconcile(a.store.all())
        try syncAll([a, b])
        XCTAssertEqual(live(a, "note").payload, fromB.payload)
        XCTAssertEqual(a.store.records.values.filter { $0.id == "note" }.count, 1)
    }

    private func case17FirstCheckpointBeforeAnyEdit() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        b.boot()
        let premature = SyncRecord(
            id: "note",
            type: "task-list",
            stamp: VersionStamp(counter: 1, wallTimeMilliseconds: 1, deviceID: a.device.deviceID),
            purged: false,
            payload: text("too soon")
        )
        XCTAssertThrowsError(try a.device.queueLocalEdit(premature)) { error in
            XCTAssertEqual(error as? SyncError, .checkpointRequired)
        }
        XCTAssertThrowsError(try a.device.nextStamp()) { error in
            XCTAssertEqual(error as? SyncError, .checkpointRequired)
        }
        a.boot()
        let checkpoint = a.device.saveCheckpoint()
        XCTAssertThrowsError(try SyncDevice.restore(from: checkpoint, expecting: DeviceID("other"))) { error in
            guard case SyncError.deviceIDMismatch = error else {
                return XCTFail("expected a device id mismatch, got \(error)")
            }
        }
        let stamp = try a.device.nextStamp()
        let edit = SyncRecord(id: "note", type: "task-list", stamp: stamp, purged: false, payload: text("first edit"))
        a.store.save(edit)
        try a.adopt(checkpoint)
        XCTAssertEqual(a.device.deviceID.raw, "phone-a")
        try a.device.reconcile(a.store.all())
        try syncAll([a, b])
        XCTAssertEqual(live(b, "note").payload, edit.payload)
        let roundTripBytes = try roundTrip(checkpoint)
        let reread = try SyncDevice.restore(from: roundTripBytes)
        XCTAssertEqual(reread.deviceID, a.device.deviceID)
    }

    private func assertFetchBeforeUploadMerges() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        var calls = 0
        let merge: MergeFunction = { left, right in
            calls += 1
            return unionMerge(left, right)
        }
        a.merge(merge)
        b.merge(merge)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let fromA = try a.edit("note", payload: text("from-a"))
        let fromB = try b.edit("note", payload: text("from-b"))
        try b.sync()
        var savedPayloads: [Data] = []
        a.holdSaves { request in
            savedPayloads.append(request.record.payload)
            if request.replaceLocalRecord {
                a.store.save(request.record)
                try? a.device.confirmLocalSave(request.record)
            }
        }
        try a.sync(order: .fetchThenUpload)
        a.resumeSaves()
        try syncAll([a, b])
        let expected = bag(tokens(fromA.payload).union(tokens(fromB.payload)))
        XCTAssertGreaterThan(calls, 0)
        XCTAssertTrue(savedPayloads.contains(expected))
        XCTAssertEqual(live(a, "note").payload, expected)
        XCTAssertEqual(live(b, "note").payload, expected)
    }

    private func assertReconcileKeepsSavedMerge() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        a.merge(unionMerge)
        b.merge(unionMerge)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let fromA = try a.edit("note", payload: text("from-a"))
        _ = try b.edit("note", payload: text("from-b"))
        try b.sync()
        var captured: Data?
        a.holdSaves { request in
            captured = request.checkpointBeforeRequest
            if request.replaceLocalRecord {
                a.store.save(request.record)
                try? a.device.confirmLocalSave(request.record)
            }
            cloud.dropAfterSuccessfulSaves = 0
        }
        XCTAssertThrowsError(try a.sync(order: .fetchThenUpload))
        XCTAssertEqual(cloud.record("note")?.record.payload, text("from-b"))
        let bytes = try XCTUnwrap(captured)
        try a.adopt(bytes)
        try a.device.reconcile(a.store.all())
        XCTAssertTrue(a.device.queuedRecords().contains { tokens($0.record.payload).isSuperset(of: ["from-a", "from-b"]) })
        XCTAssertFalse(a.device.queuedRecords().contains { $0.record.stamp == fromA.stamp && $0.record.payload == fromA.payload })
        try syncAll([a, b])
        let expected = bag(["from-a", "from-b"])
        XCTAssertEqual(live(a, "note").payload, expected)
        XCTAssertEqual(live(b, "note").payload, expected)
    }

    private func assertUnsavedMergeIsRebuiltFromTheOldEdit() throws {
        let cloud = FakeCloud()
        let a = Peer("phone-a", cloud: cloud)
        let b = Peer("phone-b", cloud: cloud)
        var calls = 0
        let merge: MergeFunction = { left, right in
            calls += 1
            return unionMerge(left, right)
        }
        a.merge(merge)
        b.merge(merge)
        a.boot()
        b.boot()
        _ = try a.edit("note", payload: text("base"))
        try syncAll([a, b])
        let fromA = try a.edit("note", payload: text("from-a"))
        _ = try b.edit("note", payload: text("from-b"))
        try b.sync()
        var captured: Data?
        a.holdSaves { request in
            captured = request.checkpointBeforeRequest
        }
        try a.sync(order: .fetchThenUpload)
        XCTAssertEqual(cloud.record("note")?.record.payload, text("from-b"))
        XCTAssertTrue(a.device.queuedRecords().contains { $0.isMergeResult && !$0.uploadable })
        let bytes = try XCTUnwrap(captured)
        try a.adopt(bytes)
        a.resumeSaves()
        a.store.save(fromA)
        try a.device.reconcile(a.store.all())
        XCTAssertTrue(a.device.queuedRecords().contains { $0.record.stamp == fromA.stamp })
        XCTAssertFalse(a.device.queuedRecords().contains { $0.isMergeResult })
        let callsBefore = calls
        try syncAll([a, b])
        XCTAssertGreaterThan(calls, callsBefore)
        let expected = bag(["from-a", "from-b"])
        XCTAssertEqual(live(a, "note").payload, expected)
        XCTAssertEqual(live(b, "note").payload, expected)
    }
}

private func permutations(_ items: [String]) -> [[String]] {
    guard items.count > 1 else { return [items] }
    var result: [[String]] = []
    for index in items.indices {
        var rest = items
        let item = rest.remove(at: index)
        for tail in permutations(rest) {
            result.append([item] + tail)
        }
    }
    return result
}

private func roundTrip(_ data: Data) throws -> Data {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("oc-sync-\(UUID().uuidString).json")
    try data.write(to: url)
    let read = try Data(contentsOf: url)
    try FileManager.default.removeItem(at: url)
    return read
}
