import Darwin
import Foundation

/// A tiny HTTP/1.1 server on a random loopback port that plays Ollama for
/// tests. Each request is answered by `handler`; every request is recorded.
/// Invented data only; it never reaches the network.
final class FakeOllama: @unchecked Sendable {
    struct Request: Equatable {
        let method: String
        let path: String
        let body: Data
        var json: [String: Any]? { try? JSONSerialization.jsonObject(with: body) as? [String: Any] }
        static func == (a: Request, b: Request) -> Bool { a.method == b.method && a.path == b.path && a.body == b.body }
    }

    enum Response {
        case json(status: Int, Any)
        case raw(status: Int, Data)
        /// Body pieces written with a pause before each, then close.
        case stream(status: Int, pieces: [(delayMillis: Int, data: Data)])
        case redirect(location: String)
        /// Accept, then close without answering.
        case drop
    }

    let port: UInt16
    private let listener: Int32
    private let lock = NSLock()
    private var recorded: [Request] = []
    var handler: (Request) -> Response

    init(handler: @escaping (Request) -> Response = { _ in .json(status: 404, ["error": "not found"]) }) throws {
        self.handler = handler
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 16) == 0 else { close(fd); throw POSIXError(.EADDRINUSE) }
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        listener = fd
        port = UInt16(bigEndian: actual.sin_port)
        let thread = Thread { [weak self] in self?.acceptLoop() }
        thread.start()
    }

    deinit { close(listener) }

    var requests: [Request] { lock.lock(); defer { lock.unlock() }; return recorded }

    private func acceptLoop() {
        while true {
            let client = accept(listener, nil, nil)
            if client < 0 { return }
            Thread { [weak self] in self?.serve(client) }.start()
        }
    }

    private func serve(_ client: Int32) {
        defer { close(client) }
        var yes: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        guard let request = readRequest(client) else { return }
        lock.lock(); recorded.append(request); let respond = handler; lock.unlock()
        switch respond(request) {
        case .json(let status, let object):
            let body = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
            write(client, head(status, length: body.count) + body)
        case .raw(let status, let body):
            write(client, head(status, length: body.count) + body)
        case .stream(let status, let pieces):
            write(client, head(status, length: nil))
            for piece in pieces {
                if piece.delayMillis > 0 { usleep(useconds_t(piece.delayMillis * 1000)) }
                if !write(client, piece.data) { return }
            }
        case .redirect(let location):
            write(client, Data("HTTP/1.1 307 Temporary Redirect\r\nLocation: \(location)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
        case .drop:
            return
        }
    }

    private func head(_ status: Int, length: Int?) -> Data {
        var text = "HTTP/1.1 \(status) X\r\nContent-Type: application/json\r\nConnection: close\r\n"
        if let length { text += "Content-Length: \(length)\r\n" }
        return Data((text + "\r\n").utf8)
    }

    @discardableResult
    private func write(_ client: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let sent = Darwin.send(client, buffer.baseAddress! + offset, buffer.count - offset, 0)
                if sent <= 0 { return false }
                offset += sent
            }
            return true
        }
    }

    private func readRequest(_ client: Int32) -> Request? {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            if let range = data.range(of: Data("\r\n\r\n".utf8)) {
                let headText = String(decoding: data[..<range.lowerBound], as: UTF8.self)
                let lines = headText.components(separatedBy: "\r\n")
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
                return Request(method: String(parts[0]), path: String(parts[1]), body: body)
            }
            let count = recv(client, &buffer, buffer.count, 0)
            if count <= 0 { return nil }
            data.append(buffer, count: count)
        }
    }
}

/// A loopback port with nothing on it. The system picks a free port for a
/// fresh socket, which is closed again before this returns, so a connect is
/// refused at once. (A FakeOllama dropped out of scope is not a closed port:
/// its accept thread can keep it alive and still answering. A socket kept
/// bound but not listening is no good either: macOS drops the connect
/// silently and the request times out instead of being refused.)
enum ClosedPort {
    static func make() throws -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard bound == 0, named == 0 else { throw POSIXError(.EADDRINUSE) }
        return UInt16(bigEndian: actual.sin_port)
    }
}

/// Invented catalog rows in Ollama 0.34.0's `/api/tags` shape.
enum Invented {
    static let digestA = String(repeating: "a1", count: 32)
    static let digestB = String(repeating: "b2", count: 32)
    static let digestC = String(repeating: "c3", count: 32)

    static func model(_ name: String, digest: String, capabilities: [String] = ["completion"],
                      remote: Bool = false) -> [String: Any] {
        var row: [String: Any] = ["name": name, "model": name, "digest": digest, "size": 1,
                                  "modified_at": "2026-10-15T00:00:00Z", "capabilities": capabilities]
        if remote { row["remote_host"] = "https://invented-cloud.example:443"; row["remote_model"] = name }
        return row
    }

    static func tags(_ rows: [[String: Any]]) -> [String: Any] { ["models": rows] }

    static func line(_ object: [String: Any]) -> Data {
        (try! JSONSerialization.data(withJSONObject: object)) + Data("\n".utf8)
    }

    static func chunk(_ text: String) -> Data { line(["message": ["role": "assistant", "content": text], "done": false]) }
    static let done = line(["message": ["role": "assistant", "content": ""], "done": true, "done_reason": "stop"])
}
