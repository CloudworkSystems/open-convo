# Design Note: Back End And Agent Hosts

Written October 25, 2026 at the owner's request, and agreed by him the same
day (`docs/decisions.md`, October 25). Status: direction agreed, nothing built
or signed up for. Any server below gets its own plan in `docs/plans/` before
it is built.

"Server" covers two separate questions here, and they stay separate so that a
convenience for building True Convo never turns into something each user's
True Convo depends on:

1. **The product's back end:** what each user's True Convo relies on.
   Foundations principles 6 (local first, visible cloud) and 19 (the safety
   floor) govern it.
2. **Agent hosts:** where the agents that build True Convo do their work.
   AGENTS.md governs it.

## 1. The Product's Back End

True Convo needs almost no server of the project's own, on purpose. Only the
public side below needs one.

| Piece | Server of ours? | When | Handled by |
| --- | --- | --- | --- |
| Sync between Mac and iPhone | No | Public launch | CloudKit, each user's private iCloud database (decided October 22) |
| Start on iPhone, continue on Mac | No | Public launch | The same CloudKit sync |
| Wake-ups and notifications | No | Public launch | CloudKit change subscriptions and Apple push |
| Sign-in and user accounts | No, at launch | Revisit for Windows and Android | The user's Apple ID through iCloud; no True Convo account |
| Subscription and entitlement | No, if sold through the App Store | Public launch | StoreKit; a license server only for sales outside the App Store |
| App updates outside the App Store | Static files only | First public build | An update feed on static hosting |
| Model calls | No | Now | Local models, or the user's own provider keys (principle 16) |
| Publishing sites | No | Site Engine | The user's own hosting account ([site-engine.md](site-engine.md)) |
| Front porch: Meta AI connector, Messenger bot | **Yes** | When Meta accepts the early-access application; the Messenger bot can start any time | The public side, below |
| Business phone callbacks | Yes | With that module ([business-phone.md](business-phone.md)) | The public side |
| Public marketplace | Yes | After launch, with its own approved plan | The public side |
| Crash reports | Optional | After launch | Opt-in only; the owner chooses a third party or none |

### The Public Side

The front porch for Meta is the start of a public side, not a one-off. More
public uses will follow, and a public marketplace would be the largest. Each
joins the public side instead of becoming a separate server.

| Public-side use | What it adds |
| --- | --- |
| Meta AI connector, Messenger bot | A public HTTPS endpoint and sign-in by OAuth; no database |
| Business phone | Real-time callbacks from a phone provider |
| Public marketplace | Seller and buyer accounts, a database of listings, payments and payouts, reviews, moderation, terms of service |

Rules for the public side:

- **The public side and the private side never share a store.** Private
  memory and conversations stay on the user's devices and in their iCloud.
  The public side holds only what someone chose to publish, sell or link, so
  a breach there can't reach private memory. Marketplace accounts are separate
  from anyone's private True Convo data.
- **Zero trust toward what comes in.** Whatever Meta or another platform sends
  is untrusted input, and whatever the public side returns to Meta is read by
  Meta's model (the zero-trust baseline in
  [agent-profiles-and-adapters.md](agent-profiles-and-adapters.md)).
- **A user's data reaches it only after that user's one-time host approval**,
  showing first what will be sent (principle 6).
- **Hosting:** prototype on a separate exe.dev VM of its own, which has an
  HTTPS address and holds no repository token or other agent credentials.
  Run the real service on a serverless host such as Cloudflare Workers, so it
  doesn't depend on one development machine staying up. The host choice goes
  in the public side's plan.
- Spending, publishing, accounts and payments each still stop for the owner
  (principle 1, AGENTS.md "Limits").

## 2. Agent Hosts

Every cloud home the project uses today is tied to one vendor's models:
GrokBot to Cursor, Claude's cloud sessions to Anthropic, Codex's cloud to
OpenAI. An exe.dev virtual machine gives any model's agent (Codex CLI, Gemini
CLI, Pi, open models, exe.dev's own agent Shelley, Claude Code) the same
workflow: clone the repository, work as `cloudwork-bot`, follow AGENTS.md and
open a pull request. In the terms of the agent profiles note, role, model and
harness stay separate, and the VM is the harness's machine. It also stays on
when the owner's Mac sleeps.

What exe.dev offers (from third-party pages, October 25, 2026; check against
exe.dev before relying on it): persistent Linux VMs that keep their disk and
boot in under a second, reached over SSH, each with an HTTPS address
(`<name>.exe.xyz`) behind an email sign-in. Price unconfirmed.

| Work | Runs without the Mac today? | With the VM |
| --- | --- | --- |
| PR keeper (hourly) | Yes, a cloud routine | No change |
| Claude building threads | Yes; each container is wiped after the session | A lasting workspace if one is needed |
| GrokBot teams | Yes, Cursor models only | No change |
| Codex reviews and cloud builds | Yes, Codex's app | No change |
| Local Codex CLI jobs | No, the Mac | Move to the VM (first job) |
| Gemini CLI, Pi, open models | No home | Run on the VM (first job: Gemini CLI) |
| Desk preview at an address the owner can open | No | The VM's HTTPS address, behind exe.dev's sign-in |
| Front porch prototype | No | A separate VM with no credentials (below) |
| Mac and iPhone builds, Swift tests, the nightly Test build | Mac only | No change: Linux can't build them |

Rules for the VM:

- **One builders' VM to start**, owned by the owner. The owner, not an
  agent, signs up, pays and keeps the account.
- **Nothing public on the builders' VM.** It serves no endpoint that takes
  requests from the internet: anything public, such as the front porch
  prototype, runs on a separate VM with no repository token, so a compromise
  there can't reach write access to the repository.
- **First jobs:** the owner's local Codex CLI jobs and the Gemini CLI, both
  working as `cloudwork-bot`, under the same review loop as every other agent.
- **Credentials:** a separate classic `cloudwork-bot` token for the VM,
  with only the `repo` scope and no `workflow` scope, as
  [merge-gate.md](../plans/merge-gate.md) sets up for every builder.
  Fine-grained tokens can't write here, because the bot is only a
  collaborator on a personal-account repository, and the bot collaborates on
  this repository alone. A separate token lets the VM's access be revoked
  without touching the other builders'. A Linux VM has no Keychain, so this
  is an owner-approved exception to "secrets belong in Keychain": the token
  is readable only by the VM's user account (a file with mode 600, or
  exe.dev's own secret store if it has one) and never in the repository,
  logs or the shell history. A Codex or Gemini sign-in goes there only when
  the owner sets it up. The VM never holds the `CloudworkSystems` account's
  credentials.
- **Zero trust:** an unknown foreign agent (for example Meta's Muse agent)
  never shares the VM or its token with the trusted builders.
- **CPU only:** local models on the VM are small ones.
- Mac app builds and full Mac test runs stay on the owner's Mac (AGENTS.md
  "Limits") or move later to GitHub's macOS runners, with their own plan.

## Sources

Checked October 25, 2026. exe.dev's own site couldn't be opened from the
cloud session, so these facts come from search results:

- exe.dev listing on AWS Marketplace: https://aws.amazon.com/marketplace/pp/prodview-2ytzwxphjhl6i
- boxd, "boxd vs exe.dev" (a competitor's comparison): https://boxd.sh/blog/boxd-vs-exe-dev
- OpenClaw's exe.dev install guide: https://docs.openclaw.ai/de/install/exe-dev.md
