# Design Note: Business Phone Assistant (Module)

Rewritten October 13, 2026 by the planning session from True Convo's
`docs/2026-10-02-business-phone-product-concept.md` (commit `c527e36`). Status:
proposed product concept, approved as a definition by the owner on October 2,
2026. It authorizes no build, live calls, voice training, provider use or
spending. No name or date is chosen. It is a subscription module built on the
Convo Engine ([convo-engine.md](convo-engine.md)), not part of the open core.

## The Product And Its First Audience

An openly identified AI assistant answers a small business's phone, helps
callers from the owner's approved business information, and brings the owner
into the same call when needed. The first audience is an owner who handles
customer calls personally. The value to test: fewer avoidable interruptions and
fewer missed calls while keeping personal service. The first concept assumes
one owner and occasional overlapping calls; departments and larger staff come
later.

The assistant says it is AI. A natural voice is a goal; fooling callers is not.

## The Caller Stays In Control

The owner's direction: the assistant introduces itself as AI, may gather a
description to summarize for the owner, connects an insistent caller directly,
and can offer an answer to a complaint while keeping the owner reachable. The
detailed rules below were proposed by Codex as safeguards; the owner has not
accepted each one as final.

1. It opens with an introduction such as "Hi, I'm [Owner]'s AI assistant. What
   can I help you with?" A request for the owner, a person or an operator is
   recognized without one exact phrase.
2. A request for the owner stays pending. The assistant may offer one optional
   chance to describe the issue for a summary. If the caller declines or
   insists, the connection attempt starts at once.
3. If an owner-approved answer fits a complaint, the assistant may offer it
   once as an alternative to the handoff. It never invents a remedy, promises
   an exception or decides outside the owner's stated permissions.
4. Explaining the problem does not cancel the request for the owner. Unless the
   caller explicitly chooses to stay with the assistant, the connection attempt
   proceeds. Silence or uncertainty leads to the handoff; a repeated request
   starts it immediately.
5. If the owner cannot answer, the assistant says so and offers only the
   message or callback arrangements the business approved, never a callback
   time it cannot support. It says "I'll try them now," not that they are
   joining, until they accept.

## What The Owner Sees And Hears

The phone app shows the caller's need, facts established, answers or
commitments already given, and what still needs attention, marking missing or
uncertain details instead of filling them in. Fictional example: "Caller wants
a repair appointment tomorrow. Availability discussed; nothing booked. Caller
asked to speak to the owner."

The owner can get an alert or a call, read the summary, listen live and choose
Take over; the caller should not have to repeat everything. On takeover the
assistant stops speaking at once, including speech already queued, and the
owner announces the change. Wording and voice choice need testing, especially
if the assistant uses the owner's voice.

A separate narrow model could suggest that human attention would help (a
confused or frustrated caller, a request for an exception), quoting the words
that prompted it and labeled as an inference. It cannot override a direct
request for the owner or authorize a business action. Whether a Jeff-like
listener can judge live calls is unestablished, and transcript text alone may
miss tone.

## What It Shares With Other Modules

The Convo Engine supplies selected, owner-approved material to each product;
the owner chooses what is available for each purpose, and nothing becomes usable
for a new purpose automatically.

| Shared capability | Creator product | Business phone |
| --- | --- | --- |
| Approved voice samples and permission | Speech for reviewed videos and clips | Speech in a disclosed AI conversation |
| The owner's way of speaking | Phrasing in prepared content | Polite, natural replies without inventing the owner's opinions |
| Selected knowledge with sources | Facts for the content being made | Current business facts and approved answers |
| Owner corrections and versions | Revise a draft; choose whether a correction is reused | Correct an answer; approve an updated business rule |
| Purpose and data controls | Limit which media are used | Keep call material separate; limit business sources |
| Processing and spending controls | Show and control outside processing | Same, for speech, transcripts and replies |

Voice and business information are managed separately: changing hours, prices
or policies never requires retraining a voice.

## Callers' Data

Customer calls never become training examples automatically (see the training
filter in [sage.md](sage.md)). Before any real caller trial, settle what
callers are told about AI processing, transcript analysis and owner listening,
including how they learn the owner has started listening. Recording, keeping
transcripts and reusing caller material each need their own purpose and
consent, which cannot be inferred from the owner's permission to use their own
voice. No speech or phone provider is chosen.

## Smallest Useful Candidate

A local simulation with fictional business facts and fictional calls, so the
owner can try the caller experience and the owner's screen without a real
number or real caller data. Voice cloning is not needed for the first handoff
test.

1. A phone-screen mockup with the summary and Listen, Take over and Unavailable
   choices, followed through one fictional complaint.
2. Simulate the rules with fictional cases: an immediate demand for the owner,
   a description with no explicit choice, an approved answer accepted, silence
   after an answer, a repeated demand, an unusual question, an unavailable
   owner.
3. Only after the local flow is useful, a separately approved voice and phone
   trial, once disclosure and consent, availability, voice permission, data
   destinations and retention, provider, spending limits and failure handling
   are settled.

Later checks: answer accuracy, false or missed owner alerts, time before a
reply starts, interruptions, connection failures, and any assistant speech
after takeover. No targets are set yet.

## Still Open

Name, platforms, availability arrangements, approved business actions,
simultaneous calls, voice technology, whether the first trial uses the owner's
voice, the takeover announcement, any training, providers, customer acceptance
and operating cost.
