import DeskHost
import Foundation
import WebKit

/// Media types the bundle may list, by file extension. A file with any other
/// extension cannot be listed, so it is never served.
public enum DeskAssetMediaType {
    public static let byExtension: [String: String] = [
        "html": "text/html",
        "js": "text/javascript",
        "mjs": "text/javascript",
        "css": "text/css",
        "woff2": "font/woff2",
        "svg": "image/svg+xml",
        "png": "image/png",
        "json": "application/json",
        "txt": "text/plain"
    ]

    public static func mediaType(forExtension fileExtension: String) -> String? {
        byExtension[fileExtension.lowercased()]
    }

    /// The `Content-Type` header: text types and JSON declare UTF-8.
    public static func contentType(for mediaType: String) -> String {
        if mediaType.hasPrefix("text/") || mediaType == "application/json" || mediaType == "image/svg+xml" {
            return mediaType + "; charset=utf-8"
        }
        return mediaType
    }
}

/// What the scheme handler sends back for one request.
public struct AssetReply: Equatable, Sendable {
    public let statusCode: Int
    public let headers: [String: String]
    public let body: Data

    public init(statusCode: Int, headers: [String: String], body: Data) {
        self.statusCode = statusCode
        self.headers = headers
        self.body = body
    }
}

/// Decides every `trueconvo-desk://desk/...` request without touching WebKit:
/// `GET`/`HEAD` of the root path or a manifest-listed file is served with its
/// listed media type; everything the resolver refuses (traversal, dot
/// segments, symlinks, directories, unlisted names, other schemes or hosts,
/// anything outside the bundle) is a bare 404; other methods are 405. No
/// reply ever names a path.
public struct DeskAssetResponder: Sendable {
    public static let entryPath = "index.html"
    public let resolver: AssetResolver

    public init(resolver: AssetResolver) {
        self.resolver = resolver
    }

    /// `trueconvo-desk://desk/index.html`: the document the host loads.
    public var entryURL: URL {
        URL(string: "\(resolver.manifest.scheme)://\(resolver.manifest.host)/\(Self.entryPath)")!
    }

    public func reply(to url: URL?, method: String?) -> AssetReply {
        let method = (method ?? "GET").uppercased()
        guard method == "GET" || method == "HEAD" else { return Self.status(405) }
        guard let requested = url, let target = Self.entryURLIfRoot(requested) else { return Self.status(404) }
        let served: (data: Data, mediaType: String)
        do {
            guard let found = try resolver.read(target) else { return Self.status(404) }
            served = found
        } catch {
            return Self.status(500)
        }
        var headers = Self.baseHeaders
        headers["Content-Type"] = DeskAssetMediaType.contentType(for: served.mediaType)
        headers["Content-Length"] = String(served.data.count)
        return AssetReply(statusCode: 200, headers: headers, body: method == "HEAD" ? Data() : served.data)
    }

    /// Whether a main-frame navigation to `url` would be answered with an
    /// HTML document: the root, or a listed `text/html` file that resolves
    /// right now. The navigation policy asks this before it allows a new
    /// document (and gives up the live connection for it); anything else
    /// would only be a 404 or a type WebKit refuses to show.
    public func servesDocument(at url: URL) -> Bool {
        guard let target = Self.entryURLIfRoot(url), case .asset(_, let mediaType) = resolver.resolve(target) else { return false }
        return mediaType == "text/html"
    }

    /// The root (`trueconvo-desk://desk` or `trueconvo-desk://desk/`) means
    /// the entry document. Any other path is passed through unchanged so the
    /// resolver's own checks decide; user, password and port stay for it to
    /// refuse.
    static func entryURLIfRoot(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        guard components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/" else { return url }
        components.percentEncodedPath = "/" + entryPath
        components.query = nil
        components.fragment = nil
        return components.url
    }

    static let baseHeaders: [String: String] = [
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    ]

    static func status(_ code: Int) -> AssetReply {
        var headers = baseHeaders
        headers["Content-Length"] = "0"
        return AssetReply(statusCode: code, headers: headers, body: Data())
    }
}

/// The `WKURLSchemeHandler` for `trueconvo-desk`. WebKit calls `start` and
/// `stop` on the main thread; the file read runs on a utility queue and the
/// reply is handed to the task on the main thread only if the task was not
/// stopped meanwhile (WebKit raises when a stopped task is answered).
public final class DeskAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    public let responder: DeskAssetResponder
    private let queue = DispatchQueue(label: "com.trueconvo.desk-assets", qos: .userInitiated)
    private var activeTasks: Set<ObjectIdentifier> = []

    public init(responder: DeskAssetResponder) {
        self.responder = responder
    }

    public convenience init(resolver: AssetResolver) {
        self.init(responder: DeskAssetResponder(resolver: resolver))
    }

    public var scheme: String { responder.resolver.manifest.scheme }

    public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let identifier = ObjectIdentifier(urlSchemeTask)
        activeTasks.insert(identifier)
        let request = urlSchemeTask.request
        let responder = self.responder
        queue.async { [weak self] in
            let reply = responder.reply(to: request.url, method: request.httpMethod)
            DispatchQueue.main.async {
                guard let self, self.activeTasks.remove(identifier) != nil else { return }
                guard let url = request.url,
                      let response = HTTPURLResponse(url: url, statusCode: reply.statusCode, httpVersion: "HTTP/1.1",
                                                     headerFields: reply.headers) else {
                    urlSchemeTask.didFailWithError(URLError(.badURL))
                    return
                }
                urlSchemeTask.didReceive(response)
                if !reply.body.isEmpty { urlSchemeTask.didReceive(reply.body) }
                urlSchemeTask.didFinish()
            }
        }
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        activeTasks.remove(ObjectIdentifier(urlSchemeTask))
    }

    /// Requests started and not yet answered or stopped.
    public var pendingTaskCount: Int { activeTasks.count }
}
