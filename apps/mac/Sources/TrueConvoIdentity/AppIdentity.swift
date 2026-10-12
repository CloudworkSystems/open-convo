import Foundation

/// Which copy of True Convo is running, and every name that follows from it.
///
/// Exactly one bundle id selects the test copy: `com.trueconvo.voice-cursor.test`
/// ("True Convo Test", made by `scripts/package_app.sh --test-identity`). It
/// gets its own settings, Keychain items, archive folder, Desk folder, log
/// label and Services entry, so it can sit next to the real app in the same
/// macOS account without reading or changing anything of the real app's.
///
/// Every other bundle id, and no bundle id at all (`swift run`, unit tests),
/// gets the release values: byte for byte the names the app used before the
/// test copy existed. The match is exact; nothing is guessed from a prefix,
/// a suffix or the app's name.
///
/// This is the only place these names are written down. The app, the Desk
/// window kit and the participant log all read them from here.
public struct AppIdentity: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case release
        case test
    }

    /// The real app's bundle id (Packaging/Info.plist).
    public static let releaseBundleIdentifier = "com.trueconvo.voice-cursor"
    /// The test copy's bundle id, set only by `package_app.sh --test-identity`.
    public static let testBundleIdentifier = "com.trueconvo.voice-cursor.test"

    public let kind: Kind
    /// The bundle id this identity belongs to.
    public let bundleIdentifier: String
    /// The app's name in Finder, the menu bar tooltip and privacy prompts.
    public let displayName: String
    /// The name of the program file inside the app (Contents/MacOS).
    public let executableName: String
    /// The settings domain (`~/Library/Preferences/<domain>.plist`).
    public let settingsDomain: String
    /// The Keychain service that holds the cloud API keys.
    public let keychainService: String
    /// The archive folder's name in the home folder (recordings, transcripts,
    /// history, saved fixes, the run log).
    public let archiveFolderName: String
    /// The app's folder in `~/Library/Application Support` (the Desk's
    /// invented-data store lives inside it).
    public let applicationSupportFolderName: String
    /// The unified-logging subsystem.
    public let logSubsystem: String
    /// The Services menu entry (NSServices NSMenuItem default).
    public let servicesMenuItemTitle: String
    /// The Services port name (NSServices NSPortName).
    public let servicesPortName: String

    /// The real app. Unchanged from before the test copy existed.
    public static let release = AppIdentity(
        kind: .release,
        bundleIdentifier: releaseBundleIdentifier,
        displayName: "True Convo",
        executableName: "True Convo",
        settingsDomain: "com.trueconvo.voice-cursor",
        keychainService: "com.trueconvo.voice-cursor",
        archiveFolderName: ".tca-dictate",
        applicationSupportFolderName: "com.trueconvo.voice-cursor",
        logSubsystem: "com.trueconvo.voice-cursor",
        servicesMenuItemTitle: "Correct With True Convo",
        servicesPortName: "True Convo"
    )

    /// The test copy, "True Convo Test".
    public static let test = AppIdentity(
        kind: .test,
        bundleIdentifier: testBundleIdentifier,
        displayName: "True Convo Test",
        executableName: "True Convo Test",
        settingsDomain: "com.trueconvo.voice-cursor.test",
        keychainService: "com.trueconvo.voice-cursor.test",
        archiveFolderName: ".tca-dictate-test",
        applicationSupportFolderName: "com.trueconvo.voice-cursor.test",
        logSubsystem: "com.trueconvo.voice-cursor.test",
        servicesMenuItemTitle: "Correct With True Convo Test",
        servicesPortName: "True Convo Test"
    )

    /// The test identity for exactly `com.trueconvo.voice-cursor.test`; the
    /// release identity for anything else, including nil.
    public static func resolve(bundleIdentifier: String?) -> AppIdentity {
        bundleIdentifier == testBundleIdentifier ? .test : .release
    }

    /// The running copy's identity, read once from the main bundle.
    public static let current = resolve(bundleIdentifier: Bundle.main.bundleIdentifier)

    public var isTest: Bool { kind == .test }

    /// The app folder's name, such as "True Convo Test.app".
    public var appBundleName: String { "\(displayName).app" }

    /// The archive folder inside the given home folder.
    public func archiveRoot(home: URL) -> URL {
        home.appendingPathComponent(archiveFolderName)
    }

    /// The app's own folder inside the given Application Support folder.
    public func applicationSupportFolder(in applicationSupport: URL) -> URL {
        applicationSupport.appendingPathComponent(applicationSupportFolderName, isDirectory: true)
    }

    /// Whether the app may offer "Open at Login". The test copy never adds a
    /// login item: it is hidden there and refused if reached anyway.
    public var mayRegisterLoginItem: Bool { !isTest }

    /// Whether the app may change the Mac's default microphone when a
    /// specific input is picked in its menu. The test copy never does: it
    /// records from whatever input the Mac already uses.
    public var mayChangeSystemDefaultInput: Bool { !isTest }

    /// Whether to warn that the real app is running, given the bundle ids of
    /// the running apps. Only the test copy ever warns, and only about the
    /// real app (`com.trueconvo.voice-cursor`, exact). The answer is a
    /// warning to show; nothing is ever done to the real app.
    public func shouldWarnRealAppIsRunning(runningBundleIdentifiers: [String?]) -> Bool {
        guard isTest else { return false }
        return runningBundleIdentifiers.contains { $0 == Self.releaseBundleIdentifier }
    }

    /// Whether the real app has just started, comparing the running-app list
    /// seen before with the one seen now. True only in the test copy, and
    /// only when the real app is in `after` but was not in `before`: once per
    /// start, so a real app that stays open is not warned about again, and
    /// one that is quit and opened again is. At launch, `before` is empty, so
    /// a real app that is already open is warned about too.
    public func shouldWarnRealAppStarted(before: [String?], after: [String?]) -> Bool {
        shouldWarnRealAppIsRunning(runningBundleIdentifiers: after)
            && !shouldWarnRealAppIsRunning(runningBundleIdentifiers: before)
    }

    /// Whether an app is the other copy of True Convo, which must never be
    /// picked as the place dictated text goes or a correction is read from.
    /// In the test copy that is the real app, so it never types into or
    /// copies from a real True Convo window. The real app answers false for
    /// every id: it keeps skipping only itself, exactly as before.
    public func isOtherTrueConvoCopy(bundleIdentifier: String?) -> Bool {
        isTest && bundleIdentifier == Self.releaseBundleIdentifier
    }
}

/// The words of the test copy's "True Convo is running" warning. Plain text,
/// kept here so tests can read it without showing a window.
public enum RealAppRunningWarning {
    public static let title = "Quit True Convo before testing"
    public static let message = [
        "Your real True Convo app is running. Both apps answer the same dictation shortcut, so one key press would start both of them.",
        "Quit True Convo from its menu bar icon: the plain one, not the one marked \"Test\". Then use True Convo Test.",
        "True Convo Test has not changed, closed or signaled True Convo, and it never will.",
    ].joined(separator: "\n\n")
    public static let okButton = "OK"
}
