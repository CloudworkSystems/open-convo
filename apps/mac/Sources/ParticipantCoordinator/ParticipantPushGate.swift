import DeskHost
import Foundation
import ParticipantProcess

/// Where participant events go (contract section 8): to each connection
/// valid for the current generation at push time, in sequence order and at
/// most once, nested as `participant.event`; with none valid, nowhere (the
/// event is only retained). Nothing goes out while the gate is shut: before
/// a Desk stack is attached, after it is detached, and while it is
/// suspended, from the moment lock, window close or quit begins
/// (`CoordinatorGate`) until an unlock that no newer lock overtook, or the
/// next attach after a close.
///
/// The gate's lock is held across the whole push, so a push is never half
/// done when the gate shuts, two pushes never interleave, and a push never
/// reaches a stack the coordinator has detached from (Codex Q21): once
/// `suspend()` or `detach()` returns, no push is under way and none follows
/// until the gate opens again. Lock order: `CoordinatorGate`, then this
/// gate, then the connection registry's lock, then the sink's own. A sink
/// must not call back into the coordinator from `push`, and must never wait
/// on the main thread there (it hops to it asynchronously): `suspend()` is
/// called on the app's main thread by lock and by the start of a close or
/// quit, and waits for a push under way, so such a wait would deadlock.
final class ParticipantPushGate: @unchecked Sendable {
    private struct Target {
        let sink: HostEventSink
        let connections: ConnectionRegistry
    }

    private let lock = NSLock()
    private var target: Target?
    private var suspended = false

    /// The attached stack's sink and connections. Pushes go out unless
    /// `suspended` (the coordinator is locked).
    func attach(sink: HostEventSink, connections: ConnectionRegistry, suspended: Bool) {
        lock.lock()
        defer { lock.unlock() }
        target = Target(sink: sink, connections: connections)
        self.suspended = suspended
    }

    /// No stack: nothing can go out, and nothing of the old one is kept.
    func detach() {
        lock.lock()
        defer { lock.unlock() }
        target = nil
    }

    /// Lock, window close or quit began: nothing goes out, whatever stack
    /// is attached, until `resume()`. Returns only once no push is under way.
    func suspend() {
        lock.lock()
        defer { lock.unlock() }
        suspended = true
    }

    /// The unlock: pushes go out again to the attached stack, if any.
    func resume() {
        lock.lock()
        defer { lock.unlock() }
        suspended = false
    }

    var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return target != nil && !suspended
    }

    /// Pushes `event` to every connection valid for the current generation,
    /// read together with that generation. Returns how many received it.
    @discardableResult
    func push(_ event: ParticipantEvent) -> Int {
        lock.lock()
        defer { lock.unlock() }
        guard !suspended, let target else { return 0 }
        let (generation, ids) = target.connections.validConnections()
        let detail = event.jsonValue
        for id in ids {
            target.sink.push(.participantEvent(connectionId: id, generation: generation, event: detail))
        }
        return ids.count
    }
}
