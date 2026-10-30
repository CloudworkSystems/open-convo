import Darwin
import DeskHost
import Foundation
import ParticipantProcess

// A test-target probe, never bundled: prints the shipping availability answer
// as one line, `available=<bool> reason=<reason or none>`. A test runs it as
// its own process with invented environment variables, launch arguments
// (including `-Name value` defaults), and invented flag files in its working
// folder, HOME and TMPDIR, to check that none of them changes the answer.
//
// Run through a link named `ParticipantAvailabilityReportProbe`, it prints
// the reporting path's answer instead (`CheckedAvailability` over the
// shipping check): `available=<bool> reason=<reason or none>
// confirmation=<omitted or its state>`. Only the name it was started under
// picks the path; the invented inputs are the same for both.
//
// Run through a link named `ParticipantAvailabilityLocalChecksProbe`, it runs
// section 5's real local checks (plan F3) over an invented tree in its
// working folder (`home`, `managed`, `preferences`, `work`; user
// `invented-user`; the git walk stops at the working folder), with this
// process's own environment, and prints `available=<bool> reason=<reason or
// none> local=<passed or its failure> production=<passed or its failure>
// outside=<count>`: even when every local check passes, the answer is not
// available. `local` runs `auth status` (the fake's; the tests' gate);
// `production` is the public initializer's checks over the same tree, which
// run it with its network blocked (the D1 decision). `outside` counts the paths the first
// checks touched outside the working folder (each is also written to
// stderr), which the test requires to be 0. The checks' log lines go nowhere
// (never the Mac's unified log).
//
// Run through a link named `ParticipantConfirmationOwnerProbe`, it makes
// section 17's owner (plan F4) as a new launch would, over those same real
// local checks, and asks it for a report, a recheck and a run claim, without
// ever starting a confirmation (so no LocalAuthentication request is made):
// `available=<bool> reason=<reason or none> confirmation=<state>
// recheck=<reason or none> claim=<bool> outside=<count>`. Whatever the
// invented inputs claim, a new launch is `unconfirmed`, not available, and
// claims nothing.

let started = URL(fileURLWithPath: CommandLine.arguments.first ?? "").lastPathComponent
let root = FileManager.default.currentDirectoryPath

/// The checks' log, dropped.
struct DroppedCheckLog: ClaudeCheckLogSink {
    func record(_ entry: ClaudeCheckLogEntry) {}
}

/// Paths the checks touched outside the working folder.
final class OutsideAccesses: @unchecked Sendable {
    private let lock = NSLock()
    private var paths: [String] = []

    func record(_ access: ClaudeCheckAccess) {
        guard !access.path.hasPrefix(root + "/") else { return }
        lock.lock(); paths.append(access.path); lock.unlock()
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        for path in paths { FileHandle.standardError.write(Data("outside: \(path)\n".utf8)) }
        return paths.count
    }
}

let outside = OutsideAccesses()

/// The invented tree in the working folder.
let inventedRoots = ClaudeCheckRoots(home: root + "/home", userName: "invented-user", owner: getuid(),
                                     managedSettingsFolder: root + "/managed", managedPreferencesFolder: root + "/preferences",
                                     probeParent: URL(fileURLWithPath: root + "/work", isDirectory: true), gitSearchTop: root)

/// Section 5's real local checks over the invented tree, running the fake's
/// `auth status` with nothing around it (the tests' gate; production runs
/// it with its network blocked).
func inventedLocalChecks() -> ClaudeLocalChecks {
    ClaudeLocalChecks(roots: inventedRoots, log: DroppedCheckLog(), observer: { outside.record($0) }, authStatus: .runForTests)
}

let done = DispatchSemaphore(value: 0)
Task.detached {
    switch started {
    case "ParticipantAvailabilityReportProbe":
        let report = await CheckedAvailability(checker: ShippingAvailability()).report()
        let confirmation: String
        switch report.confirmation?.state {
        case nil: confirmation = "omitted"
        case .unconfirmed?: confirmation = "unconfirmed"
        case .active?: confirmation = "active"
        case .ended?: confirmation = "ended"
        }
        print("available=\(report.availability.available) reason=\(report.availability.reason?.rawValue ?? "none") "
              + "confirmation=\(confirmation)")
    case "ParticipantConfirmationOwnerProbe":
        let owner = PaidUsageConfirmationOwner(checks: inventedLocalChecks(), approval: NoHostApproval())
        let report = await owner.report()
        let rechecked = await owner.recheck()
        let claimed = owner.claimRun()
        let confirmation: String
        switch report.confirmation?.state {
        case nil: confirmation = "omitted"
        case .unconfirmed?: confirmation = "unconfirmed"
        case .active?: confirmation = "active"
        case .ended?: confirmation = "ended"
        }
        print("available=\(report.availability.available) reason=\(report.availability.reason?.rawValue ?? "none") "
              + "confirmation=\(confirmation) recheck=\(rechecked.availability.reason?.rawValue ?? "none") claim=\(claimed) "
              + "outside=\(outside.count)")
    case "ParticipantAvailabilityLocalChecksProbe":
        let checks = inventedLocalChecks()
        let answer = await checks.check()
        let rechecked = await checks.recheck()
        func name(_ result: ClaudeLocalCheckResult) -> String {
            switch result {
            case .passed: return "passed"
            case .failed(let failure): return failure.rawValue
            }
        }
        let local = name(await checks.evaluate())
        // The public initializer, as F7 would make it, over the same tree.
        let production = name(await ClaudeLocalChecks(roots: inventedRoots, log: DroppedCheckLog()).evaluateFresh())
        let same = answer == rechecked ? "" : " recheck-differs"
        print("available=\(answer.available) reason=\(answer.reason?.rawValue ?? "none") local=\(local)\(same) "
              + "production=\(production) outside=\(outside.count)")
    default:
        let answer = await ShippingAvailability().check()
        print("available=\(answer.available) reason=\(answer.reason?.rawValue ?? "none")")
    }
    done.signal()
}
done.wait()
