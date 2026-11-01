# Front Porch API, First Slice

Status: Draft (Nov 1, 2026): planning approved by the owner; building and
going live each need his separate OK.

Written November 1, 2026 by the Claude thread "Get ready for Meta AI
Connectors". Builder: that Claude thread. Reviewers: Codex, plus Gemini (or a
fresh Claude review until Gemini posts reviews), as the Review Loop in
AGENTS.md sets out. Design background: the public side in
[back-end-and-agent-hosts.md](../design-notes/back-end-and-agent-hosts.md).

## Why

Meta's two connector programs (Meta AI Connectors, and the Muse Connector
Platform behind Muse) connect to a service that answers over the internet.
Today True Convo runs only on the owner's Mac, so on Meta's form we can
only answer "Planning stage (concept only)". This slice gives us the
smallest honest service: one that answers questions about True Convo from
public text we write. It is the first piece of the public side the design
note describes, not a one-off.

## What It Is

A small read-only web service at `https://api.trueconvo.com` that answers
with public information about True Convo, in two forms:

1. **REST**, described by an OpenAPI file:
   - `GET /v1/about`: what True Convo is, in a few sentences.
   - `GET /v1/features`: the feature list, each with a status of "available",
     "in development" or "planned".
   - `GET /v1/faq` and `GET /v1/faq?q=<words>`: the FAQ, optionally filtered
     by matching words.
   - `GET /v1/privacy`: the privacy promises, linking to
     trueconvo.com/privacy.html.
   - `GET /v1/status`: how far along development is.
   - `GET /v1/updates`: dated update notes, newest first.
   - `GET /openapi.json`: the OpenAPI description itself.
2. **MCP** at `POST /mcp` (Streamable HTTP), with the same read-only tools
   (`about`, `features`, `faq`, `privacy`, `status`, `updates`), since Meta's
   connectors are MCP-based.

All answers come from one **public content file**,
`services/front-porch/content.json`, checked against a schema in the same
folder. Changing an answer is a pull request that changes that file, under
the normal review loop.

## What It Is Not

- No connection to the owner's Mac, to the True Convo app, or to anyone's
  conversations or memory. The public side and the private side never share
  a store (design note).
- No user accounts, sign-in, OAuth, forms, sign-ups or stored data. No
  database or Cloudflare storage (KV, D1, R2). The content file is bundled
  into the deploy.
- No AI model runs here, so there are no model bills.
- No secrets in the service: it needs none.

## Hosting And Portability

- **Host:** Cloudflare Workers on the **free plan** (100,000 requests a day;
  at the limit it stops answering rather than billing). The domain's DNS is
  already at Cloudflare, so `api.trueconvo.com` is a Workers custom domain.
- **Portable by rule** (owner's condition, Nov 1): the service is one
  standard `fetch(request) -> Response` handler using only Web-standard APIs.
  It imports nothing Cloudflare-specific. A tiny Node 22 entry point runs the
  same handler, which the tests use, so moving to another host (a small VPS,
  Deno Deploy, Fly.io or similar) means a new entry point and DNS change, not
  a rewrite.
- **Deploys:** a GitHub Actions workflow deploys from `main` only, when
  `services/front-porch/**` changes, using a Cloudflare API token limited to
  editing this one Worker, stored as an environment secret (below). The owner creates
  that token and the Cloudflare account settings; no agent signs in to
  Cloudflare. The workflow lives under `.github/`, so the owner approves it.
- **Every deploy needs the owner (requirement).** Approving the workflow once
  must not let later content changes publish on their own. Two gates, both
  required:
  1. The deploy job runs in a GitHub environment (`front-porch-production`)
     whose required reviewer is the owner's account, and the Cloudflare token
     is an environment secret, not a repository secret. Each deploy waits
     until the owner approves that run on GitHub.
  2. The code pull request adds `services/front-porch/` to
     `.github/CODEOWNERS`, so every change to the service or its content
     also needs the owner's approval before it can merge.

## Safety Rules (Requirements)

- Only `GET` on the REST paths and `POST` on `/mcp`; anything else gets 405.
- Query text is capped at 200 characters and only used to filter the FAQ.
  It is never echoed back inside HTML. Responses are JSON only.
- MCP requests over 16 KB are refused. Only the listed read-only tools exist.
- Zero trust toward callers: what Meta or anyone else sends is untrusted
  input; what we return is read by their models, so content stays factual
  and contains no instructions to a model.
- No logging beyond Cloudflare's default request metrics; the service writes
  no logs of its own.
- The content file says nothing about features the app doesn't have,
  labeling each one with its real status.
- **Abuse guard for the daily quota.** One caller must not be able to use up
  the 100,000 free requests a day. A Cloudflare rate limiting rule on
  `api.trueconvo.com` (the free plan includes one, with a 10-second counting
  period and a 10-second block) blocks any single IP address that sends more
  than 10 requests in 10 seconds. Blocked requests stop at
  Cloudflare's edge before they reach the Worker, so they don't count toward
  the quota. The rule lives in the Cloudflare settings, not in the code, so
  the service stays portable; on another host, that host's equivalent limit
  takes its place. The REST answers also send `Cache-Control: public,
  max-age=300` so well-behaved clients and proxies reuse them.
- If the quota still runs out (for example, many callers at once), the
  service stops answering until the daily reset and nothing is billed.
  Moving to a paid plan or another host is the owner's call, never automatic.

## Server Security Controls (Requirements)

[security.md](security.md) section 3 makes these required for any server we
run. How each applies here:

- **Login by a proven provider; sessions that expire and can be revoked:**
  not applicable, because the service has no accounts, sign-in or sessions.
  Adding any of them needs a new plan.
- **Validation of every input:** the method, path, query and MCP body rules
  in Safety Rules above, each covered by a test.
- **Rate limits:** the abuse guard above.
- **Security headers** on every response, checked by a test:
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
  `Strict-Transport-Security: max-age=31536000`.
- **Errors without stack traces:** every error is a short JSON body with a
  status and a fixed message; a test forces an internal error and checks
  that no stack trace or file path comes back.
- **Logs without personal data:** the service writes no logs of its own.
- **Backups with a tested restore:** the only data is `content.json` in Git;
  restoring means redeploying from `main`, which the first deploy proves.
- **OWASP ZAP scan against staging before launch:** a ZAP baseline scan runs
  in CI against the Node entry point, and once more against the deployed
  Worker on its `workers.dev` address before `api.trueconvo.com` is
  attached. That address is the staging step; the scan must pass with no
  medium or high alerts.
- **No public side door after staging.** The `workers.dev` address isn't
  covered by the rate limiting rule on `api.trueconvo.com`, so the
  production deploy configuration turns it off (`workers_dev = false`, and
  preview URLs off) once the scan passes. From then on the Worker answers
  only at `api.trueconvo.com`.

## Before It Goes Live

1. The owner's OK to build (a separate yes from this plan).
2. The privacy policy on trueconvo.com gains a short section on the API,
   before it takes traffic, as the policy already promises.
3. The owner creates the empty Worker (`front-porch`) in the Cloudflare
   dashboard first, because a token limited to one Worker can only point at
   a Worker that already exists. Then he creates the API token with Edit
   access to that one Worker only, adds it as a secret of the
   `front-porch-production` environment (with himself as required
   reviewer), and approves the deploy workflow and the CODEOWNERS line.
4. The rate limiting rule is in place on `api.trueconvo.com` (the owner adds
   it in Cloudflare, or a session on his Mac does with his OK).
5. The owner's OK to go live.

## Finish Line

- `npm test` in `services/front-porch` passes in CI: each REST path, the MCP
  `initialize`, `tools/list` and `tools/call` flow, the 405 and size limits,
  and a check that `content.json` matches its schema.
- `openapi.json` validates as OpenAPI 3.1.
- After going live, `https://api.trueconvo.com/v1/about` answers, and an MCP
  client lists and calls the tools.
- After going live, a burst of more than 10 requests in 10 seconds from one
  address gets blocked (HTTP 429) while other callers still get answers.
- The server controls in [security.md](security.md) section 3 ("Any server
  we run") are met, as set out in Server Security Controls above, including
  a passing OWASP ZAP baseline scan before the custom domain is attached.
- After going live, the Worker's `workers.dev` address no longer answers.
- STATUS.md lists the service and its state.

## After This Slice

Meta's forms can then honestly say "functional but in beta / testing", with
the API docs link pointing at a docs page on trueconvo.com generated from
`openapi.json`. Anything that touches a user's data (account linking, the
Messenger bot) needs its own plan and the user's one-time approval
(principle 6).
