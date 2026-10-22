# Site Engine: What Will Change (PRD)

Written October 21, 2026 by a building session for the planning side, from
the approved scale-up plan (`docs/plans/scale-up.md`, option (a), which
merges in #94 with the limit of three outside modules). The builder starts
only after both this plan and #94 have merged. Session
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

**`diffFacts` returns data and prints nothing.** It returns a promise of
`{ schemaVersion: 1, changes }`, where `changes` is a list (empty when
nothing changes) of objects with exactly these fields:
- `area`: one of `name`, `tagline`, `description`, `photos`, `services`,
  `hours`, `location`, `contact`, `social`, `colors`, `siteUrl`;
- `kind`: `added`, `removed`, `changed`, `reordered`, `section-added` or
  `section-removed`;
- `path`: the field path in the facts (for example `services[1].price`, or
  `brand.background`), with one exception: the derived light/dark choice
  uses `colorScheme`, which is not a facts field (see Colors below);
- `before` and `after`: the old and new values exactly as the facts hold
  them (for colors, the resolved hex value), or `null` when there is none;
- `sentence`: the plain sentence, already escaped to one line as described
  below.

On a refusal it throws a `SiteEngineError` whose message is the build's
message plus which file was refused. It never writes to stdout or stderr
and never calls `process.exit`. The command line is a thin wrapper: it
calls `diffFacts`, then prints each `sentence` on its own line (or
"Nothing on the site changes." when `changes` is empty), or with `--json`
prints the returned object as JSON. On a refusal the wrapper prints the
message to stderr and exits with 1.

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
  10:00–14:00"; "New hours: Sun 09:00–12:00"; "No longer open: Sat".

  `hours` is optional, and the schema allows `"By appointment"` or a list of
  one to fourteen entries (never an empty list). `renderPage` and
  `buildJsonLd` in `src/render.mjs` treat the three forms like this: a list
  shows an Hours section with one line per entry and gives search engines
  `openingHoursSpecification`; `"By appointment"` shows an Hours section
  reading "By appointment" and gives search engines `openingHours: "By
  appointment"`; no `hours` shows no Hours section and gives search engines
  no hours. So:
  - No hours to `"By appointment"`: "New Hours section: By appointment".
    The reverse: "Hours section removed (it said: By appointment)".
  - No hours to a list: "New Hours section:" followed by each entry
    ("Tue–Fri 07:00–14:00; Sat 08:00–13:00", in list order). The reverse:
    "Hours section removed (it said: *the entries*)".
  - A list to `"By appointment"`: "Hours become: By appointment (instead
    of: *the entries*)". The reverse: "Hours become: *the entries*
    (instead of: By appointment)".
  These transition sentences replace the per-day sentences: a switch
  between forms never also lists "New hours" or "No longer open" lines, or
  an hours order sentence.
- **Location.** `location` is optional and has three forms, which
  `renderPage` and `buildJsonLd` in `src/render.mjs` show like this:
  - a street address: a Location section with three lines (street; city,
    region and postal code; country), and search engines see a
    `LocalBusiness` with a `PostalAddress`;
  - `"Online only"`: a Location section reading "Online only", and search
    engines see an `Organization` with no address;
  - no `location`: no Location section, and search engines see an
    `Organization` with no address.

  In the sentences below, *the address* is written as "street, city, region
  postal code, country" on one line (for example "18 Marrow Lane,
  Hearthwick, Northglass 00000, Freedonia"). Every pair of forms has
  exactly these sentences, in this order, and nothing else for location:

  | From | To | Sentences |
  | --- | --- | --- |
  | Address | Address | One per changed line, by name: "Street: 18 Marrow Lane becomes 20 Marrow Lane" (and the same for City, Region, Postal code, Country). No search-engine sentence. |
  | Address | `"Online only"` | "Location: *the address* becomes Online only"; then "Search engines will see an online business, with no address". |
  | `"Online only"` | Address | "Location: Online only becomes *the address*"; then "Search engines will see a local business at this address". |
  | None | `"Online only"` | "New Location section: Online only". No search-engine sentence (they see an online business before and after). |
  | `"Online only"` | None | "Location section removed (it said: Online only)". No search-engine sentence. |
  | None | Address | "New Location section: *the address*"; then "Search engines will see a local business at this address". |
  | Address | None | "Location section removed (it said: *the address*)"; then "Search engines will see an online business, with no address". |
  | Same form, no change | | Nothing. |

- **Contact:** phone, email and booking link, each added, removed or changed.
- **Social links**, matched by address: added, removed, or the label changes.
- **Sections that appear or disappear.** Services, photos and social links
  are optional lists that the schema never allows to be empty, and the
  Contact section shows only when at least one of phone, email or booking
  link is set. When one of these sections appears, the list says "New
  *name* section:" followed by its entries (for example "New Services
  section: Rye loaf; Morning bun"); when one disappears, "*Name* section
  removed (it said: *its entries*)". These replace the per-entry "New" and
  "removed" sentences and any order sentence for that list. Hours and
  Location follow their own tables above. Together with the always-present
  name, tagline and About section, this covers every section the page can
  show.
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
  links the same address, two photos the same picture). Among entries that
  share a key, entries whose whole content is identical in both files are
  paired first (in order of appearance), so a pure swap of two different
  "Rye loaf" entries reports only "The order of services changes", not two
  price changes. Only the entries left after that are paired by position
  among themselves: the first remaining old "Rye loaf" with the first
  remaining new "Rye loaf", and so on; any left over are added or removed.
- **Colors.** The three brand colors are compared after `resolveBrand`
  applies the defaults and normalizes them (lowercase, six digits), so
  filling in a default value, or writing `#FFF` for `#ffffff`, is no
  change. `renderCss` uses them like this, and the sentences follow:
  - `brand.accent` colors links and the skip link: "Accent color: #f37a4a
    becomes #2f6f4f".
  - `brand.text` colors all body text: "Text color: #f7f2ee becomes
    #ffffff".
  - `brand.background` is the page background, and it also sets the
    page's `theme-color` and, through `colorScheme`, whether the page
    declares itself light or dark: "Background color: #15110f becomes
    #fbf8f4". When the light/dark choice flips, a second sentence follows:
    "The page now asks browsers for a light color scheme (was dark)", or
    the reverse; it is its own change object, with `path` `colorScheme`
    and `before` and `after` set to `"dark"` or `"light"`.
  Order inside colors: background, then text, then accent.

  **Colors the build refuses are never shown as a change.** `assertContrast`
  refuses the facts when the text or accent color on the background is
  below 4.5:1. Since both files go through the build's checks first, a new
  background, text or accent color that fails contrast makes the whole diff
  a refusal, with the build's message ("Brand colors fail WCAG AA
  contrast ...") naming the new file, and no changes are listed. A change
  that keeps every pair at 4.5:1 or above is listed normally.
- **Site address** (`siteUrl`): "Site address: *old* becomes *new*. The
  page's canonical link and sitemap change too."
- **No changes:** "Nothing on the site changes."

The JSON form is the object `diffFacts` returns (see "What It Does"), one
change object per sentence. Same input gives byte-identical output.

**Each change stays on one line.** The schema's `CONTROL_CHARS` check
(`src/schema.mjs`) still allows tab, line feed and carriage return, and it
allows every character above U+007F, including ones that some programs
treat as a line break. So in the printed list a value is shown with a
backslash written as `\\`, a line feed as `\n`, a carriage return as `\r`,
a tab as `\t`, and every other character that can break or hide a line
written as a `\u` escape with four hex digits (for example `\u0085`): the
C1 controls U+0080 to U+009F (including U+0085, next line), U+2028 (line
separator) and U+2029 (paragraph separator), plus any control character
the schema might allow later. No value can start a new line of the list.
The JSON form keeps every value exactly as the facts hold it.

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
   Every row of the Location table gives exactly its sentences, in order,
   and nothing else for location (address to `"Online only"` and back,
   `"Online only"` to none and back, address to none and back, and one
   changed address line). Each of services, photos, social links and
   contact, appearing and disappearing, gives exactly its one section
   sentence and no per-entry or order sentence.
   And the hours forms: all six transitions between no hours,
   `"By appointment"` and a list of hours each give exactly the one
   sentence under "Hours", with no per-day or order sentence alongside.
3. A renamed service shows as one removed and one new. A reordering alone of
   each list (photos, services, hours, social links) shows exactly one
   order sentence for that list, and a reordering plus a price change shows
   both.
4. Repeated keys: two services named "Rye loaf" with different prices, two
   hours entries for the same days, and a repeated social address each pair
   by position when their content changes; adding a third "Rye loaf" shows
   one new service. Swapping the two different "Rye loaf" entries, and
   nothing else, reports only the order sentence for services and no price
   change (and the same for swapped hours entries with the same days).
5. One-line output: a description change whose old and new text contain a
   line break, a carriage return, a tab and a backslash prints as one line
   with `\n`, `\r`, `\t` and `\\`; the JSON holds the exact text. The same
   for U+0085, U+2028, U+2029 and U+009B, which print as `\u0085`,
   `\u2028`, `\u2029` and `\u009b`.
6. Order: one file pair changing the tagline, a photo, a service, the hours,
   social links, colors and the site address lists the changes in exactly
   the order under "What It Does".
7. Photos: a new photo, a removed photo, an alt-text change, a replaced
   picture under the same file name, and a metadata-only change (no change
   reported).
8. Filling in a brand color with its default value, or writing the same
   color in another form (`#FFF` vs `#ffffff`), reports no change. A
   background change, a text change and an accent change each give exactly
   their sentence; a background change that flips light and dark adds the
   color-scheme sentence; all three at once come out in the order
   background, text, accent. A new background that drops the text color
   below 4.5:1, a new text color below 4.5:1 and a new accent below 4.5:1
   are each a refusal naming the new file, with no changes listed.
8a. `diffFacts` returns `{ schemaVersion: 1, changes }` with the fields
   above and an empty `changes` for identical files; it writes nothing to
   stdout or stderr (a test captures both); a refusal throws. The command
   prints the same sentences, or exactly the returned object with
   `--json`.
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
