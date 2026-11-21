# Gemini API Adapter: Gemini Joins The Conversation

Status: Draft (Nov 21, 2026): proposed for the owner's yes; nothing built.

Written November 21, 2026 by a Claude session (Claude Duet, task
"261121 GEMINI IN TCA"), from the owner's ask the same day: "I want to be
able to use Gemini in True Convo, and I don't care about the OAuth versus
the API key prices" (12:58 AM ET). He picked "Open Convo core" for where it
lives (1:34 AM ET). Session name: `OC-261121-gemini-api-adapter`.

**Builder:** Claude building sessions (the OPEN-CONVO session on the
owner's Studio, through the push gate), label `agent: claude`.
**Reviewers:** Codex on every commit, plus the usual independent review
(GrokBot, or a fresh Claude review that didn't build it).
**Finish line:** the owner trial below passes in True Convo Test with
invented conversations. The real True Convo app is unchanged.

Background: [agent-profiles-and-adapters.md](../design-notes/agent-profiles-and-adapters.md)
("Gemini as an Outside Checker", "How Each Model Is Paid For"),
[claude-code-adapter.md](claude-code-adapter.md),
[step-3-local-conversation.md](step-3-local-conversation.md),
[media-generation-capability.md](media-generation-capability.md) (the
signed cap and ledger), [risk-review.md](risk-review.md) and
[docs/decisions.md](../decisions.md) (Oct 27 and Oct 31 on Gemini keys).

## What It Is

**Why.** The owner wants Google's Gemini models in the same Desk
conversation as the local model and Claude. Google's personal plans,
Ultra included, don't allow another app to drive the subscription sign-in
(the reason the October 27 decision moved Gemini to an API key), and
Ultra's limits don't cover API calls. So Gemini is paid per use on the
person's own Gemini API key.

**How.** The Mac app calls Google's Gemini API directly over HTTPS, the way
step 3 calls Ollama, but at Google's fixed address instead of this Mac.
No CLI, no Antigravity, no SDK. Text in, text out, streamed into the saved
conversation, with Stop, quit, crash and Retry behaving exactly as they do
for the local model. The difference the owner must always see: **the
conversation leaves the Mac and goes to Google, and it costs money.**

**Open Convo's core.** It lives in this repo, so every Open Convo user can
bring their own key and pay Google directly. The owner's rule of November
15 keeps a feature in True Convo only while it can't be offered at
pass-through prices; a person's own key already is pass-through.

The same module later serves the outside checker in the design note
(adapter order item 6) with no tools and public material only. That use
needs its own small plan revision; it is not part of this finish line.

## Facts This Plan Rests On

Read on Google's own pages and Google's blog on November 21, 2026.
Recheck each before the pull request that relies on it, and record what
changed.

- **Endpoint.** `https://generativelanguage.googleapis.com`, method
  `streamGenerateContent` with `alt=sse`, key in the `x-goog-api-key`
  header. Google's docs now call `generateContent` "legacy" and point to a
  newer Interactions API on the same host; PR 3 reads both and picks one,
  recording why. The OpenAI-compatible endpoint is labeled beta and isn't
  used.
- **Models and prices** (US dollars per million tokens, input then
  output): Gemini 4 Argon $2 and $10, rising to $4 and $20 on December 1;
  Gemini 4 Carbon the same; Gemini 4 Neon $3 and $15; Gemini 4 Hydrogen
  $1.50 and $7.50; Gemini 3.1 Flash-Lite $0.25 and $1.50. Thinking tokens
  are billed as output. Hydrogen's and Carbon's exact model ids weren't on
  Google's model list yet; PR 3 uses only ids that list shows.
- **Data use.** Paid tier: "not used to improve our products". Free tier:
  used. A key from a project with billing on counts as paid.
- **Google's own limits.** The first paid tier caps spending at $10 in any
  10 minutes (a `429` answer past it). AI Studio has a monthly project spend
  cap (labeled experimental) and prepay billing that stops every key at $0.
  Billing data lags about 10 minutes, so none of these is a hard cap.
- **Keys.** New keys are restricted to the Gemini API by default, and the
  API rejects unrestricted ones.

## In And Out

**In:**

- One participant route, `gemini-api`, with `executionHost` `google`.
- A list of models in code, each with its price, recorded in PR 3. A new
  model or a new price is a small pull request of its own, because the cap
  needs every model's price.
- The default model, the thinking level and the monthly cap, each changeable
  in the app at any time after merge (see "Changeable In The App").
- Earlier turns of the same conversation (local, Claude or Gemini turns)
  sent as context, counted above the composer before Send.
- The key, entered once on a native Mac screen and kept in Keychain.
- The one-time "Approve Google once" screen, the per-launch spending
  confirmation, the signed cap and the ledger.
- True Convo Test only.

**Out:**

- Gemini subscription sign-in, the Gemini CLI, Antigravity and Vertex AI.
- Any tool: function calling, code execution, search grounding, URL
  reading, files, images, audio and video. The request carries no `tools`
  field.
- Deep Think (not on the API for most people), Veo and other media (the
  media capability plan covers media).
- The batch API, context caching beyond Google's automatic caching, and
  any automatic model choice or fallback between models.
- Memory, dictation straight to Gemini, the "Wait—what?" explainer.
- The real True Convo app, other users, and anything shipped.

## The Safety Model

1. **What leaves the Mac, and when.** Only on the owner's Send: the new
   message and the earlier turns listed above the composer, to Google's
   fixed address. Availability checks send nothing: they read only
   Keychain, the approval and the cap. Nothing on dictation, lock or quit.
   The picker says "Gemini · <model> · Google (not on this Mac)". Above the
   composer: "Sends this message and N earlier turns to Google · about
   $X".
2. **One fixed host.** The client reaches only
   `https://generativelanguage.googleapis.com`. It reads no environment
   variable, default, argument, file or page value that could change it,
   refuses every redirect, and uses an ephemeral session with no cookies,
   cache or stored credentials, like the Ollama client.
3. **The key.**
   - Typed into a native secure text field in the Mac app, never into the
     Desk's web page, so the page never holds it.
   - Saved in the app's Keychain service under one account name
     (`GEMINI_API_KEY`). Unlike the dictation keys, there is **no
     environment-variable fallback**, so nothing launched beside the app can
     slip in a key.
   - Read only by the Gemini route, at send time. Never written to a file,
     a log, the store, the repo or the 1Password agents' vault. Never shown
     back: the screen offers Replace and Remove only.
   - Logs record run ids, model, token counts and cost, never headers or
     message text.
   - A test proves the key appears in no log line, store record or page
     message.
4. **Approval.** Nothing is sent until the owner has approved Google once
   in the Desk window (saved in the protected store, revocable, as section
   21.4 does for Anthropic). The screen says that what he sends goes to
   Google, that it is billed to his key, and that a key from a project
   without billing lets Google use what he sends.
5. **Spending, three layers.**
   - **Google's side**, set by the owner and checked in the trial: prepay
     with auto-reload off, the project spend cap, a budget alert.
   - **True Convo's signed cap and ledger** from `packages/capabilities`
     (part 2, #269). The cap starts at $0, so Gemini is off until the owner
     signs a cap. Before each run the ledger reserves its worst case:
     input tokens counted generously from the bytes sent, priced at the
     model's input price, plus the request's `maxOutputTokens` (which bounds
     thinking too) at its output price. A run that wouldn't fit isn't
     sent. After the run the ledger records Google's reported usage. A run
     that ends without a usage report (quit, crash, cut connection) keeps
     its full reservation as spent. The monthly total stops new runs with a
     reserve left for the 10 minutes Google's billing lags.
   - **Per launch**, a confirmation in the Desk window: "Gemini spending is
     on. $Y of $X left this month." It ends on lock, sleep, logout and quit,
     like section 17's.
6. **No paid run without the Mac's cap holder.** The cap is enforced only
   once the Mac keeps the cap's signing key and protected state in the
   Keychain (the media plan's part 4 holder). Whichever plan reaches it
   first builds it once, for both. Until it exists, Gemini can't be
   switched on.

## Changeable In The App

Owner's requirement, November 21 ("we need to be able to change any of
those after it merges too"). None of these is fixed in code or a config
file. Each is a setting the owner changes in the app, saved in the
protected store, and the starting values under "Open Questions For The
Owner" are only what a new install begins with.

- **Model.** The picker lists every Gemini model in the built-in list.
  Picking one applies to that conversation from its next message.
- **Default model.** A Gemini section in Settings sets which model a new
  conversation starts with. Changing it never changes a conversation that
  already picked one.
- **Thinking level.** Low, medium or high, chosen beside the model in the
  picker for that conversation, with a default in Settings. The composer's
  cost line updates as soon as it changes.
- **Monthly cap.** Shown in Settings with what's left this month. Lowering
  it or pausing Gemini takes effect at once. Raising it signs a new cap,
  so it asks for the owner's Mac sign-in (Touch ID or password) first, as
  the media plan's cap does; no model, page or agent can raise it.
- **Key.** Replace or Remove in Settings, as in the safety model.

A test changes each setting and checks that the next run uses the new
value and that a run already under way keeps the value it started with.

## Contract Changes (Revision 6)

`docs/desk-native-participant-contract.md` gains section 22, written in PR
2, covering:

- The route `gemini-api`: availability with `state` and `reason`
  (`no-key`, `host-not-approved`, `cap-not-set`, `cap-reached`,
  `confirmation-needed`), and one entry per listed model.
- A Gemini run's prepared shape: section 6's keys plus `contextRunIds`, as
  in 20.3 and 21.2, with the earlier turns mapped to Gemini's `user` and
  `model` roles.
- Start, events and stop: streamed text chunks, `completed` with Google's
  usage, and Google's answers mapped to reasons: no connection, `401` or
  `403` (key refused), `429` (Google's limit), safety block, too long.
- The ledger's reservation and settlement for each phase.
- Vectors for every case, run on both sides against a fake Google server
  on loopback.

## Pull Requests, In Order

1. **This plan.** Merges on the owner's yes, quoted in the pull request.
2. **Contract revision 6** and the page codec (invented chats only).
3. **The Gemini route, switched off.** A new module beside
   `LocalModelRoute`, tested only against a fake Google server; nothing in
   the app builds it. Records the model list and prices, and which Google
   method it uses.
4. **The key screen and Keychain storage.** Needs the owner's GitHub
   approval (protected paths).
5. **The cap and ledger wired to Gemini**, and the Mac cap holder if the
   media plan hasn't built it yet. Needs the owner's GitHub approval.
6. **Desk wiring:** the picker entry with its model and thinking choices,
   the Gemini section in Settings (default model, default thinking level,
   cap, key), the composer line with its cost estimate, the approval and
   spending screens, Retry. Nothing turned on.
7. **The kill proof:** a test copy of the app with a fake Google server,
   killed mid-reply at exact points, as PR 4-proof did for Claude.
8. **Switched on in True Convo Test**, then the owner trial.

Separately, one small pull request adds `/apps/mac/**/*Gemini*` and
`/apps/mac/**/*Google*` to `.github/CODEOWNERS`, so files named for this
provider are owner-protected like the OpenAI, Groq and Anthropic ones. It
lands before PR 3.

The new host and the key name trip the risk hold in PRs 3 and 4. That is
expected: they wait for the owner.

## When It Goes Wrong

1. **No connection.** Availability sends nothing, so the entry stays
   available offline. A Send that can't reach Google fails at once:
   "Couldn't reach Google. Nothing was sent. Retry when you're online." The
   reservation is released, since no request left. A connection cut
   mid-reply keeps the text so far and counts the run's full reservation
   as spent.
2. **Interrupted.** Quit, crash, lock or sleep mid-reply: the reply text
   received so far is kept, the run ends `stopped`, nothing is sent again
   on the next launch, the spending confirmation is asked again, and Retry
   makes exactly one new run with a new reservation. The kill proof covers
   each point.
3. **Empty or first run.** No key: the entry reads "Gemini · Add your key
   in Settings" and opens the key screen. No cap: "Set a monthly limit
   first". Not approved: the approval screen. Each says the one next step.
4. **Denied or stuck.** Declining the approval sends nothing, and it can be
   approved later. A refused Keychain prompt counts as no key, and the app
   still quits and reaches its menus. Stop always works, including while
   Google is slow to answer; a run with no data for 60 seconds ends
   `failed` `timeout`.
5. **The error message.** Plain words, with the next step:
   - Key refused: "Google didn't accept the key. Check it in Google AI
     Studio, or paste a new one."
   - Google's limit: "Google's spending or rate limit was reached. Try
     again in a few minutes."
   - Our cap: "This month's Gemini limit is reached. Raise it in Settings
     or wait until next month."
   - Safety block: "Google declined to answer this message."
   - Too long: "This conversation is too long to send to Gemini."

## Owner Trial Outline

In True Convo Test, invented conversations only:

1. Before a key: the entry asks for one, and nothing is sent.
2. Paste a key from a billing-on project; it isn't shown again; Remove
   works.
3. With the cap at $0, Gemini can't be sent; after signing a small cap, it
   can.
4. Approve Google once; hold a conversation that remembers earlier turns
   from the local model and Gemini; the composer line counts them and shows
   a cost.
5. Stop mid-reply; quit mid-reply from the menu and with Command-Q; Retry
   makes one new run.
6. Turn the network off and send: the plain message, nothing charged.
7. Paste a wrong key: the key-refused message.
8. Set the cap just above one reply's cost: the next Send is refused with
   the cap message.
9. Check Google AI Studio's usage against the ledger's month total.
10. Check that no log or exported store contains the key.
11. Change the default model, the thinking level and the cap in the app:
    the next message uses each new value, and raising the cap asks for the
    Mac sign-in.

## Open Questions For The Owner

Each has a starting answer the build uses unless he changes it before his
yes. B, C and F are only a new install's starting values: the owner
changes them in the app any time after merge.

- **B. Default model.** Starting answer: Gemini 4 Hydrogen if PR 3 finds
  its id on Google's model list, else Gemini 4 Argon. The others are a pick
  away.
- **C. Monthly cap.** Starts at $0. He sets the amount in Settings when
  he turns Gemini on, and changes it there later.
- **D. When it starts.** Starting answer: PRs 2 and 3 start now, alongside
  Claude's live check, since they are switched off; PR 8 waits for the Mac
  cap holder.
- **E. Ultra's Google Cloud credit.** Ultra includes $40 a month of Google
  Cloud credit that Google says covers the Gemini API; whether it applies
  to an AI Studio key wasn't confirmed. Starting answer: an AI Studio key
  now, checked again before PR 8.
- **F. Thinking level.** Starting answer: medium as the default, changed
  per conversation in the picker or as the default in Settings.

## Revisions

None yet.
