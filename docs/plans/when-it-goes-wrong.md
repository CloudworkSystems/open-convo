# When It Goes Wrong: A Check For Every Screen

Status: Approved (Nov 1, 2026): owner's yes in thread "Add a when-it-goes-wrong review check" ("ok", Nov 1, 2026); not started.

Written November 1, 2026 at the owner's request ("sure", to a draft offered in
the same thread). **Builder:** Claude (cloud, `cloudwork-bot`) writes this
plan and the two rules lines below; every builder then follows it.
**Reviewers:** Codex, plus the usual independent review. **Finish line:** this
pull request merges on the owner's quoted yes, and the next plan for a screen
the owner sees has a "When it goes wrong" section whose answers turn into
checks in its owner trial (then the status becomes Built).

## Why

Our plans spell out what a screen does when everything works. They rarely say
what it does when something doesn't, and nobody checks that before a build is
called done. The owner trials of October 31 found that gap the hard way:

- A normal quit while a reply was streaming lost the text (step 3, F11).
- The recovery-key boxes gave no sense of progress or of the rule about
  spaces (step 2, F1).
- The Keychain prompt from the menu bar icon took no typing, and with no other
  menu the app couldn't be quit or reach Archive History (step 2, F2 and F3).
- Crash recovery kept the right text but explained itself in words like "run"
  and "prefix", and hid the way to Retry (step 3, F12).

None of these are rare. They are what happens on an ordinary day. The idea
came from a post the owner saved: "Your product works when everything goes
right. The real test is what it does when nothing does."

## The Five Questions

Every screen or flow the owner sees answers these, in plain words:

1. **No connection.** What does it show when the internet, a service it needs
   or a local model isn't there? Does it keep what the owner already did?
2. **Interrupted.** If the owner quits, the app crashes or the Mac sleeps
   midway, what is kept and what does the next launch show?
3. **Empty or first run.** What does it show before there is anything in it,
   and does it tell the owner the first thing to do?
4. **Denied or stuck.** If a permission or password prompt is refused or
   won't respond, can the owner still get out (quit, go back, close) and try
   again later?
5. **The error message.** When something fails, does the message say what
   happened and what to do next, without code words?

"Doesn't apply" is a fine answer when it's true, with one line saying why.

## Where It Goes

- **Plans.** A plan that adds or changes a screen the owner sees has a short
  "When it goes wrong" section answering the five questions for that screen.
  Rule added to [AGENTS.md](AGENTS.md) in this folder.
- **Owner trials.** Each answer that describes behavior becomes one check in
  that step's trial checklist, so the owner tries the bad day too, not only
  the good one.
- **Code pull requests.** The builder builds what the plan's section
  promises, with a test where one is practical (the scripted kill-mid-reply
  proof is the model for question 2).
- **Reviews.** One line in the root Review Guidelines: when a plan's "When it
  goes wrong" section promises a behavior and the code leaves it out, that is
  a broken promise in the plan, which is already a P1. A failure state the
  plan never mentioned is a P3 at most, so this check can't restart the long
  review loops the guidelines were written to stop. The cap never lowers a
  finding that is P0 or P1 on its own terms: losing data, leaking private
  information, spending money or opening a security hole stays P0 or P1
  whether or not the plan mentioned it.

## Not In Scope

- No new tool, service or cost. It's a habit written into the rules.
- Plans already Approved or In progress aren't rewritten. Each gets the
  section when it is next revised, as the folder rules already say.
- The open trial findings (F1 to F3, F11, F12) are fixed in their own work,
  not here. Their fix plans are the first natural place to use the section.
