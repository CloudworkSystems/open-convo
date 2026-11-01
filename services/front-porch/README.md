# Front Porch

A small read-only web service that answers questions about True Convo from
public text, for Meta's connector programs and any other AI assistant. The
plan, its safety rules and its finish line are in
[docs/plans/front-porch-api.md](../../docs/plans/front-porch-api.md).

It is not live yet. Going live needs the owner's Cloudflare setup and his
separate OK (the plan's "Before It Goes Live").

## What's here

- `content.json`: every answer the service gives. Changing an answer is a
  pull request that changes this file. `content.schema.json` describes it.
- `openapi.json`: the OpenAPI 3.1 description of the REST paths.
- `src/handler.js`: the whole service as one Web-standard
  `fetch(request) -> Response` handler. It imports nothing host-specific.
- `src/mcp.js`: the MCP tools (`about`, `features`, `faq`, `privacy`,
  `status`, `updates`) over Streamable HTTP at `POST /mcp`, stateless and
  read-only.
- `src/worker.js`: the Cloudflare Workers entry point.
- `src/node-server.js`: a Node 22 entry point running the same handler.
- `wrangler.toml`: the Worker's settings. Ordinary deploys use the
  production settings (workers.dev off); `[env.staging]` turns workers.dev on
  for the one staging scan. Neither sets routes or custom domains.
- `scan/`: the OWASP ZAP API scan (`zap-scan.mjs`, needs Docker) and its ZAP
  hooks, which add the recorded MCP exchange.

## Run it

The service has no dependencies. The dev tools (the Wrangler bundler and the
OpenAPI validator) are pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm test
npm start   # http://127.0.0.1:8787/v1/about
node scan/zap-scan.mjs http://127.0.0.1:8787   # with the server running
```

## Deploying

Only `.github/workflows/front-porch-deploy.yml` deploys, from `main`, and each
run waits for the owner's approval in the `front-porch-production`
environment. It needs, in that environment:

- the owner as required reviewer (the job checks and refuses without it),
- the secret `FRONT_PORCH_CLOUDFLARE_TOKEN`: an API token with Edit access to
  the `front-porch` Worker only, created after the empty Worker exists,
- the variable `FRONT_PORCH_CLOUDFLARE_ACCOUNT_ID`.

A manual run with `staging_url` set to the Worker's workers.dev address
deploys the staging settings and runs the ZAP scan against that address. It
is refused once `api.trueconvo.com` answers. The owner attaches
`api.trueconvo.com` in the Cloudflare dashboard only after that scan passes;
the next ordinary deploy turns the workers.dev address off again.
