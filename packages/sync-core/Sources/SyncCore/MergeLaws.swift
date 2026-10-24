import Foundation

/// What a merge function returns. The sync core stamps the result; the
/// function does not.
public struct MergeOutput: Equatable, Sendable {
    public var payload: Data
    public var purged: Bool

    public init(payload: Data, purged: Bool = false) {
        self.payload = payload
        self.purged = purged
    }
}

/// Merges two copies of one record. Called with ciphertext the app can
/// decrypt; this package never decrypts. Judged on payload bytes and the
/// purged flag, not on argument order.
public typealias MergeFunction = (SyncRecord, SyncRecord) -> MergeOutput

public enum MergeLaw: String, Sendable, Equatable {
    case commutative
    case associative
    case idempotent
}

public struct MergeLawViolation: Equatable, Sendable {
    public var law: MergeLaw
    public var detail: String

    public init(law: MergeLaw, detail: String) {
        self.law = law
        self.detail = detail
    }
}

/// Checks the merge laws on decrypted contents (payload and purged flag).
/// `samples` should be alternate copies of the same record. Intermediate
/// copies keep the later of the two input stamps so a stamp-aware merge
/// still sees a total order.
public enum MergeLaws {
    public static func check(
        _ merge: MergeFunction,
        samples: [SyncRecord]
    ) -> [MergeLawViolation] {
        guard samples.count >= 2 else {
            return [MergeLawViolation(law: .commutative, detail: "Need at least two copies to check the laws.")]
        }
        var violations: [MergeLawViolation] = []
        for left in samples {
            let same = contents(merge(left, left))
            if same != contents(of: left) {
                violations.append(MergeLawViolation(
                    law: .idempotent,
                    detail: "Merging a copy with itself changed the contents."
                ))
                break
            }
        }
        for index in samples.indices {
            for other in samples.indices where other > index {
                let left = samples[index]
                let right = samples[other]
                let forward = merge(left, right)
                let backward = merge(right, left)
                if contents(forward) != contents(backward) {
                    violations.append(MergeLawViolation(
                        law: .commutative,
                        detail: "merge(a, b) and merge(b, a) differ for \(left.id)."
                    ))
                }
                let foldedLeft = merge(record(forward, left, right), left)
                let foldedRight = merge(record(forward, left, right), right)
                if contents(foldedLeft) != contents(forward) || contents(foldedRight) != contents(forward) {
                    violations.append(MergeLawViolation(
                        law: .idempotent,
                        detail: "Merging a copy that was already folded in changed the contents."
                    ))
                }
            }
        }
        if samples.count >= 3 {
            for first in samples.indices {
                for second in samples.indices where second != first {
                    for third in samples.indices where third != first && third != second {
                        let a = samples[first]
                        let b = samples[second]
                        let c = samples[third]
                        let left = merge(record(merge(a, b), a, b), c)
                        let right = merge(a, record(merge(b, c), b, c))
                        if contents(left) != contents(right) {
                            violations.append(MergeLawViolation(
                                law: .associative,
                                detail: "merge(merge(a, b), c) and merge(a, merge(b, c)) differ."
                            ))
                            return violations
                        }
                    }
                }
            }
        } else {
            violations.append(MergeLawViolation(
                law: .associative,
                detail: "Need at least three copies to check associativity."
            ))
        }
        return violations
    }

    private static func contents(_ output: MergeOutput) -> (Data, Bool) {
        (output.payload, output.purged)
    }

    private static func contents(of record: SyncRecord) -> (Data, Bool) {
        (record.payload, record.purged)
    }

    private static func record(_ output: MergeOutput, _ left: SyncRecord, _ right: SyncRecord) -> SyncRecord {
        let stamp = left.stamp > right.stamp ? left.stamp : right.stamp
        return SyncRecord(
            id: left.id,
            type: left.type,
            stamp: stamp,
            purged: output.purged,
            payload: output.payload
        )
    }
}
