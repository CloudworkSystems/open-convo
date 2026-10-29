# Design Note: Browser Assistant Lessons From Brave Leo

Written October 29, 2026 by a Claude session (project "261024 OC Steering",
thread "Learn from Brave Leo for our browser") after the owner pointed at
Brave's Leo. He doesn't want to integrate Leo. What caught his eye is that Leo
can run on a local model underneath a browser assistant, which is close to
what True Convo plans: an inline browser
([inline-browser-annotation.md](inline-browser-annotation.md)) with an
observability layer the person can switch on to make it more useful, never
as unwanted surveillance. Status: reference only. It adds no requirement and
authorizes no build.

Sources: Brave's blog and support pages as of late 2025 (listed at the end),
read through web search, since brave.com isn't reachable from the cloud
session. Leo changes often, so recheck a detail before a plan relies on it.

## How Leo Works, In Brief

- **Bring your own model.** Settings, Leo, "Bring your own model": a label,
  the model's name, an endpoint and an optional API key. Any
  OpenAI-compatible server works, so Ollama on the same computer is just
  `http://localhost:11434/v1/chat/completions` with no key. The local model
  then shows up in Leo's normal model menu. Brave says requests to your own
  endpoint skip Brave's servers entirely. It has been on every desktop
  install since version 1.69 (August 2024).
- **Brave's own models.** Requests go through a reverse proxy so Brave can't
  tie them to an IP address, no account is needed for the free tier, and the
  paid tier uses tokens that Brave says can't be linked to the person's
  usage. Brave says conversations aren't kept on its servers. These are
  policy promises, and nobody outside Brave can check them.
- **What it sees of the page.** Leo reads the page or video in front of the
  person when they ask (summarize, ask about this page). It doesn't watch
  in the background. Recent versions add "memories" that it can recall later.
- **Agentic browsing (testing since December 2025).** It is off unless the
  person turns on a flag. It runs in a separate browser profile with no
  access to the person's cookies, logins or cache. Every action is shown,
  risky steps wait for the person's approval, and a second model checks each
  action against what the person asked for. Brave itself calls agentic
  browsing "inherently dangerous" and says these guards reduce prompt
  injection but don't remove it. Brave earlier showed hidden page text
  hijacking Perplexity's Comet browser.

## Worth Borrowing

1. **A local model is just another entry in the picker.** We already have this
   shape: the Ollama route with `qwen3:8b` and a model picker (STATUS.md, step
   3). The browser assistant should use the same picker and the same routes,
   not a second model setup of its own. Like Leo, a route is defined by where
   its requests go, and the picker says so in plain words ("stays on this
   Mac", "goes to Anthropic"). Page content defaults to the local route.
2. **Page context is per question and visible.** Nothing on a page is read
   until the person asks something about it. When it is, the page shows as an
   attachment on the message that they can remove before sending. That fits
   the annotation flow, where the person already chooses the text or region
   they mean.
3. **Agents that act get their own browser profile.** When an agent drives
   the inline browser, it gets a fresh profile with no owner cookies,
   sign-ins or history. This adds to the site permissions in
   [computer-use.md](computer-use.md), it doesn't replace them. Signing in
   stays a step the person does themselves.
4. **A second model checks the first.** Before an agent's browser action
   runs, a separate check asks whether it matches the task the person
   approved. A local model can do this cheaply. It doesn't replace the
   approval card, and it never approves anything itself.

## Pitfalls To Avoid

- **"Local" has to be checked, not trusted from a label.** A BYOM-style entry
  can point at any server. True Convo marks a route "stays on this Mac" only
  when its endpoint really is on the Mac (a loopback address), and treats
  every other endpoint as sending data off the device, whatever it's called.
- **Page text is untrusted input.** Everything on a page is data, never
  instructions (as in AGENTS.md and agent-profiles-and-adapters.md). A small
  local model resists prompt injection worse than a large cloud one. So the
  local model reading a page gets no tools and can't act: it answers, and
  any action goes through the approval card.
- **Small models have small windows.** A long page won't fit in an 8B
  model's context. When page text gets cut, the reply says so instead of
  answering as if it read the whole page.
- **Don't make promises nobody can check.** Leo's no-retention promise for
  cloud models can't be verified from outside. True Convo's privacy should
  rest on design the person can see: on-device by default, and a named
  destination for anything that leaves.
- **Keep asking separate from watching.** Leo reads a page only when asked.
  The observability layer (the time mirror plan, PR #179) collects daily
  totals in the background. Keep the two apart: what the browser assistant
  reads to answer a question is never written into the time history, and the
  observability layer never keeps page text, URLs or titles without their own
  separate consent, the same rule the time mirror sets for its slice 2.

## When This Becomes A Feature

These points become requirements in the inline browser's plan when that
plan is written (PLAN.md, item 11). Nothing here changes the build order.

## Sources

- Brave, "Bring Your Own Model (BYOM): using Brave Leo with your own LLMs":
  https://brave.com/blog/byom-nightly/
- Brave Help Center, "How do I use the Bring Your Own Model (BYOM) with Brave
  Leo?": https://support.brave.app/hc/articles/34070140231821
- Brave, "The future of Leo" (roadmap): https://brave.com/blog/leo-roadmap/
- Brave, "Agentic Browser Security: Indirect Prompt Injection in Perplexity
  Comet": https://brave.com/blog/comet-prompt-injection/
- Privacy Guides, "Brave adds experimental agentic AI browsing feature"
  (December 12, 2025):
  https://www.privacyguides.org/news/2025/12/12/brave-adds-experimental-agentic-ai-browsing-feature/
