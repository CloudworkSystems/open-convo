# Site Engine: What Will Change (PRD)

Written October 21, 2026 by a building session for the planning side, from
the approved scale-up plan ([scale-up.md](scale-up.md), option (a)). Session
name: `OC-261021-site-engine-diff`. Umbrella: Business. Design background:
[docs/design-notes/site-engine.md](../design-notes/site-engine.md); the first
slice is [site-engine-standalone.md](site-engine-standalone.md). Built by an
outside builder under AGENTS.md "Outside Builders": **GrokBot (team B)**
builds, Codex reviews.

## Why

The Site Engine note says nothing goes public without a preview the owner
approves. Before a site update, the owner needs to see in plain words what
will change, not two JSON files side by side: "Hours on Sat: 08:00–13:00
becomes 10:00–14:00", "New service: Gift cards". This slice adds that list.
It is the core of the preview the owner will later approve in the Desk, and
it is useful on its own as soon as the first real site exists.

## Plan Of Record

1. **Now:** a "what will change" command inside `packages/site-engine/`,
   tested on invented businesses. No publishing, no app code, no storage
   code, no AI, no network.
2. **Later:** the Desk shows this list as the preview the owner approves
   before a site update goes out (needs step 5 and the publishing slice).

## What It Does

```
node packages/site-engine/src/diff.mjs --old <old.facts.json> --new <new.facts.json> [--json]
```

and the same as a function, `diffFacts(oldPath, newPath)`, exported from
`src/diff.mjs`.

1. **Both files go through the build's own checks**, using the existing code
   rather than a copy of it: the same size limit and JSON reading as
   `buildSite` in `src/build.mjs`, `validateFacts` from `src/schema.mjs`,
   `resolveBrand` and `assertContrast` from `src/contrast.mjs`, and
   `prepareImages` from `src/images.mjs` (in memory only). If the build would
   refuse either file, the diff refuses too, with the same message the build
   gives, says which file (current or new) was refused, and lists no
   changes. A preview never shows a change the build would not publish.
2. **Compares the two checked fact sets** and lists each change in plain
   words, one line each, in the order `renderPage` in `src/render.mjs` lays
   out the visible page: name, tagline, description (About), photos,
   services, hours, location, contact, social links. Changes that aren't a
   page section come last: colors, then site address.
3. **Writes nothing.** It reads the two facts files and the images beside
   them, prints the list (or JSON with `--json`), and exits. It never calls
   `publishSite`, never touches an output folder, and has no `--out` option.

To share the reading code, the builder may move the facts-reading part of
`buildSite` (the size limit, file checks and JSON parsing) into an exported
helper that both `build.mjs` and `diff.mjs` call. That move must not change
what the build accepts, refuses or writes: the existing build tests pass
unchanged and are not edited.

## How Changes Are Described

Fields the facts schema allows today (`schema/facts.schema.json`):

- **Single text fields** (`name`, `tagline`, `description`): "Tagline:
  *old* becomes *new*".
- **Services**, matched by name: "New service: Gift cards"; "Service
  removed: Morning bun"; "Price of Rye loaf: $9 becomes $10"; "Price of Rye
  loaf removed"; "Description of Rye loaf: *old* becomes *new*". A renamed service shows as one removed and one new.
- **Hours**, matched by `days`: "Hours on Sat: 08:00–13:00 becomes
  10:00–14:00"; "New hours: Sun 09:00–12:00"; "No longer open: Sat". A switch
  between a list of hours and `"By appointment"` is said plainly ("Hours
  become: By appointment").
- **Location:** each changed address line by name ("Street: 18 Marrow Lane
  becomes 20 Marrow Lane"). A switch between a street address and `"Online
  only"` also says what search engines will see: "Search engines will see an
  online business, with no address" (the JSON-LD type moves from
  `LocalBusiness` to `Organization`), or the reverse.
- **Contact:** phone, email and booking link, each added, removed or changed.
- **Social links**, matched by address: added, removed, or the label changes.
- **Photos**, matched by their contents after metadata is removed (what
  `prepareImages` produces): "New photo: *alt text*"; "Photo removed: *alt
  text*"; "Photo description changes: *old alt* becomes *new alt*"; "Photo
  replaced: *alt text*" when the file name stays but the picture differs.
  Metadata-only changes (for example new GPS data that the build strips
  anyway) are not changes, because the published page doesn't change.
- **Order of every list.** The page shows photos, services, hours and social
  links in the order the facts list them, so order is a change. When the
  entries found in both files appear in a different order, one sentence
  says so for that list ("The order of photos changes", and the same for
  services, hours and social links), whether or not anything else in the
  list changed.
- **Repeated keys.** The schema doesn't require list keys to be unique (two
  services can share a name, two hours entries the same `days`, two social
  links the same address, two photos the same picture). Entries that share
  a key are paired by position among the entries with that key: the first
  old "Rye loaf" with the first new "Rye loaf", the second with the second,
  and any left over are added or removed.
- **Colors:** "Accent color: #f37a4a becomes #2f6f4f", using the colors
  after defaults are applied, so filling in a default value is no change.
- **Site address** (`siteUrl`): "Site address: *old* becomes *new*. The
  page's canonical link and sitemap change too."
- **No changes:** "Nothing on the site changes."

The JSON form (`schemaVersion: 1`) lists the same changes, each with the
area, the kind (`added`, `removed` or `changed`), the field path, the old and
new values, and the plain sentence. Same input gives byte-identical output.

**Each change stays on one line.** The schema allows line breaks and tabs in
text (descriptions can have paragraphs), so in the printed list a value is
shown with a backslash written as `\\`, a line break as `\n`, a carriage
return as `\r` and a tab as `\t`. No value can start a new line of the
list. The JSON form keeps every value exactly as the facts hold it.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/site-engine` (the existing build tests plus new
diff tests), Node's built-in test runner, invented businesses only (the
existing Marrow Lane Bakery and Northglass Tutoring fixtures, plus new
invented variants beside them). At least:

1. The same file against itself gives "Nothing on the site changes."
2. Each area above, changed alone, gives exactly its expected sentence:
   tagline, a new service, a removed service, a price change, an hours
   change, a new day, a closed day, `"By appointment"`, a street change,
   street address to `"Online only"` (with the search-engine sentence),
   contact, a social link, colors and site address.
3. A renamed service shows as one removed and one new. A reordering alone of
   each list (photos, services, hours, social links) shows exactly one
   order sentence for that list, and a reordering plus a price change shows
   both.
4. Repeated keys: two services named "Rye loaf" with different prices, two
   hours entries for the same days, and a repeated social address each pair
   by position; adding a third "Rye loaf" shows one new service.
5. One-line output: a description change whose old and new text contain a
   line break, a carriage return, a tab and a backslash prints as one line
   with `\n`, `\r`, `\t` and `\\`; the JSON holds the exact text.
6. Order: one file pair changing the tagline, a photo, a service, the hours,
   social links, colors and the site address lists the changes in exactly
   the order under "What It Does".
7. Photos: a new photo, a removed photo, an alt-text change, a replaced
   picture under the same file name, and a metadata-only change (no change
   reported).
8. Filling in a brand color with its default value reports no change.
9. Every refusal the build makes is also a diff refusal with the build's
   message, for either file, and lists no changes: an unknown field (with a
   marker string that then appears in no output), a missing required field,
   failing contrast, an unsafe link, an unsafe image path, a symbolic-link
   image, an image whose contents don't match its name, invalid JSON and an
   oversized file.
10. The diff writes nothing: a test runs it inside a temporary folder and
    finds the folder exactly as before, and `diff.mjs` never imports
    `publish.mjs`.
11. The existing build tests pass unchanged.
12. Same input twice gives byte-identical text and JSON.

## Out Of Scope For This Slice

Publishing anywhere, hosting accounts, domains, Desk or app screens, the
owner's approval step itself, comparing built HTML files, AI-written
summaries of changes, new fact fields, any change to what the build accepts,
and the owner's real business.

## Rules For The Builder (GrokBot, Team B)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Work only in a checkout of this repo, on the branch
  `OC-261021-site-engine-diff`, signed in as `cloudwork-bot`. Open a pull
  request into `main`. Never push to `main` directly.
- Run **no commands on the owner's Mac** for this job. Nothing here needs it.
- Touch no keys, tokens, passwords, accounts, Keychain or private files. Use
  invented data only. If anything private turns up, stop and say so in the
  pull request without copying it.
- Change files only under `packages/site-engine/`. Nothing else, not even
  `STATUS.md`: the planning side updates STATUS.md. Inside the package, add
  the diff code, its tests, invented fixtures and a README section; change
  existing build code only for the shared reading helper described above.
- If another open pull request also changes `packages/site-engine/`, say so
  in a comment on both pull requests and keep your changes out of the files
  it changes where you can.
- No publishing code, no network calls, no AI, no paid services.
- No new dependencies; the tests may use `sharp`, which the package already
  has for tests. Add no license file and no `license` field.
- Keep the first slice small: the diff command, its tests and a README
  section, finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.

## If GrokBot Stops

If GrokBot's subscription ends before this is finished, the work stays on
its branch. Any agent may finish it from this plan, on the same branch or a
new one named after a new session, under the same rules and review.

## Review And Finish Line

1. GrokBot (team B) opens the pull request.
2. Codex reviews it as code, round after round, until it finishes with a 👍.
   The builder fixes every P1 and P2, or explains in the pull request why one
   does not apply; P3s are optional. If Codex builds any part of it (for
   example, finishing it after GrokBot stops), Claude also reviews it under
   AGENTS.md's rules for Codex-built work, so no agent's review is the only
   one on its own work.
3. The planning session or the PR steward checks the result against this
   document, gives the owner a short try-it note (change the bakery's
   Saturday hours and a price in a copy of its facts file, then read the
   list), and then switches on auto-merge. The merge gate merges it.

Done when the tests pass with one command, Codex has given a 👍 with no open
P1 or P2 (P3s are optional), and the planning check finds nothing missing
from this document.
