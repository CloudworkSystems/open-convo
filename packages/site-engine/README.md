# Site Engine (standalone slice)

Turns one public-facts file into a one-page website. Nothing is published, and
the command does not use the network.

```bash
node packages/site-engine/src/build.mjs --facts <facts.json> --out <folder>
```

From this folder:

```bash
npm test
node src/build.mjs --facts fixtures/marrow-lane-bakery.facts.json --out /tmp/marrow-lane
```

The fixtures are invented (Marrow Lane Bakery and Northglass Tutoring). A real
business facts file stays outside the repo.

`schema/facts.schema.json` is the only list of fields that may appear on a
page. Any other field stops the build before the output folder is touched.
Default colors are the Ember palette (near-black `#15110f`, cream `#f7f2ee`,
coral `#f37a4a`). The page names Atkinson Hyperlegible Next when that font is
already installed, then a system serif. It does not ship font files or request
anything from the network. Color profiles are removed from photos, because a
profile can carry a name or a device id. An AVIF is kept only when every box
is a known part of the picture and matches that box's layout. The picture
bytes themselves must be listed by the file and must be AV1 data; spare bytes
after the picture are refused. A run of letters inside a coded frame is left
in place, because compressed pixels can look like text. A progressive
JPEG keeps every scan. Reserved characters in an email are percent-encoded
in the mailto link; the address on the page stays as written.

This slice does not publish, host, take payment, or call a model.
