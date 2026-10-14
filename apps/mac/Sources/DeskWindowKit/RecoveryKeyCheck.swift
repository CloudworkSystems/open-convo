import Foundation

/// Step 2, PR 3b: the owner proves they wrote the recovery key down by
/// typing two of its groups back (picked at random, never the same one).
/// Pure, so tests drive it without a window.
public struct RecoveryKeyCheck: Equatable, Sendable {
    /// The groups as shown, e.g. ["7K2QF", ...].
    let groups: [String]
    /// The two groups asked for, 0-based, in ascending order.
    public let asked: [Int]

    public init(displayText: String, pick: (Int) -> [Int] = RecoveryKeyCheck.randomPair) {
        groups = displayText.split(separator: "-").map(String.init)
        asked = Array(Set(pick(groups.count))).sorted()
        precondition(asked.count == 2 && asked.allSatisfy { groups.indices.contains($0) })
    }

    /// Two distinct indices below `count`.
    public static func randomPair(_ count: Int) -> [Int] {
        var generator = SystemRandomNumberGenerator()
        let first = Int.random(in: 0..<count, using: &generator)
        var second = Int.random(in: 0..<(count - 1), using: &generator)
        if second >= first { second += 1 }
        return [first, second]
    }

    /// "Type group 3 and group 9" (1-based, as the owner counts).
    public var prompt: String {
        "Type group \(asked[0] + 1) and group \(asked[1] + 1) of your recovery key."
    }

    /// Whether the typed groups match, forgiving case, spaces and dashes and
    /// reading O, I and L as 0, 1 and 1, as the key itself does.
    public func matches(_ first: String, _ second: String) -> Bool {
        Self.normalized(first) == groups[asked[0]] && Self.normalized(second) == groups[asked[1]]
    }

    static func normalized(_ text: String) -> String {
        String(text.uppercased().compactMap { character -> Character? in
            switch character {
            case " ", "-", "\n", "\t": return nil
            case "O": return "0"
            case "I", "L": return "1"
            default: return character
            }
        })
    }
}
