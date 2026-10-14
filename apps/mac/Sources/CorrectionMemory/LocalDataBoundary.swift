import Foundation

/// How the lessons file is kept on disk when it is protected (step 2, PR 4):
/// the app seals it under the dictation archive's key. Without one, the file
/// is the plain owner-only JSON it always was.
public protocol LessonsFileProtection: Sendable {
    /// The lessons JSON inside a stored file. A sealed file is opened; a file
    /// written before protection is returned as it is. Throws when a sealed
    /// file does not open, so damaged lessons are never read as empty.
    func lessonsJSON(fromStored data: Data) throws -> Data
    /// The bytes to store for the lessons JSON.
    func storedBytes(forLessonsJSON json: Data) throws -> Data
}

/// The sole app-owned durable boundary for U2. It writes only the correction
/// lesson array and never provides a location for audio, drafts, transcripts,
/// logs, diagnostics, crash records, or handoffs.
public struct LocalDataBoundary {
    public static let lessonsFileName = "correction-lessons.json"

    public let directory: URL
    public let lessonsFileURL: URL

    private let fileManager: FileManager
    private let protection: (any LessonsFileProtection)?

    public init(directory: URL, fileManager: FileManager = .default, protection: (any LessonsFileProtection)? = nil) {
        self.directory = directory
        self.lessonsFileURL = directory.appendingPathComponent(Self.lessonsFileName, isDirectory: false)
        self.fileManager = fileManager
        self.protection = protection
    }

    func readLessons() throws -> [CorrectionLesson] {
        try secureExistingBoundaryIfPresent()
        guard fileManager.fileExists(atPath: lessonsFileURL.path) else {
            return []
        }

        let attributes = try fileManager.attributesOfItem(atPath: lessonsFileURL.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw LocalDataBoundaryError.lessonsPathIsNotARegularFile
        }

        let stored = try Data(contentsOf: lessonsFileURL)
        let data = try protection?.lessonsJSON(fromStored: stored) ?? stored
        return try JSONDecoder().decode([CorrectionLesson].self, from: data)
    }

    /// Writes a new owner-only temporary copy, confirms its 0600 permissions,
    /// and only then swaps it over the lessons file in one step. If any step
    /// fails, the old lessons file is untouched and the temporary copy is
    /// removed, so the disk never holds lessons the store reported as failed.
    func replaceLessonsAtomically(_ lessons: [CorrectionLesson]) throws {
        try prepareOwnerOnlyDirectory()

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let json = try encoder.encode(lessons)
        let data = try protection?.storedBytes(forLessonsJSON: json) ?? json

        let temporaryURL = directory.appendingPathComponent(
            ".\(Self.lessonsFileName).\(UUID().uuidString).tmp",
            isDirectory: false
        )
        do {
            try Self.writeNewOwnerOnlyFile(data, to: temporaryURL)
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: 0o600)],
                ofItemAtPath: temporaryURL.path
            )
            guard rename(temporaryURL.path, lessonsFileURL.path) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        } catch {
            try? fileManager.removeItem(at: temporaryURL)
            throw error
        }
    }

    /// Creates a file that did not exist before, readable only by its owner
    /// from the moment it appears.
    private static func writeNewOwnerOnlyFile(_ data: Data, to url: URL) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try handle.write(contentsOf: data)
        try handle.close()
    }

    private func secureExistingBoundaryIfPresent() throws {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory) else {
            return
        }
        guard isDirectory.boolValue else {
            throw LocalDataBoundaryError.directoryPathIsNotADirectory
        }

        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: 0o700)],
            ofItemAtPath: directory.path
        )

        if fileManager.fileExists(atPath: lessonsFileURL.path) {
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: 0o600)],
                ofItemAtPath: lessonsFileURL.path
            )
        }
    }

    private func prepareOwnerOnlyDirectory() throws {
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw LocalDataBoundaryError.directoryPathIsNotADirectory
            }
        } else {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: 0o700)]
            )
        }

        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: 0o700)],
            ofItemAtPath: directory.path
        )
    }
}

public enum LocalDataBoundaryError: Error, Equatable, Sendable {
    case directoryPathIsNotADirectory
    case lessonsPathIsNotARegularFile
}
