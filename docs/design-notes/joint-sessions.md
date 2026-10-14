# Design Note: Joint Sessions

Rewritten October 13, 2026 by the planning session from True Convo's
`docs/2026-09-30-joint-session-design.md` (commit `c527e36`). Status: design
agreed by Claude and Codex with the owner's naming decision; one trial run;
nothing built. This is a workflow tool for the owner's agents today and a
possible Desk feature later (several agents in one named session).

## What It Is

One command opens a matching conversation in each desktop app in use (Claude
and Codex now, others later), all with the same title, such as
`260930 JOINT SESSIONS`, so it is always clear which conversations belong
together. The exact start time is kept in a hidden record, not the title.
Messages between agents go by each conversation's permanent ID, so a rename
cannot misdirect them. Open Convo's session names (`OC-261012-...`, AGENTS.md)
follow the same idea.

What could go wrong: a half-created group if one app fails, and names drifting
if someone renames a conversation by hand. The tool reports both rather than
hiding them.

## Names (Owner Decision, September 30, 2026)

1. Visible title in every app: `YYMMDD NAME`, the owner's local date
   (America/New_York), six digits, a space, the name. No time in the title.
2. The title is computed once, when the group is created, and given unchanged
   to every app. Midnight, travel, reopening or a later member joining never
   changes it.
3. Every group gets an exact hidden creation time: UTC ISO 8601, local ISO 8601
   with its offset, and the timezone name, all for one instant.
4. Duplicate titles are refused and the tool asks for another name. No
   automatic suffix.
5. Warn when the title is longer than about 24 characters (sidebars cut it
   off); never shorten it. Refuse a title an app cannot keep exactly (Codex
   collapses whitespace and allows 60 UTF-16 code units).

## The Record

One small private local file per group: a permanent random group ID, the
creation request ID, NAME and full title, UTC and local creation times and
timezone, the project, and for each member its app, native conversation ID,
and creation and message status. No credentials and no old conversation
contents. A Claude messaging address is temporary (it changes when the app
restarts), so it is looked up again from the saved session ID.

## The Command (Proposed)

```bash
joint-session new "JOINT SESSIONS" --project <project folder> --with claude,codex
```

1. Check that each requested app can create a full desktop conversation,
   resolve the project, check for conflicting titles, and use the plan login
   (never API billing or overflow credits). If one app cannot, stop before
   creating the others.
2. Under a local file lock, reserve the title and save the request and creation
   time. Create each conversation with the identical title and a short
   invitation; save each returned ID at once. If one app fails, keep the ones
   that succeeded and report exactly what is missing.
3. Read back every ID and title, then send the common brief. Joining a group
   does not authorize copying old conversations, private files or credentials,
   or sending anything to an outside service.
4. Later messages use the saved IDs through an agent bridge. An uncertain
   create or send is checked before any retry; a timed-out reply never creates
   another conversation. No automatic agent reply loops.
5. Show the new conversations and check first messages, matching titles and
   reopening in each app.

"Name locked everywhere" means keeping the agreed title (set, read back, drift
reported) and noting that neither app prevents a rename. The tool never
silently undoes a rename the owner made.

## What Each App Could Do (Checked September 30, 2026)

- **Codex:** inside a Codex desktop chat, `create_thread` (project, first
  message, explicit title) and `set_thread_title` exist. An outside command into
  that route is unverified, so the first version asks an existing paired Codex
  chat to create the new one and report its ID and title. Creating starts a
  Codex turn (plan usage).
- **Claude:** renaming a desktop conversation by tool works. Creating one by
  tool is not available to a normal session, and `claude://` links cannot
  create a conversation with a first message or title. The Claude side stays
  one click by the owner (decided September 30).

Recheck both before building; desktop app abilities change.

## What The Trial Taught

- Codex created its side with the exact title and answered; Claude renamed a
  conversation the owner opened, and the coordinator reached both members by ID
  and by title.
- Member-to-member messaging failed for a good reason: the invitation said "run
  no commands," and a later message from another agent could not widen that.
  **The invitation itself must permit members to message each other through the
  bridge.**

## Not Moved

True Convo's `tools/agent-bridge` stays behind (the adapter plan replaces it);
building this tool needs a bridge designed against the current adapters. The
trial's conversation IDs and local record are not moved.
