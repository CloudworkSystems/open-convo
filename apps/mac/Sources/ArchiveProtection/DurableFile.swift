import Foundation

/// Owner-only files that reach permanent storage before they count.
///
/// On macOS `fsync(2)` only pushes to the drive's cache; `F_FULLFSYNC` asks
/// the drive to commit. Where a file system refuses `F_FULLFSYNC`, plain
/// `fsync` is the fallback; a failure of both is a write failure.
enum DurableFile {
    struct Failure: Error, Equatable {
        let code: Int32
    }

    /// Creates a file that did not exist before, owner-only (0600) from the
    /// moment it appears, writes all of `data` and flushes it.
    static func writeNew(_ data: Data, to url: URL) throws {
        let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else { throw Failure(code: errno) }
        defer { close(descriptor) }
        try writeAll(data, to: descriptor)
        try flush(descriptor)
    }

    /// Replaces `url` in one step: a flushed owner-only copy beside it is
    /// renamed over it, then the folder is flushed. If any step fails the
    /// old file is untouched and the copy is removed.
    static func replace(_ url: URL, with data: Data) throws {
        let folder = url.deletingLastPathComponent()
        let temporary = folder.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp", isDirectory: false)
        do {
            try writeNew(data, to: temporary)
            guard rename(temporary.path, url.path) == 0 else { throw Failure(code: errno) }
        } catch {
            unlink(temporary.path)
            throw error
        }
        try flushFolder(folder)
    }

    /// Appends one line (a newline is added) in a single write, then flushes.
    /// A file whose last line was cut short gets a newline first, so the new
    /// line never joins a torn one. A new file is made owner-only (0600).
    static func appendLine(_ line: Data, to url: URL) throws {
        let descriptor = Darwin.open(url.path, O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else { throw Failure(code: errno) }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0 else { throw Failure(code: errno) }
        guard (info.st_mode & S_IFMT) == S_IFREG else { throw Failure(code: EFTYPE) }
        var record = Data()
        if info.st_size > 0 {
            var last: UInt8 = 0
            guard pread(descriptor, &last, 1, info.st_size - 1) == 1 else { throw Failure(code: errno) }
            if last != UInt8(ascii: "\n") { record.append(UInt8(ascii: "\n")) }
        }
        record.append(line)
        record.append(UInt8(ascii: "\n"))
        try writeAll(record, to: descriptor)
        try flush(descriptor)
    }

    static func flushFolder(_ folder: URL) throws {
        let descriptor = Darwin.open(folder.path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { throw Failure(code: errno) }
        defer { close(descriptor) }
        try flush(descriptor)
    }

    private static func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let wrote = write(descriptor, buffer.baseAddress! + offset, buffer.count - offset)
                if wrote < 0 {
                    if errno == EINTR { continue }
                    throw Failure(code: errno)
                }
                offset += wrote
            }
        }
    }

    private static func flush(_ descriptor: Int32) throws {
        if fcntl(descriptor, F_FULLFSYNC) == 0 { return }
        guard fsync(descriptor) == 0 else { throw Failure(code: errno) }
    }
}
