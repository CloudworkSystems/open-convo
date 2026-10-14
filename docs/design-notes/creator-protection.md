# Design Note: Creator Protection (Module Idea)

Rewritten October 13, 2026 by the planning session from True Convo's
`docs/2026-09-30-creator-protection-idea.md` (commit `c527e36`). Status: idea
only; nothing built. A subscription module, not open core. **Every fact about
Meta's tools below was gathered September 30 to October 2, 2026 and must be
rechecked on Meta's own current pages before anything is built.**

## What The Owner Wants

True Convo helps creators go from "I can attract an audience" to "my audience
helps my well-being" (money, mental clarity) without being scammy. One piece:
protecting creators from accounts that steal their videos and pose as them to
collect donations. Fake accounts on Facebook and Instagram re-post a creator's
videos with their own donation links, and followers send money to the fakes.

The owner also wants, later, a Meta-approved app so True Convo can help run a
creator's own profile, and ideally catch impersonators with Meta's developer
tools.

## What Existed (Recheck Before Building)

| Tool | What it does | Who can use it |
| --- | --- | --- |
| Meta Rights Manager | Finds matching videos on Facebook and Instagram; block, track or claim | Apply; approval at Meta's discretion |
| Meta content protection (mobile, Nov 2025) | Finds reposts of eligible original Reels and alerts the creator | Creators in Facebook's paid creator program meeting originality rules, or Rights Manager users |
| Impersonator detection (Meta testing, March 2026) | Detecting accounts impersonating creators | Availability unconfirmed |
| Meta Verified (paid) | Badge, support, proactive impersonation monitoring; no promise to remove every copy | Eligible creators who pay |
| Impersonation reports | In-app reports by anyone; the dedicated form is for the person impersonated or their representative, and Meta may ask for ID | ID goes straight to Meta, never through True Convo |
| Instagram API (approved apps) | For the creator's own professional account: publish, stats, comments, mentions | Meta app review required |
| IP reporting API | Report copyright or trademark violations through code | Eligible rights holders; covers stolen content, not fake accounts |
| ReportFraud.ftc.gov, IC3.gov | Government scam reports | Anyone scammed |

Not found: any public developer interface that searches Facebook or Instagram
for fake accounts or reports them through code.

## Can The Impersonator Scanner Be Built On Meta's Tools?

Not directly. Nearest options:

- **Brand Rights Protection,** a Meta website (not a developer interface) where
  approved brands search for impersonation and report in bulk. Reported to
  require a Meta Business account and a registered trademark (unconfirmed). A
  creator who trademarks their name might qualify.
- **IP reporting API** for stolen videos, if the creator qualifies as a rights
  holder.
- **Meta Content Library API** is for approved nonprofit and academic
  researchers only.
- **Instagram API lookups** find a specific business or creator account by
  username; no look-alike search, no personal accounts, no reporting.
- **Scraping** breaks Meta's terms and would put app approval and accounts at
  risk. Not an option.

## Candidate Features

1. **Protection setup guide:** apply for Rights Manager, turn on content
   protection, decide on Meta Verified and a trademark.
2. **One official link:** a single donation link the creator confirms,
   repeated in bio, captions and every video ("my only link is ...").
3. **Report helper:** gather fake-account links and draft each report; the
   creator or their representative sends them.
4. **Follower warning kit:** posts and pinned comments that warn followers
   without sounding like a scam.
5. **Profile helper via an approved app,** later, acting only on the creator's
   own account; builds on the Convo Engine.
6. **Stolen-video reporting** through the IP reporting API, for qualifying
   creators.

## Owner Decisions (October 2, 2026)

- The setup guide, report helper, official link with follower warnings, and
  stolen-video reporting all matter.
- Brand Rights Protection: the owner checks Meta's live form himself, with an
  agent guiding; his login never passes through an agent.
- Meta app approval: not yet. Revisit once a feature needs it.

## Guardrails And Open Questions

- Meta app review likely means business verification tied to a real identity;
  ask the owner before starting.
- Decide deliberately how much access True Convo gives Meta and how much Meta
  gets from True Convo.
- Followers' data and any ID a creator shows Meta are private data from day
  one; neither passes through or is stored by True Convo.
- No creator is contacted, and no one's content is used, without the owner's
  decision.

## Sources (As Of October 2, 2026)

- [How Meta protects IP rights](https://transparency.meta.com/reports/intellectual-property/protecting-intellectual-property-rights/)
- [Rewarding original creators on Facebook (Meta, March 2026)](https://about.fb.com/news/2026/03/rewarding-original-creators-on-facebook/)
- [Meta Verified announcement](https://about.fb.com/news/2023/02/testing-meta-verified-to-help-creators/)
- [Instagram impersonation report form](https://help.instagram.com/contact/636276399721841)
- [Instagram API overview](https://developers.facebook.com/docs/instagram-platform/overview/)
- [About Brand Rights Protection (Meta)](https://www.facebook.com/business/help/828925381043253)
- [IP Reporting API and Brand Rights Protection (Meta)](https://www.facebook.com/business/news/ip-reporting-api-brand-rights-protection-new-features)
- [Meta Content Library tools for researchers](https://about.fb.com/news/2023/11/new-tools-to-support-independent-research/)
- [ReportFraud.ftc.gov](https://reportfraud.ftc.gov/)
