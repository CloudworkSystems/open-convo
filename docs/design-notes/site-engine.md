# Design Note: Site Engine

Written October 13, 2026 by the planning session, from a conversation with the
owner. Status: module plan; building starts after the Top Five.

## What It Is (Owner Decision, October 13)

A True Convo feature that builds and maintains simple websites **for True Convo
users**, with the **owner's own businesses as its first customer**. It replaces
the "one-page website" item in the first creator beta; there is one website
feature, not two. Client sites built as agency work (GoHighLevel) stay separate.

## What Carries Over From the Old Prototype

The archived prototype (`cloudwork_systems/true_convo/site_engine`, "Cloudwork
Living Sites") is broken and was never published, but two ideas carry over:

- **One public-facts sheet per business.** The site is built from it, and when a
  fact changes (hours, prices, services), the site is updated from the sheet.
- **A privacy gate.** Private notes, memory and working context can never reach
  a public page. Every page is checked against the public-facts sheet before
  publishing.

## Where Sites Live (Owner Decision, October 13)

- **Export, plus one-click publish to the person's own free hosting account**
  (Cloudflare Pages, which the prototype was built around, or similar). The site
  stays theirs; no True Convo account and no hosting fee.
- **Nothing goes public without approval:** every publish shows a preview and
  waits for the person's OK. Credentials for the hosting account live in
  Keychain.
- True Convo hosting sites itself is a possible later subscription feature, not
  a starting point.
- The same free host may also serve the Desk's private review copy (an open
  question in `PLAN.md`).

## First Deliverable

A one-page site for one of the owner's businesses (owner picks which), built
from its public-facts sheet, previewed in the Desk, exported, and published to
the owner's own hosting account after approval.

## Rules

- Build from the public-facts sheet only; the privacy gate blocks anything else.
- The person can always export the whole site and leave.
- No tracking or analytics without the person's choice.
