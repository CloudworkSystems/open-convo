// Builds src/content/emoji.json from the data-by-group.json file of the
// unicode-emoji-json npm package (MIT; Unicode emoji data). Run by hand when a
// new Unicode emoji version should reach the Desk:
//   node scripts/generate-emoji-data.mjs <path to data-by-group.json> <version>
// Nothing is fetched at runtime and the package is not a dependency.
import { readFileSync, writeFileSync } from 'node:fs';

const [source, version] = process.argv.slice(2);
if (!source || !version) throw new Error('Usage: generate-emoji-data.mjs <data-by-group.json> <package version>');
const groups = JSON.parse(readFileSync(source, 'utf8'));
const rgi = /^\p{RGI_Emoji}$/v;
const out = {
  source: `unicode-emoji-json ${version} (MIT), Unicode emoji data`,
  groups: groups.map((group) => ({
    name: group.name,
    emoji: group.emojis.map((entry) => {
      if (!rgi.test(entry.emoji)) throw new Error(`Not a standard emoji: ${entry.emoji}`);
      return [entry.emoji, entry.name];
    }),
  })),
};
writeFileSync(new URL('../src/content/emoji.json', import.meta.url), `${JSON.stringify(out)}\n`);
console.log(`Wrote ${out.groups.reduce((n, g) => n + g.emoji.length, 0)} emoji in ${out.groups.length} groups.`);
