import Foundation

// Claude Code 2.1.283 output as PREDICTED by a read-only reading of the
// installed program file (docs/reviews/2026-10-11-claude-f1-cli-reading.md;
// its corrections at the top override its body). Never a run: the program
// was not executed, so every shape here is unconfirmed until the first
// approved live request. Field names only; no code was copied, and every
// value (text, ids, account fields, paths, plugin and agent names) is
// invented. Key order is a guess: a parser must not depend on it. (Init
// follows its builder's order; the file has several result builders that
// order their keys differently, so a recorded result may not start with
// `type`.)
//
// The stream lines assume section 11's argv (with `--strict-mcp-config` and
// no `--mcp-config`) and its fixed environment (Codex F0 answer 10:
// `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and the other three switches),
// so `analytics_disabled` is true. `product_feedback_disabled` true is only a
// predicted value: the reading's correction 4 says a policy check sets it, not
// the traffic switch. The fake prints these stream lines only under exactly
// that argv and environment (`PredictedInvocation`). With
// `--model invented-pinned-model` they are
// byte-identical to Tests/ParticipantProcessTests/Fixtures/cli-2.1.283/<stream>.jsonl
// (StreamConformanceTests keeps the two equal).
enum Predicted {
    static let version = "2.1.283"
    /// The model the goldens carry; a run echoes its own `--model` instead.
    static let goldenModel = "invented-pinned-model"
    static let session = "00000000-0000-4000-8000-00000000f100"
    /// The reply, as three text deltas.
    static let reply = ["Invented reply", " about an invented café", "."]

    static func uuid(_ tail: String) -> String { "00000000-0000-4000-8000-00000000" + tail }

    // MARK: --version

    /// `--version`, `-v` or `-V`: one line, version then "(Claude Code)".
    static func versionLine(_ version: String) -> String { version + " (Claude Code)\n" }
    /// With `--verbose`, a second line (an invented commit).
    static let commitLine = "Commit: 0000000000000000000000000000000000000000\n"

    // MARK: auth status

    /// `auth status` (JSON, the default): pretty-printed, two-space indent.
    /// Exit 0 when logged in, 1 when not. Account values are invented;
    /// `configDirectory` is the scenario's (section 5's checks give their
    /// invented tree's), else invented.
    static func authStatus(_ variant: String, configDirectory: String = "/invented/config") -> (output: String, exit: Int32)? {
        let encoded = try? JSONSerialization.data(withJSONObject: [configDirectory], options: .withoutEscapingSlashes)
        let quoted = String(decoding: encoded ?? Data("[\"\"]".utf8), as: UTF8.self).dropFirst().dropLast()
        let common: [(String, String)] = [("analyticsDisabled", "true"),
                                          ("projectsDirectory", #""/invented/config/projects""#),
                                          ("configDirectory", String(quoted))]
        let account: [(String, String)] = [("email", #""invented@example.invalid""#),
                                           ("orgId", "\"\(uuid("a001"))\""),
                                           ("orgName", #""Invented Organisation""#)]
        func signedIn(_ method: String, _ provider: String) -> [(String, String)] {
            [("loggedIn", "true"), ("authMethod", "\"\(method)\""), ("apiProvider", "\"\(provider)\"")] + common
        }
        switch variant {
        case "subscription", "slow":
            return (pretty(signedIn("claude.ai", "firstParty") + account + [("subscriptionType", #""max""#)]), 0)
        case "signed-out":
            return (pretty([("loggedIn", "false"), ("authMethod", #""none""#), ("apiProvider", #""firstParty""#)] + common), 1)
        case "console":
            // A stored Console key also reads `claude.ai`; `apiKeySource` and a
            // null `subscriptionType` are what tell it apart.
            return (pretty(signedIn("claude.ai", "firstParty") + [("apiKeySource", #""/login managed key""#)] + account
                           + [("subscriptionType", "null")]), 0)
        case "api-key-env":
            return (pretty(signedIn("api_key", "firstParty") + [("apiKeySource", #""ANTHROPIC_API_KEY""#)]), 0)
        case "bedrock", "vertex":
            return (pretty(signedIn("third_party", variant)), 0)
        case "garbled":
            return ("invented garbled output {\"loggedIn\": tru\n", 0)
        // Further invented variants for section 5's checks (F3). Not
        // predicted shapes of their own: each changes one thing above.
        case "console-login":
            // A claude.ai login with no plan and no stored key.
            return (pretty(signedIn("claude.ai", "firstParty") + account + [("subscriptionType", "null")]), 0)
        case "api-key-helper":
            return (pretty(signedIn("api_key_helper", "firstParty") + [("apiKeySource", #""apiKeyHelper""#)]), 0)
        case "oauth-token":
            return (pretty(signedIn("oauth_token", "firstParty")), 0)
        case "gateway":
            return (pretty(signedIn("claude.ai", "gateway") + [("email", #""invented@example.invalid""#)]), 0)
        case "pro", "team", "enterprise":
            // A plan login like `subscription`, on that plan.
            return (pretty(signedIn("claude.ai", "firstParty") + account + [("subscriptionType", "\"\(variant)\"")]), 0)
        case "unknown-plan":
            return (pretty(signedIn("claude.ai", "firstParty") + account + [("subscriptionType", #""invented-plan""#)]), 0)
        case "unknown-method":
            return (pretty(signedIn("invented_method", "firstParty")), 0)
        case "no-account":
            return (pretty(signedIn("claude.ai", "firstParty") + [("subscriptionType", #""max""#)]), 0)
        case "logged-in-exit-1":
            return (pretty(signedIn("claude.ai", "firstParty") + account + [("subscriptionType", #""max""#)]), 1)
        case "logged-in-number":
            // `loggedIn` as a number, not a boolean.
            return (pretty([("loggedIn", "1"), ("authMethod", #""claude.ai""#), ("apiProvider", #""firstParty""#)] + common
                           + account + [("subscriptionType", #""max""#)]), 0)
        case "empty":
            return ("", 0)
        case "oversized":
            return (String(repeating: "invented padding ", count: 8_000), 0)
        default:
            return nil
        }
    }

    static func pretty(_ fields: [(String, String)]) -> String {
        "{\n" + fields.map { "  \"\($0.0)\": \($0.1)" }.joined(separator: ",\n") + "\n}\n"
    }

    // MARK: -p stream-json

    /// One `system`/`init` per user message, after input processing and just
    /// before the request. Under section 11's argv `tools`, `mcp_servers`,
    /// `slash_commands` and `skills` are empty and `apiKeySource` is "none";
    /// `plugins` cannot be pinned from the file, so one invented built-in
    /// stands in. `betas` is absent for a subscription login and
    /// `fast_mode_disabled_reason` is omitted when empty.
    static let initLine = #"""
        {"type":"system","subtype":"init","cwd":"/invented/working-folder","session_id":"\#(session)",\#
        "tools":[],"mcp_servers":[],"model":"\#(goldenModel)","permissionMode":"default","slash_commands":[],\#
        "apiKeySource":"none","claude_code_version":"\#(version)","output_style":"default","agents":["invented-agent"],\#
        "skills":[],"plugins":[{"name":"invented-builtin","path":"builtin","source":"invented-builtin@builtin"}],\#
        "capabilities":["invented-capability"],"analytics_disabled":true,"product_feedback_disabled":true,\#
        "uuid":"\#(uuid("f101"))","fast_mode_state":"off"}
        """#

    static func streamEvent(_ event: String, _ tail: String) -> String {
        #"{"type":"stream_event","event":\#(event),"session_id":"\#(session)","parent_tool_use_id":null,"uuid":"\#(uuid(tail))"}"#
    }

    static func textDelta(_ text: String, _ tail: String) -> String {
        streamEvent(#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\#(text)"}}"#, tail)
    }

    /// The streamed reply: message start, text deltas, the whole assistant
    /// message (after its block stops), message delta and message stop.
    static var replyLines: [String] {
        [
            streamEvent(#"""
                {"type":"message_start","message":{"id":"msg_invented_f1","type":"message","role":"assistant",\#
                "model":"\#(goldenModel)","content":[],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1}}}
                """#, "f102"),
            streamEvent(#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#, "f103"),
            textDelta(reply[0], "f104"),
            textDelta(reply[1], "f105"),
            textDelta(reply[2], "f106"),
            streamEvent(#"{"type":"content_block_stop","index":0}"#, "f107"),
            #"""
            {"type":"assistant","message":{"id":"msg_invented_f1","type":"message","role":"assistant",\#
            "model":"\#(goldenModel)","content":[{"type":"text","text":"\#(reply.joined())"}],"stop_reason":null,\#
            "usage":{"input_tokens":12,"output_tokens":9}},"parent_tool_use_id":null,"session_id":"\#(session)",\#
            "uuid":"\#(uuid("f108"))"}
            """#,
            streamEvent(#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}"#, "f109"),
            streamEvent(#"{"type":"message_stop"}"#, "f10a")
        ]
    }

    /// `rate_limit_event`: no subtype; `rate_limit_info`, `uuid`, `session_id`.
    static func rateLimit(_ info: String, _ tail: String) -> String {
        #"{"type":"rate_limit_event","rate_limit_info":{\#(info)},"uuid":"\#(uuid(tail))","session_id":"\#(session)"}"#
    }

    /// `result`. Every result builder sampled in the file also writes
    /// `stop_reason`, `total_cost_usd`, `usage`, `modelUsage` and
    /// `permission_denials`; their values here are invented, and the inner
    /// shapes of `usage` and `modelUsage` are not pinned (`modelUsage` is
    /// left empty). `extra` is any field one builder adds, written before
    /// `uuid` (`,"name":value`).
    static func result(subtype: String, isError: Bool, durations: (Int, Int), turns: Int, text: String,
                       stopReason: String?, cost: String, tokens: (Int, Int), extra: String = "",
                       _ tail: String) -> String {
        let stop = stopReason.map { "\"\($0)\"" } ?? "null"
        return #"""
        {"type":"result","subtype":"\#(subtype)","is_error":\#(isError),"duration_ms":\#(durations.0),\#
        "duration_api_ms":\#(durations.1),"num_turns":\#(turns),"result":"\#(text)","stop_reason":\#(stop),\#
        "session_id":"\#(session)","total_cost_usd":\#(cost),\#
        "usage":{"input_tokens":\#(tokens.0),"output_tokens":\#(tokens.1)},"modelUsage":{},"permission_denials":[]\#
        \#(extra),"uuid":"\#(uuid(tail))"}
        """#
    }

    static let replyResult = result(subtype: "success", isError: false, durations: (1500, 1400), turns: 1,
                                    text: reply.joined(), stopReason: "end_turn", cost: "0.0123", tokens: (12, 9),
                                    "f10c")

    /// The stream modes, by scenario name: lines and the exit when no step ends it.
    static func stream(_ name: String) -> (lines: [String], exit: Int32)? {
        let window = #""status":"allowed","resetsAt":1900000000,"rateLimitType":"five_hour""#
        switch name {
        case "normal":
            // (a) After the stream ends: extra usage off.
            return ([initLine] + replyLines
                    + [rateLimit(window + #","overageStatus":"rejected","isUsingOverage":false"#, "f10b"), replyResult], 0)
        case "no-overage-status":
            // (b) The overage-status header was absent: only `status` and
            // `isUsingOverage` are always set.
            return ([initLine] + replyLines + [rateLimit(window + #","isUsingOverage":false"#, "f10b"), replyResult], 0)
        case "overage-allowed":
            // (c) Extra usage on.
            return ([initLine] + replyLines
                    + [rateLimit(window + #","overageStatus":"allowed","isUsingOverage":false"#, "f10b"), replyResult], 0)
        case "no-rate-limit":
            // (d) No change to report (or not a subscription login).
            return ([initLine] + replyLines + [replyResult], 0)
        case "local-slash":
            // (e) Input starting with "/" under --disable-slash-commands:
            // refused locally, no model call, no rate-limit event. The local
            // result builder also writes `fast_mode_state`. (Review F1-3: the
            // program may also print an `assistant` line carrying the local
            // answer before this result; not modelled, and the reader ignores
            // `assistant` lines after init.)
            return ([initLine, result(subtype: "success", isError: false, durations: (4, 0), turns: 0,
                                      text: "Invented local answer: that command is not available here.",
                                      stopReason: nil, cost: "0", tokens: (0, 0), extra: #","fast_mode_state":"off""#,
                                      "f1e1")], 0)
        case "refused-429":
            // (f) The request is refused: the event comes before any text, then
            // an error result. Neither the result's subtype nor the exit code
            // is pinned by the reading. (Review F1-3: an `assistant` line
            // carrying the API error may come before the result; not
            // modelled, and the reader ignores it after init.)
            return ([initLine,
                     rateLimit(#""status":"rejected","resetsAt":1900000000,"rateLimitType":"five_hour","#
                               + #""overageStatus":"rejected","isUsingOverage":false"#, "f1f1"),
                     result(subtype: "success", isError: true, durations: (300, 250), turns: 1,
                            text: "Invented refusal: usage limit reached.", stopReason: nil, cost: "0", tokens: (0, 0),
                            "f1f2")], 1)
        default:
            return nil
        }
    }

    /// `line` with the golden model replaced by `model` as a JSON string.
    static func withModel(_ line: String, _ model: String) -> String {
        guard model != goldenModel,
              let data = try? JSONSerialization.data(withJSONObject: model, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        else { return line }
        return line.replacingOccurrences(of: "\"model\":\"\(goldenModel)\"",
                                         with: "\"model\":" + String(decoding: data, as: UTF8.self))
    }
}

/// The argv and environment the predicted streams assume: contract section
/// 11's command line and environment as Codex F0 answer 10 fixed them,
/// written out here independently of the app's rule. A predicted stream is
/// printed only under exactly these, so the goldens are never produced under
/// anything else.
enum PredictedInvocation {
    /// Every argument after the program path and before the model value.
    static let argumentsBeforeModel = [
        "-p", "--safe-mode", "--restricted", "--disable-slash-commands", "--tools", "", "--strict-mcp-config",
        "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--model"
    ]
    /// Always present, with exactly these values.
    static let fixedEnvironment = [
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_AUTOUPDATER=1",
        "CLAUDE_CODE_DISABLE_ATTACHMENTS=1", "ENABLE_CLAUDEAI_MCP_SERVERS=false"
    ]
    /// The only other names section 11 lets through.
    static let passedNames: Set<String> = ["HOME", "USER", "TMPDIR", "LANG", "LC_ALL"]

    static func name(_ entry: String) -> String { String(entry.prefix { $0 != "=" }) }

    /// A model value section 11 would pass: nonblank, at most 256 UTF-8
    /// bytes, not starting with `-` (the CLI would read it as a flag), no
    /// control characters (Codex F1-M3).
    static func isModel(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 256, !value.hasPrefix("-"),
              value.unicodeScalars.contains(where: { $0 != " " && $0 != "\t" }) else { return false }
        return !value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F || (0x80...0x9F).contains($0.value) }
    }

    /// Nil when `argv` (after the program path) and `env` are exactly what the
    /// streams assume; otherwise what differs.
    static func mismatch(argv: [String], env: [String]) -> String? {
        guard argv.count == argumentsBeforeModel.count + 1, Array(argv.dropLast()) == argumentsBeforeModel else {
            return "the argv is not section 11's"
        }
        guard let model = argv.last, isModel(model) else { return "the model argument is not one section 11 passes" }
        let names = env.map(name)
        guard Set(names).count == names.count else { return "a name appears twice in the environment" }
        guard Set(fixedEnvironment).isSubset(of: Set(env)) else { return "a fixed environment value is missing or different" }
        guard Set(names).isSubset(of: passedNames.union(fixedEnvironment.map(name))) else {
            return "the environment holds a name section 11 drops"
        }
        // Section 11 passes a name only with a nonempty value (Codex F1-M3).
        guard !env.contains(where: { passedNames.contains(name($0)) && $0.count == name($0).count + 1 }) else {
            return "the environment passes a name with an empty value"
        }
        return nil
    }
}

/// A check the real CLI answers without a model request, chosen by the
/// exact arguments it would get.
enum PredictedCheck {
    /// `--version`, `-v` or `-V`, optionally followed by `--verbose`.
    case version(verbose: Bool)
    /// `auth status`, optionally `--json` (the default).
    case authStatus
    /// Any other `auth` command (`auth status --text`, say): not modelled.
    case unsupported

    init?(arguments: [String]) {
        switch arguments {
        case ["--version"], ["-v"], ["-V"]:
            self = .version(verbose: false)
        case ["--version", "--verbose"], ["-v", "--verbose"], ["-V", "--verbose"]:
            self = .version(verbose: true)
        case ["auth", "status"], ["auth", "status", "--json"]:
            self = .authStatus
        default:
            guard arguments.first == "auth" else { return nil }
            self = .unsupported
        }
    }

    /// Its record in `records/`; a check never writes `cli.pid` or `cli.json`.
    var recordName: String {
        switch self {
        case .version: return "version.json"
        case .authStatus: return "auth-status.json"
        case .unsupported: return "unsupported.json"
        }
    }
}
