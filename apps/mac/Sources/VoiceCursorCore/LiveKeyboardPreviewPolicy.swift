import Foundation

public enum LiveKeyboardPreviewPolicy {
    public struct RevisionPlan: Equatable {
        public let prefixLength: Int
        public let removedCount: Int
        public let addedText: String
        public let suppressesRevision: Bool
        public let appendOnlyText: String
    }

    public static let keyboardPreviewEventPrefix = "completion.live-preview.keyboard"
    public static let finalReconcileEventPrefix = "completion.live-preview.final-reconcile"
    public static let liveRevisionSuppressionThreshold = 1

    public static func revisionPlan(
        currentText: String,
        outputText: String,
        eventPrefix: String,
        keepLiveText: Bool,
        keyboardCompatibility: Bool = false
    ) -> RevisionPlan {
        let prefixLength = commonPrefixLength(currentText, outputText)
        let removedCount = currentText.count - prefixLength
        let addedText = String(outputText.dropFirst(prefixLength))
        let suppressesRevision = shouldSuppressLargeKeyboardRevision(
            eventPrefix: eventPrefix,
            currentText: currentText,
            outputText: outputText,
            removedCount: removedCount,
            keepLiveText: keepLiveText,
            keyboardCompatibility: keyboardCompatibility
        )

        return RevisionPlan(
            prefixLength: prefixLength,
            removedCount: removedCount,
            addedText: addedText,
            suppressesRevision: suppressesRevision,
            appendOnlyText: suppressesRevision ? appendOnlyTail(currentText: currentText, outputText: outputText) : ""
        )
    }

    public static func commonPrefixLength(_ left: String, _ right: String) -> Int {
        var count = 0
        var leftIndex = left.startIndex
        var rightIndex = right.startIndex

        while leftIndex < left.endIndex,
              rightIndex < right.endIndex,
              left[leftIndex] == right[rightIndex] {
            count += 1
            leftIndex = left.index(after: leftIndex)
            rightIndex = right.index(after: rightIndex)
        }

        return count
    }

    public static func shouldSkipFinalRewrite(
        keepLiveText: Bool,
        keyboardCompatibility: Bool
    ) -> Bool {
        keepLiveText || keyboardCompatibility
    }

    public static func shouldCommitLiveTextOnStop(
        keepLiveText: Bool,
        keyboardCompatibility: Bool
    ) -> Bool {
        keepLiveText || keyboardCompatibility
    }

    /// What to do at the stop when live typing in a keyboard app (Notes,
    /// Codex, Hermes) has typed nothing yet.
    public enum NoLiveTextStopPlan: Equatable {
        /// Type the final text once it is ready, with the same checks as the
        /// live-words swap: the same app still in front, and no key or click
        /// since the stop.
        case typeFinalWhenReady
        /// Don't type it later; the final text goes to the clipboard/history.
        case holdFinalBack
    }

    /// Live typing holds back its last two words, so a short phrase of about
    /// three words has no live text when the dictation key stops it. That is
    /// not a safety stop, so the final text is still typed. It is held back
    /// only when a safety stop really fired (a click, another key, or a
    /// different app in front) or there is no app to type into.
    public static func noLiveTextStopPlan(
        safetyStopFired: Bool,
        targetAppAvailable: Bool
    ) -> NoLiveTextStopPlan {
        (!safetyStopFired && targetAppAvailable) ? .typeFinalWhenReady : .holdFinalBack
    }

    public static func stabilizedPreviewText(
        previousText: String?,
        currentText: String,
        alreadyInsertedText: String,
        holdBackWords: Int
    ) -> String {
        let current = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !current.isEmpty else { return alreadyInsertedText }
        guard let previous = previousText?.trimmingCharacters(in: .whitespacesAndNewlines),
              !previous.isEmpty
        else {
            return alreadyInsertedText
        }

        let sharedPrefixLength = commonPrefixLength(previous, current)
        guard sharedPrefixLength > 0 else { return alreadyInsertedText }

        let sharedPrefix = String(current.prefix(sharedPrefixLength))
        let stableCandidate = dropTrailingWords(
            from: sharedPrefix.trimmingCharacters(in: .whitespacesAndNewlines),
            count: holdBackWords
        )
        guard !stableCandidate.isEmpty else { return alreadyInsertedText }

        if alreadyInsertedText.hasPrefix(stableCandidate) {
            return alreadyInsertedText
        }

        if stableCandidate.hasPrefix(alreadyInsertedText) {
            return stableCandidate.count > alreadyInsertedText.count ? stableCandidate : alreadyInsertedText
        }

        return stableCandidate
    }

    public static func stitchedPartialResetText(base: String, fragment: String) -> String {
        let trimmedFragment = fragment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedFragment.isEmpty else { return base }

        let baseWords = normalizedWords(in: base)
        let fragmentWords = normalizedWords(in: trimmedFragment)
        guard !baseWords.isEmpty, !fragmentWords.isEmpty else {
            return appendTail(base: base, tail: trimmedFragment)
        }

        if let overlap = suffixPrefixOverlap(baseWords: baseWords, fragmentWords: fragmentWords, minimumWords: 2) {
            return appendFragmentWords(after: overlap, base: base, fragment: trimmedFragment, fragmentWords: fragmentWords)
        }

        if let fragmentIndex = suffixContainedInFragment(baseWords: baseWords, fragmentWords: fragmentWords, minimumWords: 2) {
            return appendFragmentWords(after: fragmentIndex, base: base, fragment: trimmedFragment, fragmentWords: fragmentWords)
        }

        if fragmentPrefixAlreadyVisible(baseWords: baseWords, fragmentWords: fragmentWords, minimumWords: 4) {
            return base
        }

        return appendTail(base: base, tail: trimmedFragment)
    }

    private static func shouldSuppressLargeKeyboardRevision(
        eventPrefix: String,
        currentText: String,
        outputText: String,
        removedCount: Int,
        keepLiveText: Bool,
        keyboardCompatibility: Bool
    ) -> Bool {
        guard (keepLiveText || keyboardCompatibility),
              eventPrefix == keyboardPreviewEventPrefix,
              removedCount > 0,
              !currentText.isEmpty,
              !outputText.isEmpty
        else {
            return false
        }
        return removedCount >= liveRevisionSuppressionThreshold
    }

    private static func appendOnlyTail(currentText: String, outputText: String) -> String {
        if outputText.hasPrefix(currentText), outputText.count > currentText.count {
            return String(outputText.dropFirst(currentText.count))
        }

        let outputWordRanges = wordRanges(in: outputText)
        let currentWordCount = wordRanges(in: currentText).count
        guard outputWordRanges.count > currentWordCount,
              currentWordCount > 0
        else { return "" }

        let tailStart = outputWordRanges[currentWordCount].lowerBound
        let rawTail = String(outputText[tailStart...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawTail.isEmpty else { return "" }
        if currentText.last?.isWhitespace == true {
            return rawTail
        }
        return " " + rawTail
    }

    private static func suffixPrefixOverlap(
        baseWords: [(word: String, range: Range<String.Index>)],
        fragmentWords: [(word: String, range: Range<String.Index>)],
        minimumWords: Int
    ) -> Int? {
        let maxOverlap = min(baseWords.count, fragmentWords.count)
        guard maxOverlap >= minimumWords else { return nil }
        for count in stride(from: maxOverlap, through: minimumWords, by: -1) {
            let baseStart = baseWords.count - count
            let baseSlice = baseWords[baseStart..<baseWords.count].map(\.word)
            let fragmentSlice = fragmentWords[0..<count].map(\.word)
            if baseSlice == fragmentSlice {
                return count
            }
        }
        return nil
    }

    private static func suffixContainedInFragment(
        baseWords: [(word: String, range: Range<String.Index>)],
        fragmentWords: [(word: String, range: Range<String.Index>)],
        minimumWords: Int
    ) -> Int? {
        let maxOverlap = min(baseWords.count, fragmentWords.count)
        guard maxOverlap >= minimumWords else { return nil }
        for count in stride(from: maxOverlap, through: minimumWords, by: -1) {
            let baseStart = baseWords.count - count
            let baseSlice = baseWords[baseStart..<baseWords.count].map(\.word)
            let lastStart = fragmentWords.count - count
            guard lastStart >= 0 else { continue }
            for start in 0...lastStart {
                let fragmentSlice = fragmentWords[start..<(start + count)].map(\.word)
                if baseSlice == fragmentSlice {
                    return start + count
                }
            }
        }
        return nil
    }

    private static func fragmentPrefixAlreadyVisible(
        baseWords: [(word: String, range: Range<String.Index>)],
        fragmentWords: [(word: String, range: Range<String.Index>)],
        minimumWords: Int
    ) -> Bool {
        guard fragmentWords.count >= minimumWords, baseWords.count >= minimumWords else { return false }
        let prefix = fragmentWords[0..<minimumWords].map(\.word)
        let lastStart = baseWords.count - minimumWords
        guard lastStart >= 0 else { return false }
        for start in 0...lastStart {
            let baseSlice = baseWords[start..<(start + minimumWords)].map(\.word)
            if baseSlice == prefix {
                return true
            }
        }
        return false
    }

    private static func appendFragmentWords(
        after wordCount: Int,
        base: String,
        fragment: String,
        fragmentWords: [(word: String, range: Range<String.Index>)]
    ) -> String {
        guard wordCount < fragmentWords.count else { return base }
        let tailStart = fragmentWords[wordCount].range.lowerBound
        let tail = String(fragment[tailStart...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return appendTail(base: base, tail: tail)
    }

    private static func appendTail(base: String, tail: String) -> String {
        guard !tail.isEmpty else { return base }
        if base.hasSuffix(" ") || base.hasSuffix("\n") {
            return base + tail
        }
        return base + " " + tail
    }

    private static func dropTrailingWords(from text: String, count: Int) -> String {
        guard count > 0 else { return text }
        let ranges = wordRanges(in: text)
        guard ranges.count > count else { return "" }
        let cutoff = ranges[ranges.count - count].lowerBound
        return String(text[..<cutoff]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizedWords(in text: String) -> [(word: String, range: Range<String.Index>)] {
        wordRanges(in: text).compactMap { range in
            let normalized = normalizeWord(String(text[range]))
            guard !normalized.isEmpty else { return nil }
            return (normalized, range)
        }
    }

    private static func normalizeWord(_ word: String) -> String {
        word
            .trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
    }

    private static func wordRanges(in text: String) -> [Range<String.Index>] {
        var ranges: [Range<String.Index>] = []
        var wordStart: String.Index?
        var index = text.startIndex

        while index < text.endIndex {
            let character = text[index]
            if character.isWhitespace {
                if let start = wordStart {
                    ranges.append(start..<index)
                    wordStart = nil
                }
            } else if wordStart == nil {
                wordStart = index
            }
            index = text.index(after: index)
        }

        if let start = wordStart {
            ranges.append(start..<text.endIndex)
        }
        return ranges
    }
}
