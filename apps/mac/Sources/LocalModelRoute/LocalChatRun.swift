import Foundation
import ParticipantProcess

/// One local run over HTTP (contract section 20.4): one streaming
/// `/api/chat` request to the run's alias, fed through `LocalChatCore` on a
/// single serial queue. Every redirect is refused. `stop()` cancels the
/// request. It conforms to `ParticipantRunning`, so the coordinator reads it
/// exactly like a process run. INACTIVE: nothing in the app constructs it.
public final class LocalChatRun: NSObject, ParticipantRunning, URLSessionDataDelegate, @unchecked Sendable {
    public let updates: AsyncStream<ParticipantRunUpdate>

    private let continuation: AsyncStream<ParticipantRunUpdate>.Continuation
    private let queue = DispatchQueue(label: "local-chat-run")
    private let clock: ParticipantClock
    private var core: LocalChatCore
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var timer: DispatchSourceTimer?
    private var requestDone = false
    private var finishedUpdates = false
    private let snapshotLock = NSLock()
    private var lastSnapshot: ParticipantRunSnapshot

    /// Starts the request at once. A body that can't be built ends the run
    /// `failed` `process-error` with nothing sent.
    public static func start(_ request: LocalChatRequest, clock: ParticipantClock = SystemParticipantClock(),
                             limits: LocalChatLimits = .contract) -> LocalChatRun {
        start(request, endpoint: .fixed, clock: clock, limits: limits)
    }

    static func start(_ request: LocalChatRequest, endpoint: OllamaEndpoint, clock: ParticipantClock,
                      limits: LocalChatLimits) -> LocalChatRun {
        let run = LocalChatRun(request: request, clock: clock, limits: limits)
        run.begin(request, endpoint: endpoint, limits: limits)
        return run
    }

    private init(request: LocalChatRequest, clock: ParticipantClock, limits: LocalChatLimits) {
        var continuation: AsyncStream<ParticipantRunUpdate>.Continuation!
        updates = AsyncStream { continuation = $0 }
        self.continuation = continuation
        self.clock = clock
        core = LocalChatCore(identity: request.identity, contextBytes: request.contextBytes,
                             inputBytes: request.inputBytes, limits: limits)
        lastSnapshot = core.snapshot
        super.init()
    }

    public var snapshot: ParticipantRunSnapshot {
        snapshotLock.lock(); defer { snapshotLock.unlock() }
        return lastSnapshot
    }

    /// Cancels the request and ends the run `stopped` `local-stop` if it has
    /// no terminal yet. True: the cancel was issued locally.
    @discardableResult
    public func stop() -> Bool {
        queue.async { [self] in
            apply(core.stopRequested(monotonic: clock.monotonicMillis(), wall: clock.wallMillis()))
        }
        return true
    }

    // MARK: Driving

    private func begin(_ request: LocalChatRequest, endpoint: OllamaEndpoint, limits: LocalChatLimits) {
        let operations = OperationQueue()
        operations.underlyingQueue = queue
        operations.maxConcurrentOperationCount = 1
        // URLSession's own timeouts sit above the core's, which decide.
        let configuration = OllamaEndpoint.configuration(
            requestTimeout: TimeInterval(limits.totalTimeoutMillis / 1000) + 60)
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: operations)
        queue.async { [self] in
            guard let body = try? request.body() else {
                requestDone = true
                core.requestSent(monotonic: clock.monotonicMillis())
                apply(core.finished(.failed, monotonic: clock.monotonicMillis(), wall: clock.wallMillis()))
                return
            }
            var urlRequest = URLRequest(url: endpoint.url("api/chat"))
            urlRequest.httpMethod = "POST"
            urlRequest.httpBody = body
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let dataTask = session.dataTask(with: urlRequest)
            task = dataTask
            core.requestSent(monotonic: clock.monotonicMillis())
            dataTask.resume()
            schedule()
        }
    }

    /// Carries out the core's effects in order, then rearms the timer.
    private func apply(_ effects: [LocalChatCore.Effect]) {
        for effect in effects {
            switch effect {
            case .update(let update):
                publishSnapshot()
                continuation.yield(update)
            case .cancelRequest:
                task?.cancel()
            }
        }
        publishSnapshot()
        finishIfDone()
        schedule()
    }

    private func publishSnapshot() {
        snapshotLock.lock(); lastSnapshot = core.snapshot; snapshotLock.unlock()
    }

    /// Updates finish once the run has its terminal and the request has
    /// ended (or never started), so nothing arrives after them.
    private func finishIfDone() {
        guard !finishedUpdates, core.isFinished, requestDone || task == nil else { return }
        finishedUpdates = true
        timer?.cancel()
        timer = nil
        session?.finishTasksAndInvalidate()
        continuation.finish()
    }

    private func schedule() {
        timer?.cancel()
        timer = nil
        guard !finishedUpdates, let deadline = core.nextDeadline() else { return }
        let now = clock.monotonicMillis()
        let delay = deadline > now ? deadline - now : 0
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + .milliseconds(Int(min(delay, UInt64(Int32.max)))))
        source.setEventHandler { [weak self] in
            guard let self else { return }
            self.apply(self.core.tick(monotonic: self.clock.monotonicMillis(), wall: self.clock.wallMillis()))
        }
        timer = source
        source.resume()
    }

    // MARK: URLSession (on `queue`)

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Refused (section 20.1); the 3xx is then the final response and
        // ends the run `process-error`.
        completionHandler(nil)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        apply(core.response(status: status, monotonic: clock.monotonicMillis(), wall: clock.wallMillis()))
        completionHandler(status == 200 && !core.isFinished ? .allow : .cancel)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        apply(core.bytes([UInt8](data), monotonic: clock.monotonicMillis(), wall: clock.wallMillis()))
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        requestDone = true
        let how: LocalChatFinish
        if let error = error as? URLError, error.code == .cancelled {
            how = .cancelled
        } else if error != nil {
            how = .failed
        } else if let http = task.response as? HTTPURLResponse, (300..<400).contains(http.statusCode) {
            how = .redirectRefused
        } else {
            how = .closed
        }
        apply(core.finished(how, monotonic: clock.monotonicMillis(), wall: clock.wallMillis()))
    }
}
