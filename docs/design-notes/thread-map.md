# Design Note: Thread Map In Cloudwork Nexus

Written October 30, 2026 at the owner's request. Status: direction, not
planned or built. A plan in `docs/plans/` comes first when it is built.

## Where It Came From

The owner runs many Claude threads inside one claude.ai project. The project
sidebar lists them by recent activity only, with no way to group them. On
October 26 a thread built a stand-in: a private page (an Artifact) that sorts
every thread into sections the owner names, shows each one's state (needs
you, working, ready to review, done) and links each row to what the thread
produced, such as a pull request or a published page.

The owner wants the same surface inside True Convo, as a view in the
Cloudwork Nexus module next to Nexus Navigator, Canvas, Atlas and the Rail
Map. It's an early version of Nexus Navigator's grouping.

## What The View Must Do

1. **Group by the owner's intent.** The owner names the sections and moves
   threads between them. Agents may suggest a section for a new thread. The
   owner's choice wins and is never overwritten by a suggestion.
2. **Every row opens where the work lives** (owner, October 29). A row opens
   the conversation itself, and each output it produced gets its own link:
   the pull request, the page, the document. The stand-in page couldn't link
   to threads, because a page has no way into the claude.ai thread view. The
   True Convo view must not have that gap.
3. **Show what needs the owner first.** Within each section, conversations
   waiting on the owner come first, then working, then ready to review, then
   done. Closed ones can be hidden.
4. **Stay current without anyone refreshing it** (owner, October 30). The
   view reads from live sources. It never shows a hand-made list:
   - True Convo's own conversations and agent runs are read from the app's
     own data, so they're current as they change.
   - Pull request state comes from GitHub, polled by the app on the owner's
     device on a schedule, with the time of the last update shown on the
     view. A webhook would need a server of ours to receive it, and the
     private side has none (`back-end-and-agent-hosts.md`), so polling it is.
   - Outside sources with no API or webhook (a claude.ai project today) get
     refreshed by a scheduled agent, and the view shows how old each
     source's data is.

## Privacy

Thread titles and section names are the owner's private working notes. They
stay on the owner's devices and in his private iCloud, like his other
conversations (decided October 22 and 25, `docs/decisions.md`). They never go
to a server of ours, including the public side, and never into this
repository, which is public. Unlike the Rail Map's saved snapshot
(`apps/desk/src/content/rail-map.json`), the thread map's data is never
committed. Tests use invented threads.

## Until It's Built

The stand-in page stays the owner's view. A scheduled task in its thread
refreshes it once a day. It reads the project's threads, pull requests and
pages, re-sorts them and republishes the page.
