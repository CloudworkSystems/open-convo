import AVFoundation
import Foundation

final class OpenAIRealtimeTranscriber: @unchecked Sendable {
    var onTranscript: (String) -> Void = { _ in }
    var onCompleted: (String) -> Void = { _ in }
    var onError: (Error) -> Void = { _ in }
    var onReady: () -> Void = {}

    private let queue = DispatchQueue(label: "com.trueconvo.voice-cursor.openai-realtime")
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var isReady = false
    private var isClosed = false
    private var didCommit = false
    private var finishRequested = false
    private var pendingPCM = Data()
    private var accumulatedText = ""
    private var completedText: String?
    private var finishContinuation: CheckedContinuation<String?, Never>?
    private var sentChunkCount = 0
    private var receivedDeltaCount = 0

    private let chunkByteCount = 4_800
    private let targetSampleRate = 24_000.0

    func start(language: String, model: String, delay: String) throws {
        guard let apiKey = RuntimeEnvironment.value("OPENAI_API_KEY"), !apiKey.isEmpty else {
            throw VoiceCursorError.missingAPIKey("OPENAI_API_KEY")
        }
        guard let url = URL(string: "wss://api.openai.com/v1/realtime?intent=transcription") else {
            throw VoiceCursorError.processFailed("OpenAI Realtime URL is invalid.")
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: request)
        self.session = session
        self.task = task

        RunLog.write(
            "openai-realtime.connecting",
            "model=\(model) delay=\(delay) keySource=\(RuntimeEnvironment.source("OPENAI_API_KEY"))"
        )
        task.resume()
        receiveLoop(language: language, model: model, delay: delay)
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let pcm = Self.pcm16Mono24kData(from: buffer, targetSampleRate: targetSampleRate) else {
            return
        }
        queue.async { [weak self] in
            guard let self, !self.isClosed, !self.didCommit else { return }
            self.pendingPCM.append(pcm)
            self.flushPendingAudio(force: false)
        }
    }

    func finishAndWait(timeout: TimeInterval) async -> String? {
        await withCheckedContinuation { continuation in
            queue.async { [weak self] in
                guard let self else {
                    continuation.resume(returning: nil)
                    return
                }
                if let completedText {
                    continuation.resume(returning: Self.clean(completedText))
                    return
                }
                self.finishContinuation = continuation
                self.finishRequested = true
                self.flushPendingAudio(force: true)
                self.commitIfPossible()
                self.queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                    self?.resolveFinish(reason: "timeout")
                }
            }
        }
    }

    func close(reason: String) {
        queue.async { [weak self] in
            self?.closeOnQueue(reason: reason)
        }
    }

    private func receiveLoop(language: String, model: String, delay: String) {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                self.handle(message: message, language: language, model: model, delay: delay)
            case .failure(let error):
                self.queue.async {
                    guard !self.isClosed else { return }
                    RunLog.write("openai-realtime.receive.failed", error.localizedDescription)
                    self.onError(error)
                    self.resolveFinish(reason: "receive-failed")
                }
            }
            self.queue.async {
                guard !self.isClosed else { return }
                self.receiveLoop(language: language, model: model, delay: delay)
            }
        }
    }

    private func handle(message: URLSessionWebSocketTask.Message, language: String, model: String, delay: String) {
        let text: String?
        switch message {
        case .string(let value):
            text = value
        case .data(let data):
            text = String(data: data, encoding: .utf8)
        @unknown default:
            text = nil
        }
        guard let text else { return }

        queue.async { [weak self] in
            self?.handleEventText(text, language: language, model: model, delay: delay)
        }
    }

    private func handleEventText(_ text: String, language: String, model: String, delay: String) {
        guard !isClosed else { return }
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else {
            RunLog.write("openai-realtime.event.unreadable")
            return
        }

        switch type {
        case "session.created":
            sendSessionUpdate(language: language, model: model, delay: delay)
        case "session.updated":
            isReady = true
            RunLog.write("openai-realtime.ready", "model=\(model) delay=\(delay)")
            onReady()
            flushPendingAudio(force: false)
            commitIfPossible()
        case "input_audio_buffer.committed":
            RunLog.write("openai-realtime.audio.committed", "chunks=\(sentChunkCount)")
        case "conversation.item.input_audio_transcription.delta":
            guard let delta = object["delta"] as? String, !delta.isEmpty else { return }
            receivedDeltaCount += 1
            accumulatedText += delta
            let clean = Self.clean(accumulatedText)
            onTranscript(clean)
        case "conversation.item.input_audio_transcription.completed":
            let transcript = (object["transcript"] as? String) ?? accumulatedText
            completedText = Self.clean(transcript)
            RunLog.write(
                "openai-realtime.transcription.completed",
                "chunks=\(sentChunkCount) deltas=\(receivedDeltaCount) chars=\(completedText?.count ?? 0)"
            )
            if let completedText {
                onCompleted(completedText)
            }
            resolveFinish(reason: "completed")
        case "error":
            let message = Self.errorMessage(from: object)
            let error = VoiceCursorError.processFailed(message)
            RunLog.write("openai-realtime.error", message)
            onError(error)
            resolveFinish(reason: "error")
        default:
            break
        }
    }

    private func sendSessionUpdate(language: String, model: String, delay: String) {
        let normalizedLanguage = Self.normalizedLanguage(language)
        let payload: [String: Any] = [
            "type": "session.update",
            "session": [
                "type": "transcription",
                "audio": [
                    "input": [
                        "format": [
                            "type": "audio/pcm",
                            "rate": Int(targetSampleRate),
                        ],
                        "transcription": [
                            "model": model,
                            "language": normalizedLanguage,
                            "delay": delay,
                        ],
                        "turn_detection": NSNull(),
                    ],
                ],
            ],
        ]
        sendJSON(payload, eventName: "session.update")
    }

    private func flushPendingAudio(force: Bool) {
        guard isReady, !isClosed, !pendingPCM.isEmpty else { return }
        while pendingPCM.count >= chunkByteCount || (force && !pendingPCM.isEmpty) {
            let count = force ? min(pendingPCM.count, chunkByteCount) : chunkByteCount
            let chunk = pendingPCM.prefix(count)
            pendingPCM.removeFirst(count)
            let payload: [String: Any] = [
                "type": "input_audio_buffer.append",
                "audio": Data(chunk).base64EncodedString(),
            ]
            sentChunkCount += 1
            sendJSON(payload, eventName: "input_audio_buffer.append")
        }
    }

    private func commitIfPossible() {
        guard finishRequested, isReady, !didCommit, !isClosed else { return }
        flushPendingAudio(force: true)
        didCommit = true
        sendJSON(["type": "input_audio_buffer.commit"], eventName: "input_audio_buffer.commit")
    }

    private func sendJSON(_ payload: [String: Any], eventName: String) {
        guard !isClosed, let task else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: payload)
            guard let text = String(data: data, encoding: .utf8) else { return }
            task.send(.string(text)) { [weak self] error in
                guard let self, let error else { return }
                self.queue.async {
                    guard !self.isClosed else { return }
                    RunLog.write("openai-realtime.send.failed", "event=\(eventName) error=\(error.localizedDescription)")
                    self.onError(error)
                }
            }
        } catch {
            RunLog.write("openai-realtime.json.failed", "event=\(eventName) error=\(error.localizedDescription)")
        }
    }

    private func resolveFinish(reason: String) {
        guard let continuation = finishContinuation else { return }
        finishContinuation = nil
        let result = Self.clean(completedText ?? accumulatedText)
        RunLog.write("openai-realtime.finish.resolved", "reason=\(reason) chars=\(result.count)")
        continuation.resume(returning: result.isEmpty ? nil : result)
    }

    private func closeOnQueue(reason: String) {
        guard !isClosed else { return }
        isClosed = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        pendingPCM.removeAll()
        resolveFinish(reason: "closed-\(reason)")
        RunLog.write(
            "openai-realtime.closed",
            "reason=\(reason) chunks=\(sentChunkCount) deltas=\(receivedDeltaCount)"
        )
    }

    private static func pcm16Mono24kData(from buffer: AVAudioPCMBuffer, targetSampleRate: Double) -> Data? {
        guard buffer.format.commonFormat == .pcmFormatFloat32,
              let channels = buffer.floatChannelData
        else {
            return nil
        }
        let inputFrameCount = Int(buffer.frameLength)
        guard inputFrameCount > 0 else { return nil }

        let input = channels[0]
        let inputSampleRate = buffer.format.sampleRate
        let outputFrameCount = max(1, Int((Double(inputFrameCount) * targetSampleRate / inputSampleRate).rounded(.down)))
        let ratio = inputSampleRate / targetSampleRate
        var data = Data(capacity: outputFrameCount * 2)

        for frame in 0..<outputFrameCount {
            let inputPosition = Double(frame) * ratio
            let index = min(Int(inputPosition), inputFrameCount - 1)
            let nextIndex = min(index + 1, inputFrameCount - 1)
            let fraction = Float(inputPosition - Double(index))
            let sample = input[index] + ((input[nextIndex] - input[index]) * fraction)
            let clipped = min(max(sample, -1.0), 1.0)
            var value = Int16(clipped * Float(Int16.max)).littleEndian
            withUnsafeBytes(of: &value) { bytes in
                data.append(contentsOf: bytes)
            }
        }

        return data
    }

    private static func normalizedLanguage(_ language: String) -> String {
        (language.split(separator: "-").first.map(String.init) ?? "en").lowercased()
    }

    private static func clean(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func errorMessage(from object: [String: Any]) -> String {
        if let error = object["error"] as? [String: Any] {
            if let message = error["message"] as? String {
                return message
            }
            if let code = error["code"] as? String {
                return code
            }
        }
        return "OpenAI Realtime returned an error."
    }
}
