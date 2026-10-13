# Design Note: Visibility Agent

Written October 13, 2026 by the planning session, from a conversation with the
owner. Status: module frame; details are decided when its turn comes (after the
Top Five).

## What It Does (Owner Decision, October 13)

Two parts, together:

1. **The checkup as an agent.** Given a business, it gathers the public picture
   (website, Google business listing, reviews, directory listings) and produces
   a plain-English report with a short, prioritized fix list. This automates the
   finished, independently checked checkup from the archived folder
   (`cloudwork_systems/louder_locally/customer-zero/local-visibility-checkup`),
   which is the starting template.
2. **AI visibility.** It checks how the business shows up when people ask AI
   assistants (ChatGPT, Claude, Perplexity and others) the questions customers
   ask, and suggests what would get the business mentioned accurately.

**Later:** ongoing watch over reviews, mentions and rankings, once a first report
gives a baseline to compare against (close to the old "listening module" idea).

## Who Uses It (Owner Decision, October 13)

Both **True Convo users checking their own business** and **the owner, for agency
work**. The owner's own businesses are the first ones checked.

## How It Connects

- **Site Engine** fixes what the report finds on the website, from the same
  public-facts sheet (one per business, in that business's memory space).
- **Convo Engine and the content module** write the fixes that need words:
  descriptions, posts, review replies.
- It is an agent profile like any other (see `agent-profiles-and-adapters.md`):
  it prepares the report and fixes, and nothing is published, sent or changed
  without approval.

## Open Questions (Decide When Its Turn Comes)

- **Where data comes from.** Some sources need the business owner's sign-in (for
  example, their own Google business listing); others are public pages. Respect
  each site's terms; no scraping that breaks them.
- **Cost of AI-visibility checks.** Asking several AI assistants many questions
  costs money through their APIs. Use approved routes with caps, and a local
  model wherever it can do the job.
- **Report format.** In the Desk, exported as a PDF, or both.
- **Agency side.** Pricing, client spaces kept separate from the owner's own,
  and what a client may see.
- **Competitors.** Whether and how reports compare a business with nearby
  competitors, using public information only.

## Rules

- Public information only, unless the business owner connects their own
  accounts.
- Every claim in a report links to where it was found and when, so stale facts
  are visible (the archived checkup's facts went stale while it sat unsent).
- Nothing is sent to a client or published without the owner's approval.
