import AppKit
import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantDeskControls
@testable import ParticipantProcess

// Section 17's owner (plan F4; Codex F0 answers 9, 12 and 13; the S8 R1
// promptness duty), with scripted local checks and a fake authenticator:
// never LocalAuthentication, never the real CLI, the Keychain or a file.

@Suite("Section 17 owner: confirming")
struct PaidUsageConfirmingTests {
    @Test("A successful LocalAuthentication request with passing fresh checks before and after gives active, five runs, confirmedAt the clock's time; the report is then available with that display")
    func success() async throws {
        let checks = ScriptedLocalChecks()
        let authentication = FakeOwnerAuthentication()
        let owner = await inventedOwner(checks: checks, authentication: authentication)
        #expect(owner.display == .unconfirmed, "every launch starts unconfirmed")
        let before = await owner.report()
        #expect(before.availability == .unavailable(.overflowUnverified) && before.confirmation == .unconfirmed)

        #expect(await owner.confirm() == .confirmed)
        #expect(authentication.requests == 1)
        #expect(checks.counts.fresh == 2, "a fresh check before the request and one after it")
        let confirmedAt = ParticipantTimestamp.format(millis: InventedWallClock().wall)
        #expect(owner.display == ParticipantConfirmationDisplay.active(confirmedAt: confirmedAt, runsLeft: 5))
        let report = await owner.report()
        #expect(report.availability.available && report.availability.reason == nil)
        #expect(report.confirmation == ParticipantConfirmationDisplay.active(confirmedAt: confirmedAt, runsLeft: 5))
        let recheck = await owner.recheck()
        #expect(recheck.availability.available)
        #expect(checks.counts.fresh == 3, "the recheck never reuses")
        #expect(await owner.confirm() == .alreadyActive, "never over an active one")
        #expect(authentication.requests == 1)
    }

    @Test("Cancel, failure, an unavailable request, or a request that never completes: unconfirmed, overflow-unverified, nothing claimable")
    func notConfirmed() async throws {
        for (mode, expected) in [(FakeOwnerAuthentication.Mode.answer(.notAuthenticated), PaidUsageConfirmOutcome.notAuthenticated),
                                 (.immediately(.notAuthenticated), .notAuthenticated),
                                 (.answer(.unavailable), .authenticationUnavailable),
                                 (.immediately(.unavailable), .authenticationUnavailable)] {
            let owner = await inventedOwner(authentication: FakeOwnerAuthentication(mode))
            #expect(await owner.confirm() == expected)
            #expect(owner.display == .unconfirmed && !owner.isConfirming)
            #expect(await owner.report().availability == .unavailable(.overflowUnverified))
            #expect(!owner.claimRun())
        }

        // Never answered: the attempt stays pending, nothing is confirmed.
        let authentication = FakeOwnerAuthentication(.hold)
        let owner = await inventedOwner(authentication: authentication)
        let attempt = Task { await owner.confirm() }
        #expect(await waitUntil { authentication.holding == 1 })
        #expect(owner.isConfirming)
        #expect(owner.display == .unconfirmed)
        #expect(await owner.report().availability == .unavailable(.overflowUnverified))
        #expect(await owner.recheck().availability == .unavailable(.overflowUnverified))
        #expect(!owner.claimRun())
        #expect(await owner.confirm() == .inProgress, "one attempt at a time")
        // A window close then abandons it; the request is cancelled.
        owner.abandonPendingConfirmation()
        #expect(await value(of: attempt) == .interrupted)
        #expect(await waitUntil { authentication.cancels == 1 })
        authentication.complete(.authenticated)
        #expect(owner.display == .unconfirmed, "the late success is discarded")
        #expect(!owner.isConfirming)
    }

    @Test("A failing local check asks nothing; one failing after the request confirms nothing")
    func checksFail() async throws {
        for failure in ClaudeLocalFailure.allCases {
            let checks = ScriptedLocalChecks(.failed(failure))
            let authentication = FakeOwnerAuthentication()
            let owner = await inventedOwner(checks: checks, authentication: authentication)
            #expect(await owner.confirm() == .checksFailed(failure))
            #expect(authentication.requests == 0, "nothing asked while \(failure) fails")
            #expect(owner.display == .unconfirmed)

            let after = ScriptedLocalChecks()
            after.queue(InventedSnapshot.passing, .failed(failure))
            let later = await inventedOwner(checks: after)
            #expect(await later.confirm() == .checksFailed(failure))
            #expect(later.display == .unconfirmed)
        }
    }

    @Test("The pinned file, version, login or account changing while the request is pending discards the result")
    func changedWhilePending() async throws {
        let changed = [InventedSnapshot.make(inode: 9), InventedSnapshot.make(changed: 1_700_000_001),
                       InventedSnapshot.make(version: "2.1.284"), InventedSnapshot.make(plan: .pro),
                       InventedSnapshot.make(account: "another-person@invented.invalid"),
                       InventedSnapshot.make(organization: "another-organization"), InventedSnapshot.make(organization: nil)]
        for snapshot in changed {
            let checks = ScriptedLocalChecks()
            checks.queue(InventedSnapshot.passing, .passed(snapshot))
            let owner = await inventedOwner(checks: checks)
            #expect(await owner.confirm() == .interrupted)
            #expect(owner.display == .unconfirmed)
            #expect(await owner.report().availability == .unavailable(.overflowUnverified))
        }
    }

    @Test("A change an availability check sees while the request is pending discards a late success even when the facts come back: signed out, a missing pin, another account or another pinned file, seen by report() or a start's recheck (Codex F34-R4)")
    func changeSeenWhilePending() async throws {
        let cases: [(String, ClaudeLocalCheckResult, Bool)] = [
            ("signed out, by report()", .failed(.signedOut), false),
            ("no plan, by a recheck", .failed(.notSubscription), true),
            ("CLI missing, by report()", .failed(.cliMissing), false),
            ("another version, by a recheck", .failed(.cliVersionMismatch), true),
            ("another account, by report()", .passed(InventedSnapshot.make(account: "another-person@invented.invalid")), false),
            ("another organization, by a recheck", .passed(InventedSnapshot.make(organization: "another-organization")), true),
            ("another pinned file, by report()", .passed(InventedSnapshot.make(inode: 9)), false)
        ]
        for (label, seen, byRecheck) in cases {
            let checks = ScriptedLocalChecks()
            let authentication = FakeOwnerAuthentication(.hold)
            let owner = await inventedOwner(checks: checks, authentication: authentication)
            let attempt = Task { await owner.confirm() }
            #expect(await waitUntil { authentication.holding == 1 }, "\(label): the request is pending after snapshot A")
            checks.set(seen)
            let report = byRecheck ? await owner.recheck() : await owner.report()
            #expect(!report.availability.available, "\(label)")
            checks.set(InventedSnapshot.passing)          // snapshot A again
            authentication.complete(.authenticated)       // a late success
            #expect(await value(of: attempt) == .interrupted, "\(label)")
            #expect(owner.display == .unconfirmed, "\(label): never confirmed")
            #expect(!owner.claimRun(), "\(label)")
            #expect(await owner.report().availability == .unavailable(.overflowUnverified), "\(label)")
            #expect(await waitUntil { authentication.cancels == 1 }, "\(label): the request is ended")
        }

        // Seen while the first check runs, before its snapshot is known.
        let checks = ScriptedLocalChecks()
        let gate = checks.holdFresh()
        let authentication = FakeOwnerAuthentication()
        let owner = await inventedOwner(checks: checks, authentication: authentication)
        let attempt = Task { await owner.confirm() }
        #expect(await waitUntil { gate.arrived == 1 })
        checks.set(.failed(.signedOut))
        _ = await owner.report()
        checks.set(InventedSnapshot.passing)
        checks.releaseHold()
        #expect(await value(of: attempt) == .interrupted, "a change seen during the first check")
        #expect(authentication.requests == 0, "nothing was asked")
        #expect(owner.display == .unconfirmed)

        // Controls: what ends no active confirmation ends no attempt either.
        for seen in [ClaudeLocalCheckResult.failed(.providerOverride), .failed(.checkFailed), InventedSnapshot.passing] {
            let checks = ScriptedLocalChecks()
            let authentication = FakeOwnerAuthentication(.hold)
            let owner = await inventedOwner(checks: checks, authentication: authentication)
            let attempt = Task { await owner.confirm() }
            #expect(await waitUntil { authentication.holding == 1 })
            checks.set(seen)
            _ = await owner.report()
            checks.set(InventedSnapshot.passing)
            authentication.complete(.authenticated)
            #expect(await value(of: attempt) == .confirmed, "\(seen)")
            #expect(authentication.cancels == 0)
        }
    }

    @Test("A late successful result is discarded after a lock, sleep, logout, paid-overflow end, close or quit while it was pending; the request is cancelled")
    func lateResultDiscarded() async throws {
        let events: [(String, (PaidUsageConfirmationOwner) -> Void)] = [
            ("lock", { $0.end(.lock) }), ("sleep", { $0.end(.sleep) }), ("logout", { $0.end(.logout) }),
            ("paid overflow", { $0.endForPaidOverflow() }), ("close or quit", { $0.abandonPendingConfirmation() })
        ]
        for (name, event) in events {
            let authentication = FakeOwnerAuthentication(.hold)
            let owner = await inventedOwner(authentication: authentication)
            let attempt = Task { await owner.confirm() }
            #expect(await waitUntil { authentication.holding == 1 }, "\(name)")
            event(owner)
            #expect(await value(of: attempt) == .interrupted, "\(name)")
            authentication.complete(.authenticated)
            #expect(owner.display == .unconfirmed, "\(name): never confirmed by the late success")
            #expect(await waitUntil { authentication.cancels == 1 }, "\(name): the request is ended")
            #expect(!owner.claimRun())
        }

        // An end while the fresh check before the request runs: nothing is asked.
        let checks = ScriptedLocalChecks()
        let gate = checks.holdFresh()
        let authentication = FakeOwnerAuthentication()
        let owner = await inventedOwner(checks: checks, authentication: authentication)
        let attempt = Task { await owner.confirm() }
        #expect(await waitUntil { gate.arrived == 1 })
        owner.end(.sleep)
        checks.releaseHold()
        #expect(await value(of: attempt) == .interrupted)
        #expect(authentication.requests == 0)
        #expect(owner.display == .unconfirmed)
    }
}

@Suite("Section 17 owner: claims, ends and display")
struct PaidUsageLedgerTests {
    @Test("Five claims count down from five; the fifth ends it run-limit; a sixth is refused; nothing revives it")
    func fiveClaims() async throws {
        let owner = await inventedOwner(confirmed: true)
        for left in [4, 3, 2, 1] {
            #expect(owner.claimRun())
            #expect(displayState(owner.display) == "active \(left)")
            #expect(await owner.report().availability.available)
        }
        #expect(owner.claimRun(), "the fifth is counted")
        #expect(owner.display == .ended(.runLimit))
        #expect(!owner.claimRun(), "a sixth is refused")
        let report = await owner.report()
        #expect(report.availability == .unavailable(.overflowUnverified) && report.confirmation == .ended(.runLimit))
        owner.end(.lock)
        #expect(owner.display == .ended(.runLimit), "an ended confirmation keeps its first reason")
        // The fifth run, allowed to finish, then sees paid overflow: the
        // display says so rather than "its five runs have started" (F4-1).
        owner.endForPaidOverflow()
        #expect(owner.display == .ended(.paidOverflow))
        let reportAfter = await owner.report()
        #expect(!owner.claimRun() && !reportAfter.availability.available, "still never revived")
        #expect(await owner.confirm() == .confirmed, "a new one needs the request again")
        #expect(displayState(owner.display) == "active 5")
    }

    @Test("Every end gives its endedBy; an ended one keeps its first reason except that paid-overflow replaces any; ended is never available and never revived by a passing check")
    func ends() async throws {
        for end in ParticipantConfirmationEnd.allCases {
            let owner = await inventedOwner(confirmed: true)
            if end == .paidOverflow { owner.endForPaidOverflow() } else { owner.end(end) }
            #expect(owner.display == .ended(end))
            owner.end(.lock)
            owner.end(.cliChanged)
            #expect(owner.display == .ended(end), "the first reason stays against any other end")
            owner.endForPaidOverflow()
            #expect(owner.display == .ended(.paidOverflow), "paid usage may have been used: that replaces it (Codex F4-1)")
            owner.end(.sleep)
            #expect(owner.display == .ended(.paidOverflow))
            let report = await owner.report()
            #expect(!report.availability.available && report.availability.reason == .overflowUnverified)
            #expect(!owner.claimRun())
        }
        // With none in this launch there is nothing to end.
        let none = await inventedOwner()
        none.end(.lock)
        none.endForPaidOverflow()
        #expect(none.display == .unconfirmed)
    }

    @Test("A check showing another pinned file, version, login or account ends it (cli-changed, login-changed); provider-override and check-failed win as the reason but end nothing; an earlier failing check wins")
    func changesAtACheck() async throws {
        let cases: [(ClaudeLocalCheckResult, ParticipantUnavailableReason, ParticipantConfirmationEnd?)] = [
            (.passed(InventedSnapshot.make(inode: 9)), .overflowUnverified, .cliChanged),
            (.passed(InventedSnapshot.make(changed: 1_700_000_005)), .overflowUnverified, .cliChanged),
            (.passed(InventedSnapshot.make(version: "2.1.299")), .overflowUnverified, .cliChanged),
            (.passed(InventedSnapshot.make(plan: .team)), .overflowUnverified, .loginChanged),
            (.passed(InventedSnapshot.make(account: "other@invented.invalid")), .overflowUnverified, .loginChanged),
            (.failed(.cliMissing), .cliMissing, .cliChanged),
            (.failed(.cliVersionMismatch), .cliVersionMismatch, .cliChanged),
            (.failed(.signedOut), .signedOut, .loginChanged),
            (.failed(.notSubscription), .notSubscription, .loginChanged),
            (.failed(.providerOverride), .providerOverride, nil),
            (.failed(.checkFailed), .checkFailed, nil)
        ]
        for (result, reason, end) in cases {
            for fresh in [false, true] {
                let checks = ScriptedLocalChecks()
                let owner = await inventedOwner(checks: checks, confirmed: true)
                checks.set(result)
                let report: ParticipantAvailabilityReport
                if fresh { report = await owner.recheck() } else { report = await owner.report() }
                #expect(report.availability == .unavailable(reason), "\(result)")
                if let end {
                    #expect(report.confirmation == .ended(end), "\(result)")
                } else {
                    #expect(report.confirmation?.isActive == true, "\(result): reported as it is")
                    checks.set(InventedSnapshot.passing)
                    #expect(await owner.report().availability.available, "the same snapshot again: available")
                }
            }
        }
        // Check Claude applies the same ends.
        let checks = ScriptedLocalChecks()
        let owner = await inventedOwner(checks: checks, confirmed: true)
        checks.set(.passed(InventedSnapshot.make(account: "other@invented.invalid")))
        let checked = await owner.checkClaude()
        #expect(checked.confirmation == .ended(.loginChanged))
        #expect(PaidUsageDeskControls.check(checked) == .passed, "the local checks themselves passed")
    }

    @Test("Display shapes are section 5's, with no account field; never available while unconfirmed or ended")
    func displayShapes() async throws {
        let owner = await inventedOwner()
        #expect(JSONValue.object(await owner.report().jsonFields).canonicalData()
                == JSONValue.object(["available": .bool(false), "reason": .string("overflow-unverified"),
                                     "confirmation": .object(["state": .string("unconfirmed")])]).canonicalData())
        #expect(await owner.confirm() == .confirmed)
        let active = await owner.report().jsonFields
        let confirmation = try #require(active["confirmation"]?.objectValue)
        #expect(Set(confirmation.keys) == ["state", "confirmedAt", "runsLeft"])
        #expect(confirmation["confirmedAt"] == .string(ParticipantTimestamp.format(millis: InventedWallClock().wall)))
        owner.end(.sleep)
        let ended = try #require(await owner.report().jsonFields["confirmation"]?.objectValue)
        #expect(ended == ["state": .string("ended"), "endedBy": .string("sleep")])
        let endedFields = await owner.report().jsonFields
        for fields in [active, endedFields] {
            let text = String(decoding: JSONValue.object(fields).canonicalData(), as: UTF8.self)
            for forbidden in ["invented-person", "invented.invalid", "invented-organization", "account", "email", "organization"] {
                #expect(!text.contains(forbidden), "\(forbidden) in \(text)")
            }
        }
        let comparator = InventedSnapshot.make().account
        #expect("\(comparator)" == "account-comparator" && String(reflecting: comparator) == "account-comparator")

        // Every state against every check result: available only when active
        // and the checks pass; otherwise the first failing reason.
        let results: [ClaudeLocalCheckResult] = [InventedSnapshot.passing] + ClaudeLocalFailure.allCases.map { .failed($0) }
        for state in ["unconfirmed", "active", "ended"] {
            for result in results {
                let checks = ScriptedLocalChecks()
                let owner = await inventedOwner(checks: checks, confirmed: state != "unconfirmed")
                if state == "ended" { owner.end(.runLimit) }
                checks.set(result)
                let report = await owner.report()
                let isActive = report.confirmation?.isActive == true
                #expect(report.availability.available == (isActive && result.snapshot != nil), "\(state) \(result)")
                #expect(!(report.availability.available && !isActive), "never available unless active")
                if case .failed(let failure) = result { #expect(report.availability.reason == failure.reason, "the earlier failing check wins") }
            }
        }
    }

    @Test("The owner's ends, the claim and an abandonment return while the main queue is blocked, with the Desk controls' change handler installed")
    func promptWithMainBlocked() async throws {
        let owner = await inventedOwner(confirmed: true)
        let controls = await MainActor.run { PaidUsageDeskControls(owner: owner) }
        let blocker = DispatchSemaphore(value: 0)
        let entered = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            entered.signal()
            _ = blocker.wait(timeout: .now() + 10)
        }
        #expect(await waitOffPool(entered, seconds: 5), "the main queue is held")
        let timings = await Task.detached { () -> [Double] in
            var spent: [Double] = []
            for call in [{ _ = owner.claimRun() }, { owner.abandonPendingConfirmation() }, { owner.endForPaidOverflow() },
                         { owner.end(.lock) }, { _ = owner.claimRun() }] as [() -> Void] {
                let began = Date()
                call()
                spent.append(Date().timeIntervalSince(began))
            }
            return spent
        }.value
        #expect(timings.allSatisfy { $0 < 0.5 }, "\(timings)")
        #expect(owner.display == .ended(.paidOverflow))
        blocker.signal()
        _ = controls
    }
}

@Suite("Section 17 owner: end observers")
struct PaidUsageEndSignalTests {
    @Test("The AppKit names are AppKit's own")
    func names() {
        #expect(PaidUsageEndSignals.sessionResigned == NSWorkspace.sessionDidResignActiveNotification)
        #expect(PaidUsageEndSignals.willSleep == NSWorkspace.willSleepNotification)
        #expect(PaidUsageEndSignals.screensDidSleep == NSWorkspace.screensDidSleepNotification)
        #expect(PaidUsageEndSignals.willPowerOff == NSWorkspace.willPowerOffNotification)
        #expect(PaidUsageEndSignals.screenLocked.rawValue == "com.apple.screenIsLocked")
    }

    @Test("Each signal gives its endedBy with no Desk at all, on the posting thread; a pending attempt is abandoned; stopped, nothing ends")
    func eachSignal() async throws {
        let signals: [(Notification.Name, ParticipantConfirmationEnd, Bool)] = [
            (PaidUsageEndSignals.screenLocked, .lock, true), (PaidUsageEndSignals.sessionResigned, .lock, false),
            (PaidUsageEndSignals.willSleep, .sleep, false), (PaidUsageEndSignals.screensDidSleep, .sleep, false),
            (PaidUsageEndSignals.willPowerOff, .logout, false)
        ]
        for (name, end, distributed) in signals {
            let owner = await inventedOwner(confirmed: true)
            let distributedCenter = NotificationCenter()
            let workspaceCenter = NotificationCenter()
            let observers = PaidUsageEndSignals(owner: owner, distributedCenter: distributedCenter, workspaceCenter: workspaceCenter)
            observers.start()
            #expect(observers.isRunning)
            (distributed ? workspaceCenter : distributedCenter).post(name: name, object: nil)
            #expect(owner.display.isActive, "\(name.rawValue) on the other center does nothing")
            (distributed ? distributedCenter : workspaceCenter).post(name: name, object: nil)
            #expect(owner.display == .ended(end), "\(name.rawValue)")
            observers.stop()

            let stopped = await inventedOwner(confirmed: true)
            let quiet = PaidUsageEndSignals(owner: stopped, distributedCenter: distributedCenter, workspaceCenter: workspaceCenter)
            quiet.start()
            quiet.stop()
            (distributed ? distributedCenter : workspaceCenter).post(name: name, object: nil)
            #expect(stopped.display.isActive, "stopped: \(name.rawValue) ends nothing")
        }

        // A pending attempt is abandoned by a signal: the late success is discarded.
        let authentication = FakeOwnerAuthentication(.hold)
        let owner = await inventedOwner(authentication: authentication)
        let center = NotificationCenter()
        let observers = PaidUsageEndSignals(owner: owner, distributedCenter: center, workspaceCenter: center)
        observers.start()
        let attempt = Task { await owner.confirm() }
        #expect(await waitUntil { authentication.holding == 1 })
        center.post(name: PaidUsageEndSignals.screensDidSleep, object: nil)
        #expect(await value(of: attempt) == .interrupted)
        authentication.complete(.authenticated)
        #expect(owner.display == .unconfirmed)
        observers.stop()
    }

    @Test("Observers never re-enter the coordinator: a signal ends the confirmation and leaves the coordinator's lock and close flags, and its requests, untouched")
    func noCoordinatorReentry() async throws {
        let world = try await ParticipantCoordinatorStartTests.oneRun()
        defer { world.clean() }
        let owner = await inventedOwner(confirmed: true)
        world.availability.set(owner)
        let manual = try await ParticipantCoordinatorStartTests.Manual(world, confirmation: owner)
        let center = NotificationCenter()
        let observers = PaidUsageEndSignals(owner: owner, distributedCenter: center, workspaceCenter: center)
        observers.start()
        defer { observers.stop() }
        let lifecycle = manual.coordinator.gate.state
        center.post(name: PaidUsageEndSignals.screenLocked, object: nil)
        center.post(name: PaidUsageEndSignals.willSleep, object: nil)
        #expect(owner.display == .ended(.lock))
        let after = manual.coordinator.gate.state
        #expect(!after.locked && !after.closing && after.serial == lifecycle.serial, "the coordinator's gate never moved")
        let start = try await manual.send(.participantStart, ParticipantCoordinatorStartTests.start())
        #expect(start.reason == .participantUnavailable, "the ended confirmation: \(start.jsonValue)")
        #expect(manual.launcher.runs.isEmpty)
    }
}

@Suite("Section 17 owner: bypasses")
struct PaidUsageBypassTests {
    @Test("Registered defaults never make a confirmation in process (the environment and arguments are the new-launch probe's, a separate process; that the owner writes nothing is the ledger's source gate)")
    func inProcess() async throws {
        // Registered only (in memory, invented keys): nothing is read from or
        // written to a real defaults domain, and the process environment is
        // left alone, since other suites run in parallel (Codex F4-7).
        UserDefaults.standard.register(defaults: ["ParticipantConfirmationActive": true, "PaidUsageConfirmed": "active",
                                                  "participant.confirmation.runsLeft": 5])
        let owner = await inventedOwner()
        let report = await owner.report()
        #expect(report.availability == .unavailable(.overflowUnverified) && report.confirmation == .unconfirmed)
        #expect(!owner.claimRun())
        #expect(await owner.confirm() == .confirmed)
    }

    @Test("beginConfirmation registers the attempt at once: abandoned before it runs, it is interrupted and checks and asks nothing")
    func beginIsSynchronous() async throws {
        let checks = ScriptedLocalChecks()
        let authentication = FakeOwnerAuthentication()
        let owner = await inventedOwner(checks: checks, authentication: authentication)
        let attempt = owner.beginConfirmation()
        #expect(owner.isConfirming, "under way from the moment it returns")
        #expect(await owner.confirm() == .inProgress, "one attempt at a time")
        owner.abandonPendingConfirmation()
        #expect(!owner.isConfirming)
        #expect(await owner.confirm(attempt) == .interrupted)
        #expect(checks.counts.fresh == 0 && authentication.requests == 0, "nothing checked or asked")
        #expect(owner.display == .unconfirmed)
        let again = owner.beginConfirmation()
        #expect(await owner.confirm(again) == .confirmed, "a new attempt runs")
    }

    @Test("The window's adapter begins the attempt before its first suspension: a Desk lock handled on the main queue right after finds and abandons it")
    @MainActor
    func adapterBeginsBeforeSuspending() async throws {
        let checks = ScriptedLocalChecks()
        let gate = checks.holdFresh()
        let authentication = FakeOwnerAuthentication()
        let owner = await inventedOwner(checks: checks, authentication: authentication)
        let controls = PaidUsageDeskControls(owner: owner)
        let seen = ResultBox<Bool>()
        // Queued now, so it runs as soon as the main actor is free: at the
        // adapter's first suspension, as a Desk lock's render would.
        DispatchQueue.main.async {
            seen.set(owner.isConfirming)
            owner.abandonPendingConfirmation()
            checks.releaseHold()
        }
        let result = await controls.confirm()
        #expect(seen.value == true, "the attempt was under way when the main queue ran next")
        #expect(result == .interrupted)
        #expect(authentication.requests == 0, "no request after the abandonment")
        #expect(controls.state == .unconfirmed && !controls.isConfirming)
        _ = gate
    }

    @Test("A synthetic Confirm without a completed request (the statement answered, the request never completing) confirms nothing")
    @MainActor
    func syntheticPress() async throws {
        let authentication = FakeOwnerAuthentication(.hold)
        let owner = await inventedOwner(authentication: authentication)
        let controls = PaidUsageDeskControls(owner: owner)
        let attempt = Task { await controls.confirm() }
        #expect(await waitUntil { authentication.holding == 1 })
        #expect(controls.isConfirming)
        #expect(controls.state == .unconfirmed)
        #expect(await owner.report().availability == .unavailable(.overflowUnverified))
        controls.abandonPendingConfirmation()
        #expect(await value(of: attempt) == .interrupted)
        #expect(controls.state == .unconfirmed)
    }
}

extension ProcessSuites {
    @Suite("Section 17 owner: a new launch")
    struct PaidUsageNewLaunch {
        @Test("A new launch with invented environment, arguments, defaults and flag files: unconfirmed, host-not-approved (no store, so nothing approved) with every local check passing, and nothing claimed; the tree is unchanged and the probe touched nothing outside it")
        func newLaunchProbe() throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            for folder in [tree.root, tree.home, tree.temporary] {
                for name in ["participant-confirmation", ".trueconvo-paid-usage-off", "confirmation.json", "participant.json"] {
                    try "{\"state\":\"active\",\"confirmedAt\":\"2026-10-11T00:00:00.000Z\",\"runsLeft\":5,\"available\":true}"
                        .write(to: folder.appendingPathComponent(name), atomically: false, encoding: .utf8)
                }
            }
            let link = tree.root.appendingPathComponent("ParticipantConfirmationOwnerProbe")
            try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: Products.availabilityProbe)
            func listing() -> [String] {
                (FileManager.default.subpaths(atPath: tree.root.path) ?? []).filter { !$0.contains("records") }.sorted()
            }
            let before = listing()
            let process = Process()
            process.executableURL = link
            process.arguments = ["--confirmation=active", "--paid-usage-off", "-ParticipantConfirmationActive", "YES",
                                 "-PaidUsageConfirmed", "1", "--runs-left=5"]
            process.environment = ["HOME": tree.home.path, "USER": InventedClaudeTree.userName, "TMPDIR": tree.temporary.path + "/",
                                   "LANG": "en_US.UTF-8", "PATH": "/usr/bin:/bin", "TRUECONVO_PARTICIPANT_CONFIRMATION": "active",
                                   "PARTICIPANT_OVERFLOW_CONFIRMED": "1", "TRUECONVO_PAID_USAGE_OFF": "1"]
            process.currentDirectoryURL = tree.root
            let ran = try runBounded(process)
            #expect(ran?.status == 0, "the probe ended in time")
            #expect(ran?.output
                    == "available=false reason=host-not-approved confirmation=unconfirmed recheck=host-not-approved claim=false outside=0\n")
            #expect(tree.probes("version") >= 2 && tree.probes("auth-status") >= 2, "the real local checks ran and passed, twice")
            #expect(listing() == before, "the owner wrote nothing (the probes' folders came and went)")
        }
    }

    @Suite("Section 17 owner over the real local checks")
    struct PaidUsageRealChecks {
        @Test("Confirming over section 5's real checks (the fake CLI in an invented tree): the two fresh checks agree, the report and a start's recheck are available, and a replaced pin ends it cli-changed; nothing outside the tree is touched")
        func confirmsOverRealChecks() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let authentication = FakeOwnerAuthentication()
            let owner = PaidUsageConfirmationOwner(checks: tree.checks(), approval: InventedApproval(), authentication: authentication, clock: InventedWallClock())
            #expect(await owner.confirm() == .confirmed, "\(tree.log.entries.map(\.line))")
            #expect(authentication.requests == 1)
            #expect(tree.probes("auth-status") == 2, "a fresh check before the request and one after")
            #expect(await owner.report().availability.available)
            #expect(await owner.recheck().availability.available, "a fresh check matches the confirmed snapshot")

            // The same bytes as a new file: another identity.
            let spare = tree.root.appendingPathComponent("spare").path
            try FileManager.default.copyItem(atPath: tree.binaryPath, toPath: spare)
            tree.remove(tree.binaryPath)
            try FileManager.default.moveItem(atPath: spare, toPath: tree.binaryPath)
            let after = await owner.report()
            #expect(after.confirmation == .ended(.cliChanged))
            #expect(after.availability == .unavailable(.overflowUnverified))
            #expect(!owner.claimRun())
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }
    }
}
