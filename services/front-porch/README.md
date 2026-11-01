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

## Run it

Needs Node 22 and nothing else (no dependencies).

```sh
npm test
npm start   # http://127.0.0.1:8787/v1/about
```
