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
            dependencies: ["DeskHost", "ParticipantSupervisorCore"]
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
        .testTarget(
            name: "ParticipantProcessTests",
            dependencies: ["ParticipantProcess", "ParticipantSupervisorCore", "DeskHost"]
        ),
        // The Desk window for the Mac app (invented data only): its folders,
        // the bundled Desk's location, one Desk session per app run, lock
        // signals, owner verification, the window and quitting.
        .target(
            name: "DeskWindowKit",
            dependencies: ["DeskHost", "DeskHostWebKit"]
        ),
        .testTarget(
            name: "DeskWindowKitTests",
            dependencies: ["DeskWindowKit", "DeskHost", "DeskHostWebKit"]
        ),
        .executableTarget(
            name: "DeskBundleManifest",
            dependencies: ["DeskHost", "DeskHostWebKit"]
        ),
        .executableTarget(
            name: "VoiceCursorMac",
            dependencies: ["VoiceCursorCore", "CorrectionMemory", "DeskHost", "DeskHostWebKit", "DeskWindowKit"]
        ),
        .executableTarget(
            name: "VoiceCursorPolicyCheck",
            dependencies: ["VoiceCursorCore"]
        )
    ]
)
