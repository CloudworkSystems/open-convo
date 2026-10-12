import Foundation

public enum SpokenPunctuationNormalizer {
    public static func normalize(_ value: String) -> String {
        let collapsed = value
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !collapsed.isEmpty else { return "" }

        let tokens = collapsed.split(separator: " ").map(String.init)
        var output = ""
        var previousWord: String?
        var capitalizeNext = false
        var justOpenedPair = false
        var quoteIsOpen = false
        var index = 0

        func nextWord(offset: Int = 1) -> String? {
            let nextIndex = index + offset
            guard tokens.indices.contains(nextIndex) else { return nil }
            return commandWord(tokens[nextIndex])
        }

        func appendWord(_ rawToken: String) {
            var token = rawToken
            if capitalizeNext {
                token = capitalizingFirstLetter(token)
                capitalizeNext = false
            }

            if output.isEmpty || output.hasSuffix("\n") || justOpenedPair {
                output += token
            } else {
                output += " " + token
            }

            previousWord = commandWord(rawToken)
            justOpenedPair = false
        }

        func appendPunctuation(_ mark: String, sentenceEnding: Bool = false) {
            while output.hasSuffix(" ") {
                output.removeLast()
            }
            if shouldSuppressDuplicatePunctuation(mark, in: output) {
                capitalizeNext = sentenceEnding
                previousWord = nil
                justOpenedPair = false
                return
            }
            output += mark
            capitalizeNext = sentenceEnding
            previousWord = nil
            justOpenedPair = false
        }

        func appendOpening(_ mark: String) {
            if !output.isEmpty, !output.hasSuffix(" "), !output.hasSuffix("\n") {
                output += " "
            }
            output += mark
            previousWord = nil
            justOpenedPair = true
        }

        func appendOpeningQuote() {
            if !output.isEmpty, !output.hasSuffix(" "), !output.hasSuffix("\n"), !output.hasSuffix("(") {
                output += " "
            }
            output += "\""
            quoteIsOpen = true
            previousWord = nil
            justOpenedPair = true
        }

        func appendClosingQuote() {
            while output.hasSuffix(" ") {
                output.removeLast()
            }
            output += "\""
            quoteIsOpen = false
            previousWord = nil
            justOpenedPair = false
        }

        func appendBreak(_ value: String) {
            output = output.trimmingCharacters(in: .whitespaces)
            output += value
            capitalizeNext = false
            previousWord = nil
            justOpenedPair = false
        }

        while index < tokens.count {
            let word = commandWord(tokens[index])
            let next = nextWord()

            if word == "question", next == "mark" {
                appendPunctuation("?", sentenceEnding: true)
                index += 2
                continue
            }

            if word == "exclamation", next == "point" || next == "mark" {
                appendPunctuation("!", sentenceEnding: true)
                index += 2
                continue
            }

            if word == "full", next == "stop" {
                appendPunctuation(".", sentenceEnding: true)
                index += 2
                continue
            }

            if word == "dot", next == "dot", nextWord(offset: 2) == "dot" {
                appendPunctuation("...")
                index += 3
                continue
            }

            if word == "period", next == "period", nextWord(offset: 2) == "period" {
                appendPunctuation("...")
                index += 3
                continue
            }

            if (word == "open" || word == "start" || word == "begin"), next == "quote" {
                appendOpeningQuote()
                index += 2
                continue
            }

            if (word == "close" || word == "end"), next == "quote" {
                appendClosingQuote()
                index += 2
                continue
            }

            if word == "and", next == "quote", quoteIsOpen {
                appendClosingQuote()
                index += 2
                continue
            }

            if word == "and", next == "the", nextWord(offset: 2) == "quote", quoteIsOpen {
                appendClosingQuote()
                index += 3
                continue
            }

            if word == "new", next == "line" {
                appendBreak("\n")
                index += 2
                continue
            }

            if word == "new", next == "paragraph" {
                appendBreak("\n\n")
                index += 2
                continue
            }

            if (word == "open" || word == "left"), next == "parenthesis" || next == "paren" {
                appendOpening("(")
                index += 2
                continue
            }

            if (word == "close" || word == "right"), next == "parenthesis" || next == "paren" {
                appendPunctuation(")")
                index += 2
                continue
            }

            if (word == "open" || word == "left"), next == "bracket" || next == "brackets" || next == "square" {
                let consumed = next == "square" && nextWord(offset: 2) == "bracket" ? 3 : 2
                appendOpening("[")
                index += consumed
                continue
            }

            if (word == "close" || word == "right"), next == "bracket" || next == "brackets" || next == "square" {
                let consumed = next == "square" && nextWord(offset: 2) == "bracket" ? 3 : 2
                appendPunctuation("]")
                index += consumed
                continue
            }

            if word == "questionmark" {
                appendPunctuation("?", sentenceEnding: true)
                index += 1
                continue
            }

            if word == "endquote" || word == "unquote" {
                appendClosingQuote()
                index += 1
                continue
            }

            if word == "quote" {
                if quoteIsOpen {
                    appendClosingQuote()
                } else {
                    appendOpeningQuote()
                }
                index += 1
                continue
            }

            if word == "newline" {
                appendBreak("\n")
                index += 1
                continue
            }

            if word == "come", next == "up", shouldConvertComeUpToComma(previousWord: previousWord, nextWord: nextWord(offset: 2)) {
                appendPunctuation(",")
                index += 2
                continue
            }

            switch word {
            case "comma" where shouldConvertSymbolWord(previousWord: previousWord):
                appendPunctuation(",")
            case "ellipsis" where shouldConvertSymbolWord(previousWord: previousWord):
                appendPunctuation("...")
            case "comment" where shouldConvertMisheardComment(previousWord: previousWord, nextWord: next):
                appendPunctuation(",")
            case "camera" where shouldConvertMisheardComma(previousWord: previousWord, nextWord: next):
                appendPunctuation(",")
            case "coma" where shouldConvertMisheardComma(previousWord: previousWord, nextWord: next):
                appendPunctuation(",")
            case "period" where shouldConvertPeriod(previousWord: previousWord, nextWord: next):
                appendPunctuation(".", sentenceEnding: true)
            case "dot" where shouldConvertDot(previousWord: previousWord, nextWord: next):
                appendPunctuation(".")
            case "point" where shouldConvertPoint(previousWord: previousWord, nextWord: next):
                appendPunctuation(".")
            case "slash" where shouldConvertSymbolWord(previousWord: previousWord):
                appendPunctuation("/")
            case "colon" where shouldConvertSymbolWord(previousWord: previousWord):
                appendPunctuation(":")
            case "semicolon" where shouldConvertSymbolWord(previousWord: previousWord):
                appendPunctuation(";")
            case "dash" where shouldConvertSymbolWord(previousWord: previousWord):
                appendPunctuation(" - ")
            case "hyphen" where shouldConvertSymbolWord(previousWord: previousWord):
                appendPunctuation("-")
            default:
                appendWord(tokens[index])
            }

            index += 1
        }

        return output
            .replacingOccurrences(of: "\\s+([,\\.\\?!:;\\)])", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "[,;:]\\s*([\\?!\\.])", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "([,\\?!:;])(\\S)", with: "$1 $2", options: .regularExpression)
            .replacingOccurrences(of: "\\(\\s+", with: "(", options: .regularExpression)
            .replacingOccurrences(of: "\\[\\s+", with: "[", options: .regularExpression)
            .replacingOccurrences(of: "\\s+\\]", with: "]", options: .regularExpression)
            .replacingOccurrences(of: "\\s+\\n", with: "\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func commandWord(_ token: String) -> String {
        token
            .trimmingCharacters(in: .punctuationCharacters)
            .lowercased()
    }

    private static func shouldConvertSymbolWord(previousWord: String?) -> Bool {
        guard let previousWord else { return true }
        return !literalCueWords.contains(previousWord)
    }

    private static func shouldConvertPeriod(previousWord: String?, nextWord: String?) -> Bool {
        guard shouldConvertSymbolWord(previousWord: previousWord) else { return false }

        if let previousWord, periodContextBefore.contains(previousWord) {
            return false
        }

        if let nextWord, periodContextAfter.contains(nextWord) {
            return false
        }

        return true
    }

    private static func shouldConvertDot(previousWord: String?, nextWord: String?) -> Bool {
        guard shouldConvertSymbolWord(previousWord: previousWord) else { return false }
        if let previousWord, literalDotContextBefore.contains(previousWord) {
            return false
        }
        if let nextWord, literalDotContextAfter.contains(nextWord) {
            return false
        }
        return true
    }

    private static func shouldConvertPoint(previousWord: String?, nextWord: String?) -> Bool {
        guard shouldConvertSymbolWord(previousWord: previousWord) else { return false }
        if let previousWord, literalPointContextBefore.contains(previousWord) {
            return false
        }
        if let nextWord, literalPointContextAfter.contains(nextWord) {
            return false
        }
        return true
    }

    private static func shouldConvertMisheardComma(previousWord: String?, nextWord: String?) -> Bool {
        guard shouldConvertSymbolWord(previousWord: previousWord) else { return false }

        if let previousWord, literalCameraContextBefore.contains(previousWord) {
            return false
        }

        if let nextWord, literalCameraContextAfter.contains(nextWord) {
            return false
        }

        return true
    }

    private static func shouldConvertMisheardComment(previousWord: String?, nextWord: String?) -> Bool {
        guard shouldConvertSymbolWord(previousWord: previousWord) else { return false }

        if let previousWord, literalCommentContextBefore.contains(previousWord) {
            return false
        }

        if let nextWord, literalCommentContextAfter.contains(nextWord) {
            return false
        }

        return true
    }

    private static func shouldConvertComeUpToComma(previousWord: String?, nextWord: String?) -> Bool {
        guard shouldConvertSymbolWord(previousWord: previousWord) else { return false }

        if let nextWord, literalComeUpContextAfter.contains(nextWord) {
            return false
        }

        return true
    }

    private static func shouldSuppressDuplicatePunctuation(_ mark: String, in output: String) -> Bool {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if mark == "..." {
            return trimmed.hasSuffix("...")
        }
        if [",", ".", "?", "!", ":", ";"].contains(mark) {
            return trimmed.hasSuffix(mark)
        }
        return false
    }

    private static func capitalizingFirstLetter(_ value: String) -> String {
        guard let first = value.first else { return value }
        return String(first).uppercased() + value.dropFirst()
    }

    private static let literalCueWords: Set<String> = [
        "literal",
        "term",
        "phrase",
        "word",
        "called",
        "named",
    ]

    private static let literalCommentContextBefore: Set<String> = [
        "a",
        "add",
        "leave",
        "make",
        "my",
        "post",
        "reply",
        "that",
        "the",
        "this",
        "your",
    ]

    private static let literalCommentContextAfter: Set<String> = [
        "about",
        "below",
        "box",
        "field",
        "on",
        "section",
        "thread",
    ]

    private static let periodContextBefore: Set<String> = [
        "ancient",
        "billing",
        "class",
        "cooling",
        "evaluation",
        "grace",
        "historical",
        "incubation",
        "lookback",
        "modern",
        "pay",
        "reporting",
        "rental",
        "school",
        "time",
        "transition",
        "trial",
        "vesting",
        "waiting",
    ]

    private static let periodContextAfter: Set<String> = [
        "after",
        "before",
        "between",
        "during",
        "for",
        "from",
        "in",
        "of",
        "over",
        "piece",
        "through",
        "throughout",
        "to",
        "under",
        "when",
        "where",
        "while",
    ]

    private static let literalCameraContextBefore: Set<String> = [
        "a",
        "an",
        "back",
        "digital",
        "front",
        "her",
        "his",
        "iphone",
        "my",
        "our",
        "phone",
        "security",
        "that",
        "the",
        "their",
        "these",
        "this",
        "those",
        "video",
        "web",
        "your",
    ]

    private static let literalCameraContextAfter: Set<String> = [
        "angle",
        "app",
        "feed",
        "image",
        "lens",
        "lenses",
        "phone",
        "quality",
        "roll",
        "shot",
        "shots",
        "view",
    ]

    private static let literalDotContextBefore: Set<String> = [
        "a",
        "blue",
        "green",
        "little",
        "red",
        "small",
        "the",
        "this",
        "that",
    ]

    private static let literalDotContextAfter: Set<String> = [
        "com",
        "gov",
        "net",
        "org",
        "pattern",
    ]

    private static let literalPointContextBefore: Set<String> = [
        "a",
        "at",
        "data",
        "decimal",
        "inflection",
        "plot",
        "turning",
        "the",
        "this",
        "that",
    ]

    private static let literalPointContextAfter: Set<String> = [
        "about",
        "at",
        "being",
        "for",
        "is",
        "of",
        "on",
        "where",
    ]

    private static let literalComeUpContextAfter: Set<String> = [
        "again",
        "for",
        "here",
        "later",
        "short",
        "soon",
        "there",
        "to",
        "with",
    ]
}
