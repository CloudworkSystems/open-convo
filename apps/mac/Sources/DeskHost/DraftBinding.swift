import Foundation

/// What `dictation.bindDraft` captured at recording start: which workspace and
/// session, the workspace revision the draft was read at, and the selection.
/// The draft text itself is not kept; only its UTF-16 length, so a later
/// selection check has something to measure against.
public struct DraftTarget: Equatable, Sendable {
    public let workspaceHandle: String
    /// DeskState session id, case preserved.
    public let sessionId: String
    public let expectedRevision: Int
    public let selection: TextSelection
    public let expectedTextUTF16Count: Int

    public init(workspaceHandle: String, sessionId: String, expectedRevision: Int, selection: TextSelection,
                expectedTextUTF16Count: Int) {
        self.workspaceHandle = workspaceHandle
        self.sessionId = sessionId
        self.expectedRevision = expectedRevision
        self.selection = selection
        self.expectedTextUTF16Count = expectedTextUTF16Count
    }
}

public struct DraftBinding: Equatable, Sendable {
    public let bindingId: UUID
    public let connectionId: String
    public let generation: Int
    public let target: DraftTarget
    public let boundAt: Date
    /// Set once final text was pushed for this binding. The binding stays,
    /// consumed, until unbound or invalidated.
    public internal(set) var deliveryId: UUID?
}

/// A delivery the host pushed to the page: identities only, never the text.
public struct PendingDelivery: Equatable, Sendable {
    public let deliveryId: UUID
    public let bindingId: UUID
    public let connectionId: String
    public let generation: Int
    public let target: DraftTarget
    public let pushedAt: Date
}

public enum HeldReason: String, Equatable, Sendable {
    /// No draft was bound when the recording started.
    case noBinding
    /// The draft captured at recording start was unbound, already delivered
    /// to, or lost its connection or document before the final text arrived.
    /// The text is never retargeted to a draft bound later.
    case targetChanged
    case textTooLarge
    /// The write-ahead delivery record could not be written.
    case storeUnavailable
    /// The host has no event sink, so nothing can be pushed to a page; the
    /// binding is left untouched.
    case noEventSink
    /// Pushed to the page but never confirmed saved: the page's binding was
    /// released, its document went away, or the Desk locked first.
    case notSaved
    /// The recording finished while the Desk was locked (owner decision A,
    /// October 12: words are kept in memory through a lock, never on disk).
    case locked
}

/// Final text the host kept natively because it could not be pushed to the
/// draft its recording was started for. It is never pasted or typed; the app
/// surfaces it for the owner to place by hand. Kept across navigation and
/// lock (in memory only), cleared on close. `generation` is the recording's document.
public struct HeldDelivery: Equatable, Sendable {
    public let deliveryId: UUID
    public let generation: Int
    public let reason: HeldReason
    public let text: String
    public let heldAt: Date
}

/// Ephemeral bindings and pending deliveries: one binding per host-issued
/// id, tied to the connection and document generation it was made in.
/// Advancing the generation drops bindings and pending deliveries; their
/// unsaved text moves to held. Lock keeps held text; close drops it.
public final class DraftBindingRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private let clock: @Sendable () -> Date
    private let makeBindingId: @Sendable () -> UUID
    private let makeDeliveryIdValue: @Sendable () -> UUID
    private var bindings: [UUID: DraftBinding] = [:]
    private var pending: [UUID: PendingDelivery] = [:]
    private var held: [HeldDelivery] = []
    /// Text pushed to a page and kept, in memory only, until its commit is
    /// confirmed. Never written to the store.
    private var retained: [UUID: HeldDelivery] = [:]
    /// Called after held text changes, outside the lock, so the app can show it.
    public var onHeldChange: (@Sendable () -> Void)?

    public init(clock: @escaping @Sendable () -> Date = { Date() },
                makeBindingId: @escaping @Sendable () -> UUID = { UUID() },
                makeDeliveryId: @escaping @Sendable () -> UUID = { UUID() }) {
        self.clock = clock
        self.makeBindingId = makeBindingId
        self.makeDeliveryIdValue = makeDeliveryId
    }

    public func binding(_ id: UUID) -> DraftBinding? {
        lock.lock()
        defer { lock.unlock() }
        return bindings[id]
    }

    public var activeBindingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return bindings.count
    }

    /// Deliveries pushed in a live generation and not yet saved by a commit.
    public var pendingDeliveries: [PendingDelivery] {
        lock.lock()
        defer { lock.unlock() }
        return pending.values.sorted { $0.pushedAt < $1.pushedAt }
    }

    public var heldDeliveries: [HeldDelivery] {
        lock.lock()
        defer { lock.unlock() }
        return held
    }

    /// Whether any words would be lost if the stack closed now: set-aside
    /// text, or text pushed to a page and not yet confirmed saved (a lock
    /// still under way may not have set it aside yet).
    public var keepsUnsavedWords: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !held.isEmpty || !retained.isEmpty
    }

    /// Issues a fresh binding. Binding again does not retarget anything: each
    /// call is its own binding, the newest undelivered one is what a recording
    /// started now captures, and a recording started earlier keeps its own.
    public func bind(connectionId: String, generation: Int, target: DraftTarget) -> DraftBinding {
        lock.lock()
        defer { lock.unlock() }
        var id = makeBindingId()
        while bindings[id] != nil { id = makeBindingId() }
        let binding = DraftBinding(bindingId: id, connectionId: connectionId, generation: generation, target: target,
                                   boundAt: clock(), deliveryId: nil)
        bindings[id] = binding
        return binding
    }

    /// Only the connection and generation that made a binding may remove it;
    /// anything else is told the binding is unknown rather than that it
    /// exists. A late old unbind affects only its own binding.
    public func unbind(bindingId: UUID, connectionId: String, generation: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let existing = bindings[bindingId], existing.generation == generation, existing.connectionId == connectionId else {
            return false
        }
        bindings.removeValue(forKey: bindingId)
        // Released before its delivery was saved: the page will not commit it.
        let setAside = existing.deliveryId.map { setAsideLocked([$0]) } ?? false
        lock.unlock()
        if setAside { onHeldChange?() }
        lock.lock()
        return true
    }

    /// The newest binding in `generation` that has not received final text:
    /// what `DeskHostProtocol.beginRecording` captures. Delivery never
    /// consults this again; it goes to the captured binding or nowhere.
    public func currentBinding(generation: Int) -> DraftBinding? {
        lock.lock()
        defer { lock.unlock() }
        return bindings.values.filter { $0.generation == generation && $0.deliveryId == nil }.max { $0.boundAt < $1.boundAt }
    }

    public func makeDeliveryId() -> UUID {
        lock.lock()
        defer { lock.unlock() }
        var id = makeDeliveryIdValue()
        while pending[id] != nil || retained[id] != nil || held.contains(where: { $0.deliveryId == id }) { id = makeDeliveryIdValue() }
        return id
    }

    /// Marks the binding delivered and remembers the pending delivery. The
    /// text is not stored here; the caller pushes it once and drops it.
    public func reservePending(_ delivery: PendingDelivery) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard var binding = bindings[delivery.bindingId], binding.deliveryId == nil, pending[delivery.deliveryId] == nil else { return false }
        binding.deliveryId = delivery.deliveryId
        bindings[delivery.bindingId] = binding
        pending[delivery.deliveryId] = delivery
        return true
    }

    public func pendingDelivery(_ id: UUID) -> PendingDelivery? {
        lock.lock()
        defer { lock.unlock() }
        return pending[id]
    }

    /// The durable commit saved this delivery; it is pending no longer.
    /// Also takes it out of the set-aside words: an unbind, navigation or
    /// lock while its commit was running may have set it aside already, and
    /// saved words must not be offered again.
    public func completePending(_ id: UUID) {
        lock.lock()
        pending.removeValue(forKey: id)
        retained.removeValue(forKey: id)
        let before = held.count
        held.removeAll { $0.deliveryId == id }
        let changed = held.count != before
        lock.unlock()
        if changed { onHeldChange?() }
    }

    /// Keep pushed text until its commit is confirmed (`completePending`).
    public func retainUntilSaved(_ delivery: HeldDelivery) {
        lock.lock()
        defer { lock.unlock() }
        retained[delivery.deliveryId] = delivery
    }

    public func hold(_ delivery: HeldDelivery) {
        lock.lock()
        held.append(delivery)
        lock.unlock()
        onHeldChange?()
    }

    /// Moves retained text for these deliveries to held, oldest first
    /// whatever order the ids came in. Caller holds the lock.
    private func setAsideLocked(_ ids: [UUID]) -> Bool {
        var kept: [HeldDelivery] = []
        for id in ids {
            pending.removeValue(forKey: id)
            if let one = retained.removeValue(forKey: id) { kept.append(one) }
        }
        held.append(contentsOf: kept.sorted { $0.heldAt < $1.heldAt })
        return !kept.isEmpty
    }

    /// Hands a held text to the app once and forgets it.
    public func takeHeldDelivery(_ id: UUID) -> HeldDelivery? {
        lock.lock()
        guard let index = held.firstIndex(where: { $0.deliveryId == id }) else { lock.unlock(); return nil }
        let taken = held.remove(at: index)
        lock.unlock()
        onHeldChange?()
        return taken
    }

    /// Navigation: bindings and pending deliveries from superseded documents
    /// are gone. Held text belongs to the host, not the document, and stays.
    public func invalidate(generationsBefore generation: Int) {
        lock.lock()
        bindings = bindings.filter { $0.value.generation >= generation }
        let gone = pending.values.filter { $0.generation < generation }.map(\.deliveryId)
        let moved = setAsideLocked(gone)
        lock.unlock()
        if moved { onHeldChange?() }
    }

    /// Lock keeps the owner's words (unsaved text moves to held, held stays);
    /// close drops everything. Bindings and pending deliveries go either way.
    public func invalidateAll(keepingWords: Bool = false) {
        lock.lock()
        let hadHeld = !held.isEmpty || !retained.isEmpty
        if keepingWords {
            // Every retained text, in one oldest-first batch.
            _ = setAsideLocked(Array(retained.keys))
        } else {
            held.removeAll()
        }
        retained.removeAll()
        bindings.removeAll()
        pending.removeAll()
        lock.unlock()
        if hadHeld { onHeldChange?() }
    }
}
