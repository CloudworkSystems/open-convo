import AppKit
import Foundation
import TrueConvoIdentity

/// True Convo Test only: the first thing the app does at launch, before
/// anything reads or writes the archive (the launch sweep of temporary
/// recordings, the run log, `Archive.ensureDirectories`, saved fixes), is to
/// check that `~/.tca-dictate-test` is the test copy's own folder
/// (`TestArchiveBoundary`). If it, or anything in it, is a link, a Finder
/// alias or leads anywhere else, the app says so in an alert and quits. It
/// changes nothing on disk and writes no log into that folder. The real app
/// returns at once: no new check, exactly as before.
enum TestArchiveLaunchCheck {
    static func quitIfTestArchiveIsNotItsOwn() {
        guard AppIdentity.current.isTest else { return }
        let verdict = TestArchiveBoundary.check(identity: AppIdentity.current, home: FileManager.default.homeDirectoryForCurrentUser)
        guard case .refused(let refusal) = verdict else { return }
        // Standard error only: the run log lives in the folder being refused.
        FileHandle.standardError.write(Data("True Convo Test refused \(refusal.displayPath) (\(refusal.problem.rawValue)) and quit; nothing was changed.\n".utf8))
        // A bare app that only shows the alert, then quits. The real app
        // delegate (menu, shortcut, launch sweep) is never made.
        let app = NSApplication.shared
        let refusalDelegate = TestArchiveRefusalDelegate(refusal: refusal)
        app.delegate = refusalDelegate
        withExtendedLifetime(refusalDelegate) {
            app.run()
        }
        exit(EXIT_FAILURE)
    }
}

private final class TestArchiveRefusalDelegate: NSObject, NSApplicationDelegate {
    private let refusal: TestArchiveBoundary.Refusal

    init(refusal: TestArchiveBoundary.Refusal) {
        self.refusal = refusal
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let alert = NSAlert()
        alert.messageText = TestArchiveRefusalMessage.title
        alert.informativeText = TestArchiveRefusalMessage.message(for: refusal)
        alert.alertStyle = .critical
        alert.addButton(withTitle: TestArchiveRefusalMessage.quitButton)
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        exit(EXIT_FAILURE)
    }
}
