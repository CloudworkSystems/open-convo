# Design Note: Connections, True Convo's Own Way To Reach Apps

Written October 30, 2026 at the owner's request, in the thread "Plan an
in-house connector layer for TCA". Status: direction for the owner to read,
not a plan. Nothing is built, signed up for or registered. It extends
[capabilities-and-primitives.md](capabilities-and-primitives.md) and
[portable-capability-layer.md](portable-capability-layer.md), arrives with
step 6 and jumps nothing in the build order. Each slice gets its own plan in
`docs/plans/` before it is built.

## Why This Note Exists

The owner's ask: True Convo should connect to everything seamlessly. Where it
can, that should be free, or run on the person's own sign-ins and
subscriptions. Where it can't, it should cost as little as possible while
staying reliable and fast. The same connections should also serve Claude
Code and Codex on the owner's Mac while True Convo is being built.

Composio was checked first, on October 30, and set aside for True Convo:

- Its open-source code is only the client. Signing in, running actions and
  its MCP endpoint all happen on Composio's servers, so Composio would hold
  every user's sign-ins.
- By default it keeps the full request and response of every action for up to
  a year, and its free plan can't switch that off.
- n8n is free to self-host for internal use, but shipping it inside a product
  needs n8n's paid Embed license.

**Learn, don't copy (owner, October 30).** We study how Composio and similar
tools behave, from their public docs and from using them, and then write our
own version. No code, schemas or tool descriptions are copied from them.

## What We Keep From Composio, And Where We Do Better

Worth keeping:

- One sign-in per app, handled for the person, with tokens refreshed
  automatically.
- **Tool search.** The model searches for the few tools it needs instead of
  loading hundreds into its context.
- The narrowest permissions each app allows.
- Several actions run in one call when they don't depend on each other.

Where True Convo does better:

- **Sign-ins stay on the person's Mac,** in Keychain, and calls go straight
  from the Mac to the app. No server of ours or anyone else's sits in the
  middle.
- **One wrapper for every connection.** True Convo's approvals, cost caps
  and logs apply to every connection, whichever model is driving.
- **Logs stay on the Mac,** sealed like other private data and erased by the
  same Forget.
- **Small models can use it too.** Tool search returns only a few tools,
  each with a written recipe that has passed on the local default model.
- **No fee per call.**

## How True Convo Reaches An App, Cheapest First

For each app, True Convo uses the first route on this list that works:

1. **The Mac itself.** Apple's own frameworks and app scripting reach
   Calendar, Reminders and Contacts, and Shortcuts and scripting reach Mail,
   Notes and other apps. These cost nothing and need no sign-in of ours.
   They are not automatically on-device, though. When the calendar, list or
   mailbox is synced to iCloud, Google, Exchange or another account, a change
   made through the Mac app goes to that provider. So each route-1 connector
   checks which account backs the item it touches and declares what an
   action sends out. Changes to a synced account get the same outside-host
   approval, logging and privacy handling as a direct connection. Only items
   kept "On My Mac" count as local. Each connector needs a Mac permission
   that the person grants once, and each new permission also needs the
   owner's approval ([security.md](../plans/security.md) checklist, item 5).
2. **The app's own official MCP server.** Many services now run one with
   standard sign-in (MCP authorization, built on OAuth 2.1). Newer versions
   of the standard let a client identify itself with a published metadata
   document, so where a service supports that, True Convo needs no separate
   registration with it. True Convo is the MCP client, and the token lives in
   Keychain. It costs us nothing, and the person's own plan with that service
   sets the limits.
3. **A connector of our own, against the app's public API.** Small, partly
   generated from the app's published API description, reviewed by a person,
   and tested against recorded, invented responses. Most providers let us
   register True Convo as an app for free.
4. **Standard protocols, where the API costs money or needs a review.**
   These are IMAP and SMTP for mail and CalDAV and CardDAV for calendars and
   contacts, signed in with an app password the person creates. Gmail is
   the open case. Google's API needs its restricted-scope review. Google
   ties the yearly paid security assessment to restricted data reached from
   or through a third-party server, and in this design the data stays on
   the Mac. So the assessment may not apply, but that isn't confirmed. The
   Gmail slice's plan settles Google's actual requirement for a Mac-only
   app before choosing between the Gmail API (route 3) and IMAP. IMAP is
   the fallback, not the default.
5. **Browser or computer use,** only when none of the above exists. It is
   slower and less reliable, and it follows
   [computer-use.md](computer-use.md).

True Convo never runs a server of its own that holds people's sign-ins. That
would break the back-end direction in
[back-end-and-agent-hosts.md](back-end-and-agent-hosts.md), where the
product's back end is almost nothing.

## Sign-Ins

- The browser sign-in uses PKCE and returns to the Mac directly, so no server
  of ours is needed. Each sign-in is stored per person and per app in
  Keychain, with the narrowest permissions.
- An app ID True Convo registers with a provider is public. The app ships no
  client secrets, because a secret inside a desktop app isn't secret.
- A person can bring their own provider app instead, such as their own Google
  Cloud project. Its 100-user testing limit doesn't matter for one person,
  but while a Google project is left in Testing, its sign-ins for mail,
  calendar and contacts expire after seven days. So that path either has
  the person publish their project to production, or True Convo tells them
  plainly that they'll need to sign in again each week, and asks before the
  sign-in lapses.
- Registering True Convo with a provider, and any review fee, is an account
  or spending step, so each needs the owner's approval.

## Speed And Reliability

- One hop: the Mac talks to the app directly.
- Tool search runs over a local index (`search_local`, already planned in
  capabilities-and-primitives.md).
- Each connector declares the app's rate limits. True Convo queues calls and
  retries with backoff. A provider's quota on True Convo's registered app is
  shared by every user, so each connector says whether the limit applies per
  person or to everyone.
- "Something changed" alerts (new mail, a changed event) come from polling
  on the Mac, or from the provider's own push where that needs no public
  server. The private side gets no public webhook address.
- Each connector reports its own health. A broken one shows up as "not
  working" instead of failing silently.

## Costs

| Item | Cost | Who pays |
| --- | --- | --- |
| The Mac's own apps (synced accounts still reach their provider), official MCP servers, standard protocols | $0 | Nobody |
| Registering True Convo with most providers | $0 | Nobody, with the owner's approval |
| Google's restricted-scope review, only if we use the Gmail API | The review itself; a yearly paid assessment only if Google requires one for a Mac-only app (to confirm) | The owner, if he decides to; IMAP is the fallback |
| The app's own plan limits | The person's existing plan | The person |
| The model that picks and runs tools | The person's own sign-in, key or local model (foundations, principle 16) | The person |

## The Same Connections For Claude And Codex

The connectors also run as a local, tools-only MCP server through the
capability adapter: no network port, keys in Keychain. That lets Claude Code
and Codex on the owner's Mac use them during development. Built once, the
connectors serve three users.

## Rules

- **Our code only.** Outside tools are studied for ideas, never copied.
- **Every connector declares its actions** (read, send, delete, spend), and
  those actions go through True Convo's approvals.
- **What comes back from an app is data, never instructions** (security.md
  checklist, item 6). Mail, issues and documents can carry text meant to
  steer an agent.
- **Each new outside host is approved once** (foundations, principle 6), and
  each new Mac permission is approved by the owner.
- **No tokens in files, logs or test output.** Tests use invented, recorded
  responses.
- **Connector logs stay on the Mac,** sealed, under the memory rules.

## First Slice: The Owner Picks

Per the build rule, a slice is planned only once the owner would use it
within a week. Candidates:

1. **Calendar and Reminders through the Mac** (route 1). It feeds the Today
   agenda and the calendar merge engine. Reading comes first; any change to a
   synced calendar goes through approval, as described under route 1.
2. **One official MCP server** (route 2), to prove the sign-in flow and tool
   search with a real service the owner already uses.
3. **Read-only mail over IMAP** (route 4). It feeds the email sorting engine
   without Google's review.

## Open Questions

- Which first slice.
- Whether True Convo registers its own Google app at all, or stays on IMAP
  and CalDAV for Google accounts.
- How many connectors we build ourselves, and how far we rely on official
  MCP servers.
