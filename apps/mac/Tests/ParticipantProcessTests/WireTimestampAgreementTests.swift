import DeskHost
import Foundation
@testable import ParticipantProcess
import Testing

/// `WireTimestamp` (DeskHost) is a hand copy of `ParticipantTimestamp.parse`,
/// because DeskHost cannot import this module. A time native accepts at
/// commit must be one this module can read, and the reverse, so the two give
/// the same answer for every string. Invented times only; no process starts.
@Suite("Wire timestamp agreement")
struct WireTimestampAgreementTests {
    static let cases = [
        "2026-10-09T00:00:00.000Z", "2024-02-29T23:59:59.999Z", "1970-01-01T00:00:00.000Z", "2023-11-14T22:13:20.123Z",
        "1969-12-31T23:59:59.000Z", "1969-12-31T23:59:59.999Z", "0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z",
        "2023-02-30T00:00:00.000Z", "2023-02-29T00:00:00.000Z", "2026-13-01T00:00:00.000Z", "2026-10-09T24:00:00.000Z",
        "2026-10-09T00:60:00.000Z", "2026-10-00T00:00:00.000Z", "2026-00-09T00:00:00.000Z", "2016-12-31T23:59:60.000Z",
        "2026-04-31T00:00:00.000Z", "2026-10-09T00:00:00.00Z", "2026-10-09T00:00:00.000", "2026-10-09T00:00:00Z",
        "2026-10-09T00:00:00.0000Z", "2026-10-09 00:00:00.000Z", "2026-10-09t00:00:00.000z", "2026-10-09T00:00:00.000+00:00",
        "+026-10-09T00:00:00.000Z", "2026-1O-09T00:00:00.000Z", "", "2026-10-09T00:00:00.000Z\u{0}",
        // Before 1970 with nonzero milliseconds, and calendar edges before it.
        "1969-12-31T23:59:59.001Z", "1969-12-31T00:00:00.500Z", "1969-07-20T20:17:40.123Z", "1900-02-28T23:59:59.999Z",
        "1900-02-29T00:00:00.000Z", "1600-02-29T12:00:00.001Z", "0000-01-01T00:00:00.001Z", "0000-02-29T00:00:00.999Z",
        "1969-12-31T23:59:60.999Z", "1969-02-29T00:00:00.001Z", "0001-01-01T00:00:00.000Z"
    ]

    /// The page's answer for each case: its `timestamp` check
    /// (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`, a finite
    /// `Date.parse`, and `new Date(v).toISOString() === v`), run in Node for
    /// these exact strings and written down here.
    static let pageAccepts: Set<String> = [
        "2026-10-09T00:00:00.000Z", "2024-02-29T23:59:59.999Z", "1970-01-01T00:00:00.000Z", "2023-11-14T22:13:20.123Z",
        "1969-12-31T23:59:59.000Z", "1969-12-31T23:59:59.999Z", "0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z",
        "1969-12-31T23:59:59.001Z", "1969-12-31T00:00:00.500Z", "1969-07-20T20:17:40.123Z", "1900-02-28T23:59:59.999Z",
        "1600-02-29T12:00:00.001Z", "0000-01-01T00:00:00.001Z", "0000-02-29T00:00:00.999Z", "0001-01-01T00:00:00.000Z"
    ]

    @Test("WireTimestamp.isValid accepts exactly the strings ParticipantTimestamp.parse reads", arguments: cases)
    func agree(text: String) {
        #expect(WireTimestamp.isValid(text) == (ParticipantTimestamp.parse(text) != nil))
    }

    @Test("Both copies give the page's answer for every case, pre-1970 milliseconds included", arguments: cases)
    func agreeWithPage(text: String) {
        let page = Self.pageAccepts.contains(text)
        #expect(WireTimestamp.isValid(text) == page, "\(text.debugDescription)")
        #expect((ParticipantTimestamp.parse(text) != nil) == page, "\(text.debugDescription)")
    }

    @Test("Both accept the times ParticipantTimestamp writes, before 1970 too, with or without milliseconds")
    func formattedTimes() {
        for millis: Int64 in [0, 1, 999, 1_000, 951_782_400_000, 1_700_000_000_123, 4_102_444_799_999, -1_000, -86_400_000] {
            let text = ParticipantTimestamp.format(millis: millis)
            #expect(WireTimestamp.isValid(text), "\(text)")
            #expect(ParticipantTimestamp.parse(text) == millis, "\(text)")
        }
        #expect(WireTimestamp.isValid("2024-02-29T23:59:59.999Z") && ParticipantTimestamp.parse("2024-02-29T23:59:59.999Z") != nil)
        #expect(WireTimestamp.isValid("1969-12-31T23:59:59.999Z") && ParticipantTimestamp.parse("1969-12-31T23:59:59.999Z") == -1,
                "before 1970 with nonzero milliseconds: accepted by both, as the page accepts it")
    }

    @Test("Before 1970, and before 1900, the formatter writes what toISOString writes, and both read it back")
    func preEpochMilliseconds() {
        // Each pair's string is `new Date(millis).toISOString()` in Node.
        let pairs: [(Int64, String)] = [
            (-1, "1969-12-31T23:59:59.999Z"), (-999, "1969-12-31T23:59:59.001Z"), (-1_000, "1969-12-31T23:59:59.000Z"),
            (-1_001, "1969-12-31T23:59:58.999Z"), (-86_400_001, "1969-12-30T23:59:59.999Z"),
            (-14_182_940_877, "1969-07-20T20:17:39.123Z"), (-62_167_219_200_000, "0000-01-01T00:00:00.000Z"),
            (-62_167_219_199_999, "0000-01-01T00:00:00.001Z"), (-2_208_988_800_001, "1899-12-31T23:59:59.999Z"),
            (-2_203_891_200_000, "1900-03-01T00:00:00.000Z"), (-11_670_955_199_999, "1600-02-29T12:00:00.001Z"),
            (-62_162_121_599_001, "0000-02-29T00:00:00.999Z"), (253_402_300_799_999, "9999-12-31T23:59:59.999Z")
        ]
        for (millis, text) in pairs {
            #expect(ParticipantTimestamp.format(millis: millis) == text, "\(millis)")
            #expect(ParticipantTimestamp.parse(text) == millis, "\(text)")
            #expect(WireTimestamp.isValid(text), "\(text)")
        }
    }

    @Test("From 1900 to 2200 the new formatter writes exactly what the old gmtime_r one wrote wherever that one was right")
    func sameAsBefore() {
        // The formatter before this change, kept here as the reference. It
        // was right for every time at or after 1970 and for whole seconds
        // before it.
        func old(_ millis: Int64) -> String {
            var seconds = time_t(millis / 1000)
            let fraction = Int(millis % 1000)
            var parts = tm()
            gmtime_r(&seconds, &parts)
            return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                          Int(parts.tm_year) + 1900, Int(parts.tm_mon) + 1, Int(parts.tm_mday),
                          Int(parts.tm_hour), Int(parts.tm_min), Int(parts.tm_sec), fraction)
        }
        var compared = 0
        var millis: Int64 = -2_208_988_800_000   // 1900-01-01
        while millis < 7_258_118_400_000 {      // 2200-01-01
            for value in [millis, millis - millis % 1000] where value >= 0 || value % 1000 == 0 {
                let text = ParticipantTimestamp.format(millis: value)
                #expect(text == old(value), "\(value)")
                #expect(ParticipantTimestamp.parse(text) == value && WireTimestamp.isValid(text), "\(text)")
                compared += 1
            }
            millis += 977_777_777   // about 11 days and a varying time and millisecond
        }
        #expect(compared > 15_000, "\(compared)")
    }
}
