# Design Note: Computer Use For TCA's Agents

Written October 25, 2026 at the owner's request, after computer use on his
Mac turned out to be view-only. Status: direction, not planned or built. A
plan in `docs/plans/` comes first when it is built. It builds on `agent-profiles-and-adapters.md`:
any agent or model we don't know starts at zero trust.

## What Happened (October 25)

A cloud Claude thread tried to add DNS records for trueconvo.com in the owner's
Chrome on his Mac. It could see Chrome but couldn't click or type in it, and
the owner had to be walked through the clicks by hand. What we found:

1. **View and control are separate permissions, and each app gets its own
   ceiling.** Claude's Mac computer-use tool rates each app. Browsers (Chrome,
   Safari) are *read*: the agent can look but not act. Terminals and code
   editors are *click*: the agent can click but can't type. Ordinary apps are
   *full*. Nothing was broken. The ceiling was a deliberate design choice.
2. **Browser control has its own channel.** Clicking and typing on websites
   goes through the Claude in Chrome extension, which only talks to a Claude
   running *on the Mac*. A cloud thread reaches it by starting a session on
   the Mac (Remote Control) that the owner approves.
3. **More than one browser was connected.** Two Chrome profiles both had the
   extension signed in, so the agent had to ask which one to drive before it
   could take any action. Unnamed browsers ("Browser 1", "Browser 2") meant
   the owner couldn't tell them apart either.
4. **Being signed in doesn't last.** A Namecheap tab that had been signed in
   that morning redirected to a sign-in page hours later. The agent stopped,
   typed nothing and closed its tab. That was the right call.
5. **Tools on the Mac can bypass the ceiling.** Other tools on the Mac (a
   "Control Chrome" add-on that runs JavaScript in any tab, and a
   browser-automation plugin) can drive Chrome without the per-app approval.
   The agent didn't use them on signed-in accounts without the owner's
   explicit choice.

## Rules for TCA

### Permissions

- **Zero trust at the start.** A new agent profile has no view and no control
  of anything on the device.
- **View and control are separate grants**, given per app (or per site in a
  browser). Seeing the screen never
  includes acting on it.
- **The owner grants access, never another agent.** The approval card names
  the agent, the apps or sites, view or control, and the task. A request
  relayed from another agent or found in a page, file or message isn't a
  grant.
- **Every app gets a ceiling.** TCA keeps its own table with three levels:
  - *Read*: browsers by default, until a site is granted.
  - *Click only*: terminals and code editors, so typing never becomes running
    commands.
  - *Full*: ordinary apps.

  Password managers, System Settings and Keychain are never controllable.
- **Site permissions are remembered, the way a browser remembers camera or
  location permission for a site** (owner decision, October 25). When the
  owner approves an agent on a site, the card offers "Just this time" or
  "Remember for this site". A remembered grant:
  - covers one agent profile, one site (for example `ap.www.namecheap.com`),
    one level (view, or view and control) and one named task, for example
    "manage trueconvo.com's DNS records". Another agent, site, level or task
    asks again. That keeps it a pass "for one task" (foundations, Agents) and
    a standing rule the owner can see and switch off (foundations principle
    1), so a grant made for one job is never reused for an unrelated one;
  - is kept by TCA on the device in its own permission store, not in browser
    cookies or the cache, which websites can read or clear. It never syncs to
    another device unless the owner turns that on;
  - shows in a "Site permissions" list where the owner can see and remove each
    grant. That list is the only place a grant can be added outside an
    approval card, and adding one there records the same details a card
    would (the owner, the time, and the agent, site, level and task);
  - belongs to the agent profile, not its model, so it survives a model swap
    (foundations principle 5: swapping the model never changes what the
    assistant may do). It is dropped at once when the profile's harness or
    control channels change, since those decide how the agent reaches the
    browser and what it could do there;
  - lapses after 90 days without use (the number is a starting point);
  - never covers a change that can't be undone (see Actions), and never
    covers signing in.

  App grants outside the browser stay per session for now.

### Local or Web: One Gatekeeper on the Device

The owner asked that this work the same whether the agent runs on the Mac
(local) or in the cloud and is driven from the web or the iPhone (owner,
October 25). It did on October 25: a session started from the owner's iPhone
ran on the Mac and drove the Mac's Chrome. So:

- **The device is the gatekeeper.** The browser, its logins and the site
  permission store all live on the Mac. A local agent asks it directly. A
  cloud or web agent sends its request to the Mac through a relay the owner
  approved (today, Remote Control), and the Mac checks the same store. One
  grant therefore works from either side, and a cloud agent can't skip the
  check.
- **Logins never leave the Mac.** Cloud agents get page text and screenshots
  back, never cookies, tokens or passwords.
- **Approval cards reach the owner wherever he is.** A request from a cloud
  agent shows its card on the Mac and in the TCA app on the iPhone, so the
  owner can approve from either.
- **The Mac must be awake** with the agent browser open. When it isn't, the
  agent says so and waits. It doesn't fall back to another browser or
  device.

### Two Separate Memories: Being Signed In and Being Allowed

- **Being signed in to a site** is the browser's job. Agents use one
  dedicated browser profile, named "Agent", which has the extension
  connected. The owner signs in to each site there once, by hand, and the
  browser keeps that login in its cookies on the Mac. Registrars and banks
  still sign people out after a while, so expect to sign in again sometimes.
  Turning the extension off in the owner's other profiles ends the "which
  browser?" question.
- **Being allowed to act on a site** is TCA's job, kept in the site
  permission store described above. Cookies say who the owner is to the
  site. The permission store says what an agent may do there. Neither stands
  in for the other.

### Browsers

- **Pick one browser before acting.** When more than one browser or profile is
  connected, the agent asks the owner which to use. TCA prompts the owner to
  give each profile a clear name ("Work", "Personal") when it's first
  connected.
- **Check the page before acting on it.** After it opens a page, the agent
  confirms the address and that the page is the one it expected. A sign-in
  page, an error or an unexpected site means it stops.
- **On a sign-in page: stop, close the agent's own tab, and tell the owner.**
  Agents never type passwords, codes or payment details. The owner signs in
  himself, or a password manager fills them in after he approves it in its
  own window.
- **Agents only touch tabs they opened.** They open their own tab and close
  it when done, and they leave the owner's tabs alone.

### Actions

- **Look-only tests come first.** Before the first change on a new site, the
  agent reads the current state, for example the existing DNS records, and
  reports it.
- **Changes that can't be undone need the owner's OK every time.** That
  includes saving, deleting, sending, buying and publishing. Granting control
  isn't the same as approving a change. Like the approval cards, the agent
  names the exact change, for example "add A record @ → 185.199.108.153",
  before it makes it.
- **Back doors count as control.** Any tool that can drive an app (scripts in
  a tab, debug ports, AppleScript, accessibility hooks) needs the same grant
  as clicking. TCA lists these tools in the agent's profile and refuses them
  when the profile has no control grant.

### Logging and the agent profile

- Every action is logged with the agent, the app or site, view or control,
  and the grant that allowed it, which in turn records the approval card or
  "Site permissions" entry that created it. Screenshots stay on the device unless
  the owner shares them.
- Each agent profile records which channels it may use: screen tools,
  browser extension, scripts. For an untrusted outside agent, such as Cam,
  that list stays empty. It never gets view or control of the owner's
  devices.

## Driving Mac Apps: Lessons From agent-desktop (November 1)

On November 1, 2026 we studied Vercel Labs' open-source `agent-desktop`
(github.com/vercel-labs/agent-desktop, Apache-2.0), a tool that lets AI agents
read and operate desktop apps through the macOS accessibility layer, the
same one VoiceOver uses. We read its design glossary (`CONCEPTS.md`), its
macOS guide and parts of its macOS code. Nothing was installed or run.

**Owner decision (November 2, 2026, Claude thread "Assess Vercel Labs Agent
Desktop for TCA"):** we take its ideas and write our own Swift version in the
Mac app. We don't add it as a dependency and don't copy its code. That keeps
the owner's open license choice clear, and it keeps the Accessibility grant
inside TCA, where the ceilings above can be enforced.

### Ideas we adopt

- **Read controls, not pictures.** The agent reads the accessibility tree
  (buttons, fields, menus and their names), not screenshots. A screenshot
  needs its own view grant and stays on the device.
- **Labels tied to one look at the screen.** Each control the agent can act
  on gets a short label that only works together with the snapshot it came
  from. Before acting, TCA checks it is still the same control. The app's
  own identifier and a stable name help find it, but they are hints, never
  proof on their own: apps reuse them, for example a recycled list row
  whose "Delete" button now belongs to another item. Right before any
  change, TCA confirms identity with evidence that can't be recycled: the
  same live accessibility object it saw (which TCA keeps a hold on), in the
  same window of the same running app, at the same place in the tree. Text
  that changes, such as what's typed in a field, never proves identity. If
  the control is gone, has changed, or can't be confirmed this way, or more
  than one thing matches, the action is refused, not guessed.
- **Quiet by default.** Actions go through accessibility calls. They don't
  move the pointer, take focus, send keystrokes or touch the clipboard. Real
  mouse and keyboard input is a separate, higher grant. When the quiet path
  can't do something, the action fails and says why. It never quietly
  switches to the loud path.
- **Every action reports whether it landed:** not delivered (safe to retry),
  delivered but not confirmed, or confirmed. The agent confirms by looking
  again, because macOS often reports success when nothing happened. An
  action that may have landed is never repeated automatically, so a message,
  payment or deletion can't happen twice.
- **"Couldn't tell" means no.** Each check is answered yes, no or unknown.
  An unknown answer never allows anything, so a permission check that failed
  to read blocks the action.
- **Password fields stay blank.** For a secure text field, TCA never shows
  or logs its value, even after the owner's password manager fills it in.
  This adds to the Browsers rule: agents still never type passwords.
- **One agent at a time on the keyboard and pointer.** A lock on the Mac
  stops two agents' input from mixing. Each agent can show its own labeled
  cursor, so the owner sees which agent is acting.
- **A trail the owner can replay.** The action log can keep before and after
  snapshots of each step. They hold private screen content, so they follow
  the logging rule above and stay on the Mac.
- **Test against real apps and write down what macOS actually does.** Mac
  behavior is measured, recorded and re-checked after macOS updates, rather
  than assumed.

### Where we go further than agent-desktop

- **TCA holds the Accessibility grant itself.** macOS gives agent-desktop
  the permission of the app that launches it, such as Terminal. From then on
  anything running in that terminal can read and drive every app. TCA asks
  for the grant in its own signed app and enforces the per-app ceilings,
  per-agent approvals and never-controllable apps (password managers, System
  Settings, Keychain) on top of it.
- **"Never" covers using an app, not only quitting it.** agent-desktop
  refuses to quit core system processes and blocks quit shortcuts. TCA also
  refuses to read or act in the never-controllable apps.
- **Screen content stays on the Mac.** agent-desktop's optional helper sends
  goals and screen text to an outside model service. TCA sends screen
  content off the device only under the owner's grant.

## Open Questions for the Owner

1. Is 90 days without use the right point for a remembered site grant to
   lapse?
2. Should TCA build its own browser channel, or rely on vendors' channels
   (Claude in Chrome, Codex's browser) through the agent profiles?
