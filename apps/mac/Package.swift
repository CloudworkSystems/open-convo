// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "VoiceCursorMac",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "VoiceCursorMac", targets: ["VoiceCursorMac"]),
        .executable(name: "VoiceCursorPolicyCheck", targets: ["VoiceCursorPolicyCheck"]),
        // Bundled next to the app's executable; one per participant run.
        .executable(name: "ParticipantSupervisor", targets: ["ParticipantSupervisor"]),
        // Packaging tool: writes and verifies the Desk bundle manifest.
        .executable(name: "DeskBundleManifest", targets: ["DeskBundleManifest"])
    ],
    targets: [
        // Which copy is running (the real app or "True Convo Test") and every
        // name that follows from it. Pure Foundation; read by the app, the
        // Desk window kit and the participant log.
        .target(name: "TrueConvoIdentity"),
        .testTarget(
            name: "TrueConvoIdentityTests",
            // VoiceCursorCore only so a test can run the real launch sweep
            // (TemporaryAudioStore) against an invented, linked archive.
            dependencies: ["TrueConvoIdentity", "VoiceCursorCore"]
        ),
        .target(name: "VoiceCursorCore"),
        .testTarget(
            name: "VoiceCursorCoreTests",
            dependencies: ["VoiceCursorCore"]
        ),
        // Remembered corrections ("remember this fix"), brought in from Beta Zero.
        .target(name: "CorrectionMemory"),
        .testTarget(
            name: "CorrectionMemoryTests",
            dependencies: ["CorrectionMemory"]
        ),
        // Dictation words sealed on disk (step 2, PR 4): the archive's own
        // key under the Desk store's custody rules, sealed files and history
        // lines, and the sealed word-fix file.
        .target(
            name: "ArchiveProtection",
            dependencies: ["DeskHost", "CorrectionMemory"]
        ),
        .testTarget(
            name: "ArchiveProtectionTests",
            dependencies: ["ArchiveProtection", "DeskHost", "CorrectionMemory"]
        ),
        // Step 2, PR 5: the kill-and-reopen proof. A test-only writer that is
        // SIGKILLed at random moments (never bundled), and the tests that
        // reopen what it left and check nothing acknowledged was lost and
        // nothing is damaged or readable.
        .executableTarget(
            name: "ProtectionProofHost",
            dependencies: ["ArchiveProtection", "DeskHost"],
            path: "Sources/ParticipantTestFakes/ProtectionProofHost"
        ),
        .testTarget(
            name: "ProtectionProofTests",
            dependencies: ["ArchiveProtection", "DeskHost"]
        ),
        // Native side of the Desk join proof (docs/desk-native-join-contract.md).
        // Pure Swift: no AppKit or WebKit, so every refusal is unit-testable.
        .target(name: "DeskHost"),
        .testTarget(
            name: "DeskHostTests",
            dependencies: ["DeskHost"],
            // Shared invented vectors from the Desk side (apps/desk/tests/fixtures).
            resources: [.copy("Fixtures/native-host-v1.json")]
        ),
        // WebKit glue for DeskHost: the trueConvoHost reply handler, the
        // trueConvoHostBootstrap user script, the trueconvo-host DOM event
        // sink, the trueconvo-desk scheme handler and the web view factory.
        .target(
            name: "DeskHostWebKit",
            dependencies: ["DeskHost"]
        ),
        .testTarget(
            name: "DeskHostWebKitTests",
            dependencies: ["DeskHostWebKit", "DeskHost"],
            // Same shared vectors as DeskHostTests (apps/desk/tests/fixtures).
            resources: [.copy("Fixtures/native-host-v1.json")]
        ),
        // One subscription participant's process (docs/desk-native-participant-contract.md
        // section 11). Nothing here resolves or runs the real CLI: its path is
        // always injected, and availability answers `overflow-unverified`.
        // The supervisor's state machine and control codec, Darwin only.
        .target(
            name: "ParticipantSupervisorCore",
            path: "Sources/ParticipantSupervisor/Core"
        ),
        .executableTarget(
            name: "ParticipantSupervisor",
            dependencies: ["ParticipantSupervisorCore"],
            path: "Sources/ParticipantSupervisor/Main"
        ),
        // App side: spawner, control client, stream reader, run driver.
        .target(
            name: "ParticipantProcess",
            dependencies: ["DeskHost", "ParticipantSupervisorCore", "TrueConvoIdentity"]
        ),
        // The participant lane behind HostRouter (contract sections 3-10):
        // one launch-scoped coordinator actor. INACTIVE: only the test target
        // depends on it, nothing in Sources constructs it, and linking it
        // constructs nothing (Codex Q1, Q19).
        .target(
            name: "ParticipantCoordinator",
            dependencies: ["DeskHost", "ParticipantProcess"]
        ),
        // The local-model route (contract section 20): Ollama on this Mac only.
        // INACTIVE: only test targets depend on it. DeskHost for the catalog
        // seam a participant host reads (`LocalCatalogReading`); the
        // coordinator's start wiring follows in step 3 PR 3c.
        .target(
            name: "LocalModelRoute",
            dependencies: ["DeskHost", "ParticipantProcess"]
        ),
        .testTarget(
            name: "LocalModelRouteTests",
            dependencies: ["LocalModelRoute", "ParticipantProcess", "DeskHost"]
        ),
        // Test-only helpers, never bundled: a fake CLI, a host that plays the
        // app (so a test can SIGKILL it), a supervisor test build that can
        // pause before it watches the app and records how it saw the app go,
        // and an availability probe.
        .executableTarget(
            name: "ParticipantFakeCLI",
            path: "Sources/ParticipantTestFakes/FakeCLI"
        ),
        .executableTarget(
            name: "ParticipantTestHost",
            dependencies: ["ParticipantProcess"],
            path: "Sources/ParticipantTestFakes/TestHost"
        ),
        .executableTarget(
            name: "ParticipantPausingSupervisor",
            dependencies: ["ParticipantSupervisorCore"],
            path: "Sources/ParticipantTestFakes/PausingSupervisor"
        ),
        // Prints the shipping availability answer, run by a test with invented
        // environment, arguments, defaults and files.
        .executableTarget(
            name: "ParticipantAvailabilityProbe",
            dependencies: ["ParticipantProcess"],
            path: "Sources/ParticipantTestFakes/AvailabilityProbe"
        ),
        // Section 17's owner as the Desk window's native controls see it
        // (plan F4). INACTIVE: only the test target depends on it, so the app
        // links neither it nor ParticipantProcess; the window shows the
        // controls only when given them, and the app gives none.
        .target(
            name: "ParticipantDeskControls",
            dependencies: ["DeskWindowKit", "ParticipantProcess"]
        ),
        .testTarget(
            name: "ParticipantProcessTests",
            // DeskHostWebKit and DeskWindowKit only so tests can drive the real
            // coordinator through the WebKit glue and the Desk session (plan
            // S11's end-to-end proof); the app and those targets still never
            // depend on the coordinator.
            // LocalModelRoute only so the shared local vectors run through
            // the real catalog parser (step 3 PR 3b).
            dependencies: ["ParticipantProcess", "ParticipantSupervisorCore", "DeskHost", "ParticipantCoordinator",
                           "DeskHostWebKit", "DeskWindowKit", "ParticipantDeskControls", "LocalModelRoute"],
            // Byte copy of the shared participant vectors (apps/desk/tests/fixtures);
            // ParticipantVectorTests fails if the two ever differ. cli-2.1.283:
            // invented streams in the shapes PREDICTED for Claude Code 2.1.283
            // (F1; its README), which StreamConformanceTests replays.
            resources: [.copy("Fixtures/native-participant-v1.json"), .copy("Fixtures/native-participant-local-v1.json"),
                        .copy("Fixtures/cli-2.1.283")]
        ),
        // The Desk window for the Mac app (invented data only): its folders,
        // the bundled Desk's location, one Desk session per app run, lock
        // signals, owner verification, the window and quitting.
        .target(
            name: "DeskWindowKit",
            dependencies: ["DeskHost", "DeskHostWebKit", "TrueConvoIdentity"]
        ),
        .testTarget(
            name: "DeskWindowKitTests",
            dependencies: ["DeskWindowKit", "DeskHost", "DeskHostWebKit", "TrueConvoIdentity"]
        ),
        .executableTarget(
            name: "DeskBundleManifest",
            dependencies: ["DeskHost", "DeskHostWebKit"]
        ),
        .executableTarget(
            name: "VoiceCursorMac",
            dependencies: ["VoiceCursorCore", "CorrectionMemory", "ArchiveProtection", "DeskHost", "DeskHostWebKit", "DeskWindowKit", "TrueConvoIdentity"]
        ),
        .executableTarget(
            name: "VoiceCursorPolicyCheck",
            dependencies: ["VoiceCursorCore"]
        )
    ]
)
