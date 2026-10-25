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
  - covers one agent profile, one site (for example `ap.www.namecheap.com`)
    and one level (view, or view and control). Another agent, another site or
    a higher level asks again;
  - is kept by TCA on the device in its own permission store, not in browser
    cookies or the cache, which websites can read or clear. It never syncs to
    another device unless the owner turns that on;
  - shows in a "Site permissions" list where the owner can see and remove each
    grant, and that list is the only place a grant can be added outside an
    approval card;
  - lapses after 90 days without use (the number is a starting point), and is
    dropped at once when the agent profile changes its model, harness or
    channels;
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
  and the approval card it came from. Screenshots stay on the device unless
  the owner shares them.
- Each agent profile records which channels it may use: screen tools,
  browser extension, scripts. For an untrusted outside agent, such as Cam,
  that list stays empty. It never gets view or control of the owner's
  devices.

## Open Questions for the Owner

1. Is 90 days without use the right point for a remembered site grant to
   lapse?
2. Should TCA build its own browser channel, or rely on vendors' channels
   (Claude in Chrome, Codex's browser) through the agent profiles?
