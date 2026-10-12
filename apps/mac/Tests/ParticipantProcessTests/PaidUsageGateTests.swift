import Foundation
import Testing
@testable import DeskWindowKit
@testable import ParticipantDeskControls
@testable import ParticipantProcess

// Source gates for section 17's owner (plan F4): one authentication
// conformer, a ledger that holds nothing durable, wording free of the
// forbidden claims, and nothing in the app that constructs or shows any of
// it (inactive until F7).

private struct SourceLine: CustomStringConvertible {
    let file: String
    let line: String
    var description: String { "\(file): \(line)" }
}

private enum Sources {
    static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()

    /// Every Swift file's code lines under `Sources/<folder>` (all of Sources
    /// when nil), trimmed, comment lines left out, paths relative to Sources.
    static func code(_ folder: String? = nil) throws -> [SourceLine] {
        let sources = root.appendingPathComponent("Sources")
        let files = try #require(FileManager.default.subpaths(atPath: sources.path))
            .filter { path in path.hasSuffix(".swift") && (folder.map { path.hasPrefix($0 + "/") } ?? true) }
        return try files.flatMap { relative in
            try String(contentsOf: sources.appendingPathComponent(relative), encoding: .utf8)
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.hasPrefix("//") && !$0.hasPrefix("///") }
                .map { SourceLine(file: relative, line: $0) }
        }
    }

    static func lines(of relative: String) throws -> [SourceLine] {
        try code().filter { $0.file == relative }
    }
}

@Suite("Section 17 owner: source gates")
struct PaidUsageGateTests {
    static let ownerFiles = ["ParticipantProcess/PaidUsageConfirmation.swift", "ParticipantProcess/OwnerAuthentication.swift",
                             "ParticipantProcess/PaidUsageEndSignals.swift",
                             "ParticipantDeskControls/PaidUsageDeskControls.swift"]

    @Test("Exactly one OwnerAuthentication conformer in Sources, using LAContext's .deviceOwnerAuthentication with a fixed reason, all internal; the owner's one public initializer takes the real checks and uses that conformer; the Desk unlock verifiers are not reused")
    func oneAuthenticator() throws {
        let all = try Sources.code()
        #expect(all.count > 1_000, "the scan read the sources")
        let declaration = try NSRegularExpression(pattern: "^(public |private |fileprivate |internal |final |open )*(class|struct|enum|actor|extension)\\s+[A-Za-z0-9_.]+[^{]*:[^{]*\\bOwnerAuthentication\\b")
        let conformers = all.filter { declaration.firstMatch(in: $0.line, range: NSRange($0.line.startIndex..., in: $0.line)) != nil }
        #expect(conformers.map(\.description)
                    == ["ParticipantProcess/OwnerAuthentication.swift: final class LocalAuthenticationOwnerCheck: OwnerAuthentication {"],
                "\(conformers)")
        let contexts = Set(all.filter { $0.line.contains("LAContext") || $0.line.contains("evaluatePolicy(") }.map(\.file))
        #expect(contexts == ["ParticipantProcess/OwnerAuthentication.swift", "DeskWindowKit/DeskUnlockVerifier.swift"], "\(contexts)")
        let authentication = try Sources.lines(of: "ParticipantProcess/OwnerAuthentication.swift")
        #expect(authentication.contains { $0.line.contains("canEvaluatePolicy(.deviceOwnerAuthentication") })
        #expect(authentication.contains { $0.line.contains("evaluatePolicy(.deviceOwnerAuthentication, localizedReason: Self.reason)") })
        #expect(authentication.filter { $0.line.contains("localizedReason:") }.count == 1, "one fixed reason")
        // The compiler, not this scan alone, keeps a second authenticator or
        // other checks out of the owner (Codex F34-6): nothing here is public,
        // and the owner's only public initializer takes the real checks.
        #expect(!authentication.contains { $0.line.hasPrefix("public ") || $0.line.contains(" public ") }, "internal only")
        let owner = try Sources.lines(of: "ParticipantProcess/PaidUsageConfirmation.swift")
        let publicInits = owner.filter { $0.line.hasPrefix("public") && $0.line.contains("init(") }
        #expect(publicInits.map(\.line) == ["public convenience init(checks: ClaudeLocalChecks) {"], "\(publicInits)")
        #expect(owner.contains { $0.line == "self.init(checks: checks, authentication: LocalAuthenticationOwnerCheck())" })
        for folder in ["ParticipantProcess", "ParticipantDeskControls", "ParticipantCoordinator"] {
            for reused in ["MacOwnerVerifier", "StubUnlockVerifier", "DeskUnlockVerifier"] {
                #expect(!(try Sources.code(folder)).contains { $0.line.contains(reused) }, "\(folder) uses \(reused)")
            }
        }
    }

    @Test("The ledger and the owner keep nothing durable and read no input: no FileManager, defaults, Keychain, encoder, environment or argument; the confirmation is constructed in one place only")
    func ledgerHoldsNothing() throws {
        for file in Self.ownerFiles {
            let code = try Sources.lines(of: file)
            #expect(code.count > 20, "\(file) was read")
            for forbidden in ["FileManager", "UserDefaults", "NSUserDefaults", "SecItem", "SecKeychain", "Keychain", "Encoder",
                              "Encodable", "Codable", "NSKeyedArchiver", "PropertyListSerialization", "JSONSerialization",
                              "write(to", "fopen(", "ProcessInfo", "getenv", "environ", "CommandLine", "Bundle.", "URLSession",
                              "Process(", "@_spi", "#if", "print("] {
                #expect(!code.contains { $0.line.contains(forbidden) }, "\(file): \(forbidden)")
            }
        }
        let constructions = try Sources.code().filter { $0.line.contains("PaidUsageConfirmation(") }
        #expect(constructions.map(\.description)
                    == ["ParticipantProcess/PaidUsageConfirmation.swift: state = .active(PaidUsageConfirmation(confirmedAtMillis: clock.wallMillis(), snapshot: second))"],
                "\(constructions)")
        let ledger = try Sources.lines(of: "ParticipantProcess/PaidUsageConfirmation.swift")
        #expect(ledger.contains { $0.line == "struct PaidUsageConfirmation {" }, "internal, never public")
        #expect(ledger.contains { $0.line == "fileprivate init(confirmedAtMillis: Int64, snapshot: ClaudeLocalSnapshot) {" })
        #expect(!ledger.contains { $0.line.hasPrefix("public init") && $0.line.contains("PaidUsageConfirmation") })
    }

    @Test("The wording never says verified, no charge or free, and says what section 17 requires")
    func wording() throws {
        var texts = DeskPaidUsageWording.allFixed + [LocalAuthenticationOwnerCheck.reason]
        let time: (Date) -> String = { _ in "3:42 PM" }
        let states: [DeskPaidUsageState] = [.unconfirmed] + (1...5).map { .active(confirmedAt: Date(), runsLeft: $0) }
            + DeskPaidUsageEnd.allCases.map { .ended($0) }
        texts += states.map { DeskPaidUsageWording.stateLine($0, time: time) }
        texts += DeskClaudeCheck.allCases.map(DeskPaidUsageWording.checkLine)
        let results: [DeskPaidUsageConfirmResult] = [.confirmed, .alreadyActive, .inProgress, .notAuthenticated,
                                                     .authenticationUnavailable, .interrupted]
            + DeskClaudeCheck.allCases.map { .checksFailed($0) }
        texts += results.compactMap(DeskPaidUsageWording.resultLine)
        for text in texts {
            let lower = text.lowercased()
            for forbidden in ["verified", "verify", "no charge", "free"] {
                #expect(!lower.contains(forbidden), "\(forbidden) in \(text)")
            }
            #expect(!lower.contains("password box") && !lower.contains("touch id"), "\(text)")
        }
        // String literals in the controls' sources too.
        let literal = try NSRegularExpression(pattern: "\"[^\"]*\"")
        for file in ["DeskWindowKit/DeskPaidUsageControls.swift", "ParticipantProcess/OwnerAuthentication.swift",
                     "ParticipantDeskControls/PaidUsageDeskControls.swift"] {
            for line in try Sources.lines(of: file) {
                for match in literal.matches(in: line.line, range: NSRange(line.line.startIndex..., in: line.line)) {
                    let text = String(line.line[Range(match.range, in: line.line)!]).lowercased()
                    #expect(!text.contains("verified") && !text.contains("no charge") && !text.contains("free"), "\(line)")
                }
            }
        }
        #expect(DeskPaidUsageWording.stateLine(.active(confirmedAt: Date(), runsLeft: 4), time: time)
                == "You confirmed paid usage was off at 3:42 PM. True Convo cannot see your billing setting. 4 runs left.")
        #expect(DeskPaidUsageWording.stateLine(.active(confirmedAt: Date(), runsLeft: 1), time: time).hasSuffix(" 1 run left."))
        #expect(DeskPaidUsageWording.stateLine(.ended(.runLimit), time: time).hasPrefix("Paid usage confirmation ended, "))
        #expect(DeskPaidUsageWording.statementDetail.contains("claude.ai Settings > Usage"))
        #expect(DeskPaidUsageWording.statementDetail.contains("True Convo cannot see your billing setting."))
        #expect(DeskPaidUsageWording.statementDetail.contains("macOS asks you to confirm it's you"))
        for text in texts {
            #expect(!text.contains("LocalAuthentication"), "plain words, not the framework's name: \(text)")
        }
        for ending in ["Claude Code or its login or account changes", "paid usage may have been used", "screens sleep"] {
            #expect(DeskPaidUsageWording.statementDetail.contains(ending), "the statement names \(ending)")
        }
        let overflow = DeskPaidUsageWording.stateLine(.ended(.paidOverflow), time: time)
        #expect(!overflow.contains("until you confirm again") && overflow.contains("needs review"),
                "after paid overflow it says stop and review, not confirm again: \(overflow)")
        #expect(DeskPaidUsageWording.confirmButton == "Confirm paid usage is off…" && DeskPaidUsageWording.checkButton == "Check Claude")
    }

    @Test("The end observers' production wiring: the screen lock arrives while the app is in the background, the distributed center defaults to the system's, and the workspace center is the composer's to give")
    func endSignalWiring() throws {
        let code = try Sources.lines(of: "ParticipantProcess/PaidUsageEndSignals.swift")
        #expect(code.contains { $0.line.contains("suspensionBehavior: .deliverImmediately") }, "delivered in the background too")
        #expect(code.contains { $0.line.contains("distributedCenter: NotificationCenter = DistributedNotificationCenter.default()") })
        #expect(code.contains { $0.line == "workspaceCenter: NotificationCenter) {" }, "no default: F7 must give NSWorkspace's")
        #expect(PaidUsageEndSignals.workspaceEnds.map(\.end) == [.lock, .sleep, .sleep, .logout])
    }

    @Test("The mappings to the window's plain values are total and faithful")
    func mappings() {
        for end in ParticipantConfirmationEnd.allCases {
            #expect(PaidUsageDeskControls.end(end).rawValue == end.rawValue)
        }
        for failure in ClaudeLocalFailure.allCases {
            #expect(PaidUsageDeskControls.check(failure).rawValue == failure.rawValue)
            #expect(PaidUsageDeskControls.check(ParticipantAvailabilityReport(availability: .unavailable(failure.reason), confirmation: nil))
                    .rawValue == failure.rawValue)
        }
        #expect(PaidUsageDeskControls.check(ParticipantAvailabilityReport(availability: .unavailable(.overflowUnverified), confirmation: nil))
                == .passed)
        #expect(PaidUsageDeskControls.state(.unconfirmed) == .unconfirmed)
        let active = ParticipantConfirmationDisplay.active(confirmedAt: "2026-10-11T12:00:00.500Z", runsLeft: 3)!
        #expect(PaidUsageDeskControls.state(active)
                == .active(confirmedAt: Date(timeIntervalSince1970: Double(ParticipantTimestamp.parse("2026-10-11T12:00:00.500Z")!) / 1000),
                           runsLeft: 3))
        #expect(PaidUsageDeskControls.state(.ended(.cliChanged)) == .ended(.cliChanged))
    }

    @Test("Inactive: only the test-only probe constructs the owner or the LocalAuthentication check; nothing constructs the controls or the observers, or calls the owner initializer; the app passes no controls and links none of it")
    func inactive() throws {
        let all = try Sources.code()
        let owners = all.filter { $0.line.contains("PaidUsageConfirmationOwner(") }
        #expect(owners.map(\.file) == ["ParticipantTestFakes/AvailabilityProbe/main.swift"], "\(owners)")
        let checks = all.filter { $0.line.contains("LocalAuthenticationOwnerCheck(") }
        #expect(checks.map(\.file) == ["ParticipantProcess/PaidUsageConfirmation.swift"], "only the owner's public initializer: \(checks)")
        #expect(!all.contains { $0.line.contains("PaidUsageDeskControls(") || $0.line.contains("PaidUsageEndSignals(") })
        let ownerInit = all.filter { $0.line.contains("confirmationOwner") }
        #expect(Set(ownerInit.map(\.file)) == ["ParticipantCoordinator/ParticipantCoordinator.swift"], "declared, never called: \(ownerInit)")
        let app = try Sources.code("VoiceCursorMac")
        #expect(app.count > 1_000)
        for name in ["paidUsage", "PaidUsage", "ParticipantProcess", "ParticipantCoordinator", "ParticipantDeskControls",
                     "OwnerAuthentication"] {
            #expect(!app.contains { $0.line.contains(name) }, "the app names \(name)")
        }
        let window = try Sources.lines(of: "DeskWindowKit/DeskWindowController.swift")
        #expect(window.contains { $0.line.contains("paidUsage: DeskPaidUsageControlling? = nil") }, "defaults to nil")
        let package = try String(contentsOf: Sources.root.appendingPathComponent("Package.swift"), encoding: .utf8)
        let appTarget = try #require(package.range(of: "name: \"VoiceCursorMac\",\n            dependencies: [").map {
            String(package[$0.upperBound...].prefix { $0 != "]" })
        })
        #expect(appTarget.contains("DeskWindowKit"))
        for module in ["ParticipantProcess", "ParticipantCoordinator", "ParticipantDeskControls"] {
            #expect(!appTarget.contains(module), "the app links \(module)")
        }
        let windowKit = try #require(package.range(of: "name: \"DeskWindowKit\",\n            dependencies: [").map {
            String(package[$0.upperBound...].prefix { $0 != "]" })
        })
        #expect(!windowKit.contains("Participant"), "the window kit knows no participant module")
    }
}
