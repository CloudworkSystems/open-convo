#!/usr/bin/env swift

import AppKit
import Foundation

let arguments = Array(CommandLine.arguments.dropFirst())
let outputURL = URL(fileURLWithPath: arguments.first ?? "Packaging/AppIcon.iconset")
let sourceURL = URL(fileURLWithPath: arguments.dropFirst().first ?? "Packaging/TrueConvoIcon.png")
let fileManager = FileManager.default

guard let sourceImage = NSImage(contentsOf: sourceURL) else {
    throw NSError(
        domain: "ConvoCursorIcon",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Could not load icon source at \(sourceURL.path)"]
    )
}

try? fileManager.removeItem(at: outputURL)
try fileManager.createDirectory(at: outputURL, withIntermediateDirectories: true)

let iconFiles: [(String, CGFloat)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

func drawIcon(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    defer { image.unlockFocus() }

    let bounds = NSRect(x: 0, y: 0, width: size, height: size)
    NSColor.clear.setFill()
    bounds.fill()

    let padding = size * 0.06
    let target = bounds.insetBy(dx: padding, dy: padding)
    let sourceSize = sourceImage.size
    let scale = min(target.width / sourceSize.width, target.height / sourceSize.height)
    let drawSize = NSSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
    let drawRect = NSRect(
        x: bounds.midX - drawSize.width / 2,
        y: bounds.midY - drawSize.height / 2,
        width: drawSize.width,
        height: drawSize.height
    )

    sourceImage.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)
    return image
}

func writePNG(_ image: NSImage, to url: URL) throws {
    guard
        let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:])
    else {
        throw NSError(
            domain: "ConvoCursorIcon",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Could not render PNG"]
        )
    }
    try png.write(to: url)
}

for (filename, size) in iconFiles {
    try writePNG(drawIcon(size: size), to: outputURL.appendingPathComponent(filename))
}

print(outputURL.path)
