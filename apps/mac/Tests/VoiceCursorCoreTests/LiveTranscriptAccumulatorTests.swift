import Testing
import VoiceCursorCore

/// Synthetic result sequences shaped like Apple SpeechAnalyzer output: each
/// result covers a stretch of audio in seconds, and carries a finalization
/// time up to which nothing changes again. No audio or model is involved.
@Suite("Live transcript accumulator")
struct LiveTranscriptAccumulatorTests {
    @Test("No results means no text")
    func emptyInput() {
        let accumulator = LiveTranscriptAccumulator()

        #expect(accumulator.text == "")
        #expect(accumulator.pieces.isEmpty)
        #expect(accumulator.finalPieceCount == 0)
        #expect(accumulator.roughPieceCount == 0)
    }

    @Test("An empty result adds nothing")
    func emptyResultAddsNothing() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "  ", start: 0, end: 1, isFinal: true, finalizationTime: 1)

        #expect(accumulator.text == "")
        #expect(accumulator.pieces.isEmpty)
    }

    @Test("A rough piece is replaced by its revised final version")
    func volatileThenRevisedFinal() {
        var accumulator = LiveTranscriptAccumulator()

        let roughWasFinal = accumulator.receive(text: "hello wold", start: 0, end: 1.5, isFinal: false, finalizationTime: 0)
        #expect(!roughWasFinal)
        #expect(accumulator.text == "hello wold")

        let finalWasFinal = accumulator.receive(text: "hello world", start: 0, end: 1.6, isFinal: true, finalizationTime: 1.6)
        #expect(finalWasFinal)
        #expect(accumulator.text == "hello world")
        #expect(accumulator.finalPieceCount == 1)
        #expect(accumulator.roughPieceCount == 0)
    }

    @Test("A rough piece is replaced by a revised rough piece for the same audio")
    func volatileReplacedByRevisedVolatile() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "the whether", start: 0, end: 1, isFinal: false, finalizationTime: 0)
        accumulator.receive(text: "the weather is", start: 0, end: 1.4, isFinal: false, finalizationTime: 0)

        #expect(accumulator.text == "the weather is")
        #expect(accumulator.pieces.count == 1)
        #expect(accumulator.roughPieceCount == 1)
    }

    @Test("A result counts as final when its audio ends by the finalization time")
    func finalByFinalizationTime() {
        var accumulator = LiveTranscriptAccumulator()

        let wasFinal = accumulator.receive(text: "good morning", start: 0, end: 1, isFinal: false, finalizationTime: 1)

        #expect(wasFinal)
        #expect(accumulator.finalPieceCount == 1)
    }

    @Test("A rough piece becomes final from a later finalization time without being sent again")
    func volatileFinalizedWithoutResend() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "first part", start: 0, end: 2, isFinal: false, finalizationTime: 0)
        accumulator.receive(text: "second", start: 2, end: 3, isFinal: false, finalizationTime: 2)

        #expect(accumulator.text == "first part second")
        #expect(accumulator.pieces.map(\.isFinal) == [true, false])
        #expect(accumulator.roughPiecesFinalizedWithoutResend == 1)
        #expect(accumulator.latestFinalizationTime == 2)
    }

    @Test("A finalization time before a rough piece ends leaves it rough")
    func finalizationTimeBeforeEndLeavesRough() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "still talking", start: 0, end: 2, isFinal: false, finalizationTime: 0)
        accumulator.receive(text: "more", start: 2, end: 3, isFinal: false, finalizationTime: 1.5)

        #expect(accumulator.pieces.map(\.isFinal) == [false, false])
        #expect(accumulator.roughPiecesFinalizedWithoutResend == 0)
    }

    @Test("An earlier rough piece is revoked by an overlapping new rough piece")
    func earlierRoughPieceRevokedByOverlap() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "I scream", start: 0, end: 1, isFinal: false, finalizationTime: 0)
        accumulator.receive(text: "for", start: 1, end: 1.5, isFinal: false, finalizationTime: 0)
        #expect(accumulator.text == "I scream for")

        // Apple heard both stretches again as one phrase.
        accumulator.receive(text: "ice cream for", start: 0.5, end: 1.5, isFinal: false, finalizationTime: 0)

        #expect(accumulator.text == "ice cream for")
        #expect(accumulator.pieces.count == 1)
    }

    @Test("An empty rough result takes back the rough piece it overlaps")
    func emptyResultRevokesRoughPiece() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "settled", start: 0, end: 1, isFinal: true, finalizationTime: 1)
        accumulator.receive(text: "um", start: 1, end: 1.4, isFinal: false, finalizationTime: 1)
        accumulator.receive(text: "", start: 1, end: 1.4, isFinal: false, finalizationTime: 1)

        #expect(accumulator.text == "settled")
        #expect(accumulator.roughPieceCount == 0)
    }

    @Test("An empty final result for the only rough piece leaves no text")
    func emptyFinalResultLeavesNoText() {
        var accumulator = LiveTranscriptAccumulator()

        // A short noise shows as a rough word, then Apple's final pass for
        // that audio is empty. The finished text is empty, not the rough word.
        accumulator.receive(text: "Uh", start: 0, end: 0.4, isFinal: false, finalizationTime: 0)
        accumulator.receive(text: "", start: 0, end: 0.4, isFinal: true, finalizationTime: 0.4)

        #expect(accumulator.text == "")
        #expect(accumulator.pieces.isEmpty)
    }

    @Test("A final piece is kept when a new rough piece follows it")
    func finalThenNewVolatile() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "Send the report.", start: 0, end: 2, isFinal: true, finalizationTime: 2)
        accumulator.receive(text: "Then call", start: 2, end: 3, isFinal: false, finalizationTime: 2)

        #expect(accumulator.text == "Send the report. Then call")
        #expect(accumulator.pieces.map(\.isFinal) == [true, false])

        accumulator.receive(text: "Then call Sam", start: 2, end: 3.5, isFinal: false, finalizationTime: 2)

        #expect(accumulator.text == "Send the report. Then call Sam")
        #expect(accumulator.finalPieceCount == 1)
    }

    @Test("A rough piece never replaces a final piece it overlaps")
    func finalPieceIsNeverReplaced() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "kept", start: 0, end: 2, isFinal: true, finalizationTime: 2)
        accumulator.receive(text: "next", start: 1.9, end: 3, isFinal: false, finalizationTime: 2)

        #expect(accumulator.text == "kept next")
    }

    @Test("Pieces are joined in time order, whatever order they arrive in")
    func joinsInTimeOrder() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "world", start: 1, end: 2, isFinal: true, finalizationTime: 2)
        accumulator.receive(text: "hello", start: 0, end: 1, isFinal: true, finalizationTime: 2)
        accumulator.receive(text: ", again", start: 2, end: 3, isFinal: false, finalizationTime: 2)

        #expect(accumulator.text == "hello world, again")
    }

    @Test("A result without usable timing replaces the rough pieces and goes last")
    func untimedResultReplacesRoughPieces() {
        var accumulator = LiveTranscriptAccumulator()

        accumulator.receive(text: "done", start: 0, end: 1, isFinal: true, finalizationTime: 1)
        accumulator.receive(text: "rough", start: 1, end: 2, isFinal: false, finalizationTime: 1)
        accumulator.receive(text: "rough again", start: nil, end: nil, isFinal: false, finalizationTime: nil)

        #expect(accumulator.text == "done rough again")

        accumulator.receive(text: "rough again, fixed", start: 1, end: 2.5, isFinal: true, finalizationTime: 2.5)

        #expect(accumulator.text == "done rough again, fixed")
        #expect(accumulator.roughPieceCount == 0)
    }
}
