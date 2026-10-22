import Darwin
import DeskHost
import Foundation

/// Ollama for the shared local vectors' host cases (contract section 20.5):
/// a small HTTP/1.1 server on a random loopback port, set up from a case's
/// `localRoute` seed and played by its fake-server `script` steps. It keeps
/// the catalog `/api/tags` lists, answers `/api/copy` and `/api/delete` on
/// it, and holds each `/api/chat` connection open for the harness to answer
/// step by step. Every request is recorded in order (`calls`). Invented data
/// only; it never reaches the network.
final class VectorOllama: @unchecked Sendable {
    /// One `/api/chat` connection, answered by the harness.
    final class Chat: @unchecked Sendable {
        private let lock = NSLock()
        private var fd: Int32

        init(fd: Int32) { self.fd = fd }

        /// The streaming response's head, `200`, chunked newline-delimited
        /// JSON as Ollama sends it, with no content sniffing (so the client
        /// sees the status before any line).
        func head() {
            write(VectorOllama.head(200, length: nil, type: "application/x-ndjson",
                                    extra: "Transfer-Encoding: chunked\r\nX-Content-Type-Options: nosniff\r\n"))
        }

        /// One newline-ended JSON line, as one HTTP chunk. Returns the
        /// body bytes it adds (the line, without the chunk framing).
        @discardableResult
        func line(_ object: [String: Any]) -> Int {
            let line = ((try? JSONSerialization.data(withJSONObject: object)) ?? Data()) + Data("\n".utf8)
            write(Data(String(line.count, radix: 16).utf8) + Data("\r\n".utf8) + line + Data("\r\n".utf8))
            return line.count
        }

        /// The chunked body's end.
        func end() { write(Data("0\r\n\r\n".utf8)) }

        /// A whole answer (an error status or a redirect), then close.
        func answer(_ data: Data) {
            write(data)
            close()
        }

        /// Close without another byte (`drop`, or after `done`).
        func close() {
            lock.lock(); defer { lock.unlock() }
            guard fd >= 0 else { return }
            Darwin.close(fd)
            fd = -1
        }

        private func write(_ data: Data) {
            lock.lock(); defer { lock.unlock() }
            guard fd >= 0 else { return }
            VectorOllama.send(fd, data)
        }
    }

    enum Mode: Equatable {
        case ready
        /// Nothing listens on the port: `ollama-not-running`.
        case notRunning
        /// `/api/tags` answers something that is not a model list:
        /// `catalog-unreadable`.
        case unreadable
    }

    let port: UInt16
    private let lock = NSLock()
    private var listening = false
    private var acceptDone = DispatchSemaphore(value: 0)
    private var recorded: [JSONValue] = []
    private var rows: [[String: Any]] = []
    private var currentMode: Mode = .ready
    private var retag: [String: Any]?
    private var aliasSwap: String?
    private var openChats: [Chat] = []
    /// Called with the request body when a `/api/chat` arrives, before
    /// anything is answered (the harness checks the start record is
    /// durable then).
    var onChat: ((JSONValue) -> Void)?

    init() throws {
        let fd = try Self.listen(port: 0)
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        port = UInt16(bigEndian: actual.sin_port)
        start(fd)
    }

    deinit { shutDown() }

    /// Every request so far, as `{method, path, body}` (body null when empty).
    var calls: [JSONValue] { lock.lock(); defer { lock.unlock() }; return recorded }
    var chats: [Chat] { lock.lock(); defer { lock.unlock() }; return openChats }
    var mode: Mode { lock.lock(); defer { lock.unlock() }; return currentMode }
    /// The names `/api/tags` would list.
    var names: [String] { lock.lock(); defer { lock.unlock() }; return rows.compactMap { $0["name"] as? String } }

    func clearCalls() { lock.lock(); recorded = []; lock.unlock() }

    /// A `localRoute` seed: `{state, reason, models}`. `models` rows are
    /// `{name, digest}` plus optional `remote: true` (Ollama's cloud
    /// marker) and `capabilities` (default `["completion"]`).
    func configure(_ seed: JSONValue) throws {
        guard let fields = seed.objectValue, Set(fields.keys) == ["state", "reason", "models"],
              case .array(let models)? = fields["models"] else { throw VectorHarnessError.fixture("localRoute is not {state, reason, models}") }
        let mode: Mode
        switch (fields["state"]?.stringValue, fields["reason"]) {
        case ("ready"?, .null?): mode = .ready
        case ("unavailable"?, .string("ollama-not-running")?): mode = .notRunning
        case ("unavailable"?, .string("catalog-unreadable")?): mode = .unreadable
        default: throw VectorHarnessError.unsupported("localRoute \(seed)")
        }
        let built = try models.map(Self.row)
        lock.lock()
        rows = built
        currentMode = mode
        lock.unlock()
        if mode == .notRunning { stopListening() } else if !isListening { start(try Self.listen(port: port)) }
    }

    /// `retag`: the next `/api/copy` first moves the named tag to another
    /// digest (or makes it remote), as if someone retagged it between the
    /// catalog read and the copy. `alias-swap`: the next copy's alias is
    /// then moved to another digest before the check reads it.
    func arm(_ step: JSONValue) throws {
        guard let fields = step.objectValue, let kind = fields["kind"]?.stringValue else { throw VectorHarnessError.fixture("a script step") }
        lock.lock(); defer { lock.unlock() }
        switch kind {
        case "retag":
            guard Set(fields.keys).isSubset(of: ["kind", "name", "digest", "remote"]), let name = fields["name"]?.stringValue,
                  let digest = fields["digest"]?.stringValue else { throw VectorHarnessError.fixture("retag is {kind, name, digest, remote?}") }
            retag = ["name": name, "digest": digest, "remote": fields["remote"] == .bool(true)]
        case "alias-swap":
            guard Set(fields.keys) == ["kind", "digest"], let digest = fields["digest"]?.stringValue else {
                throw VectorHarnessError.fixture("alias-swap is {kind, digest}")
            }
            aliasSwap = digest
        default:
            throw VectorHarnessError.unsupported("script step \(kind) cannot be armed")
        }
    }

    func shutDown() {
        stopListening()
        for chat in chats { chat.close() }
    }

    // MARK: Serving

    private var isListening: Bool { lock.lock(); defer { lock.unlock() }; return listening }

    private func start(_ fd: Int32) {
        lock.lock()
        listening = true
        let done = DispatchSemaphore(value: 0)
        acceptDone = done
        lock.unlock()
        Thread { [weak self] in
            self?.acceptLoop(fd)
            if self == nil { Darwin.close(fd) }
            done.signal()
        }.start()
    }

    /// Stops accepting and closes the listener before returning, so a
    /// request made after this finds nothing listening.
    private func stopListening() {
        lock.lock()
        guard listening else { lock.unlock(); return }
        listening = false
        let done = acceptDone
        lock.unlock()
        done.wait()
    }

    private func acceptLoop(_ fd: Int32) {
        defer { Darwin.close(fd) }
        while isListening {
            var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&poller, 1, 20) > 0 else { continue }
            let client = accept(fd, nil, nil)
            if client < 0 { continue }
            Thread { [weak self] in
                guard let self else { Darwin.close(client); return }
                self.serve(client)
            }.start()
        }
    }

    private func serve(_ client: Int32) {
        var yes: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        guard let (method, path, body) = Self.readRequest(client) else { Darwin.close(client); return }
        let parsed: JSONValue = body.isEmpty ? .null : ((try? JSONValue.decode(body)) ?? .string(String(decoding: body, as: UTF8.self)))
        lock.lock()
        recorded.append(.object(["method": .string(method), "path": .string(path), "body": parsed]))
        let chatHook = onChat
        lock.unlock()
        if method == "POST", path == "/api/chat" {
            chatHook?(parsed)
            let chat = Chat(fd: client)
            lock.lock(); openChats.append(chat); lock.unlock()
            return
        }
        Self.send(client, respond(method: method, path: path, body: parsed))
        Darwin.close(client)
    }

    private func respond(method: String, path: String, body: JSONValue) -> Data {
        lock.lock(); defer { lock.unlock() }
        switch (method, path) {
        case ("GET", "/api/tags"):
            if currentMode == .unreadable { return Self.answer(200, Data("invented: not a model list".utf8)) }
            return Self.answer(200, (try? JSONSerialization.data(withJSONObject: ["models": rows])) ?? Data())
        case ("POST", "/api/copy"):
            if let retag, let index = rows.firstIndex(where: { ($0["name"] as? String) == retag["name"] as? String }) {
                rows[index]["digest"] = retag["digest"]
                if retag["remote"] as? Bool == true {
                    rows[index]["remote_host"] = Self.remoteHost
                    rows[index]["remote_model"] = rows[index]["name"]
                }
                self.retag = nil
            }
            guard let source = body.objectValue?["source"]?.stringValue, let destination = body.objectValue?["destination"]?.stringValue,
                  var row = rows.first(where: { ($0["name"] as? String) == source }) else {
                return Self.answer(404, Data(#"{"error":"invented: model not found"}"#.utf8))
            }
            row["name"] = destination
            row["model"] = destination
            if let swap = aliasSwap {
                row["digest"] = swap
                aliasSwap = nil
            }
            rows.removeAll { ($0["name"] as? String) == destination }
            rows.append(row)
            return Self.answer(200, Data())
        case ("DELETE", "/api/delete"):
            guard let name = body.objectValue?["model"]?.stringValue, rows.contains(where: { ($0["name"] as? String) == name }) else {
                return Self.answer(404, Data(#"{"error":"invented: model not found"}"#.utf8))
            }
            rows.removeAll { ($0["name"] as? String) == name }
            return Self.answer(200, Data())
        default:
            return Self.answer(404, Data(#"{"error":"invented: not found"}"#.utf8))
        }
    }

    // MARK: Wire

    static let remoteHost = "https://invented-cloud.example:443"

    static func row(_ value: JSONValue) throws -> [String: Any] {
        guard let fields = value.objectValue, Set(fields.keys).isSubset(of: ["name", "digest", "remote", "capabilities"]),
              let name = fields["name"]?.stringValue, let digest = fields["digest"]?.stringValue else {
            throw VectorHarnessError.fixture("a localRoute model is not {name, digest, remote?, capabilities?}")
        }
        var capabilities = ["completion"]
        if let value = fields["capabilities"] {
            guard case .array(let items) = value else { throw VectorHarnessError.fixture("capabilities is not a list") }
            capabilities = items.compactMap(\.stringValue)
        }
        var row: [String: Any] = ["name": name, "model": name, "digest": digest, "size": 1, "modified_at": "2026-10-15T00:00:00Z",
                                  "capabilities": capabilities]
        if fields["remote"] == .bool(true) {
            row["remote_host"] = remoteHost
            row["remote_model"] = name
        }
        return row
    }

    static func head(_ status: Int, length: Int?, type: String = "application/json", extra: String = "") -> Data {
        var text = "HTTP/1.1 \(status) X\r\nContent-Type: \(type)\r\nConnection: close\r\n" + extra
        if let length { text += "Content-Length: \(length)\r\n" }
        return Data((text + "\r\n").utf8)
    }

    static func answer(_ status: Int, _ body: Data) -> Data { head(status, length: body.count) + body }

    @discardableResult
    static func send(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let sent = Darwin.send(fd, buffer.baseAddress! + offset, buffer.count - offset, 0)
                if sent <= 0 { return false }
                offset += sent
            }
            return true
        }
    }

    private static func listen(port: UInt16) throws -> Int32 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = port.bigEndian
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, Darwin.listen(fd, 16) == 0 else { Darwin.close(fd); throw POSIXError(.EADDRINUSE) }
        return fd
    }

    private static func readRequest(_ client: Int32) -> (String, String, Data)? {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            if let range = data.range(of: Data("\r\n\r\n".utf8)) {
                let lines = String(decoding: data[..<range.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
                let parts = lines.first?.split(separator: " ") ?? []
                guard parts.count >= 2 else { return nil }
                let length = lines.dropFirst().compactMap { line -> Int? in
                    let pair = line.split(separator: ":", maxSplits: 1)
                    guard pair.count == 2, pair[0].lowercased() == "content-length" else { return nil }
                    return Int(pair[1].trimmingCharacters(in: .whitespaces))
                }.first ?? 0
                var body = Data(data[range.upperBound...])
                while body.count < length {
                    let count = recv(client, &buffer, buffer.count, 0)
                    if count <= 0 { break }
                    body.append(buffer, count: count)
                }
                return (String(parts[0]), String(parts[1]), body)
            }
            let count = recv(client, &buffer, buffer.count, 0)
            if count <= 0 { return nil }
            data.append(buffer, count: count)
        }
    }
}
