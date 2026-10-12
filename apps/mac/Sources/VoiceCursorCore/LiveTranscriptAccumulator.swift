import Foundation

/// Builds the running transcript from a live speech engine's results (Apple's
/// SpeechAnalyzer). Pure rules over plain numbers, so tests can prove them
/// without a microphone or Apple's model.
///
/// Each result covers a stretch of audio (`start` to `end`, in seconds) and
/// carries Apple's finalization time: audio up to that time is final and its
/// words won't change again.
/// - A result is final when Apple marks it final or its stretch ends at or
///   before the latest finalization time.
/// - A result replaces every rough (not yet final) piece whose stretch overlaps
///   its own. That covers a rough piece Apple revised and one it took back
///   (an empty result). Final pieces are never replaced.
/// - A rough piece whose stretch ends at or before the latest finalization
///   time becomes final even if Apple doesn't send it again.
/// - A result without usable timing replaces every rough piece and goes after
///   everything else.
/// - The text joins the pieces in time order.
public struct LiveTranscriptAccumulator: Equatable, Sendable {
    public struct Piece: Equatable, Sendable {
        public let text: String
        public let start: Double
        public let end: Double
        public fileprivate(set) var isFinal: Bool
    }

    public private(set) var pieces: [Piece] = []
    /// The latest finalization time seen, in seconds of audio.
    public private(set) var latestFinalizationTime: Double?
    /// Rough pieces made final by a later finalization time, without Apple
    /// sending them again.
    public private(set) var roughPiecesFinalizedWithoutResend = 0

    public init() {}

    /// Takes one result. Returns whether it counted as final.
    @discardableResult
    public mutating func receive(
        text: String,
        start: Double?,
        end: Double?,
        isFinal: Bool,
        finalizationTime: Double?
    ) -> Bool {
        if let finalizationTime, finalizationTime.isFinite {
            latestFinalizationTime = max(latestFinalizationTime ?? finalizationTime, finalizationTime)
        }

        let timed: (start: Double, end: Double)?
        if let start, let end, start.isFinite, end.isFinite, end >= start {
            timed = (start, end)
        } else {
            timed = nil
        }
        let final: Bool
        if isFinal {
            final = true
        } else if let timed, let latestFinalizationTime {
            final = latestFinalizationTime >= timed.end
        } else {
            final = false
        }

        pieces.removeAll { piece in
            guard !piece.isFinal else { return false }
            guard let timed else { return true }
            return Self.overlaps(piece, start: timed.start, end: timed.end)
        }

        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let pieceStart = timed?.start ?? timelineEnd
            // An untimed rough piece reaches to the end, so the next timed
            // result replaces it.
            let pieceEnd = timed?.end ?? (final ? pieceStart : .infinity)
            let piece = Piece(text: text, start: pieceStart, end: pieceEnd, isFinal: final)
            let index = pieces.firstIndex { $0.start > pieceStart } ?? pieces.count
            pieces.insert(piece, at: index)
        }

        if let latestFinalizationTime {
            for index in pieces.indices where !pieces[index].isFinal && pieces[index].end <= latestFinalizationTime {
                pieces[index].isFinal = true
                roughPiecesFinalizedWithoutResend += 1
            }
        }
        return final
    }

    /// The whole transcript so far, final and rough pieces in time order.
    public var text: String {
        pieces.map(\.text)
            .joined(separator: " ")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: " ([,.!?;:])", with: "$1", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var finalPieceCount: Int {
        pieces.filter(\.isFinal).count
    }

    public var roughPieceCount: Int {
        pieces.count - finalPieceCount
    }

    /// Where the timed audio heard so far ends.
    private var timelineEnd: Double {
        pieces.map(\.end).filter(\.isFinite).max() ?? 0
    }

    /// Stretches that only touch at an edge don't overlap; the same stretch
    /// always does, even when it has no length.
    private static func overlaps(_ piece: Piece, start: Double, end: Double) -> Bool {
        if piece.start == start && piece.end == end { return true }
        return piece.start < end && start < piece.end
    }
}
