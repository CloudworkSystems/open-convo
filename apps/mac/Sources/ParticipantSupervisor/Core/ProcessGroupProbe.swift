import Darwin

/// Lists a process group's members with `proc_listpids(PROC_PGRP_ONLY)`.
/// Zombies are listed too (the kernel walks both the live and the zombie
/// lists), which is why callers leave out the exited, unreaped leader.
public enum ProcessGroupProbe {
    /// More members than this are reported as this many; the caller only
    /// needs to know whether any remain.
    public static let capacity = 4096

    /// The group's members, or nil when the probe failed. A failure is never
    /// an empty group: the wrapper answers 0 both for "no member" and for an
    /// error (out of memory, or a sandbox or policy denial), telling them
    /// apart only by `errno`.
    public static func members(of group: pid_t) -> [pid_t]? {
        members(of: group, bufferBytes: capacity * MemoryLayout<pid_t>.size)
    }

    /// `bufferBytes` under one pid's size makes the kernel refuse with
    /// `ENOMEM`; tests use it to check a failed probe reads as unknown.
    static func members(of group: pid_t, bufferBytes: Int) -> [pid_t]? {
        guard group > 0 else { return [] }
        let slots = max(1, (bufferBytes + MemoryLayout<pid_t>.size - 1) / MemoryLayout<pid_t>.size)
        var pids = [pid_t](repeating: 0, count: slots)
        var failure: Int32 = 0
        let bytes = pids.withUnsafeMutableBytes { buffer -> Int32 in
            errno = 0
            let result = proc_listpids(UInt32(PROC_PGRP_ONLY), UInt32(group), buffer.baseAddress, Int32(bufferBytes))
            failure = errno
            return result
        }
        guard bytes >= 0 else { return nil }
        if bytes == 0 { return failure == 0 ? [] : nil }
        let count = min(Int(bytes) / MemoryLayout<pid_t>.size, slots)
        return pids.prefix(count).filter { $0 > 0 }
    }
}
