import AVFoundation
import Darwin
import Foundation

enum OpenAIRealtimeSmoke {
    static let argument = "--openai-realtime-smoke"

    static func runIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains(argument) else { return }

        let semaphore = DispatchSemaphore(value: 0)
        var exitCode: Int32 = 0
        Task {
            do {
                try await run()
            } catch {
                fputs("Native OpenAI Realtime smoke failed: \(error.localizedDescription)\n", stderr)
                exitCode = 1
            }
            semaphore.signal()
        }
        semaphore.wait()
        Darwin.exit(exitCode)
    }

    private static func run() async throws {
        let phrase = "True Convo native real time smoke. This is synthetic audio, not private dictation. The transcript should arrive in streaming pieces before the final result appears."
        let audioURL = try makeSyntheticAudio(phrase)
        defer {
            try? FileManager.default.removeItem(at: audioURL.deletingLastPathComponent())
        }

        let buffer = try readFloatMonoBuffer(audioURL)
        var latest = ""
        var deltaCount = 0
        let readyFlag = SmokeReadyFlag()
        let transcriber = OpenAIRealtimeTranscriber()
        transcriber.onReady = {
            print("Native realtime session ready")
            Task {
                await readyFlag.markReady()
            }
        }
        transcriber.onTranscript = { text in
            latest = text
            deltaCount += 1
        }
        transcriber.onCompleted = { text in
            latest = text
        }
        transcriber.onError = { error in
            fputs("Native realtime event error: \(error.localizedDescription)\n", stderr)
        }

        try transcriber.start(
            language: "en-US",
            model: "gpt-realtime-whisper",
            delay: "low"
        )
        guard try await readyFlag.wait(timeoutSeconds: 15) else {
            throw VoiceCursorError.processFailed("OpenAI Realtime native smoke did not become ready.")
        }
        try await streamBufferInRealtime(buffer, to: transcriber)
        let finalText = await transcriber.finishAndWait(timeout: 45) ?? latest
        transcriber.close(reason: "native-smoke")

        let clean = finalText
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else {
            throw VoiceCursorError.emptyTranscript("OpenAI Realtime native smoke")
        }
        guard deltaCount > 0 else {
            throw VoiceCursorError.processFailed("OpenAI Realtime native smoke completed without transcript deltas.")
        }

        print("Native OpenAI Realtime smoke passed")
        print("Transcript deltas: \(deltaCount)")
        print("Final transcript:")
        print(clean)
    }

    private static func makeSyntheticAudio(_ phrase: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("convo-cursor-native-realtime-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let audioURL = directory.appendingPathComponent("synthetic.aiff")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        process.arguments = ["-o", audioURL.path, phrase]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw VoiceCursorError.processFailed("macOS say failed with exit \(process.terminationStatus).")
        }
        return audioURL
    }

    private static func readFloatMonoBuffer(_ url: URL) throws -> AVAudioPCMBuffer {
        let output = Pipe()
        let error = Pipe()
        let process = Process()
        if FileManager.default.isExecutableFile(atPath: "/opt/homebrew/bin/ffmpeg") {
            process.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
            process.arguments = ffmpegArguments(for: url)
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["ffmpeg"] + ffmpegArguments(for: url)
        }
        process.standardOutput = output
        process.standardError = error
        try process.run()
        let pcm = output.fileHandleForReading.readDataToEndOfFile()
        let errorText = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw VoiceCursorError.processFailed(errorText.isEmpty ? "ffmpeg failed with exit \(process.terminationStatus)." : errorText)
        }

        let bytesPerFloat = MemoryLayout<Float>.size
        let frameCount = pcm.count / bytesPerFloat
        guard frameCount > 0 else {
            throw VoiceCursorError.processFailed("ffmpeg returned empty native smoke PCM.")
        }

        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 24_000,
            channels: 1,
            interleaved: false
        ) else {
            throw VoiceCursorError.processFailed("Could not create native smoke output audio format.")
        }
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: AVAudioFrameCount(frameCount)
        ), let channel = buffer.floatChannelData?[0] else {
            throw VoiceCursorError.processFailed("Could not allocate native smoke PCM buffer.")
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        pcm.withUnsafeBytes { rawBuffer in
            let floats = rawBuffer.bindMemory(to: Float.self)
            if let base = floats.baseAddress {
                channel.update(from: base, count: frameCount)
            }
        }
        return buffer
    }

    private static func ffmpegArguments(for url: URL) -> [String] {
        [
            "-hide_banner",
            "-loglevel", "error",
            "-i", url.path,
            "-ac", "1",
            "-ar", "24000",
            "-f", "f32le",
            "pipe:1",
        ]
    }

    private static func streamBufferInRealtime(_ buffer: AVAudioPCMBuffer, to transcriber: OpenAIRealtimeTranscriber) async throws {
        guard let sourceChannels = buffer.floatChannelData else {
            throw VoiceCursorError.processFailed("Native smoke buffer has no float channel data.")
        }
        let frameLength = Int(buffer.frameLength)
        let framesPerChunk = max(1, Int(buffer.format.sampleRate * 0.1))
        var offset = 0
        while offset < frameLength {
            let chunkFrames = min(framesPerChunk, frameLength - offset)
            guard let chunk = AVAudioPCMBuffer(
                pcmFormat: buffer.format,
                frameCapacity: AVAudioFrameCount(chunkFrames)
            ), let chunkChannels = chunk.floatChannelData else {
                throw VoiceCursorError.processFailed("Could not allocate native smoke chunk.")
            }
            chunk.frameLength = AVAudioFrameCount(chunkFrames)
            let channelCount = Int(buffer.format.channelCount)
            for channel in 0..<channelCount {
                chunkChannels[channel].update(from: sourceChannels[channel] + offset, count: chunkFrames)
            }
            transcriber.append(chunk)
            offset += chunkFrames
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }
}

private actor SmokeReadyFlag {
    private var ready = false

    func markReady() {
        ready = true
    }

    func wait(timeoutSeconds: TimeInterval) async throws -> Bool {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if ready {
                return true
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        return false
    }
}
