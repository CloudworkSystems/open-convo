import Foundation
import ParticipantProcess

/// Ollama on this Mac (contract section 20.1). Production reaches only the
/// fixed base `http://127.0.0.1:11434`; nothing reads an environment
/// variable (including `OLLAMA_HOST`), default, argument, file or page value
/// that could change it. Tests reach a fake server on another loopback port
/// through the internal initializer.
public struct OllamaEndpoint: Equatable, Sendable {
    public let base: URL

    public static let fixed = OllamaEndpoint(port: 11434)

    /// Internal: tests only, and only loopback.
    init(port: UInt16) {
        base = URL(string: "http://127.0.0.1:\(port)")!
    }

    func url(_ path: String) -> URL { base.appendingPathComponent(path) }

    /// No proxy, cache, cookies or credentials: a loopback request goes
    /// straight to the socket.
    static func configuration(requestTimeout: TimeInterval) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.timeoutIntervalForResource = requestTimeout
        configuration.waitsForConnectivity = false
        return configuration
    }
}

/// Refuses every redirect (section 20.1), whatever its target.
final class RedirectRefuser: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// The result of binding a run to its model's digest (section 20.4).
public enum LocalBindResult: Equatable, Sendable {
    /// The alias exists with the run's exact digest and no remote marker.
    case bound(alias: String)
    /// The model moved, vanished, became remote or the copy failed:
    /// `participant-changed`, nothing sent.
    case changed
    /// The route went down: `participant-unavailable`, nothing sent.
    case unavailable(LocalRouteReason)
}

/// Catalog reads and alias management, each a short request. Chat runs go
/// through `LocalChatRun`.
public final class OllamaClient: @unchecked Sendable {
    public let endpoint: OllamaEndpoint
    private let session: URLSession
    private let refuser = RedirectRefuser()

    public convenience init() { self.init(endpoint: .fixed) }

    init(endpoint: OllamaEndpoint, requestTimeout: TimeInterval = 5) {
        self.endpoint = endpoint
        self.session = URLSession(configuration: OllamaEndpoint.configuration(requestTimeout: requestTimeout),
                                  delegate: refuser, delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    /// `/api/tags`, read afresh every time (no reused answer).
    public func catalog() async -> LocalCatalog {
        switch await send(method: "GET", path: "api/tags", body: nil) {
        case .ok(let data): return OllamaCatalog.parse(data)
        case .status, .redirected: return .unavailable(.catalogUnreadable)
        case .notRunning: return .unavailable(.ollamaNotRunning)
        case .transport: return .unavailable(.catalogUnreadable)
        }
    }

    /// Step 13 for a local run: copy the model to the run's alias, then a
    /// fresh catalog read must show the alias with the run's exact digest and
    /// no remote marker. Any other result deletes the alias.
    public func bind(entry: LocalModelEntry, runId: String) async -> LocalBindResult {
        guard entry.isLocal, let alias = OllamaAlias.name(forRunId: runId) else { return .changed }
        let copy = await send(method: "POST", path: "api/copy",
                              body: ["source": entry.name, "destination": alias])
        switch copy {
        case .ok: break
        case .notRunning: return .unavailable(.ollamaNotRunning)
        case .status, .redirected, .transport:
            await deleteAlias(alias)
            return .changed
        }
        // The alias is excluded from entries, so read the raw list for it.
        switch await send(method: "GET", path: "api/tags", body: nil) {
        case .ok(let data):
            if Self.aliasMatches(data, alias: alias, digest: entry.digest) { return .bound(alias: alias) }
            await deleteAlias(alias)
            return .changed
        case .notRunning:
            return .unavailable(.ollamaNotRunning)
        case .status, .redirected, .transport:
            await deleteAlias(alias)
            return .changed
        }
    }

    /// Deletes one alias, only in the exact generated format.
    @discardableResult
    public func deleteAlias(_ alias: String) async -> Bool {
        guard OllamaAlias.isAlias(alias) else { return false }
        if case .ok = await send(method: "DELETE", path: "api/delete", body: ["model": alias]) { return true }
        return false
    }

    /// Deletes every alias in the exact generated format that no live run
    /// owns (at launch and before a start). Never any other name.
    public func sweepAliases(keeping liveRunIds: Set<String>) async {
        guard case .ok(let data) = await send(method: "GET", path: "api/tags", body: nil),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = root["models"] as? [[String: Any]] else { return }
        let keep = Set(liveRunIds.compactMap(OllamaAlias.name(forRunId:)))
        for case let name as String in models.map({ $0["name"] }) where OllamaAlias.isAlias(name) && !keep.contains(name) {
            await deleteAlias(name)
        }
    }

    static func aliasMatches(_ data: Data, alias: String, digest: String) -> Bool {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = root["models"] as? [[String: Any]] else { return false }
        let found = models.filter { ($0["name"] as? String) == alias }
        guard found.count == 1, let model = found.first else { return false }
        return (model["digest"] as? String) == digest && model["remote_host"] == nil && model["remote_model"] == nil
    }

    // MARK: Transport

    enum Outcome {
        case ok(Data)
        case status(Int)
        case redirected
        case notRunning
        case transport
    }

    func send(method: String, path: String, body: [String: String]?) async -> Outcome {
        var request = URLRequest(url: endpoint.url(path))
        request.httpMethod = method
        if let body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return await withCheckedContinuation { continuation in
            // A refused redirect leaves its 3xx as the final response.
            let task = session.dataTask(with: request) { data, response, error in
                if let error = error as? URLError {
                    continuation.resume(returning: Self.notRunning(error) ? .notRunning : .transport)
                    return
                }
                guard error == nil, let http = response as? HTTPURLResponse else {
                    continuation.resume(returning: .transport); return
                }
                if (300..<400).contains(http.statusCode) { continuation.resume(returning: .redirected); return }
                continuation.resume(returning: http.statusCode == 200 ? .ok(data ?? Data()) : .status(http.statusCode))
            }
            task.resume()
        }
    }

    static func notRunning(_ error: URLError) -> Bool {
        [.cannotConnectToHost, .cannotFindHost, .networkConnectionLost].contains(error.code)
    }
}

/// One turn sent as context (section 20.3).
public struct LocalChatTurn: Equatable, Sendable {
    public enum Role: String, Sendable { case user, assistant }
    public let role: Role
    public let text: String

    public init(role: Role, text: String) {
        self.role = role
        self.text = text
    }
}

/// What a local start sends once its receipt is durable (section 20.4).
public struct LocalChatRequest: Sendable {
    public var identity: ParticipantRunIdentity
    /// The run's alias, from `OllamaClient.bind`.
    public var alias: String
    public var context: [LocalChatTurn]
    public var inputChunks: [String]
    /// The prepared entry's byte counts (section 20.5).
    public var contextBytes: Int
    public var inputBytes: Int

    public init(identity: ParticipantRunIdentity, alias: String, context: [LocalChatTurn], inputChunks: [String],
                contextBytes: Int, inputBytes: Int) {
        self.identity = identity
        self.alias = alias
        self.context = context
        self.inputChunks = inputChunks
        self.contextBytes = contextBytes
        self.inputBytes = inputBytes
    }

    /// `/api/chat`'s body: the alias, streaming, thinking off, the context
    /// turns and then the new message, joined as stored.
    func body() throws -> Data {
        var messages = context.map { ["role": $0.role.rawValue, "content": $0.text] }
        messages.append(["role": "user", "content": inputChunks.joined()])
        let object: [String: Any] = ["model": alias, "stream": true, "think": false, "messages": messages]
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}
