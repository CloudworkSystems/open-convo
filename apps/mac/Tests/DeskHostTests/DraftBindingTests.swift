import Foundation
import Testing
@testable import DeskHost

@Suite("Draft bindings")
struct DraftBindingTests {
    private let target = DraftTarget(workspaceHandle: "h", sessionId: "52abcdef-0000-4000-8abc-000000000001", expectedRevision: 5,
                                     selection: TextSelection(start: 7, end: 9), expectedTextUTF16Count: 15)

    @Test("The host issues binding ids; only the owning connection and generation may unbind; the newest undelivered binding is current")
    func bindAndUnbind() {
        let ids = IdSequence([UUID(), UUID()])
        let registry = DraftBindingRegistry(makeBindingId: { ids.next() })
        let first = registry.bind(connectionId: "c1", generation: 2, target: target)
        let second = registry.bind(connectionId: "c1", generation: 2, target: target)
        #expect(first.bindingId != second.bindingId)
        #expect(registry.activeBindingCount == 2)
        #expect(registry.currentBinding(generation: 2)?.bindingId == second.bindingId)
        #expect(registry.currentBinding(generation: 3) == nil)

        #expect(!registry.unbind(bindingId: second.bindingId, connectionId: "c2", generation: 2), "another connection learns nothing")
        #expect(!registry.unbind(bindingId: second.bindingId, connectionId: "c1", generation: 1), "an old generation cannot unbind")
        #expect(!registry.unbind(bindingId: UUID(), connectionId: "c1", generation: 2))
        #expect(registry.unbind(bindingId: second.bindingId, connectionId: "c1", generation: 2))
        #expect(!registry.unbind(bindingId: second.bindingId, connectionId: "c1", generation: 2), "a second unbind finds nothing")
        #expect(registry.currentBinding(generation: 2)?.bindingId == first.bindingId, "a late unbind affects only its own binding")

        let newer = registry.bind(connectionId: "c2", generation: 3, target: target)
        registry.invalidate(generationsBefore: 3)
        #expect(registry.binding(first.bindingId) == nil)
        #expect(registry.binding(newer.bindingId) != nil)
        registry.invalidateAll()
        #expect(registry.activeBindingCount == 0)
    }

    @Test("A delivery consumes its binding once and is pending until the commit completes it; no text is kept")
    func pendingDeliveries() {
        let registry = DraftBindingRegistry()
        let binding = registry.bind(connectionId: "c1", generation: 0, target: target)
        let deliveryId = registry.makeDeliveryId()
        let pending = PendingDelivery(deliveryId: deliveryId, bindingId: binding.bindingId, connectionId: "c1", generation: 0,
                                      target: target, pushedAt: Date())
        #expect(registry.reservePending(pending))
        #expect(!registry.reservePending(pending), "a binding receives final text once")
        #expect(registry.currentBinding(generation: 0) == nil, "a consumed binding is no longer current")
        #expect(registry.binding(binding.bindingId)?.deliveryId == deliveryId)
        #expect(registry.pendingDelivery(deliveryId) == pending)
        #expect(registry.pendingDeliveries == [pending])
        #expect(!Mirror(reflecting: pending).children.compactMap(\.label).contains("text"))

        registry.completePending(deliveryId)
        #expect(registry.pendingDelivery(deliveryId) == nil)
        #expect(registry.binding(binding.bindingId) != nil, "the consumed binding stays until unbound")
        let another = registry.bind(connectionId: "c1", generation: 0, target: target)
        let later = PendingDelivery(deliveryId: registry.makeDeliveryId(), bindingId: another.bindingId, connectionId: "c1",
                                    generation: 0, target: target, pushedAt: Date())
        #expect(registry.reservePending(later))
        registry.invalidate(generationsBefore: 1)
        #expect(registry.pendingDeliveries.isEmpty, "navigation drops pending deliveries with their bindings")
    }

    @Test("Held text survives navigation and lock, is handed out once, and is cleared by close")
    func heldDeliveries() {
        let registry = DraftBindingRegistry()
        let held = HeldDelivery(deliveryId: registry.makeDeliveryId(), generation: 0, reason: .noBinding, text: "private words", heldAt: Date())
        registry.hold(held)
        registry.invalidate(generationsBefore: 5)
        #expect(registry.heldDeliveries == [held], "held text belongs to the host, not the document")
        #expect(registry.takeHeldDelivery(held.deliveryId) == held)
        #expect(registry.takeHeldDelivery(held.deliveryId) == nil)
        registry.hold(held)
        registry.invalidateAll(keepingWords: true)
        #expect(registry.heldDeliveries == [held], "lock keeps the owner's words in memory (owner decision A)")
        registry.invalidateAll()
        #expect(registry.heldDeliveries.isEmpty, "close leaves no dictated text in the host")
    }

    @Test("Pushed text is kept until its commit is confirmed; released, navigated or locked before then, it is set aside as held")
    func retainedUntilSaved() {
        let registry = DraftBindingRegistry()
        let changes = Counter()
        registry.onHeldChange = { changes.increment() }
        func push(_ text: String, generation: Int = 0) -> (binding: DraftBinding, deliveryId: UUID) {
            let binding = registry.bind(connectionId: "c1", generation: generation, target: target)
            let id = registry.makeDeliveryId()
            #expect(registry.reservePending(PendingDelivery(deliveryId: id, bindingId: binding.bindingId, connectionId: "c1",
                                                            generation: generation, target: target, pushedAt: Date())))
            registry.retainUntilSaved(HeldDelivery(deliveryId: id, generation: generation, reason: .notSaved, text: text, heldAt: Date()))
            return (binding, id)
        }
        let saved = push("saved words")
        registry.completePending(saved.deliveryId)
        #expect(registry.unbind(bindingId: saved.binding.bindingId, connectionId: "c1", generation: 0))
        #expect(registry.heldDeliveries.isEmpty, "a confirmed save releases the text")

        let released = push("released words")
        #expect(registry.unbind(bindingId: released.binding.bindingId, connectionId: "c1", generation: 0))
        #expect(registry.heldDeliveries.map(\.text) == ["released words"], "released before saving: set aside")
        #expect(registry.heldDeliveries.first?.reason == .notSaved)

        _ = push("navigated words")
        registry.invalidate(generationsBefore: 1)
        _ = push("locked words", generation: 1)
        registry.invalidateAll(keepingWords: true)
        #expect(registry.heldDeliveries.map(\.text) == ["released words", "navigated words", "locked words"])
        #expect(registry.pendingDeliveries.isEmpty && registry.activeBindingCount == 0)
        #expect(changes.value == 3, "the app is told each time words are set aside")
    }

    /// Codex P1 on #7, round 2: a commit that finishes after its words were
    /// set aside takes them out of the set-aside list.
    @Test("A save confirmed after a set-aside forgets the set-aside words")
    func saveAfterSetAside() {
        let registry = DraftBindingRegistry()
        let changes = Counter()
        registry.onHeldChange = { changes.increment() }
        let binding = registry.bind(connectionId: "c1", generation: 0, target: target)
        let id = registry.makeDeliveryId()
        #expect(registry.reservePending(PendingDelivery(deliveryId: id, bindingId: binding.bindingId, connectionId: "c1",
                                                        generation: 0, target: target, pushedAt: Date())))
        registry.retainUntilSaved(HeldDelivery(deliveryId: id, generation: 0, reason: .notSaved, text: "words", heldAt: Date()))
        registry.invalidateAll(keepingWords: true)
        #expect(registry.heldDeliveries.map(\.text) == ["words"])
        registry.completePending(id)
        #expect(registry.heldDeliveries.isEmpty, "saved words are not offered again")
        #expect(!registry.keepsUnsavedWords)
        #expect(changes.value == 2, "set aside, then forgotten")
    }

    /// Codex P2 on #7, round 2: a batch set aside together keeps its order.
    @Test("Words set aside together stay oldest first")
    func setAsideOrder() {
        let registry = DraftBindingRegistry()
        let start = Date(timeIntervalSince1970: 1_000_000)
        let texts = (0..<12).map { "words \($0)" }
        for (index, text) in texts.enumerated() {
            let binding = registry.bind(connectionId: "c1", generation: 0, target: target)
            let id = registry.makeDeliveryId()
            let at = start.addingTimeInterval(Double(index))
            #expect(registry.reservePending(PendingDelivery(deliveryId: id, bindingId: binding.bindingId, connectionId: "c1",
                                                            generation: 0, target: target, pushedAt: at)))
            registry.retainUntilSaved(HeldDelivery(deliveryId: id, generation: 0, reason: .notSaved, text: text, heldAt: at))
        }
        registry.invalidateAll(keepingWords: true)
        #expect(registry.heldDeliveries.map(\.text) == texts)
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func increment() { lock.lock(); count += 1; lock.unlock() }
}

