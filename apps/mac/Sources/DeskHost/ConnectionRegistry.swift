import Foundation

/// A host-issued connection. The id is opaque; the generation is the document
/// generation the connection was issued for.
public struct HostConnection: Equatable, Sendable {
    public let id: String
    public let generation: Int
}

public enum ConnectionCheck: Equatable, Sendable {
    case valid
    case staleGeneration
    case unknownConnection
}

/// Issues, checks and revokes connection identities.
///
/// The generation counts Desk document loads. Advancing it (navigation,
/// reload) makes every earlier envelope stale and revokes every earlier
/// connection; lock and close revoke without advancing. A JavaScript global,
/// URL or copied nonce never creates a connection: only `issue()` does, and the
/// app host calls it after verifying its own webview, frame and origin.
public final class ConnectionRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = 0
    private var connections: Set<String> = []

    public init() {}

    public var currentGeneration: Int {
        lock.lock()
        defer { lock.unlock() }
        return generation
    }

    public var activeConnectionCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return connections.count
    }

    /// Ids of every live connection, for lifecycle events.
    public var activeConnections: [String] {
        lock.lock()
        defer { lock.unlock() }
        return connections.sorted()
    }

    /// Registers a caller-chosen id in the current generation. Test hook for
    /// replaying shared vectors; the app host only ever uses `issue()`.
    func adopt(id: String) -> HostConnection {
        lock.lock()
        defer { lock.unlock() }
        connections.insert(id)
        return HostConnection(id: id, generation: generation)
    }

    public func issue() -> HostConnection {
        lock.lock()
        defer { lock.unlock() }
        var id = Self.randomIdentifier()
        while connections.contains(id) { id = Self.randomIdentifier() }
        connections.insert(id)
        return HostConnection(id: id, generation: generation)
    }

    /// A new document generation. Every existing connection is revoked.
    @discardableResult
    public func advanceGeneration() -> Int {
        lock.lock()
        defer { lock.unlock() }
        generation += 1
        connections.removeAll()
        return generation
    }

    /// Generation is checked first so a request from a superseded document is
    /// reported as stale rather than merely unknown.
    public func check(_ id: String, generation requested: Int) -> ConnectionCheck {
        lock.lock()
        defer { lock.unlock() }
        guard requested == generation else { return .staleGeneration }
        guard connections.contains(id) else { return .unknownConnection }
        return .valid
    }

    public func invalidate(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        connections.remove(id)
    }

    public func invalidateAll() {
        lock.lock()
        defer { lock.unlock() }
        connections.removeAll()
    }

    private static func randomIdentifier() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator)) }.joined()
    }
}
