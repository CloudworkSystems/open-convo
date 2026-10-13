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

## Design Capabilities (Owner Decision, October 13)

Site Engine uses **Impeccable** (design audit and polish) and **ScrollCraft**
(scroll-driven pages) as True Convo capabilities, not as AI-program skills. See
`capabilities-and-primitives.md`.

## First Deliverable

A one-page site for one of the owner's businesses (owner picks which), built
from its public-facts sheet, previewed in the Desk, exported, and published to
the owner's own hosting account after approval.

## Open Questions (Decide When Site Engine's Turn Comes)

The owner chose to settle these later, once the Desk and real conversations
exist to react to. Suggested starting answers are noted, not decided.

1. **Kinds of sites.** Suggested: one-page first; end state multi-page plus a
   blog fed by Convo Engine. Booking and selling are later add-ons (payments,
   calendars, customer data).
2. **How the design is chosen.** Templates, the person's brand kit,
   AI-generated options, or a mix.
3. **How people edit.** By conversation ("change our hours to 9 to 5"),
   clicking on the page, marking it up as the owner does in Codex, or all three.
4. **How the public-facts sheet is filled.** An interview, importing an
   existing site or Google listing (shared with the Visibility Agent), dictation.
5. **Forms and booking.** Where contact-form messages go (for example, the
   business's space in True Convo).

Defaults unless the owner says otherwise:

- Custom domains: guided steps to connect a domain bought from any registrar;
  True Convo never sells domains.
- Search and AI visibility built in: titles, structured data, sitemap.
- Every site works on phones and passes basic accessibility checks.
- Analytics off unless the person turns on a privacy-friendly option.
- The builder produces plain website files, so export always works; the tools
  that build them are the building session's choice.
- Several sites per person, one per business.

Decided now because it touches the core: each business's public-facts sheet
lives in that business's own memory space (step 5).

## Rules

- Build from the public-facts sheet only; the privacy gate blocks anything else.
- The person can always export the whole site and leave.
- No tracking or analytics without the person's choice.
