# Design Note: A Verified Yes From The Person

Written October 27, 2026 by a Claude building session (thread "Review and
annotate the Desk UI"), from a conversation with the owner. Status: idea
only, not in the build order. Nothing here is built or scheduled.

## Where This Came From

The owner asked why he has to open GitHub to approve a pull request when he
has already said yes in a Claude thread. The honest answer was that a yes
typed in a chat reaches the agent as a message, and nothing downstream can
tell a real yes from one an agent wrote. He asked what would change if only
he could send the signal, for example with Face ID. Then he pointed out that
this isn't a GitHub problem: so much of people's lives runs through apps and
assistants now that True Convo, or something like it, could offer this to
everyone.

## The Idea

The person presses Face ID (or a passkey) on their own phone or Mac, and that
proves the yes came from them. An assistant can carry the yes to wherever
it's needed, but it can never make one up, change what it covers, or use it
twice.

Each yes covers **one exact action**: "approve pull request #161 at commit
316eefa", "send this email to these three people", "pay $40 to this
merchant". If the action changes after the person says yes, it needs a new
yes.

## How It Would Work

1. **The assistant asks.** It describes the action in full (what, to whom,
   the exact contents or a fingerprint of them) and sends the request to
   the person's device.
2. **The phone shows it plainly, from the bytes it will sign.** The app
   draws the short summary and the exact details from the request itself,
   never from words the assistant supplies alongside it. A fingerprint the
   phone can't turn back into the full action is refused: the phone must be
   able to show everything it signs. Nothing is pre-approved.
3. **The person signs, in the True Convo iPhone app** (the owner's choice,
   October 27). Face ID authorizes exactly one signature, by a key the app
   keeps in the iPhone's Secure Enclave, over the request on screen plus a
   one-time number and an expiry time. Each signature needs its own Face ID;
   one unlock never covers a later request. The key never leaves the phone. The
   app uses Apple's own Face ID check (which reads the face with the
   front camera's depth sensor) rather than its own camera code, so the app
   never sees or stores the face. A passkey can stand in on other devices,
   with its challenge set to a hash of the whole request: the action on
   screen, the one-time number and the expiry.
4. **A verifier acts.** A small, separate piece sits next to the thing that
   acts. It checks the signature, that the request matches the action, that
   it hasn't expired and hasn't been used before. Only then does it perform
   the signed action itself, exactly as signed, with a credential the
   assistant never sees. It ignores any other copy or description of the
   action the assistant sends.
5. **It keeps a record.** Each yes, what it covered and what happened are
   logged where the person can read them.

## Rules It Has To Keep

- **Assistants never hold the credential the yes unlocks.** Only the verifier
  does. That's the difference from giving an agent a key. This follows the
  zero-trust baseline in
  [agent-profiles-and-adapters.md](agent-profiles-and-adapters.md).
- **The person decides; assistants only bring choices.** This is the same
  rule as "Jeff surfaces choices; the owner makes them" in that note. The
  verified yes is how "the person decides" gets enforced, not just written
  down.
- **The verifier trusts only keys the person enrolled.** It accepts
  signatures from a public key pinned when the person set it up, in person
  on their own device, never from a key that arrives through an assistant.
  Adding or replacing a device needs a yes signed by a key already enrolled,
  or a fresh in-person setup. An assistant can never add its own key.
- **A yes is used once, even under retries and crashes.** The verifier
  claims the yes durably and atomically before it acts, so two copies
  arriving together can't both run. The action itself carries the yes's
  one-time number, so a retry after a crash is recognized and not done
  twice; where a service can't take such a number, the verifier first
  checks whether the action already happened.
- **No blanket yes.** One yes, one action. Standing permissions ("always let
  it file receipts under $20") may come later, each as its own signed rule
  the person can see and revoke.
- **The verifier's credential should be as narrow as the service allows.**
  Where a service can't narrow it (GitHub has no "approve only" token), the
  verifier must be the only thing that can reach that credential, and it does
  nothing but check yeses and act on them.

## A First Use, If The Owner Wants One

The project's own GitHub approvals would be a first test: a Claude thread
asks, the owner's phone signs, and a verifier approves that exact commit.
The verifier's token must be reachable only by the verifier. A plain
repository secret isn't enough: any agent that can push a branch can run a
workflow that reads one (`tests.yml` already keeps secrets away from
pull-request code for this reason). So the verifier runs only from the
default branch's own copy, never from pull-request code, with its token in
a place no pull-request workflow can read (for example a GitHub environment
limited to the default branch), or outside GitHub altogether. This needs the
owner's approval under AGENTS.md's Limits (a credential, a service that
outlives the session, and a rule change, since today no agent may act as the
owner's account). On October 27 the owner chose to try fewer approvals first
(plans now merge on his yes in a thread), so this waits until the remaining
approvals prove to be a real burden.

## Open Questions

- Where the verifier runs: on the person's own Mac (private, but it sleeps)
  or a small cloud service (always on, but it's a server the project would
  run).
- A lost or replaced phone: recovery, and a second device that can also sign.
- Accessibility: a fallback for people who can't use Face ID or a passkey.
- What counts as "the same action" when a draft is edited after the yes.
- Whether a signed yes carries any legal weight, for payments especially;
  this needs checking before anything ships to other people.
