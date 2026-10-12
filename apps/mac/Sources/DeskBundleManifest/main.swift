import DeskHost
import DeskHostWebKit
import Foundation

// Packaging tool for the Desk bundle inside True Convo.app.
//
//   DeskBundleManifest write <Desk folder> <manifest.json>
//   DeskBundleManifest --verify <Desk folder> <manifest.json>
//
// `write` scans the folder (DeskBundleScanner: every regular file with a
// listable extension; a symlink, an unknown extension or a missing
// index.html is refused) and writes the manifest the app reads. `--verify`
// scans again and requires the saved manifest to match exactly. Any refusal
// or mismatch exits non-zero. Prints counts only, never file contents.

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data(("DeskBundleManifest: " + message + "\n").utf8))
    exit(code)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 3, arguments[0] == "write" || arguments[0] == "--verify" else {
    fail("usage: DeskBundleManifest write|--verify <Desk folder> <manifest.json>", code: 2)
}
let folder = URL(fileURLWithPath: arguments[1], isDirectory: true)
let manifestURL = URL(fileURLWithPath: arguments[2], isDirectory: false)

let scanned: BundleManifest
do {
    scanned = try DeskBundleScanner.manifest(forBundleAt: folder)
} catch {
    fail("the Desk folder was refused: \(error)")
}

if arguments[0] == "write" {
    do {
        try DeskBundleScanner.write(scanned, to: manifestURL)
    } catch {
        fail("could not write the manifest: \(error)")
    }
    print("Desk manifest written: \(scanned.assets.count) assets")
} else {
    let saved: BundleManifest
    do {
        saved = try BundleManifest.load(from: manifestURL)
    } catch {
        fail("the manifest could not be read: \(error)")
    }
    guard saved == scanned else {
        fail("the manifest does not match the Desk folder (\(saved.assets.count) listed, \(scanned.assets.count) found)")
    }
    print("Desk manifest verified: \(scanned.assets.count) assets")
}
