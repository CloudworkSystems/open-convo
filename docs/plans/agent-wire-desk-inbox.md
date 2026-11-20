# Agent Wire Part 3: Mailbox Notes In The Desk (PRD)

Status: Draft (Nov 19, 2026): the screen plan that part 3 of
[agent-wire.md](agent-wire.md) asks for before it is built; waits on the
owner's yes.

Written November 19, 2026 by a Claude building session (project
"OpenConvo Project", thread "Build agent wire parts 2 and 3"). Session name:
`OC-261106-agent-wire` (part 3). Umbrella: Agents. **Builder:** this Claude
building session, after this plan merges. **Reviewers:** Codex reviews every
push; GrokBot or a fresh Claude gives the independent review, ending with
the risk-review checklist ([risk-review.md](risk-review.md)); the
coordinator checks the build against this plan and
[agent-wire.md](agent-wire.md). **Finish line:** under "Finish Line".

## Why

Part 1 built the mailbox (`services/agent-wire/`, #327). Today the owner can
only read and answer notes through a connector or the backup commands. Part
3 of the agent wire plan says notes show up in the Desk, read through the
owner tools, with replies that leave only on his yes. The Desk has no inbox
screen yet, so this plan defines one: a **Mailbox** page.

## What The Owner Sees

A **Mailbox** entry in the Desk's navigator opens one page:

- **Notes**, newest first: who it is from, who it is to, the subject, the
  time, and the body as plain text. Links are shown as text and are never
  opened, fetched or previewed. A reply the owner sent shows under the note
  it answers.
- **Under each note from an agent:** a reply box and a **Send reply** button.
  Pressing it opens a confirmation that names the recipient: "This reply
  leaves your Desk and goes to cam. Send it?" with **Send** and **Not now**.
  Only **Send** calls `answer_note`.
- **Claude's drafts** (made with `draft_reply`) show under the note they
  answer, marked "Claude's draft, not sent". Each has **Send this draft**
  (same confirmation, then `send_draft`) and **Edit before sending**, which
  copies the text into the reply box; the owner then sends his edited text
  with **Send reply**. The mailbox has no tool to delete a draft, so the
  unsent draft stays listed until it is sent or its note is cleared; the page
  says so in one line.
- **Refresh**, and the time the page last heard from the mailbox.

Nothing on the page clears notes, changes the agent list, exports or
restores. Those stay with the README's commands and the owner's connector.
That keeps the Desk's reach to five owner tools: `list_notes`,
`list_drafts`, `list_agents`, `answer_note` and `send_draft`.

## How The Desk Reaches The Mailbox

The mailbox sits behind Cloudflare Access, and the owner signs in as
himself (agent-wire.md, "Sign-In"). The Desk is a page on `127.0.0.1`, so
it can't hold his sign-in itself without loosening the mailbox. Instead:

- **A small local bridge in the Desk's development server** (the one
  `Start Desk.command` runs), at one same-origin route, for example
  `POST /__wire/mcp`. It answers only requests from the Desk's own page on
  `127.0.0.1` (it checks the `Origin` and `Host` headers and refuses
  anything else, which stops web pages but not programs on the Mac; see
  "Who on the Mac can act as the owner" below), accepts only a `tools/call` for the five tools above,
  checks the arguments against the same shapes the mailbox uses, and
  forwards the call to the mailbox's `POST /mcp`.
- **The owner's sign-in comes from `cloudflared`,** exactly as the README's
  backup commands get it: the bridge runs `cloudflared access token
  -app=<mailbox-origin>` (fixed arguments, no shell, a timeout) and sends the
  result in the `cf-access-token` header. The owner installs `cloudflared`
  and signs in himself with `cloudflared access login <mailbox-origin>`; the
  Desk never runs the login and never asks for or stores a token.
- **The token never reaches the browser,** never appears in a log, an error,
  the page or a file, and is held in memory only for the one call (or until
  its expiry, if the build caches it). Child-process output and errors are
  never echoed, since either may contain it (as `backup.mjs` already does).
- **The mailbox address is a local setting,** `AGENT_WIRE_ORIGIN`, in an
  untracked local file the owner fills in (an `https://` origin with no path,
  query or credentials, else the page says the setting is wrong). No address,
  token or note is committed to the repo.
- **Only on the owner's Mac, only in the development server.** The bridge is
  not part of `vite build`, the hosted preview or the native-proof build.
  There the page says "Your mailbox opens only in the Desk on your own Mac."
  The production build's network policy stays as it is.
- **Nothing is stored.** Notes and drafts live in the page's memory only,
  never in IndexedDB, local storage or a file, in keeping with the Desk's
  "invented data only" rule for anything it saves. Notes are public material
  (agent-wire.md, Safety rule 2), and the Desk keeps none of them.

**After the November 19 revision of agent-wire.md** (the mailbox on the
owner's Mac): the bridge works the same way, with `AGENT_WIRE_ORIGIN` set to
the mailbox's outside address. If part 2a's Tailscale door for the owner is
built, the bridge may use it instead: it then sends no token at all, and
`cloudflared` isn't needed for the Desk. The build pull request says which
door it uses, and the tests cover that one. That door is read-only, so
sending from the Desk always goes through the Cloudflare door under the
rules below.

**Who on the Mac can act as the owner.** `Origin` and `Host` checks stop
other web pages, not other programs: any program running as the same macOS
user can fake those headers, and can also ask `cloudflared` for the owner's
cached sign-in directly. So the real boundary is the macOS user, as in
[github-app-switch.md](github-app-switch.md) (Build Order step 4, the
owner's browser sign-in kept out of agents' reach):

- The owner's `cloudflared` sign-in and the Desk's bridge run only under a
  macOS user that no agent runs as: Claude Code, the Codex CLI, GrokBot's
  builders, Remote Control sessions and scheduled tasks all run as another
  user. The owner names his own user once in the local settings file, and the
  bridge refuses to start under any other user.
- **Sending is off until the owner turns it on.** The bridge starts with the
  read tools only (`list_notes`, `list_drafts`, `list_agents`). It forwards
  `answer_note` and `send_draft` only after the owner sets
  `AGENT_WIRE_DESK_SEND=1` in the local settings file himself, at part 2
  setup, once he has confirmed no agent runs as his macOS user. Until then
  the page shows replies and drafts, and says "Sending from the Desk is
  off on this Mac." in place of the Send buttons.
- If agents do run as his macOS user, the owner's sign-in isn't safe there
  at all (the same program could use `cloudflared` itself), so part 2 sets
  up the mailbox sign-in on a separate macOS user before going live.

**Calls stay under the mailbox's limits.** The owner shares the limit of 10
calls in any rolling minute. Opening the page makes three calls
(`list_notes`, `list_drafts`, `list_agents`); **Refresh** makes two
(`list_notes`, `list_drafts`) and is unavailable for 30 seconds after the
page opens or refreshes. So reads use at most five calls in any minute,
leaving five for sends. The bridge also counts its own calls in a rolling
minute and refuses an eleventh locally with the mailbox's own limit message,
without calling the mailbox. There is no automatic polling.

## Safety

agent-wire.md's six Safety rules hold here too. In the Desk that means:

- A note's words are only shown. Nothing in the Desk reads a note to decide
  what to do, starts work from one, or hands one to a model.
- A reply leaves only after the owner presses **Send** in the confirmation
  for that one reply. There is no "send all", and no keyboard shortcut sends
  without the confirmation.
- The bridge can't be used for any tool outside the five, so a bug in the
  page can't clear notes or change who may write in.

## When It Goes Wrong

The five questions of [when-it-goes-wrong.md](when-it-goes-wrong.md), for
the Mailbox page:

1. **No connection.** If the mailbox or the internet can't be reached: "Can't
   reach your mailbox right now." The page keeps showing what it last loaded,
   with the time it last heard from the mailbox, and keeps any reply text the
   owner typed. **Send** shows the same message, and the reply stays in its
   box. Nothing retries by itself; **Refresh** tries again.
2. **Interrupted.** If the Desk is closed or the Mac sleeps mid-send, the
   reply was either saved whole by the mailbox or not at all (one storage
   transaction, part 1). After any send that didn't hear back, the page says
   "Not sure that reply was sent. Refresh to check before sending again." and
   doesn't offer **Send** for that reply until a refresh. Text typed but not
   sent is lost when the Desk closes; leaving the page with unsent text asks
   first.
3. **Empty or first run.** No address set: "Add your mailbox address to
   connect." with the one line to add. Not signed in, or the sign-in expired:
   "Sign in to your mailbox first: cloudflared access login
   <mailbox-origin>" with his address filled in. `cloudflared` missing:
   "Install cloudflared, then sign in to your mailbox." No notes: the
   mailbox's own "No notes yet." No agents: the mailbox's own "No agents can
   write to this mailbox yet. Add one to let it in."
4. **Denied or stuck.** The mailbox's own plain messages are shown word for
   word: past the minute limit, "Too many notes for now. Try again in N
   minutes."; during a restore, "This mailbox is being restored. Try again
   soon."; a draft already sent, "That draft is no longer here." Anything else
   from the mailbox, or an answer that isn't the mailbox's own (an Access page,
   an HTML error), gives "Your mailbox didn't answer as expected. Try again,
   or sign in again." and never shows the raw answer.
5. **The error message.** Every message says what happened and what to do
   next in plain words, with no codes, internals or stack traces, and never
   shows a token or a header. The mailbox's short reference code is shown
   only as "Reference: <code>" under the message, for a builder to look up.

## Tests (Must Pass, Run By `npm run check` In `apps/desk`)

Invented notes, agent names and mailbox address only. A fake mailbox and a
fake `cloudflared` stand in; no test reaches the internet or a real account.

1. The page shows notes newest first, with sender, recipient, subject, time
   and plain-text body; a body with HTML or a link shows as text and nothing
   is fetched.
2. **Send reply** does nothing until **Send** in the confirmation, which
   names the recipient; **Not now** sends nothing. The same for **Send this
   draft**. **Edit before sending** copies the text and sends nothing.
3. The bridge forwards only the five tools; every other tool name, a batch,
   a non-`tools/call` method, a request from another origin or host, and a
   request with a query string are refused and never forwarded.
4. The token from the fake `cloudflared` goes only in the `cf-access-token`
   header to the mailbox origin. It never appears in a response to the page,
   the page itself, an error, a log line or a file (a test searches them).
5. No note, draft or reply text is written to IndexedDB, local storage or
   any file (a test reads browser storage after a full session).
6. The production build, the hosted preview and the native-proof build
   contain no bridge, and their Mailbox page shows the "only on your own Mac"
   line.
7. Opening the page makes three calls and **Refresh** two; **Refresh** is
   unavailable for 30 seconds after the page opens or refreshes; refreshing
   whenever the button is enabled for five minutes never exceeds five read
   calls in any rolling minute and never gets a limit refusal from the fake
   mailbox; nothing polls.
8. Every message under "When It Goes Wrong" appears word for word in its
   case: no address, a bad address, `cloudflared` missing, sign-in refused,
   no connection (last view kept), a send with no answer (send blocked until
   refresh), each mailbox refusal, and an Access or HTML answer.
9. Leaving the page with unsent reply text asks first.
10. The bridge refuses to start under a macOS user other than the configured
    owner user; without `AGENT_WIRE_DESK_SEND=1` it refuses `answer_note` and
    `send_draft` and the page shows "Sending from the Desk is off on this
    Mac."; with it, both work only through the confirmation.

## Owner Trial Checks

After part 2 is live, on invented notes, with the owner at his Mac: Cam
leaves a note and it shows on the Mailbox page after **Refresh**; he replies,
the confirmation names Cam, and the reply reaches Cam; a Claude draft shows
as "not sent", and Cam gets nothing until he sends it; with the network off,
the page says "Can't reach your mailbox right now." and keeps what it showed
and what he typed; a send cut off midway shows the "Not sure that reply was
sent" line and the reply is there whole or not at all after a refresh;
with `cloudflared` signed out, the page tells him the one command to sign
in; an empty mailbox says "No notes yet."; during a restore the page shows
the "being restored" line; past the minute limit it shows the limit message.
He confirms each message tells him what to do next.

## Out Of Scope

Clearing notes, the agent list, export and restore in the Desk; sending to a
new recipient (the page only answers notes); notifications; keeping notes
for offline reading; the Mac app's own view (it follows once protected
native storage exists); and any change to `services/agent-wire/`.

## Rules For The Builder

- Build after this plan merges, on a branch for this session, in
  `apps/desk/` only, plus `STATUS.md` and this plan's status line. No change
  to `services/agent-wire/` or `.github/`.
- No new dependency. `cloudflared` is the owner's own tool, as in the
  mailbox's README, never an npm package; if the build needs anything else,
  it stops for the owner (the risk hold).
- Touch no real token, address or account. Never run `cloudflared` for
  real, never reach a real mailbox, invented data only.
- Supported setups: macOS and the Linux CI runners on Node 22.

## Finish Line

Done when the build pull request merges with `npm run check` passing in
`apps/desk`, Codex and the independent review clean on its latest commit,
and, after part 2 goes live, the owner trial checks above pass. Then this
plan's status becomes Built, and part 3 of agent-wire.md is done.
