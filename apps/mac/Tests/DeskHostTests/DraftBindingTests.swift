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

    @Test("Held text survives navigation, is handed out once, and is cleared by lock")
    func heldDeliveries() {
        let registry = DraftBindingRegistry()
        let held = HeldDelivery(deliveryId: registry.makeDeliveryId(), generation: 0, reason: .noBinding, text: "private words", heldAt: Date())
        registry.hold(held)
        registry.invalidate(generationsBefore: 5)
        #expect(registry.heldDeliveries == [held], "held text belongs to the host, not the document")
        #expect(registry.takeHeldDelivery(held.deliveryId) == held)
        #expect(registry.takeHeldDelivery(held.deliveryId) == nil)
        registry.hold(held)
        registry.invalidateAll()
        #expect(registry.heldDeliveries.isEmpty, "lock leaves no dictated text in the host")
    }
}

