import DeskHost
import Foundation

/// The document-start user script that defines
/// `window.trueConvoHostBootstrap = { v: 1, connectionId, generation }` for
/// one document generation. The values are JSON-encoded by
/// `JSONSerialization` and dropped into a fixed template at one placeholder;
/// no raw string is ever interpolated, so an opaque connection id cannot
/// break out of the literal. The page reads the global as a hint only; the
/// host still checks the connection id in every request.
public struct HostBootstrapScript: Equatable, Sendable {
    public static let globalName = "trueConvoHostBootstrap"
    static let placeholder = "__TRUECONVO_BOOTSTRAP_JSON__"

    /// Fixed template. The object is frozen, and the window property is
    /// neither writable nor configurable, so page code cannot replace it. A
    /// second definition on the same document (which WebKit never does for
    /// one user script) fails silently rather than throwing into the page.
    static let template = """
    (function (bootstrap) {
      "use strict";
      try {
        Object.defineProperty(window, "\(globalName)", {
          value: Object.freeze(bootstrap),
          writable: false,
          enumerable: false,
          configurable: false
        });
      } catch (error) {}
    })(\(placeholder));
    """

    public let connectionId: String
    public let generation: Int
    /// The JSON text that was substituted, exactly as the encoder wrote it.
    public let encodedBootstrap: String
    public let source: String

    public init(connection: HostConnection) throws {
        try self.init(connectionId: connection.id, generation: connection.generation)
    }

    public init(connectionId: String, generation: Int) throws {
        let object: [String: Any] = [
            "v": DeskHost.protocolVersion,
            "connectionId": connectionId,
            "generation": generation
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard let encoded = String(data: data, encoding: .utf8) else { throw BootstrapScriptError.encodingFailed }
        self.connectionId = connectionId
        self.generation = generation
        encodedBootstrap = encoded
        source = Self.template.replacingOccurrences(of: Self.placeholder, with: encoded)
    }
}

public enum BootstrapScriptError: Error, Equatable, Sendable {
    case encodingFailed
}
