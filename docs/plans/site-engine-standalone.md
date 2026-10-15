# Site Engine, Standalone First Slice (PRD)

Written October 15, 2026 by the planning session. Session name:
`OC-261015-site-engine-standalone`. Design background:
[docs/design-notes/site-engine.md](../design-notes/site-engine.md).

This is the first module built by an outside builder (see AGENTS.md, "Outside
Builders"). GrokBot builds, Codex reviews, the planning session checks the
result against this document, and the owner merges.

## Why This Slice, Why Now

The owner needs a simple website for one of his businesses soon, and Site
Engine as a full True Convo feature waits for step 9 (it needs memory spaces
from step 5). This slice stands on its own: a facts file goes in, website files
come out. It touches nothing in the Desk, the Mac app, storage or memory, so it
can be built beside steps 3 to 5 without waiting for them or disturbing them.

The one connection to True Convo later is the facts file format and the build
command. When step 5 exists, the facts sheet moves into the business's own
memory space and the Desk calls the same command.

## What It Does

```
node packages/site-engine/src/build.mjs --facts <facts.json> --out <folder>
```

1. Reads one **public-facts file** (JSON) describing one business.
2. Checks it against the facts schema. Any field not in the schema stops the
   build with a plain error naming the field. This is the privacy gate: the
   builder can only ever publish what the schema allows.
3. Builds a one-page website in a fresh temporary folder: `index.html`, one
   CSS file, `sitemap.xml`, `robots.txt`, and any images listed in the facts
   file (copied from beside the facts file).
4. Only when the whole build has succeeded, replaces the output folder with the
   new build. The output folder then holds exactly what this build made:
   nothing left over from an earlier build. If anything fails, the previous
   output folder is left untouched.

## The Facts File

Fields (all text is plain text, never HTML):

- Required: `name`, `tagline`, `description`, `siteUrl`.
- Optional: `services` (list of `{ name, description, price? }`), `hours`
  (list of `{ days, open, close }` or `"By appointment"`), `location`
  (`{ street, city, region, postalCode, country }` or `"Online only"`),
  `contact` (`{ phone?, email?, bookingUrl? }`), `social` (list of
  `{ label, url }`), `images` (list of `{ file, alt }`, alt required),
  `brand` (`{ accent?, background?, text? }` as hex colors).
- `schemaVersion`: `1`.

The schema lives in the package as a JSON file and is the single authority for
what may appear on a page.

**Links.** `siteUrl`, `bookingUrl` and every `social` URL must be complete
`https://` addresses (plain `http://` is refused too). Anything else, including
`javascript:`, `data:`, `mailto:` in a URL field, or an address starting with
`//`, fails the build before anything is written. `email` and `phone` are
checked as an email address and a phone number and written as `mailto:` and
`tel:` links by the builder itself.

**Images.** `images[].file` is a plain file name, or a path inside the folder
that holds the facts file. The build refuses:
- absolute paths, `..`, or any path whose real location (after following
  links) is outside the facts file's folder;
- symbolic links and anything that is not a regular file;
- any format other than `.jpg`, `.jpeg`, `.png`, `.webp` and `.avif`, checked by
  the file's actual contents, not only its name (no SVG or HTML).

The builder chooses the copied file's name (for example `images/1.webp`); names
from the facts file are never used as output paths.

## Page Requirements

- **Every value is escaped for where it lands.** Facts are plain text that may
  contain `&`, quotes, `<`, `>` or `</script>`. Text in HTML, values in HTML
  attributes, entries in `sitemap.xml`, and the JSON-LD block are each escaped
  with the right rules for that place, so no fact can break the page or add
  markup. The JSON-LD escapes `<` so it can never end its own script block.

- Works on a phone and a Mac screen; readable without zooming.
- Basic accessibility: `lang` set, one `h1`, headings in order, every image has
  alt text, text and background colors pass WCAG AA contrast (the build fails
  if brand colors don't).
- Search and AI visibility: page title, meta description, canonical link,
  `LocalBusiness` JSON-LD built from the facts, `sitemap.xml`, `robots.txt`.
- **No outside requests**: no CDNs, web fonts, trackers, analytics or scripts
  from anywhere. The page works with JavaScript turned off. Links to the
  business's own `bookingUrl` and `social` URLs are the only outside links.
- Plain look by default. The Ember kit in `brand/` may be used for the default
  colors; brand colors in the facts file override them.

## Tests (Must Pass, Run By One Command)

`npm test` inside `packages/site-engine`, using Node's built-in test runner and
invented businesses only (for example a fictional bakery and a fictional
online tutor). At least:

1. A complete facts file builds, and every required file exists.
2. Same input gives byte-identical output (no dates or random values in files).
3. A facts file with an extra field (for example `privateNotes` holding a
   marker string) fails, and the marker string appears in no output file.
4. A missing required field fails with a message naming it.
5. Brand colors that fail contrast fail the build with a plain message.
6. The JSON-LD parses as JSON and its name, address and hours match the facts.
7. No output file contains `http://` or `https://` except `siteUrl`,
   `bookingUrl` and `social` URLs from the facts file.
8. Any image without alt text fails the build.
9. Hostile but allowed text (a name with `&`, quotes, `<b>` and
   `</script><script>`) builds, shows as plain text, and adds no element: the
   page has exactly one script block (the JSON-LD), which still parses, and
   `sitemap.xml` is still valid XML.
10. Each unsafe link fails before output is written: `javascript:`, `data:`,
    `//example.test`, `http://` and `ftp://`.
11. Each unsafe image fails: an absolute path, a `../` path, a symbolic link to
    a file outside the folder, an `.svg`, and a `.png` name whose contents are
    HTML.
12. Building business A, then rebuilding into the same folder from facts with
    one image removed, leaves no trace of the removed image; and a failing
    rebuild leaves the previous good output exactly as it was.

## Out Of Scope For This Slice

- Publishing anywhere, hosting accounts, Cloudflare, domains. Publishing comes
  later with a preview, the owner's approval and credentials in Keychain.
- Any change to `apps/`, other packages, the Desk or the Mac app.
- AI of any kind: no model calls, no generated text or images.
- Impeccable and ScrollCraft (later, as pinned copies with their licenses).
- Forms, booking, payments, blogs, multiple pages.
- The owner's real business. The first real site is made after merge, from a
  facts file kept outside the repo.

## Rules For The Builder (GrokBot)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Work only in a checkout of this repo, on the branch
  `OC-261015-site-engine-standalone`. Open a pull request into `main`. Never
  push to `main` directly.
- Run **no commands on the owner's Mac** for this job. Nothing here needs it.
- Touch no keys, tokens, passwords, accounts, Keychain or private files. Use
  invented data only. If anything private turns up, stop and say so in the
  pull request without copying it.
- Change files only under `packages/site-engine/` plus one line in
  `STATUS.md`.
- No new dependencies unless unavoidable; list any in the pull request with its
  license. Add no license file for the repo.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.

## Review And Merge

1. GrokBot opens the pull request.
2. Codex reviews it on GitHub as code, round after round, until it finishes
   with a 👍. GrokBot fixes every P1 and P2 or explains in the pull request why
   one does not apply.
3. The planning session checks the result against this document and gives the
   owner a short plain-language summary and a try-it checklist (open the sample
   page on the phone and the Mac, read it, try the failure tests).
4. The owner merges with GitHub's button.

## Finish Line

The tests pass with one command, Codex has given a 👍, the planning check
finds nothing missing from this document, and the owner has opened a sample
site on his phone and Mac.
