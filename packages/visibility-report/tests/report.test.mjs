import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import { clearNetworkCalls, networkCalls, STUBBED_MODULES } from './network-guard.mjs';
import snapshot from './builtin-modules.json' with { type: 'json' };
import { fixedWording } from '../src/wording.mjs';

const readLog = [];
let recordReads = false;

function noteRead(kind, file) {
  if (!recordReads) return;
  readLog.push({ kind, file: typeof file === 'string' ? file : String(file) });
}

const realPromises = fs.promises;
const promises = new Proxy(realPromises, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (prop === 'readFile') {
      return (file, ...args) => {
        noteRead('promises.readFile', file);
        return Reflect.apply(value, target, [file, ...args]);
      };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

mock.module('node:fs', {
  namedExports: {
    ...fs,
    readFileSync(file, ...args) {
      noteRead('readFileSync', file);
      return fs.readFileSync(file, ...args);
    },
    readFile(file, ...args) {
      noteRead('readFile', file);
      return fs.readFile(file, ...args);
    },
    createReadStream(file, ...args) {
      noteRead('createReadStream', file);
      return fs.createReadStream(file, ...args);
    },
    openSync(file, ...args) {
      noteRead('openSync', file);
      return fs.openSync(file, ...args);
    },
    open(file, ...args) {
      noteRead('open', file);
      return fs.open(file, ...args);
    },
    promises,
  },
});

const { run, isMainModule } = await import('../src/report.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const REPORT = '2026-10-21';
const RECENT = '2026-10-20';
const gfm = new MarkdownIt({ html: true, linkify: true, typographer: false });
const FORBIDDEN = [/grade/i, /score/i, /guarantee/i, /failing/i, /terrible/i, /#1/];

function invoke(args) {
  let stdout = '';
  let stderr = '';
  const code = run(args, {
    stdout: { write(chunk) { stdout += chunk; return true; } },
    stderr: { write(chunk) { stderr += chunk; return true; } },
  });
  return { code, stdout, stderr };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
}

function writeFindings(value, dir = tempDir()) {
  const file = path.join(dir, 'findings.json');
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  return { dir, file, bytes };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function expectRefuse(value, pattern) {
  const { dir, file, bytes } = writeFindings(value);
  const md = path.join(dir, 'out.md');
  const json = path.join(dir, 'out.json');
  try {
    const result = invoke(['--findings', file, '--md', md, '--json', json]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(md), false);
    assert.equal(fs.existsSync(json), false);
    assert.deepEqual(fs.readFileSync(file), bytes);
    return result;
  } finally {
    cleanup(dir);
  }
}

function render(value) {
  const { dir, file, bytes } = writeFindings(value);
  const md = path.join(dir, 'out.md');
  const json = path.join(dir, 'out.json');
  try {
    const result = invoke(['--findings', file, '--md', md, '--json', json]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(fs.readFileSync(file), bytes);
    const markdown = fs.readFileSync(md, 'utf8');
    const jsonText = fs.readFileSync(json, 'utf8');
    const again = invoke(['--findings', file, '--md', md, '--json', json]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fs.readFileSync(md, 'utf8'), markdown);
    assert.equal(fs.readFileSync(json, 'utf8'), jsonText);
    return { markdown, json: JSON.parse(fs.readFileSync(json, 'utf8')) };
  } finally {
    cleanup(dir);
  }
}

function doc(findings, extra = {}) {
  const business = { name: extra.name ?? 'Hearthwick Cycle Works' };
  if (extra.siteUrl) business.siteUrl = extra.siteUrl;
  return {
    schemaVersion: 1,
    business,
    reportDate: extra.reportDate ?? REPORT,
    findings,
  };
}

function urlSource(label, url = 'https://maps.example/shop') {
  return { label, url };
}

function locatorSource(label, locator) {
  return { label, locator };
}

function website(checkedOn = RECENT) {
  return {
    websiteSource: urlSource('Shop site', 'https://hearthwick-cycles.example/'),
    websiteCheckedOn: checkedOn,
  };
}

function sectionsOf(markdown) {
  const map = new Map();
  for (const part of markdown.split(/^## /m).slice(1)) {
    const newline = part.indexOf('\n');
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    map.set(heading, newline === -1 ? '' : part.slice(newline + 1));
  }
  return map;
}

function analyze(markdown) {
  const hrefs = [];
  const chunks = [];
  function walk(list) {
    for (const token of list) {
      if (token.type === 'link_open') hrefs.push(token.attrGet('href'));
      if (token.type === 'text' || token.type === 'code_inline') {
        chunks.push({ type: token.type, content: token.content });
      }
      if (token.children) walk(token.children);
    }
  }
  walk(gfm.parse(markdown, {}));
  return { hrefs, chunks, html: gfm.render(markdown) };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, seed) {
  const copy = [...list];
  const random = mulberry32(seed);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function problemByRank(rank, id) {
  const base = { id, status: 'problem', checkedOn: RECENT };
  const page = {
    hasWebsite: true,
    title: true,
    description: true,
    contact: true,
    worksOnPhone: true,
  };
  switch (rank) {
    case 1:
      return {
        ...base,
        check: 'listing-details-match',
        details: { service: 'Hearthwick Maps', mismatches: [{ field: 'hours', listing: 'Mon 9 to 5', website: 'Mon 10 to 6' }] },
        source: urlSource('Hearthwick Maps'),
        ...website(),
      };
    case 2:
      return {
        ...base,
        check: 'listing-details-match',
        details: { service: 'Lampblack Listings', mismatches: [{ field: 'phone', listing: '555-0100', website: '555-0148' }] },
        source: urlSource('Lampblack Listings', 'https://lampblack.example/shop'),
        ...website(),
      };
    case 3:
      return {
        ...base,
        check: 'listing-details-match',
        details: { service: 'Northglass Directory', mismatches: [{ field: 'address', listing: '1 Oak Street', website: '18 Lampblack Lane' }] },
        source: urlSource('Northglass Directory', 'https://northglass.example/shop'),
        ...website(),
      };
    case 4:
      return {
        ...base,
        check: 'ai-mention',
        details: {
          assistant: 'Askwell',
          question: 'Who repairs bikes in Hearthwick?',
          result: 'wrong-details',
          wrongDetails: 'It said the shop is closed on Monday.',
        },
        source: locatorSource('Askwell', 'Asked Askwell on 2026-10-20.'),
      };
    case 5:
      return {
        ...base,
        check: 'listing-present',
        details: { service: 'Northglass Directory', present: false },
        source: urlSource('Northglass Directory', 'https://northglass.example/list'),
      };
    case 6:
      return {
        ...base,
        check: 'website-basics',
        details: { hasWebsite: false },
        source: locatorSource('Shop desk', 'No site was named on the desk card.'),
      };
    case 7:
      return {
        ...base,
        check: 'website-basics',
        details: { ...page, worksOnPhone: false },
        source: urlSource('Shop site', 'https://hearthwick-cycles.example/'),
      };
    case 8:
      return {
        ...base,
        check: 'ai-mention',
        details: {
          assistant: 'Askwell',
          question: 'Where can I get a bike repaired in Hearthwick?',
          result: 'not-mentioned',
        },
        source: locatorSource('Askwell', 'Asked Askwell on 2026-10-20 about repairs.'),
      };
    case 9:
      return {
        ...base,
        check: 'reviews',
        details: { service: 'Hearthwick Maps', count: 12, last90Days: 2, unanswered: 1 },
        source: urlSource('Hearthwick Maps reviews', 'https://maps.example/reviews'),
      };
    case 10:
      return {
        ...base,
        check: 'reviews',
        details: { service: 'Lampblack Listings', count: 12, last90Days: 0, unanswered: 0 },
        source: urlSource('Lampblack Listings', 'https://lampblack.example/reviews'),
      };
    case 11:
      return {
        ...base,
        check: 'reviews',
        details: { service: 'Brindle Ledger page', count: 4, last90Days: 1, unanswered: 0 },
        source: urlSource('Brindle Ledger page', 'https://brindle-ledger.example/reviews'),
      };
    case 12:
      return {
        ...base,
        check: 'listing-details-match',
        details: { service: 'Hearthwick Maps', mismatches: [{ field: 'name', listing: 'Cycle Works', website: 'Hearthwick Cycle Works' }] },
        source: urlSource('Hearthwick Maps', 'https://maps.example/name'),
        ...website(),
      };
    case 13:
      return {
        ...base,
        check: 'website-basics',
        details: { ...page, title: false },
        source: urlSource('Shop site', 'https://hearthwick-cycles.example/title'),
      };
    case 14:
      return {
        ...base,
        check: 'website-basics',
        details: { ...page, description: false },
        source: urlSource('Shop site', 'https://hearthwick-cycles.example/about'),
      };
    case 15:
      return {
        ...base,
        check: 'website-basics',
        details: { ...page, contact: false },
        source: urlSource('Shop site', 'https://hearthwick-cycles.example/contact'),
      };
    default:
      throw new Error(`no problem for rank ${rank}`);
  }
}

test('a complete findings file matches the saved report', () => {
  const findings = path.join(root, 'fixtures/hearthwick-cycles.findings.json');
  const expectedMd = fs.readFileSync(path.join(root, 'fixtures/hearthwick-cycles.report.md'), 'utf8');
  const expectedJson = fs.readFileSync(path.join(root, 'fixtures/hearthwick-cycles.report.json'), 'utf8');
  const before = fs.readFileSync(findings);
  const dir = tempDir();
  try {
    const md = path.join(dir, 'out.md');
    const json = path.join(dir, 'out.json');
    const written = invoke(['--findings', findings, '--md', md, '--json', json]);
    assert.equal(written.code, 0, written.stderr);
    assert.equal(written.stdout, '');
    assert.equal(fs.readFileSync(md, 'utf8'), expectedMd);
    assert.equal(fs.readFileSync(json, 'utf8'), expectedJson);
    const printed = invoke(['--findings', findings]);
    assert.equal(printed.code, 0, printed.stderr);
    assert.equal(printed.stdout, expectedMd);
    const repeated = invoke(['--findings', findings]);
    assert.equal(repeated.stdout, printed.stdout);
    assert.deepEqual(fs.readFileSync(findings), before);
  } finally {
    cleanup(dir);
  }
});

test('group order follows the rank table', () => {
  const { json } = render(doc([
    problemByRank(12, 'name-1'),
    problemByRank(9, 'reviews-1'),
    problemByRank(5, 'listing-1'),
    problemByRank(1, 'hours-1'),
  ], { name: 'Brindle Ledger', siteUrl: 'https://brindle-ledger.example/' }));
  assert.deepEqual(json.fixList.map((item) => item.group), [1, 2, 3, 4]);
  assert.deepEqual(json.fixList.map((item) => item.rank), [1, 5, 9, 12]);
});

test('ranks, ties, and a finding with two problems stay stable when shuffled', () => {
  const both = {
    id: 'both-1',
    status: 'problem',
    checkedOn: RECENT,
    check: 'listing-details-match',
    details: {
      service: 'Hearthwick Maps',
      mismatches: [
        { field: 'name', listing: 'Cycle Works', website: 'Hearthwick Cycle Works' },
        { field: 'phone', listing: '555-0100', website: '555-0148' },
      ],
    },
    source: urlSource('Hearthwick Maps', 'https://maps.example/both'),
    ...website(),
  };
  const findings = [
    ...Array.from({ length: 15 }, (_, index) => problemByRank(index + 1, `p${String(index + 1).padStart(2, '0')}`)),
    problemByRank(5, 'same-b'),
    problemByRank(5, 'same-a'),
    both,
  ];
  const expectedIds = [
    'p01', 'both-1', 'p02', 'p03', 'p04', 'p05', 'same-a', 'same-b',
    'p06', 'p07', 'p08', 'p09', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15',
  ];
  const first = render(doc(findings));
  assert.deepEqual(first.json.fixList.concat(first.json.alsoFound).map((item) => item.id), expectedIds);
  assert.deepEqual(first.json.fixList.concat(first.json.alsoFound).map((item) => item.rank), [
    1, 2, 2, 3, 4, 5, 5, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ]);
  const combined = first.json.fixList.find((item) => item.id === 'both-1');
  assert.equal(combined.rank, 2);
  assert.deepEqual(combined.problems.map((problem) => problem.rank), [2, 12]);
  assert.match(combined.problems.map((problem) => problem.problem).join('\n'), /phone/);
  assert.match(combined.problems.map((problem) => problem.problem).join('\n'), /name/i);
  const baseline = first.markdown;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const shuffled = render(doc(shuffle(findings, seed)));
    assert.equal(shuffled.markdown, baseline);
  }
});

test('the fix list holds five findings and the summary counts findings', () => {
  const both = {
    id: 'hours-and-name',
    status: 'problem',
    checkedOn: RECENT,
    check: 'listing-details-match',
    details: {
      service: 'Hearthwick Maps',
      mismatches: [
        { field: 'hours', listing: 'Mon 9 to 5', website: 'Mon 10 to 6' },
        { field: 'name', listing: 'Cycle Works', website: 'Hearthwick Cycle Works' },
      ],
    },
    source: urlSource('Hearthwick Maps', 'https://maps.example/both'),
    ...website(),
  };
  const findings = [
    both,
    problemByRank(2, 'phone-1'),
    problemByRank(5, 'listing-1'),
    problemByRank(6, 'site-1'),
    problemByRank(9, 'reviews-1'),
    problemByRank(13, 'title-1'),
  ];
  const { markdown, json } = render(doc(shuffle(findings, 9)));
  assert.equal(json.fixList.length, 5);
  assert.equal(json.alsoFound.length, 1);
  assert.equal(json.summary[0], 'We found 6 things to fix.');
  assert.match(markdown, /We found 6 things to fix\./);
  assert.equal(json.fixList[0].id, 'hours-and-name');
  assert.equal(json.fixList[0].problems.length, 2);
  const first = sectionsOf(markdown).get('Fix these first');
  assert.match(first, /different hours/);
  assert.match(first, /writes the name differently/);
  assert.equal(first.match(/^\d+\. /gm).length, 5);
  assert.equal(sectionsOf(markdown).get('Also found').match(/^\d+\. /gm).length, 1);
  assert.equal(json.fixList.concat(json.alsoFound).reduce((sum, item) => sum + item.problems.length, 0), 7);
});

test('a finding checked 31 days before is marked stale and 30 days is not', () => {
  const older = render(doc([{ ...problemByRank(5, 'old'), checkedOn: '2026-09-20' }]));
  const newer = render(doc([{ ...problemByRank(5, 'fresh'), checkedOn: '2026-09-21' }]));
  assert.match(older.markdown, /Check again before acting: found \*2026-09-20\*\./);
  assert.equal(older.json.fixList[0].stale, true);
  assert.doesNotMatch(newer.markdown, /Check again before acting/);
  assert.equal(newer.json.fixList[0].stale, false);
});

test('unknown findings are only under Couldn\'t check and ok findings only under What\'s working', () => {
  const { markdown } = render(doc([
    problemByRank(5, 'problem-1'),
    {
      id: 'unknown-1',
      check: 'listing-present',
      status: 'unknown',
      details: { service: 'Northglass Directory' },
      source: urlSource('Northglass Directory', 'https://northglass.example/list'),
      checkedOn: RECENT,
    },
    {
      id: 'working-1',
      check: 'listing-present',
      status: 'ok',
      details: { service: 'Hearthwick Maps', present: true },
      source: urlSource('Hearthwick Maps'),
      checkedOn: RECENT,
    },
  ]));
  const sections = sectionsOf(markdown);
  assert.match(sections.get("Couldn't check"), /unknown-1|Northglass Directory/);
  assert.match(sections.get("What's working"), /Hearthwick Maps has a listing/);
  assert.doesNotMatch(sections.get('Fix these first'), /could not be checked|has a listing for this business/);
  assert.doesNotMatch(sections.get("Couldn't check"), /has a listing for this business|has no listing/);
  assert.doesNotMatch(sections.get("What's working"), /could not be checked|has no listing/);
});

test('every section cites the source and the date', () => {
  const { markdown } = render(doc([
    {
      id: 'fix-url',
      ...problemByRank(5, 'fix-url'),
      source: urlSource('Fix Label', 'https://maps.example/fix'),
      checkedOn: '2026-10-11',
    },
    {
      id: 'also-locator',
      ...problemByRank(15, 'also-locator'),
      source: locatorSource('Also Label', 'Asked at the shop desk.'),
      checkedOn: '2026-10-12',
    },
    problemByRank(8, 'third'),
    problemByRank(9, 'fourth'),
    problemByRank(11, 'fifth'),
    {
      id: 'unknown-locator',
      check: 'reviews',
      status: 'unknown',
      details: { service: 'Hearthwick Maps' },
      source: locatorSource('Unknown Label', 'The review page would not open.'),
      checkedOn: '2026-10-13',
    },
    {
      id: 'working-url',
      check: 'ai-mention',
      status: 'ok',
      details: {
        assistant: 'Askwell',
        question: 'Who repairs bikes in Hearthwick?',
        result: 'mentioned',
      },
      source: urlSource('Working Label', 'https://askwell.example/ok'),
      checkedOn: '2026-10-14',
    },
    {
      id: 'compare-1',
      ...problemByRank(1, 'compare-1'),
      source: urlSource('Listing Label', 'https://maps.example/compare'),
      checkedOn: '2026-10-15',
      websiteSource: locatorSource('Website Label', 'The hours page on the shop site.'),
      websiteCheckedOn: '2026-10-16',
    },
  ]));
  const sections = sectionsOf(markdown);
  const fix = sections.get('Fix these first');
  const also = sections.get('Also found');
  const unknown = sections.get("Couldn't check");
  const working = sections.get("What's working");
  assert.match(fix, /Fix Label \(\[link\]\(<https:\/\/maps\.example\/fix>\)\), checked 2026-10-11\./);
  assert.match(fix, /Listing: Listing Label \(\[link\]\(<https:\/\/maps\.example\/compare>\)\) \(2026-10-15\); website: Website Label \("The hours page on the shop site\."\) \(2026-10-16\)\./);
  assert.match(also, /Also Label \("Asked at the shop desk\."\), checked 2026-10-12\./);
  assert.match(unknown, /Unknown Label \("The review page would not open\."\), checked 2026-10-13\./);
  assert.match(working, /Working Label \(\[link\]\(<https:\/\/askwell\.example\/ok>\)\), checked 2026-10-14\./);
  for (const [name, text] of sections) {
    assert.match(text, /checked |\(20/, name);
  }
});

test('the schema refuses malformed findings without copying them into the report', () => {
  const marker = 'MARKER-do-not-copy-7f3c';
  const refused = expectRefuse(doc([{ ...problemByRank(5, 'ok-id'), marker }]), /unknown field "findings\[0\]\.marker"/);
  assert.equal(refused.stderr.includes(marker), false);
  assert.equal(refused.stdout.includes(marker), false);
  expectRefuse(doc([{ ...problemByRank(5, 'kind-1'), check: 'not-a-kind' }]), /unknown check kind "not-a-kind"/);
  const missingDate = doc([problemByRank(5, 'date-1')]);
  delete missingDate.reportDate;
  expectRefuse(missingDate, /missing reportDate/);
  expectRefuse(doc([{ ...problemByRank(5, 'late'), checkedOn: '2026-10-22' }]), /checkedOn "2026-10-22" is after reportDate/);
  expectRefuse(doc([{ ...problemByRank(5, 'http'), source: urlSource('Maps', 'http://maps.example/shop') }]), /is not an https:\/\/ address/);
  expectRefuse(doc([{ ...problemByRank(5, 'bad-host'), source: urlSource('Maps', 'https://[not-a-host') }]), /Finding "bad-host" field findings\[0\]\.source\.url is not an https:\/\/ address/);
  expectRefuse(doc([{ ...problemByRank(5, 'bad-port'), source: urlSource('Maps', 'https://example.com:bad') }]), /Finding "bad-port" field findings\[0\]\.source\.url is not an https:\/\/ address/);
  for (const status of ['ok', 'problem', 'unknown']) {
    const details = status === 'unknown'
      ? { service: 'Hearthwick Maps' }
      : { service: 'Hearthwick Maps', present: status === 'ok' };
    expectRefuse(doc([{
      id: `bare-${status}`,
      check: 'listing-present',
      status,
      details,
      source: { label: 'Hearthwick Maps' },
      checkedOn: RECENT,
    }]), new RegExp(`Finding "bare-${status}" needs a source url or a locator`));
  }
  expectRefuse(doc([
    problemByRank(5, 'same-id'),
    problemByRank(6, 'same-id'),
  ]), /The id "same-id" is repeated/);
  expectRefuse(doc([{ ...problemByRank(5, ''), id: '' }]), /The id "" is empty/);
  expectRefuse(doc([{ ...problemByRank(5, 'a'.repeat(65)), id: 'a'.repeat(65) }]), /65 characters/);
  expectRefuse(doc([{ ...problemByRank(5, 'a b'), id: 'a b' }]), /The id "a b"/);
  expectRefuse(doc([{ ...problemByRank(5, 'a/b'), id: 'a/b' }]), /The id "a\/b"/);
  expectRefuse(doc([{ ...problemByRank(5, 'n'), id: 12 }]), /The id 12 must be a string/);
  const tied = ['item-10', 'item-9', 'B-2', 'a-1'].map((id) => problemByRank(5, id));
  const { json } = render(doc(tied));
  assert.deepEqual(json.fixList.map((item) => item.id), ['B-2', 'a-1', 'item-10', 'item-9']);
  assert.ok('B-2' < 'a-1' && 'a-1' < 'item-10' && 'item-10' < 'item-9');
});

test('dates must be real calendar dates', () => {
  const bad = ['2026-02-30', '2026-13-01', '2026-02-29', '2026-00-10', '2026-1-05', '2026-01-05T00:00'];
  for (const value of bad) {
    expectRefuse(doc([problemByRank(5, 'd')], { reportDate: value }), new RegExp(`reportDate "${value}"`));
    expectRefuse(doc([{ ...problemByRank(5, 'd'), checkedOn: value }]), new RegExp(`checkedOn "${value}"`));
    expectRefuse(doc([{ ...problemByRank(1, 'd'), websiteCheckedOn: value }]), new RegExp(`websiteCheckedOn "${value}"`));
  }
  const accepted = render(doc([{
    ...problemByRank(1, 'leap'),
    checkedOn: '2028-02-29',
    websiteCheckedOn: '2028-02-29',
  }], { reportDate: '2028-02-29' }));
  assert.equal(accepted.json.reportDate, '2028-02-29');
});

test('listing comparisons cite both sides and keep websiteSource to that kind', () => {
  const missing = problemByRank(1, 'missing-site');
  delete missing.websiteSource;
  expectRefuse(doc([missing]), /missing websiteSource/);
  expectRefuse(doc([{
    ...problemByRank(1, 'bare-site'),
    websiteSource: { label: 'Shop site' },
  }]), /needs a websiteSource url or a locator/);
  expectRefuse(doc([{
    ...problemByRank(1, 'late-site'),
    websiteCheckedOn: '2026-10-22',
  }]), /websiteCheckedOn "2026-10-22" is after reportDate/);
  expectRefuse(doc([{
    ...problemByRank(5, 'extra-site'),
    websiteSource: urlSource('Shop site', 'https://hearthwick-cycles.example/'),
    websiteCheckedOn: RECENT,
  }]), /includes websiteSource/);
  const { markdown, json } = render(doc([{
    ...problemByRank(1, 'both-sides'),
    checkedOn: '2026-10-20',
    websiteCheckedOn: '2026-09-20',
  }]));
  assert.match(markdown, /Listing: Hearthwick Maps \(\[link\]\(<https:\/\/maps\.example\/shop>\)\) \(2026-10-20\); website: Shop site \(\[link\]\(<https:\/\/hearthwick-cycles\.example\/>\)\) \(2026-09-20\)\./);
  assert.match(markdown, /Check again before acting: found \*2026-09-20\*\./);
  assert.equal(json.fixList[0].stale, true);
});

test('the renderer wording has no grades, promises, or alarm words', () => {
  for (const sentence of fixedWording()) {
    for (const pattern of FORBIDDEN) assert.equal(pattern.test(sentence), false, `${sentence} matches ${pattern}`);
  }
  const { markdown, json } = render(doc([
    problemByRank(1, 'neutral-1'),
    problemByRank(5, 'neutral-2'),
    {
      id: 'neutral-ok',
      check: 'reviews',
      status: 'ok',
      details: { service: 'Hearthwick Maps', count: 12, last90Days: 2, unanswered: 0 },
      source: urlSource('Hearthwick Maps'),
      checkedOn: RECENT,
    },
  ]));
  for (const pattern of FORBIDDEN) {
    assert.equal(pattern.test(markdown), false, pattern);
    assert.equal(pattern.test(JSON.stringify(json)), false, pattern);
  }
  const shown = render(doc([{
    id: 'score-bikes',
    check: 'listing-present',
    status: 'problem',
    details: { service: 'Hearthwick Maps', present: false },
    source: locatorSource('Score Bikes desk', 'Asked Askwell about the review score.'),
    checkedOn: RECENT,
  }], { name: 'Score Bikes' }));
  assert.match(shown.markdown, /Score Bikes/);
  assert.match(shown.markdown, /review score/);
});

test('hostile finding text cannot add a link, heading, or tag', () => {
  const tricky = 'https://a.example/x) <y> [z](https://evil.example\\a';
  const { markdown } = render(doc([
    {
      id: 'hostile',
      check: 'ai-mention',
      status: 'problem',
      details: {
        assistant: 'Askwell',
        question: 'Who repairs bikes in Hearthwick?',
        result: 'wrong-details',
        wrongDetails: '[link](https://evil.example) # heading <img src=x> ~~Sale~~',
      },
      source: urlSource('Askwell', tricky),
      checkedOn: RECENT,
    },
    {
      id: 'query',
      ...problemByRank(5, 'query'),
      source: urlSource('Query Label', 'https://a.example/x?a=1&b=2'),
    },
    {
      id: 'entity-url',
      ...problemByRank(6, 'entity-url'),
      source: urlSource('Entity Label', 'https://a.example/x&copy;'),
    },
  ], { name: 'AT&T &copy; Cycles' }));
  assert.match(markdown, /`\[link\]\(https:\/\/evil\.example\)`/);
  assert.match(markdown, /\\# heading/);
  assert.match(markdown, /&lt;img src=x&gt;/);
  assert.match(markdown, /\\~\\~Sale\\~\\~/);
  assert.match(markdown, /<https:\/\/a\.example\/x%29%20%3Cy%3E%20\[z\]%28https:\/\/evil\.example%5Ca>/);
  const view = analyze(markdown);
  assert.equal(view.html.includes('<img'), false);
  assert.equal(view.html.includes('©'), false);
  assert.equal(view.hrefs.length, 3);
  assert.equal(view.hrefs.some((href) => href.endsWith('?a=1&b=2')), true);
  assert.equal(view.hrefs.some((href) => href.includes('&copy;')), true);
  assert.equal(view.chunks.some((chunk) => chunk.type === 'text' && chunk.content.includes('©')), false);
  assert.equal(view.html.includes('<s>'), false);
  assert.equal(view.html.includes('<del>'), false);
  assert.match(view.html, /~~Sale~~/);
});

test('bare web and email addresses stay plain text', () => {
  const locator = 'https://evil.example/x www.evil.example owner@evil.example mailto:owner@evil.example https://evil.example/a&copy; `owner@evil.example`';
  const { markdown } = render(doc([
    {
      id: 'bare',
      check: 'ai-mention',
      status: 'problem',
      details: {
        assistant: 'Askwell',
        question: 'Who keeps the books?',
        result: 'wrong-details',
        wrongDetails: locator,
      },
      source: locatorSource('AT&T &copy; desk', `Note &copy; from AT&T. ${locator}`),
      checkedOn: RECENT,
    },
    problemByRank(5, 'only-link'),
  ], { name: 'AT&T &copy; Cycles' }));
  for (const word of [
    'https://evil.example/x',
    'www.evil.example',
    'owner@evil.example',
    'mailto:owner@evil.example',
  ]) {
    assert.match(markdown, new RegExp(`\`${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
  }
  assert.match(markdown, /`` `owner@evil\.example` ``/);
  assert.match(markdown, /`https:\/\/evil\.example\/a&copy;`/);
  const view = analyze(markdown);
  assert.deepEqual(view.hrefs, ['https://northglass.example/list']);
  assert.equal(view.chunks.some((chunk) => chunk.type === 'code_inline' && chunk.content.includes('&copy;')), true);
  assert.equal(view.chunks.some((chunk) => chunk.content.includes('©')), false);
  const text = view.chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.content).join('\n');
  assert.match(text, /AT&T/);
  assert.match(text, /&copy;/);
});

test('builtin modules match the Node 22 snapshot', () => {
  assert.deepEqual(snapshot.map((entry) => entry.name), [...builtinModules].sort());
  const allowed = new Set(['network or process: stubbed above', 'no network']);
  for (const entry of snapshot) assert.equal(allowed.has(entry.mark), true, entry.name);
  const marked = snapshot
    .filter((entry) => entry.mark === 'network or process: stubbed above')
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(marked, [...STUBBED_MODULES].sort());
});

test('fetch is blocked', () => {
  assert.throws(() => fetch('https://example.com'), /Network blocked: fetch/);
  clearNetworkCalls();
});

test('net.connect is blocked', async () => {
  const net = await import('node:net');
  assert.throws(() => net.connect(80, '127.0.0.1'), /Network blocked: net\.connect/);
  clearNetworkCalls();
});

test('stubbed entry points throw before they can connect', async () => {
  const net = await import('node:net');
  const tls = await import('node:tls');
  const http = await import('node:http');
  const https = await import('node:https');
  const http2 = await import('node:http2');
  const dgram = await import('node:dgram');
  const dns = await import('node:dns');
  const dnsPromises = await import('node:dns/promises');
  const inspector = await import('node:inspector');
  const inspectorPromises = await import('node:inspector/promises');
  const childProcess = await import('node:child_process');
  const cluster = await import('node:cluster');
  const workerThreads = await import('node:worker_threads');
  assert.throws(() => net.createConnection(), /Network blocked/);
  assert.throws(() => new net.Socket().connect(1, '127.0.0.1'), /Network blocked/);
  assert.throws(() => new net.Server().listen(0), /Network blocked: net\.Server\.prototype\.listen/);
  assert.throws(() => http.createServer().listen(0), /Network blocked: net\.Server\.prototype\.listen/);
  assert.throws(() => https.createServer().listen(0), /Network blocked: net\.Server\.prototype\.listen/);
  assert.throws(() => tls.createServer().listen(0), /Network blocked: net\.Server\.prototype\.listen/);
  assert.throws(() => http2.createServer().listen(0), /Network blocked: net\.Server\.prototype\.listen/);
  assert.throws(() => tls.connect(443, 'example.com'), /Network blocked/);
  assert.throws(() => tls.TLSSocket.prototype.connect.call({}), /Network blocked/);
  assert.throws(() => http.get('http://127.0.0.1'), /Network blocked/);
  assert.throws(() => http.request('http://127.0.0.1'), /Network blocked/);
  assert.throws(() => https.get('https://127.0.0.1'), /Network blocked/);
  assert.throws(() => https.request('https://127.0.0.1'), /Network blocked/);
  assert.throws(() => http2.connect('https://127.0.0.1'), /Network blocked/);
  assert.throws(() => dgram.createSocket('udp4'), /Network blocked/);
  assert.throws(() => dgram._createSocketHandle('udp4'), /Network blocked: dgram\._createSocketHandle/);
  assert.throws(() => new dgram.Socket('udp4'), /Network blocked: dgram\.Socket/);
  assert.throws(() => dgram.Socket.prototype.bind.call({}, 0), /Network blocked: dgram\.Socket\.prototype\.bind/);
  assert.throws(() => dgram.Socket.prototype.send.call({}, 'x'), /Network blocked: dgram\.Socket\.prototype\.send/);
  assert.throws(() => dgram.Socket.prototype.connect.call({}, 9, '127.0.0.1'), /Network blocked: dgram\.Socket\.prototype\.connect/);
  assert.throws(() => dns.lookup('example.com', () => {}), /Network blocked/);
  assert.throws(() => dns.resolve('example.com', () => {}), /Network blocked/);
  assert.throws(() => dnsPromises.lookup('example.com'), /Network blocked/);
  assert.throws(() => new dnsPromises.Resolver().resolve4('example.com'), /Network blocked: dns\/promises\.Resolver\.prototype\.resolve4/);
  assert.throws(() => new dnsPromises.Resolver().resolve('example.com'), /Network blocked: dns\/promises\.Resolver\.prototype\.resolve/);
  assert.throws(() => new dns.promises.Resolver().resolve4('example.com'), /Network blocked: dns\/promises\.Resolver\.prototype\.resolve4/);
  assert.throws(() => new dns.Resolver().resolve4('example.com', () => {}), /Network blocked: dns\.Resolver\.prototype\.resolve4/);
  assert.throws(() => dns.reverse('127.0.0.1', () => {}), /Network blocked: dns\.reverse/);
  assert.throws(() => dns.lookupService('127.0.0.1', 443, () => {}), /Network blocked: dns\.lookupService/);
  assert.throws(() => dns.promises.reverse('127.0.0.1'), /Network blocked: dns\/promises\.reverse/);
  assert.throws(() => dns.promises.lookupService('127.0.0.1', 443), /Network blocked: dns\/promises\.lookupService/);
  assert.throws(() => dnsPromises.reverse('127.0.0.1'), /Network blocked: dns\/promises\.reverse/);
  assert.throws(() => dnsPromises.lookupService('127.0.0.1', 443), /Network blocked: dns\/promises\.lookupService/);
  assert.throws(() => new dns.Resolver().reverse('127.0.0.1', () => {}), /Network blocked: dns\.Resolver\.prototype\.reverse/);
  assert.throws(() => new dnsPromises.Resolver().reverse('127.0.0.1'), /Network blocked: dns\/promises\.Resolver\.prototype\.reverse/);
  assert.throws(() => new dns.promises.Resolver().reverse('127.0.0.1'), /Network blocked: dns\/promises\.Resolver\.prototype\.reverse/);
  assert.throws(() => inspector.open(), /Network blocked/);
  assert.throws(() => inspectorPromises.open(), /Network blocked/);
  assert.throws(() => childProcess.spawn('true'), /Network blocked/);
  assert.throws(() => new childProcess.ChildProcess().spawn({ file: 'true', args: ['true'] }), /Network blocked: child_process\.ChildProcess\.prototype\.spawn/);
  const builtinChild = process.getBuiltinModule('child_process');
  const builtinChildNode = process.getBuiltinModule('node:child_process');
  assert.throws(() => builtinChild.spawn('true'), /Network blocked: child_process\.spawn/);
  assert.throws(() => new builtinChildNode.ChildProcess().spawn({ file: 'true', args: ['true'] }), /Network blocked: child_process\.ChildProcess\.prototype\.spawn/);
  assert.throws(() => process.getBuiltinModule('dns').lookup('example.com', () => {}), /Network blocked: dns\.lookup/);
  assert.throws(() => process.getBuiltinModule('node:dns/promises').resolve('example.com'), /Network blocked: dns\/promises\.resolve/);
  assert.throws(() => process.getBuiltinModule('dns').promises.lookup('example.com'), /Network blocked: dns\/promises\.lookup/);
  assert.throws(() => process.getBuiltinModule('dgram').createSocket('udp4'), /Network blocked: dgram\.createSocket/);
  assert.throws(() => new (process.getBuiltinModule('node:dgram').Socket)('udp4'), /Network blocked: dgram\.Socket/);
  assert.throws(() => process.getBuiltinModule('inspector').open(), /Network blocked: inspector\.open/);
  assert.throws(() => childProcess.exec('true'), /Network blocked/);
  assert.throws(() => childProcess.execFile('true'), /Network blocked/);
  assert.throws(() => childProcess.fork('true'), /Network blocked/);
  assert.throws(() => childProcess.spawnSync('true'), /Network blocked/);
  assert.throws(() => childProcess.execSync('true'), /Network blocked/);
  assert.throws(() => childProcess.execFileSync('true'), /Network blocked/);
  assert.throws(() => cluster.fork(), /Network blocked/);
  assert.throws(() => new workerThreads.Worker(new URL(import.meta.url)), /Network blocked/);
  assert.throws(() => new WebSocket('wss://example.com'), /Network blocked/);
  clearNetworkCalls();
});

test('the command reads no file other than the findings file', () => {
  const findings = path.join(root, 'fixtures/hearthwick-cycles.findings.json');
  readLog.length = 0;
  recordReads = true;
  try {
    const result = invoke(['--findings', findings]);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    recordReads = false;
  }
  assert.deepEqual(readLog, [{ kind: 'readFileSync', file: findings }]);
});

test('Windows and Windows-shaped output paths are refused', () => {
  const dir = tempDir();
  try {
    const findings = path.join(dir, 'findings.json');
    const bytes = Buffer.from('do-not-touch-findings');
    fs.writeFileSync(findings, bytes);
    const cases = [
      ['--json', 'C:\\cwd\\out', /backslash/],
      ['--md', 'C:out', /colon/],
      ['--json', 'out::$DATA', /colon/],
      ['--md', path.join(dir, 'out.'), /trailing dot/],
      ['--json', path.join(dir, 'out.json.'), /trailing dot/],
    ];
    for (const [flag, target, pattern] of cases) {
      const result = invoke(['--findings', findings, flag, target]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, pattern);
      assert.match(result.stderr, /macOS and Linux only/);
      assert.equal(result.stdout, '');
      assert.equal(fs.existsSync(path.join(dir, 'out.json')), false);
      assert.equal(fs.existsSync(path.join(dir, 'out.md')), false);
      assert.equal(fs.existsSync(path.join(dir, 'out.')), false);
      assert.deepEqual(fs.readFileSync(findings), bytes);
    }
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const result = invoke(['--findings', findings]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /This report runs on macOS and Linux only/);
      assert.equal(result.stdout, '');
      assert.deepEqual(fs.readFileSync(findings), bytes);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  } finally {
    cleanup(dir);
  }
});

test('a symlinked command path still counts as this program', () => {
  const dir = tempDir();
  try {
    const real = path.join(dir, 'report.mjs');
    fs.writeFileSync(real, '');
    const link = path.join(dir, 'report-link.mjs');
    const linkedDir = path.join(dir, 'linked-dir');
    fs.symlinkSync(real, link);
    fs.symlinkSync(dir, linkedDir);
    const moduleUrl = pathToFileURL(real).href;
    assert.equal(isMainModule(real, moduleUrl), true);
    assert.equal(isMainModule(link, moduleUrl), true);
    assert.equal(isMainModule(path.join(linkedDir, 'report.mjs'), moduleUrl), true);
    assert.equal(isMainModule(path.join(dir, 'other.mjs'), moduleUrl), false);
    assert.equal(isMainModule('', moduleUrl), false);
  } finally {
    cleanup(dir);
  }
});

test('output paths that name one file are refused and the findings file is unchanged', () => {
  const dir = tempDir();
  try {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data);
    const findings = path.join(data, 'findings.json');
    const bytes = Buffer.from('do-not-touch-findings');
    fs.writeFileSync(findings, bytes);
    const link = path.join(dir, 'linked.json');
    const hard = path.join(dir, 'hard.json');
    fs.symlinkSync(findings, link);
    fs.linkSync(findings, hard);
    const cases = [
      ['--json', findings, /--json to the findings file/],
      ['--md', findings, /--md to the findings file/],
      ['--json', path.join(data, '..', 'data', 'findings.json'), /--json to the findings file/],
      ['--md', path.join(data, '..', 'data', 'findings.json'), /--md to the findings file/],
      ['--json', link, /--json to the findings file/],
      ['--md', link, /--md to the findings file/],
      ['--json', hard, /--json to the findings file/],
      ['--md', hard, /--md to the findings file/],
      ['--json', path.join(data, 'FINDINGS.json'), /--json to the findings file/],
      ['--md', path.join(data, 'FINDINGS.json'), /--md to the findings file/],
    ];
    for (const [flag, target, pattern] of cases) {
      const result = invoke(['--findings', findings, flag, target]);
      assert.equal(result.code, 1, `${flag} ${target}: ${result.stderr}`);
      assert.match(result.stderr, pattern);
      assert.deepEqual(fs.readFileSync(findings), bytes);
    }
    const upper = path.join(dir, 'Out.md');
    const lower = path.join(dir, 'out.md');
    const same = invoke(['--findings', findings, '--json', upper, '--md', lower]);
    assert.equal(same.code, 1);
    assert.match(same.stderr, /--json and --md to the same file/);
    assert.equal(fs.existsSync(upper), false);
    assert.equal(fs.existsSync(lower), false);
    const identical = invoke(['--findings', findings, '--json', upper, '--md', upper]);
    assert.equal(identical.code, 1);
    assert.match(identical.stderr, /--json and --md to the same file/);
    const out = path.join(dir, 'out');
    const outLink = path.join(dir, 'out-link');
    fs.symlinkSync('out', outLink);
    const dangling = invoke(['--findings', findings, '--json', outLink, '--md', out]);
    assert.equal(dangling.code, 1, dangling.stderr);
    assert.match(dangling.stderr, /--json and --md to the same file/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.lstatSync(outLink).isSymbolicLink(), true);
    const chain = path.join(dir, 'chain');
    const mid = path.join(dir, 'mid');
    fs.symlinkSync('mid', chain);
    fs.symlinkSync('out', mid);
    const chained = invoke(['--findings', findings, '--md', chain, '--json', out]);
    assert.equal(chained.code, 1, chained.stderr);
    assert.match(chained.stderr, /--json and --md to the same file/);
    assert.equal(fs.existsSync(out), false);
    const nest = path.join(dir, 'nest');
    const realDir = path.join(nest, 'real');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync('real', path.join(nest, 'alias'));
    fs.symlinkSync(path.join('alias', 'out'), path.join(nest, 'out-link'));
    const realOut = path.join(realDir, 'out');
    const aliased = invoke(['--findings', findings, '--json', path.join(nest, 'out-link'), '--md', realOut]);
    assert.equal(aliased.code, 1, aliased.stderr);
    assert.match(aliased.stderr, /--json and --md to the same file/);
    assert.equal(fs.existsSync(realOut), false);
    fs.symlinkSync(path.join('alias', 'nested', 'out'), path.join(nest, 'deep-link'));
    const deepOut = path.join(realDir, 'nested', 'out');
    const deep = invoke(['--findings', findings, '--json', path.join(nest, 'deep-link'), '--md', deepOut]);
    assert.equal(deep.code, 1, deep.stderr);
    assert.match(deep.stderr, /--json and --md to the same file/);
    assert.equal(fs.existsSync(deepOut), false);
    const dot = path.join(dir, 'dotdot');
    const dotReal = path.join(dot, 'real');
    fs.mkdirSync(path.join(dotReal, 'sub'), { recursive: true });
    fs.symlinkSync('real/sub', path.join(dot, 'alias'));
    fs.symlinkSync('alias/../out', path.join(dot, 'out-link'));
    const dotOut = path.join(dotReal, 'out');
    const throughDots = invoke(['--findings', findings, '--json', path.join(dot, 'out-link'), '--md', dotOut]);
    assert.equal(throughDots.code, 1, throughDots.stderr);
    assert.match(throughDots.stderr, /--json and --md to the same file/);
    assert.equal(fs.existsSync(dotOut), false);
    const directDots = `${path.join(dot, 'alias')}/../out`;
    const direct = invoke(['--findings', findings, '--json', directDots, '--md', dotOut]);
    assert.equal(direct.code, 1, direct.stderr);
    assert.match(direct.stderr, /--json and --md to the same file/);
    assert.equal(fs.existsSync(dotOut), false);
    const repeat = path.join(dir, 'repeat');
    const repeatReal = path.join(repeat, 'real');
    fs.mkdirSync(repeatReal, { recursive: true });
    fs.symlinkSync('real', path.join(repeat, 'alias'));
    const repeatOut = path.join(repeatReal, 'out');
    const repeated = `${path.join(repeat, 'alias')}/../alias/out`;
    const again = invoke(['--findings', findings, '--json', repeated, '--md', repeatOut]);
    assert.equal(again.code, 1, again.stderr);
    assert.match(again.stderr, /--json and --md to the same file/);
    assert.equal(fs.existsSync(repeatOut), false);
    const nfc = path.join(dir, 'caf\u00e9.json');
    const nfd = path.join(dir, 'cafe\u0301.json');
    const folded = invoke(['--findings', findings, '--json', nfc, '--md', nfd]);
    assert.equal(folded.code, 1);
    assert.match(folded.stderr, /same file/);
    assert.equal(fs.existsSync(nfc), false);
    assert.equal(fs.existsSync(nfd), false);
    assert.deepEqual(fs.readFileSync(findings), bytes);
  } finally {
    cleanup(dir);
  }
});

test('details and status have to agree', () => {
  for (let rank = 1; rank <= 15; rank += 1) {
    const { json } = render(doc([problemByRank(rank, `rank-${rank}`)]));
    assert.equal(json.fixList[0].rank, rank);
    assert.equal(json.fixList[0].problems.length, 1);
  }
  const zero = render(doc([{
    id: 'zero-reviews',
    check: 'reviews',
    status: 'problem',
    details: { service: 'Hearthwick Maps', count: 0, last90Days: 0, unanswered: 0 },
    source: urlSource('Hearthwick Maps'),
    checkedOn: RECENT,
  }]));
  assert.equal(zero.json.fixList[0].rank, 10);
  assert.deepEqual(zero.json.fixList[0].problems.map((problem) => problem.rank), [10, 11]);
  assert.match(zero.markdown, /no reviews in the last 90 days/);
  assert.match(zero.markdown, /fewer than 10/);

  const flips = [
    ['listing-present', { service: 'Hearthwick Maps', present: true }, { service: 'Hearthwick Maps', present: false }],
    ['listing-details-match', { service: 'Hearthwick Maps', mismatches: [] }, {
      service: 'Hearthwick Maps',
      mismatches: [{ field: 'phone', listing: '555-0100', website: '555-0148' }],
    }],
    ['ai-mention', {
      assistant: 'Askwell',
      question: 'Who repairs bikes in Hearthwick?',
      result: 'mentioned',
    }, {
      assistant: 'Askwell',
      question: 'Who repairs bikes in Hearthwick?',
      result: 'not-mentioned',
    }],
    ['reviews', { service: 'Hearthwick Maps', count: 20, last90Days: 3, unanswered: 0 }, {
      service: 'Hearthwick Maps', count: 20, last90Days: 0, unanswered: 0,
    }],
    ['website-basics', {
      hasWebsite: true, title: true, description: true, contact: true, worksOnPhone: true,
    }, { hasWebsite: false }],
  ];
  for (const [check, okDetails, problemDetails] of flips) {
    const listing = check === 'listing-details-match' ? website() : {};
    expectRefuse(doc([{
      id: `${check}-bad-problem`,
      check,
      status: 'problem',
      details: okDetails,
      source: urlSource('Hearthwick Maps'),
      checkedOn: RECENT,
      ...listing,
    }]), new RegExp(`Finding "${check}-bad-problem" is marked "problem"`));
    expectRefuse(doc([{
      id: `${check}-bad-ok`,
      check,
      status: 'ok',
      details: problemDetails,
      source: urlSource('Hearthwick Maps'),
      checkedOn: RECENT,
      ...listing,
    }]), new RegExp(`Finding "${check}-bad-ok" is marked "ok"`));
  }

  expectRefuse(doc([{
    id: 'unknown-result',
    check: 'listing-present',
    status: 'unknown',
    details: { service: 'Hearthwick Maps', present: true },
    source: urlSource('Hearthwick Maps'),
    checkedOn: RECENT,
  }]), /unknown-result/);
  expectRefuse(doc([{
    id: 'missing-subject',
    check: 'reviews',
    status: 'unknown',
    details: {},
    source: urlSource('Hearthwick Maps'),
    checkedOn: RECENT,
  }]), /missing-subject/);
  expectRefuse(doc([{
    id: 'wrong-extra',
    check: 'ai-mention',
    status: 'ok',
    details: {
      assistant: 'Askwell',
      question: 'Who repairs bikes in Hearthwick?',
      result: 'mentioned',
      wrongDetails: 'This should not be here.',
    },
    source: urlSource('Askwell', 'https://askwell.example/x'),
    checkedOn: RECENT,
  }]), /wrong-extra[\s\S]*wrongDetails/);
  expectRefuse(doc([{
    ...problemByRank(1, 'repeat-phone'),
    details: {
      service: 'Hearthwick Maps',
      mismatches: [
        { field: 'phone', listing: '555-0100', website: '555-0148' },
        { field: 'phone', listing: '555-0101', website: '555-0199' },
      ],
    },
  }]), /repeat-phone[\s\S]*phone/);
  expectRefuse(doc([{
    id: 'too-many-recent',
    check: 'reviews',
    status: 'problem',
    details: { service: 'Hearthwick Maps', count: 2, last90Days: 3, unanswered: 0 },
    source: urlSource('Hearthwick Maps'),
    checkedOn: RECENT,
  }]), /too-many-recent[\s\S]*last90Days/);
  expectRefuse(doc([{
    id: 'title-without-site',
    check: 'website-basics',
    status: 'problem',
    details: { hasWebsite: false, title: false },
    source: urlSource('Shop site', 'https://hearthwick-cycles.example/'),
    checkedOn: RECENT,
  }]), /title-without-site[\s\S]*title/);
  expectRefuse(doc([{
    ...problemByRank(2, 'same-text'),
    details: {
      service: 'Lampblack Listings',
      mismatches: [{ field: 'phone', listing: '555-0148', website: '555-0148' }],
    },
  }]), /same-text[\s\S]*phone/);
  expectRefuse(doc([{
    ...problemByRank(2, 'padded-text'),
    details: {
      service: 'Lampblack Listings',
      mismatches: [{ field: 'phone', listing: '  555-0148', website: '555-0148  ' }],
    },
  }]), /padded-text[\s\S]*phone/);
});

test('displayed text refuses hidden characters and keeps a line feed inside the entry', () => {
  const chars = ['\u0000', '\t', '\r', '\u001b', '\u007f', '\u0085', '\u2028', '\u2029'];
  const bases = () => ({
    business: doc([problemByRank(5, 'text-1')]),
    label: doc([problemByRank(5, 'text-1')]),
    locator: doc([{
      ...problemByRank(5, 'text-1'),
      source: locatorSource('Desk', 'On the desk card.'),
    }]),
    url: doc([problemByRank(5, 'text-1')]),
    service: doc([problemByRank(5, 'text-1')]),
    assistant: doc([problemByRank(4, 'text-1')]),
    question: doc([problemByRank(4, 'text-1')]),
    wrongDetails: doc([problemByRank(4, 'text-1')]),
    listing: doc([problemByRank(1, 'text-1')]),
    website: doc([problemByRank(1, 'text-1')]),
  });
  const paths = {
    business: 'business.name',
    label: 'findings[0].source.label',
    locator: 'findings[0].source.locator',
    url: 'findings[0].source.url',
    service: 'findings[0].details.service',
    assistant: 'findings[0].details.assistant',
    question: 'findings[0].details.question',
    wrongDetails: 'findings[0].details.wrongDetails',
    listing: 'findings[0].details.mismatches[0].listing',
    website: 'findings[0].details.mismatches[0].website',
  };
  for (const ch of chars) {
    for (const key of Object.keys(paths)) {
      const value = bases()[key];
      const finding = value.findings[0];
      if (key === 'business') value.business.name = `Shop${ch}`;
      else if (key === 'label') finding.source.label = `Label${ch}`;
      else if (key === 'locator') finding.source.locator = `Place${ch}`;
      else if (key === 'url') finding.source.url = `https://a.example/x${ch}y`;
      else if (key === 'service') finding.details.service = `Service${ch}`;
      else if (key === 'assistant') finding.details.assistant = `Ask${ch}`;
      else if (key === 'question') finding.details.question = `Question${ch}`;
      else if (key === 'wrongDetails') finding.details.wrongDetails = `Wrong${ch}`;
      else if (key === 'listing') finding.details.mismatches[0].listing = `Mon${ch}`;
      else finding.details.mismatches[0].website = `Tue${ch}`;
      const result = expectRefuse(value, new RegExp(paths[key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      if (key !== 'business') assert.match(result.stderr, /text-1/);
    }
  }
  const lineFeed = doc([problemByRank(5, 'lf')]);
  lineFeed.business.name = 'Shop\nName';
  expectRefuse(lineFeed, /business\.name/);
  const kept = render(doc([
    {
      ...problemByRank(4, 'lines'),
      details: {
        assistant: 'Askwell',
        question: 'Who repairs bikes in Hearthwick?',
        result: 'wrong-details',
        wrongDetails: 'First line\n\nsecond\n# not-a-heading\n- not-a-list',
      },
    },
    {
      ...problemByRank(1, 'hours-lines'),
      details: {
        service: 'Hearthwick Maps',
        mismatches: [{
          field: 'hours',
          listing: 'Mon 9 to 5\n\nSat 10 to 2\n# not-a-heading\n- not-a-list',
          website: 'Mon 10 to 6',
        }],
      },
    },
  ]));
  for (const line of kept.markdown.split('\n')) {
    if (line.includes('not-a-heading')) assert.equal(/^#{1,6} /.test(line), false, line);
    if (line.includes('not-a-list')) assert.equal(/^[-*+] /.test(line), false, line);
  }
  assert.match(kept.markdown, /First line/);
  assert.match(kept.markdown, /Mon 9 to 5/);
  assert.match(kept.markdown, /second/);
  assert.match(kept.markdown, /Sat 10 to 2/);
  const view = analyze(kept.markdown);
  assert.equal(view.html.includes('<h1>not-a-heading'), false);
  assert.equal(view.html.includes('<pre>'), false);
  assert.equal(view.html.includes('<code>'), false);
  assert.match(view.html, /First line/);
  assert.match(view.html, /second/);
  assert.match(view.html, /Sat 10 to 2/);
  assert.match(view.html, /not-a-heading/);
  assert.match(kept.json.fixList[0].problems[0].sentences.join('\n'), /Mon 9 to 5\n\nSat 10 to 2/);
});

test('a findings file larger than 1 MB is refused', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'findings.json');
    fs.writeFileSync(file, Buffer.alloc(1_000_001, 0x61));
    const result = invoke(['--findings', file]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /larger than 1 MB/);
  } finally {
    cleanup(dir);
  }
});
