import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRound, reportJson, RoundError } from '../src/index.mjs';
import { dedupeProtectedPaths, pathsMatch, resetPathCache, volumeFoldsCase, volumeRules } from '../src/round.mjs';

const CLI = fileURLToPath(new URL('../src/check.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/OC-990101-sample-round.md', import.meta.url));
const EXPECTED_JSON = fileURLToPath(new URL('./expected/complete.json', import.meta.url));
const EXPECTED_MD = fileURLToPath(new URL('./expected/complete.md', import.meta.url));
const SESSION = 'OC-990101-sample-round';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MB = 1024 * 1024;

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function withDir(fn) {
  // macOS reports tmpdir under /tmp or /var, which are symbolic links. A
  // checklist path with that ancestor is refused, so start from the real path.
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'annotation-rounds-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRound(dir, body, name = `${SESSION}.md`) {
  const file = path.join(dir, name);
  writeFileSync(file, body.endsWith('\n') ? body : `${body}\n`);
  return file;
}

function writePng(file) {
  writeFileSync(file, PNG);
}

function item(number, extra = '') {
  return [
    `${number}. Screen: Desk`,
    'Element: Button',
    "Owner's words: Please change it.",
    'Change: Make the change.',
    extra,
  ].filter(Boolean).join('\n');
}

function messages(report) {
  return [
    ...report.problems.map(entry => entry.message),
    ...report.items.flatMap(entry => entry.problems.map(problem => problem.message)),
  ];
}

test('1. a complete round matches the saved checklist', () => {
  const first = checkRound(FIXTURE);
  const second = checkRound(FIXTURE);
  const json = reportJson(first.report);
  const expectedJson = readFileSync(EXPECTED_JSON, 'utf8');
  const expectedMd = readFileSync(EXPECTED_MD, 'utf8');
  assert.equal(json, expectedJson);
  assert.equal(first.markdown, expectedMd);
  assert.equal(json, reportJson(second.report));
  assert.equal(first.markdown, second.markdown);
  assert.equal(first.report.problems.length, 0);
  assert.equal(first.report.items.every(entry => entry.problems.length === 0), true);
  assert.equal(first.report.items[0].ownersWords, 'Too small.\nChange: bigger, please.');
  assert.equal(first.report.items[0].done, false);

  const before = readFileSync(FIXTURE);
  const printed = run([FIXTURE]);
  assert.equal(printed.status, 0);
  assert.equal(printed.stdout, expectedMd);
  assert.equal(printed.stderr, '');
  assert.deepEqual(readFileSync(FIXTURE), before);

  withDir(dir => {
    const jsonPath = path.join(dir, 'checklist.json');
    const mdPath = path.join(dir, 'checklist.md');
    const written = run([FIXTURE, '--json', jsonPath, '--md', mdPath]);
    assert.equal(written.status, 0);
    assert.equal(written.stdout, '');
    assert.equal(readFileSync(jsonPath, 'utf8'), expectedJson);
    assert.equal(readFileSync(mdPath, 'utf8'), expectedMd);
  });
});

test('2. missing and repeated fields are errors and neither value is kept', () => {
  withDir(dir => {
    const body = [
      '1. Element: Button',
      "Owner's words: Please.",
      'Change: Make the change.',
      '',
      '2. Screen: Desk',
      "Owner's words: Please.",
      'Change: Make the change.',
      '',
      '3. Screen: Desk',
      'Element: Button',
      'Change: Make the change.',
      '',
      '4. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      '',
      '5. Screen:',
      'Element:    ',
      "Owner's words: Please.",
      'Change: Make the change.',
      '',
      '6. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      'Change: Make it larger',
      'Change: Make it smaller',
      '',
      '7. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      'Change: Keep this one',
      'Requested change: Or this one',
      '',
      '8. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      'Change: Make the change.',
      'Screenshot: alpha-shot.png',
      'Screenshot: beta-shot.png',
    ].join('\n');
    const report = checkRound(writeRound(dir, body)).report;
    const text = messages(report);

    assert.ok(text.some(message => message.includes('Item 1') && message.includes('screen')));
    assert.ok(text.some(message => message.includes('Item 2') && message.includes('element')));
    assert.ok(text.some(message => message.includes('Item 3') && message.includes("owner's words")));
    assert.ok(text.some(message => message.includes('Item 4') && message.includes('change')));
    assert.equal(report.items[0].screen, null);
    assert.equal(report.items[1].element, null);
    assert.equal(report.items[2].ownersWords, null);
    assert.equal(report.items[3].change, null);
    assert.match(text.find(message => message.includes('Item 5')), /empty screen/);
    assert.match(text.find(message => message.includes('Item 5') && message.includes('element')), /empty element/);

    for (const index of [5, 6]) {
      const raw = JSON.stringify(report.items[index]);
      assert.equal(report.items[index].change, null);
      assert.equal(raw.includes('Make it larger'), false);
      assert.equal(raw.includes('Make it smaller'), false);
      assert.equal(raw.includes('Keep this one'), false);
      assert.equal(raw.includes('Or this one'), false);
      assert.ok(report.items[index].problems.some(problem => (
        problem.level === 'error' && problem.message.includes('label Change')
      )));
    }

    const shots = report.items[7];
    assert.deepEqual(shots.screenshots, []);
    const shotJson = JSON.stringify(shots);
    assert.equal(shotJson.includes('alpha-shot.png'), false);
    assert.equal(shotJson.includes('beta-shot.png'), false);
    assert.ok(shots.problems.some(problem => problem.message.includes('label Screenshot')));
  });
});

test('3. label variants read the same', () => {
  const variants = [
    [
      '1. Screen: Desk home',
      'Element: The button',
      "Owner's words: Too small.",
      'Change: Make it larger',
      `Screenshot: ${SESSION}-01.png`,
    ],
    [
      '1. **Screen:** Desk home',
      '**Element**: The button',
      "**Owner's words:** Too small.",
      '**Change:** Make it larger',
      `**Screenshot:** ${SESSION}-01.png`,
    ],
    [
      '1. __Screen__: Desk home',
      'ELEMENT: The button',
      'WORDS: Too small.',
      'REQUESTED CHANGE: Make it larger',
      `SCREENSHOTS: ${SESSION}-01.png`,
    ],
    [
      '1. screen Desk home',
      'Element or area: The button',
      'Owner said: Too small.',
      'requested change: Make it larger',
      `screenshot: ${SESSION}-01.png, ${SESSION}-001.png`,
    ],
    [
      '1. **Screen** Desk home',
      'AREA: The button',
      "**Owner's words**: Too small.",
      '**Requested change:** Make it larger',
      `**Screenshots**: ${SESSION}-01.png`,
    ],
  ];
  withDir(dir => {
    writePng(path.join(dir, `${SESSION}-01.png`));
    writePng(path.join(dir, `${SESSION}-001.png`));
    const reports = variants.map(lines => checkRound(writeRound(dir, lines.join('\n'))).report);
    for (const report of reports) {
      const item = report.items[0];
      assert.equal(item.screen, 'Desk home');
      assert.equal(item.element, 'The button');
      assert.equal(item.ownersWords, 'Too small.');
      assert.equal(item.change, 'Make it larger');
      assert.equal(item.screenshots[0].name, `${SESSION}-01.png`);
      assert.equal(item.screenshots[0].present, true);
      assert.equal(item.problems.length, 0);
    }
    assert.equal(reports[3].items[0].screenshots[1].name, `${SESSION}-001.png`);
    assert.equal(reports[3].items[0].screenshots[1].present, true);
  });
});

test('4. missing, unnamed, and shared screenshots', () => {
  withDir(dir => {
    writePng(path.join(dir, `${SESSION}-01.png`));
    writePng(path.join(dir, `${SESSION}-02.png`));
    const body = [
      item(1, `Screenshot: ${SESSION}-01.png`),
      item(2, `Screenshot: ${SESSION}-01.png`),
      item(3, `Screenshot: ${SESSION}-09.png`),
    ].join('\n\n');
    const { report } = checkRound(writeRound(dir, body));
    const shared = report.problems.find(problem => problem.message.includes('more than one item'));
    const unnamed = report.problems.find(problem => problem.message.includes('no item names it'));
    assert.equal(shared.level, 'warning');
    assert.match(shared.message, new RegExp(SESSION));
    assert.equal(unnamed.level, 'warning');
    assert.match(unnamed.message, new RegExp(`${SESSION}-02.png`));
    const missing = report.items[2].problems.find(problem => problem.message.includes('not present'));
    assert.equal(missing.level, 'error');
    assert.match(missing.message, new RegExp(`${SESSION}-09.png`));
    assert.equal(report.items[2].screenshots[0].present, false);
  });
});

test('5. a screenshot name must match the session and use at least two digits', () => {
  withDir(dir => {
    writePng(path.join(dir, 'OC-000000-other-01.png'));
    writePng(path.join(dir, `${SESSION}-1.png`));
    writePng(path.join(dir, `${SESSION}-01.jpg`));
    const body = item(1, [
      'Screenshot: OC-000000-other-01.png, ' + `${SESSION}-1.png, ${SESSION}-01.jpg`,
    ].join('\n'));
    const { report } = checkRound(writeRound(dir, body));
    const text = report.items[0].problems.map(problem => problem.message);
    assert.equal(text.length, 3);
    assert.match(text[0], /OC-000000-other-01.png/);
    assert.match(text[0], new RegExp(`${SESSION}-NN.png`));
    assert.match(text[1], /at least two digits/);
    assert.match(text[2], /OC-990101-sample-round-01.jpg/);
    assert.equal(text.some(message => message.includes('not present')), false);
  });
});

test('6. unsafe names and non-files are not read as present screenshots', () => {
  withDir(dir => {
    const outsideDir = path.join(path.dirname(dir), `outside-${path.basename(dir)}`);
    mkdirSync(outsideDir);
    const outside = path.join(outsideDir, 'x.png');
    const secret = Buffer.concat([PNG, Buffer.from('SECRET-OUTSIDE-BYTES')]);
    writeFileSync(outside, secret);
    try {
      symlinkSync(outside, path.join(dir, `${SESSION}-01.png`));
      mkdirSync(path.join(dir, `${SESSION}-02.png`));
      writeFileSync(path.join(dir, `${SESSION}-03.png`), Buffer.from('not a png!!'));
      mkdirSync(path.join(dir, `${SESSION}-04.png`));
      const absolute = path.join(outsideDir, 'absolute.png');
      writeFileSync(absolute, secret);
      const body = [
        item(1, `Screenshot: ../${path.basename(outsideDir)}/x.png`),
        item(2, `Screenshot: ${absolute}`),
        item(3, 'Screenshot: shots/a.png'),
        item(4, `Screenshot: ${SESSION}-01.png, ${SESSION}-02.png, ${SESSION}-03.png`),
      ].join('\n\n');
      const { report, markdown } = checkRound(writeRound(dir, body));
      const raw = JSON.stringify(report) + markdown;
      assert.equal(raw.includes('SECRET-OUTSIDE-BYTES'), false);
      for (const entry of report.items.slice(0, 3)) {
        assert.equal(entry.screenshots[0].present, false);
        assert.match(entry.problems[0].message, /plain file name/);
      }
      for (const shot of report.items[3].screenshots) {
        assert.equal(shot.present, false);
        assert.match(report.items[3].problems.find(problem => problem.message.includes(shot.name)).message, /not present/);
      }
      const unnamed = checkRound(writeRound(dir, item(1))).report;
      assert.equal(unnamed.problems.some(problem => problem.message.includes(`${SESSION}-01.png`)), false);
      assert.equal(unnamed.problems.some(problem => problem.message.includes(`${SESSION}-04.png`)), false);
      assert.deepEqual(readFileSync(outside), secret);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test('7. repeated, skipped, and out-of-order item numbers', () => {
  withDir(dir => {
    const repeated = checkRound(writeRound(dir, `${item(1)}\n\n${item(1)}`)).report;
    assert.ok(repeated.problems.some(problem => problem.message === 'Item number 1 is repeated.'));
    assert.equal(repeated.problems.some(problem => problem.message.includes('skipped')), false);
    assert.equal(repeated.problems.some(problem => problem.message.includes('out of order')), false);

    const skipped = checkRound(writeRound(dir, `${item(1)}\n\n${item(3)}`)).report;
    assert.ok(skipped.problems.some(problem => problem.message === 'Item number 2 is skipped.'));
    assert.equal(skipped.problems.some(problem => problem.message.includes('out of order')), false);

    const ordered = checkRound(writeRound(dir, `${item(1)}\n\n${item(3)}\n\n${item(2)}`)).report;
    assert.deepEqual(ordered.items.map(entry => entry.number), [1, 3, 2]);
    assert.ok(ordered.problems.some(problem => problem.message === 'Item number 2 is out of order.'));
    assert.equal(ordered.problems.some(problem => problem.message.includes('skipped')), false);

    const startsLate = checkRound(writeRound(dir, `${item(2)}\n\n${item(3)}`)).report;
    assert.ok(startsLate.problems.some(problem => problem.message === 'Item number 1 is skipped.'));

    const earlyLater = checkRound(writeRound(dir, [item(1), item(10), item(3)].join('\n\n'))).report;
    const skipTwo = earlyLater.problems.find(problem => problem.message === 'Item number 2 is skipped.');
    assert.equal(skipTwo.line, 6);
    const skipRange = earlyLater.problems.find(problem => problem.message === 'Item number 4 is skipped.');
    assert.equal(skipRange.line, 6);
  });
});

test('8. a line that cannot be read is reported and the rest is checked', () => {
  withDir(dir => {
    const body = [
      item(1),
      'Hello there',
      item(2),
    ].join('\n');
    const { report } = checkRound(writeRound(dir, body));
    const unread = report.problems.find(problem => problem.message.includes('Could not read'));
    assert.equal(unread.level, 'error');
    assert.match(unread.message, /Could not read line \d+\./);
    assert.equal(typeof unread.line, 'number');
    assert.equal(report.items.length, 2);
    assert.equal(report.items[0].screen, 'Desk');
    assert.equal(report.items[1].change, 'Make the change.');
    assert.equal(report.items[0].problems.length, 0);
    assert.equal(report.items[1].problems.length, 0);

    const proseItem = checkRound(writeRound(dir, '1. The button is too small and should be bigger\n', 'prose-item.md')).report;
    assert.ok(proseItem.problems.some(problem => problem.message === 'Could not read line 1.'));
    assert.equal(proseItem.items.length, 1);
    assert.equal(proseItem.items[0].screen, null);
  });
});

test('9. hostile field text is escaped in Markdown and exact in JSON', () => {
  const hostile = [
    '- [x] fake item',
    '# heading',
    '[link](https://example.test)',
    '![logo](https://example.test/logo.png)',
    '<script>alert(1)</script>',
  ].join('\n');
  withDir(dir => {
    const body = [
      '1. Screen: <script>alert(1)</script>',
      'Element: [link](https://example.test)',
      `Owner's words: ${hostile.split('\n')[0]}`,
      `  ${hostile.split('\n')[1]}`,
      `  ${hostile.split('\n')[2]}`,
      `  ${hostile.split('\n')[3]}`,
      `  ${hostile.split('\n')[4]}`,
      'Change: - [x] fake item',
    ].join('\n');
    const { report, markdown } = checkRound(writeRound(dir, body));
    assert.equal(report.items[0].screen, '<script>alert(1)</script>');
    assert.equal(report.items[0].element, '[link](https://example.test)');
    assert.equal(report.items[0].ownersWords, hostile);
    assert.equal(report.items[0].change, '- [x] fake item');

    const lines = markdown.split('\n');
    assert.deepEqual(
      lines.filter(line => /^#{1,6} /.test(line)),
      [`# ${SESSION}`, '## Before you start'],
    );
    assert.equal(lines.filter(line => line.startsWith('- [ ]')).length, 1);
    assert.equal(lines.some(line => line.startsWith('- [x]')), false);
    assert.equal(lines.some(line => line.trim() === '# heading'), false);
    assert.equal(markdown.includes('<script>'), false);
    assert.equal(markdown.includes('[link](https://example.test)'), false);
    assert.equal(markdown.includes('![logo]'), false);
    assert.equal(markdown.includes('&lt;script&gt;'), true);
    assert.equal(markdown.includes('\\[link\\](https:\\/\\/example.test)'), true);
    assert.equal(markdown.includes('\\!\\[logo\\]'), false);
    assert.equal(markdown.includes('!\\[logo\\]'), true);
    assert.equal(markdown.includes('://'), false);

    const bare = [
      '1. Screen: https://example.test/desk',
      'Element: owner@example.test',
      "Owner's words: See www.example.test",
      'Change: Mail me at owner@example.test',
      'Screenshot: https://cdn.example.test/shot.png',
    ].join('\n');
    const linked = checkRound(writeRound(dir, bare, 'bare.md'));
    assert.equal(linked.report.items[0].screen, 'https://example.test/desk');
    assert.equal(linked.report.items[0].element, 'owner@example.test');
    assert.equal(linked.report.items[0].ownersWords, 'See www.example.test');
    assert.equal(linked.report.items[0].change, 'Mail me at owner@example.test');
    assert.equal(linked.report.items[0].screenshots[0].name, 'https://cdn.example.test/shot.png');
    assert.equal(linked.markdown.includes('://'), false);
    assert.equal(linked.markdown.includes('owner@example.test'), false);
    assert.equal(linked.markdown.includes('www.example.test'), false);
    assert.equal(linked.markdown.includes('https:\\/\\/example.test/desk'), true);
    assert.equal(linked.markdown.includes('owner\\@example.test'), true);
    assert.equal(linked.markdown.includes('www\\.example.test'), true);
    assert.equal(linked.markdown.includes('https:\\/\\/cdn.example.test/shot.png'), true);

    const preescaped = checkRound(writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      String.raw`Owner's words: \[click\](/target)`,
      'Change: Make the change.',
    ].join('\n'), 'slashes.md'));
    assert.equal(preescaped.report.items[0].ownersWords, String.raw`\[click\](/target)`);
    assert.equal(preescaped.markdown.includes(String.raw`\\\[click\\\](/target)`), true);
    assert.equal(preescaped.markdown.includes('[click](/target)'), false);

    const fenced = checkRound(writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: See this",
      '  ```js',
      '  ~~~',
      '  still words',
      'Change: Make the change.',
    ].join('\n'), 'fence.md'));
    assert.equal(fenced.report.items[0].ownersWords, 'See this\n```js\n~~~\nstill words');
    assert.equal(fenced.report.items[0].change, 'Make the change.');
    assert.equal(/^\s*`{3,}/m.test(fenced.markdown), false);
    assert.equal(/^\s*~{3,}/m.test(fenced.markdown), false);
    assert.equal(fenced.markdown.includes('\\```js'), true);
    assert.equal(fenced.markdown.includes('\\~~~'), true);

    const ruled = checkRound(writeRound(dir, [
      '1. Screen: Desk title',
      '  ===',
      'Element: Button',
      '  ---',
      "Owner's words: Please.",
      'Change: Make the change.',
      '  ***',
      '  ___',
      '  - - -',
    ].join('\n'), 'rules.md'));
    assert.equal(ruled.report.items[0].screen, 'Desk title\n===');
    assert.equal(ruled.report.items[0].element, 'Button\n---');
    assert.equal(ruled.report.items[0].change, 'Make the change.\n***\n___\n- - -');
    assert.equal(/^\s*(=+|-+)\s*$/m.test(ruled.markdown), false);
    assert.equal(/^\s*([-*_])(?:\s*\1){2,}\s*$/m.test(ruled.markdown), false);
    assert.equal(ruled.markdown.includes('\\==='), true);
    assert.equal(ruled.markdown.includes('\\---'), true);
    assert.equal(ruled.markdown.includes('\\***'), true);
    assert.equal(ruled.markdown.includes('\\___'), true);

    const ordered = checkRound(writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      '  1) nested item',
      '  12) more',
      '  1. dotted',
      'Change: Make the change.',
    ].join('\n'), 'ordered.md'));
    assert.equal(ordered.report.items[0].ownersWords, 'Please.\n1) nested item\n12) more\n1. dotted');
    assert.equal(/^\s*\d+\)/m.test(ordered.markdown), false);
    assert.equal(/^\s*\d+\./m.test(ordered.markdown), false);
    assert.equal(ordered.markdown.includes('1\\) nested item'), true);
    assert.equal(ordered.markdown.includes('12\\) more'), true);
    assert.equal(ordered.markdown.includes('1\\. dotted'), true);
  });
});

test('10. exit code is 0 for warnings only and 1 when there is an error', () => {
  withDir(dir => {
    writePng(path.join(dir, `${SESSION}-01.png`));
    writePng(path.join(dir, `${SESSION}-02.png`));
    const warnings = writeRound(dir, [
      item(1, `Screenshot: ${SESSION}-01.png`),
      item(2, `Screenshot: ${SESSION}-01.png`),
    ].join('\n\n'));
    const warned = run([warnings], dir);
    assert.equal(warned.status, 0);
    assert.match(warned.stdout, /0 errors, 2 warnings/);

    const broken = writeRound(dir, item(1, `Screenshot: ${SESSION}-09.png`), 'broken.md');
    const failed = run([broken], dir);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /not present/);
  });
});

test('11. output paths that would overwrite an input are refused', () => {
  withDir(dir => {
    const round = writeRound(dir, item(1, `Screenshot: ${SESSION}-01.png`));
    const png = path.join(dir, `${SESSION}-01.png`);
    writePng(png);
    const roundBefore = readFileSync(round);
    const pngBefore = readFileSync(png);

    function refused(args, cwd = dir) {
      const result = run(args, cwd);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Refusing to write/);
      assert.equal(result.stdout, '');
      assert.deepEqual(readFileSync(round), roundBefore);
      assert.deepEqual(readFileSync(png), pngBefore);
      return result;
    }

    refused([round, '--json', round]);
    refused([round, '--md', round]);
    refused([path.basename(round), '--json', path.join('..', path.basename(dir), path.basename(round))]);
    const roundLink = path.join(dir, 'round-link.md');
    symlinkSync(round, roundLink);
    refused([round, '--md', roundLink]);
    const roundHard = path.join(dir, 'round-hard.md');
    linkSync(round, roundHard);
    refused([round, '--json', roundHard]);

    refused([round, '--json', png]);
    refused([path.basename(round), '--md', path.join('..', path.basename(dir), path.basename(png))]);
    const pngLink = path.join(dir, 'png-link.png');
    symlinkSync(png, pngLink);
    refused([round, '--json', pngLink]);
    const pngHard = path.join(dir, 'png-hard.png');
    linkSync(png, pngHard);
    refused([round, '--md', pngHard]);

    const mentioned = writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      'Change: Make the change.',
      'Screenshot: notes.png, shots/a.png',
    ].join('\n'), 'mentioned.md');
    refused([mentioned, '--json', path.join(dir, 'notes.png')]);
    assert.equal(existsSync(path.join(dir, 'notes.png')), false);
    mkdirSync(path.join(dir, 'shots'));
    refused([mentioned, '--md', path.join(dir, 'shots', 'a.png')]);
    assert.equal(existsSync(path.join(dir, 'shots', 'a.png')), false);
    writeFileSync(path.join(dir, 'shots', 'a.png'), 'shot-keep');
    refused([mentioned, '--json', path.join(dir, 'shots', 'a.png')]);
    assert.equal(readFileSync(path.join(dir, 'shots', 'a.png'), 'utf8'), 'shot-keep');

    const parent = path.dirname(dir);
    const other = path.join(parent, `other-${path.basename(dir)}.png`);
    writeFileSync(other, 'other-keep');
    const outsideRound = writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      'Change: Make the change.',
      `Screenshot: ../${path.basename(other)}, ../missing-${path.basename(dir)}.png`,
    ].join('\n'), 'outside.md');
    try {
      refused([path.basename(outsideRound), '--md', path.join('..', path.basename(other))]);
      assert.equal(readFileSync(other, 'utf8'), 'other-keep');
      const missing = path.join(parent, `missing-${path.basename(dir)}.png`);
      refused([outsideRound, '--json', missing]);
      assert.equal(existsSync(missing), false);
    } finally {
      rmSync(other, { force: true });
    }

    const absolute = path.join(dir, 'absolute-target.png');
    const absoluteMissing = path.join(dir, 'absolute-missing.png');
    writeFileSync(absolute, 'abs-keep');
    const absoluteRound = writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      'Change: Make the change.',
      `Screenshot: ${absolute}, ${absoluteMissing}`,
    ].join('\n'), 'absolute.md');
    refused([absoluteRound, '--json', absolute]);
    assert.equal(readFileSync(absolute, 'utf8'), 'abs-keep');
    refused([absoluteRound, '--md', absoluteMissing]);
    assert.equal(existsSync(absoluteMissing), false);

    const notes = path.join(dir, 'notes-real.png');
    writeFileSync(notes, 'notes-keep');
    const notesLink = path.join(dir, 'notes-link.png');
    linkSync(notes, notesLink);
    const linkedRound = writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      'Change: Make the change.',
      'Screenshot: notes-real.png',
    ].join('\n'), 'linked.md');
    refused([linkedRound, '--json', notesLink]);
    assert.equal(readFileSync(notes, 'utf8'), 'notes-keep');

    const same = path.join(dir, 'same.md');
    refused([round, '--json', same, '--md', same]);
    assert.equal(existsSync(same), false);
    refused([round, '--json', same, '--md', path.join(dir, '.', 'same.md')]);
    assert.equal(existsSync(same), false);

    const keep = path.join(dir, 'keep.txt');
    const keepLink = path.join(dir, 'keep-link.txt');
    writeFileSync(keep, 'keep-me');
    linkSync(keep, keepLink);
    refused([round, '--json', keepLink]);
    assert.equal(readFileSync(keep, 'utf8'), 'keep-me');

    const harmless = path.join(dir, 'harmless.txt');
    writeFileSync(harmless, 'harmless');
    const outLink = path.join(dir, 'out-link.json');
    symlinkSync(harmless, outLink);
    refused([round, '--json', outLink]);
    assert.equal(readFileSync(harmless, 'utf8'), 'harmless');
    assert.equal(lstatSync(outLink).isSymbolicLink(), true);
    assert.equal(readlinkSync(outLink), harmless);

    const outsideHarm = path.join(parent, `harm-${path.basename(dir)}.txt`);
    writeFileSync(outsideHarm, 'outside-harmless');
    const outsideLink = path.join(dir, 'outside-link.json');
    symlinkSync(outsideHarm, outsideLink);
    try {
      refused([round, '--md', outsideLink]);
      assert.equal(readFileSync(outsideHarm, 'utf8'), 'outside-harmless');
    } finally {
      rmSync(outsideHarm, { force: true });
    }

    const realDir = path.join(dir, 'real-out');
    mkdirSync(realDir);
    const through = path.join(realDir, 'out.json');
    writeFileSync(through, 'keep-real');
    const via = path.join(dir, 'via-out');
    symlinkSync(realDir, via);
    refused([round, '--json', path.join(via, 'out.json')]);
    assert.equal(readFileSync(through, 'utf8'), 'keep-real');
    refused([round, '--md', path.join(via, 'new.json')]);
    assert.equal(existsSync(path.join(realDir, 'new.json')), false);

    const continued = writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      'Change: Make the change.',
      'Screenshot: continued-a.png,',
      '  continued-b.png',
    ].join('\n'), 'continued.md');
    refused([continued, '--json', path.join(dir, 'continued-b.png')]);
    assert.equal(existsSync(path.join(dir, 'continued-b.png')), false);

    const duplicated = writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      'Change: Make the change.',
      'Screenshot: dup-a.png',
      'Screenshot: dup-b.png',
    ].join('\n'), 'duplicated.md');
    refused([duplicated, '--md', path.join(dir, 'dup-b.png')]);
    assert.equal(existsSync(path.join(dir, 'dup-b.png')), false);

    const checklist = path.join(dir, 'checklist.json');
    const checklistMd = path.join(dir, 'checklist.md');
    const ok = run([round, '--json', checklist, '--md', checklistMd], dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(readFileSync(round), roundBefore);
    assert.deepEqual(readFileSync(png), pngBefore);
    const checked = checkRound(round);
    assert.equal(readFileSync(checklist, 'utf8'), reportJson(checked.report));
    assert.equal(readFileSync(checklistMd, 'utf8'), checked.markdown);
  });
});

test('12. line rules keep indented text inside the field', () => {
  withDir(dir => {
    writePng(path.join(dir, `${SESSION}-01.png`));
    const example = [
      '1. Screen: Desk home',
      'Element: The "New note" button',
      "Owner's words: Too small.",
      '  Change: bigger, please.',
      'Change: Make the button larger',
      `Screenshot: ${SESSION}-01.png`,
    ].join('\n');
    const parsed = checkRound(writeRound(dir, example)).report.items[0];
    assert.equal(parsed.ownersWords, 'Too small.\nChange: bigger, please.');
    assert.equal(parsed.change, 'Make the button larger');
    assert.equal(parsed.problems.length, 0);

    const indented = [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: See this",
      '  3. Not an item',
      '  Change: not a field',
      'Change: Real change',
    ].join('\n');
    const held = checkRound(writeRound(dir, indented, 'held.md')).report;
    assert.equal(held.items.length, 1);
    assert.equal(held.items[0].ownersWords, 'See this\n3. Not an item\nChange: not a field');
    assert.equal(held.items[0].change, 'Real change');

    const blankInside = [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: First",
      '  ',
      '  Third',
      'Change: Real change',
    ].join('\n');
    const spaced = checkRound(writeRound(dir, blankInside, 'spaced.md')).report.items[0];
    assert.equal(spaced.ownersWords, 'First\n\nThird');

    const ended = [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: First",
      '',
      '  Not included',
      'Change: Real change',
    ].join('\n');
    const afterBlank = checkRound(writeRound(dir, ended, 'ended.md')).report;
    assert.equal(afterBlank.items[0].ownersWords, 'First');
    assert.equal(afterBlank.items[0].change, 'Real change');
    assert.ok(afterBlank.problems.some(problem => problem.message === 'Could not read line 5.'));

    const prose = [
      '1. Screen: Desk',
      'Element: Button',
      'Hello there',
      "Owner's words: Please.",
      'Change: Make the change.',
    ].join('\n');
    const unread = checkRound(writeRound(dir, prose, 'prose.md')).report;
    assert.ok(unread.problems.some(problem => problem.message === 'Could not read line 3.'));
    assert.equal(unread.items[0].ownersWords, 'Please.');

    const crlf = checkRound(writeRound(dir, example.replaceAll('\n', '\r\n'), 'crlf.md')).report.items[0];
    assert.equal(crlf.ownersWords, parsed.ownersWords);
    assert.equal(crlf.change, parsed.change);
  });
});

test('13. the same input produces the same bytes', () => {
  const first = checkRound(FIXTURE);
  const second = checkRound(FIXTURE);
  assert.equal(reportJson(first.report), reportJson(second.report));
  assert.equal(first.markdown, second.markdown);
  assert.equal(reportJson(first.report), readFileSync(EXPECTED_JSON, 'utf8'));
  assert.equal(first.markdown, readFileSync(EXPECTED_MD, 'utf8'));
});

test('14. an empty file and a file with no items each give one error', () => {
  withDir(dir => {
    const emptyPath = path.join(dir, `${SESSION}.md`);
    writeFileSync(emptyPath, '');
    const empty = checkRound(emptyPath).report;
    assert.equal(empty.items.length, 0);
    assert.equal(empty.problems.length, 1);
    assert.equal(empty.problems[0].level, 'error');
    assert.match(empty.problems[0].message, /empty/);
    assert.equal(JSON.stringify(empty).includes('Could not read'), false);

    const blank = checkRound(writeRound(dir, '\n\n', 'blank.md')).report;
    assert.equal(blank.problems.length, 1);
    assert.match(blank.problems[0].message, /empty/);

    const prose = checkRound(writeRound(dir, 'Just a note about the Desk.\n', 'prose.md')).report;
    assert.equal(prose.items.length, 0);
    assert.equal(prose.problems.length, 1);
    assert.match(prose.problems[0].message, /no numbered items/);
    assert.equal(JSON.stringify(prose).includes('Could not read'), false);
  });
});

test('a round over 1 MB is refused and nothing is written', () => {
  withDir(dir => {
    const huge = path.join(dir, `${SESSION}.md`);
    const fd = openSync(huge, 'w');
    try {
      ftruncateSync(fd, MB + 1);
    } finally {
      closeSync(fd);
    }
    const out = path.join(dir, 'out.json');
    const result = run([huge, '--json', out], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /over 1 MB/);
    assert.equal(existsSync(out), false);
    assert.throws(() => checkRound(huge), RoundError);

    const exact = path.join(dir, 'exact.md');
    const exactFd = openSync(exact, 'w');
    try {
      ftruncateSync(exactFd, MB);
    } finally {
      closeSync(exactFd);
    }
    const allowed = checkRound(exact);
    assert.equal(allowed.report.problems.some(problem => problem.message.includes('over 1 MB')), false);
    assert.match(allowed.report.problems[0].message, /no numbered items/);
  });
});

test('a screenshot named with no numbered item is not overwritten', () => {
  withDir(dir => {
    const notes = path.join(dir, 'notes.png');
    writeFileSync(notes, 'notes-keep');
    const round = writeRound(dir, 'Screenshot: notes.png\n', 'loose.md');
    const report = checkRound(round).report;
    assert.equal(report.items.length, 0);
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0].message, /no numbered items/);
    assert.equal(JSON.stringify(report).includes('Could not read'), false);

    const result = run([round, '--json', notes], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to write/);
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(notes, 'utf8'), 'notes-keep');

    const continued = writeRound(dir, 'Screenshot: continued-a.png,\n  continued-b.png\n', 'continued.md');
    const continuedOut = path.join(dir, 'continued-b.png');
    writeFileSync(continuedOut, 'continued-keep');
    const continuedRun = run([continued, '--md', continuedOut], dir);
    assert.equal(continuedRun.status, 1);
    assert.match(continuedRun.stderr, /Refusing to write/);
    assert.equal(continuedRun.stdout, '');
    assert.equal(readFileSync(continuedOut, 'utf8'), 'continued-keep');
    assert.equal(existsSync(path.join(dir, 'continued-a.png')), false);

    const early = writeRound(dir, `Screenshot: early.png\n\n${item(1)}\n`, 'early.md');
    const earlyFile = path.join(dir, 'early.png');
    writeFileSync(earlyFile, 'early-keep');
    const earlyRun = run([early, '--json', earlyFile], dir);
    assert.equal(earlyRun.status, 1);
    assert.match(earlyRun.stderr, /Refusing to write/);
    assert.equal(readFileSync(earlyFile, 'utf8'), 'early-keep');
    const earlyReport = checkRound(early).report;
    assert.equal(earlyReport.items.length, 1);
    assert.ok(earlyReport.problems.some(problem => problem.message === 'Could not read line 1.'));

    const buried = writeRound(dir, [
      '1. Screen: Desk',
      'Element: Button',
      "Owner's words: Please.",
      '  Screenshot: buried.png',
      'Change: Make the change.',
    ].join('\n'), 'buried.md');
    const buriedOut = path.join(dir, 'buried.json');
    const buriedRun = run([buried, '--json', buriedOut], dir);
    assert.equal(buriedRun.status, 0, buriedRun.stderr);
    assert.equal(existsSync(buriedOut), true);
    const buriedReport = checkRound(buried).report;
    assert.equal(buriedReport.items[0].ownersWords, 'Please.\nScreenshot: buried.png');
    assert.equal(buriedReport.items[0].screenshots.length, 0);
  });
});

test('huge item numbers are reported without listing every missing number', { timeout: 1000 }, () => {
  withDir(dir => {
    const huge = checkRound(writeRound(dir, item(1000000000), 'huge.md')).report;
    assert.equal(huge.items[0].number, 1000000000);
    assert.equal(huge.problems.length, 1);
    assert.equal(huge.problems[0].message, 'Item numbers 1 through 999999999 are skipped.');
    assert.equal(huge.items[0].problems.length, 0);

    const listed = checkRound(writeRound(dir, `${item(1)}\n\n${item(22)}`, 'listed.md')).report;
    const listedSkips = listed.problems.filter(problem => problem.message.endsWith('is skipped.'));
    assert.equal(listedSkips.length, 20);
    assert.equal(listedSkips[0].message, 'Item number 2 is skipped.');
    assert.equal(listedSkips[19].message, 'Item number 21 is skipped.');
    assert.equal(listed.problems.some(problem => problem.message.includes('through')), false);

    const ranged = checkRound(writeRound(dir, `${item(1)}\n\n${item(23)}`, 'ranged.md')).report;
    assert.equal(ranged.problems.filter(problem => problem.message.includes('skipped')).length, 1);
    assert.equal(ranged.problems.find(problem => problem.message.includes('skipped')).message, 'Item numbers 2 through 22 are skipped.');

    const digits = '9'.repeat(40);
    const tooBigRound = writeRound(dir, item(digits), 'too-big.md');
    const tooBigChecked = checkRound(tooBigRound);
    const tooBig = tooBigChecked.report;
    assert.equal(tooBig.items.length, 1);
    assert.equal(tooBig.items[0].number, null);
    assert.match(tooBigChecked.markdown, /- \[ \] too large\. Desk/);
    assert.equal(tooBig.problems.length, 1);
    assert.equal(tooBig.problems[0].message, `Item number ${'9'.repeat(20)}... is too large.`);
    assert.equal(JSON.stringify(tooBig).includes(digits), false);
    assert.equal(tooBig.items[0].problems.length, 0);
  });
});

test('sparse item numbers keep the later line without a slow rescan', { timeout: 2500 }, () => {
  withDir(dir => {
    const lines = [];
    for (let number = 2; number <= 80000; number += 2) lines.push(`${number}.`);
    const report = checkRound(writeRound(dir, lines.join('\n'), 'sparse.md')).report;
    assert.equal(report.items.length, 500);
    assert.equal(report.problems.length, 201);
    assert.equal(report.problems[0].message, 'This round has 40000 numbered items. Only the first 500 are listed.');
    assert.equal(report.problems.at(-1).message, '301 more problems were left out.');
    const firstSkip = report.problems.find(problem => problem.message === 'Item number 1 is skipped.');
    assert.equal(firstSkip.line, 1);
    const laterSkip = report.problems.find(problem => problem.message === 'Item number 3 is skipped.');
    assert.equal(laterSkip.line, 2);
  });
});

test('a long round stays bounded and still protects a later screenshot', () => {
  withDir(dir => {
    const lines = [];
    for (let number = 1; number <= 500; number += 1) lines.push(`${number}.`);
    const atLimit = checkRound(writeRound(dir, lines.join('\n'), 'limit.md')).report;
    assert.equal(atLimit.items.length, 500);
    assert.equal(atLimit.problems.some(problem => problem.message.includes('Only the first')), false);

    lines.push('501. Screenshot: late.png');
    lines.push('Screenshot: after.png,');
    lines.push('  continued-late.png');
    const round = writeRound(dir, lines.join('\n'), 'over.md');
    const over = checkRound(round).report;
    assert.equal(over.items.length, 500);
    assert.ok(over.problems.some(problem => problem.message === 'This round has 501 numbered items. Only the first 500 are listed.'));

    const late = path.join(dir, 'late.png');
    writeFileSync(late, 'late-keep');
    const lateRun = run([round, '--json', late], dir);
    assert.match(lateRun.stderr, /Refusing to write/);
    assert.equal(lateRun.stdout, '');
    assert.equal(readFileSync(late, 'utf8'), 'late-keep');
    const continued = path.join(dir, 'continued-late.png');
    writeFileSync(continued, 'continued-keep');
    const continuedRun = run([round, '--md', continued], dir);
    assert.match(continuedRun.stderr, /Refusing to write/);
    assert.equal(readFileSync(continued, 'utf8'), 'continued-keep');

    const noise = Array.from({ length: 250 }, () => 'hello');
    noise.push(item(1));
    const noisy = checkRound(writeRound(dir, noise.join('\n'), 'noise.md')).report;
    assert.equal(noisy.items.length, 1);
    assert.equal(noisy.problems.length, 201);
    assert.equal(noisy.problems.at(-1).message, '50 more problems were left out.');

    const names = Array.from({ length: 250 }, (_, index) => `shot-${index}.png`).join(', ');
    const many = checkRound(writeRound(dir, item(1, `Screenshot: ${names}`), 'many.md')).report;
    assert.equal(many.items[0].screenshots.length, 250);
    assert.equal(many.items[0].problems.length, 201);
    assert.equal(many.items[0].problems.at(-1).message, '50 more problems were left out.');

    const presentNames = [];
    for (let number = 1; number <= 201; number += 1) {
      const name = `${SESSION}-${String(number).padStart(3, '0')}.png`;
      presentNames.push(name);
      writePng(path.join(dir, name));
    }
    const presentRound = writeRound(dir, item(1, `Screenshot: ${presentNames.join(', ')}`));
    const present = checkRound(presentRound);
    assert.equal(present.report.items[0].screenshots.length, 201);
    assert.equal(present.report.items[0].screenshots.every(shot => shot.present), true);
    assert.equal(present.report.items[0].problems.length, 0);
    assert.equal(present.report.problems.length, 0);
    const presentRun = run([presentRound], dir);
    assert.equal(presentRun.status, 0, presentRun.stderr);

    const shared = Array.from({ length: 30 }, (_, index) => `dup-${index}.png`).join(', ');
    const mixed = [
      ...Array.from({ length: 180 }, () => 'hello'),
      item(1, `Screenshot: ${shared}`),
      '',
      item(2, `Screenshot: ${shared}`),
    ].join('\n');
    const mixedReport = checkRound(writeRound(dir, mixed, 'mixed.md')).report;
    assert.equal(mixedReport.problems.length, 201);
    assert.equal(mixedReport.problems.at(-1).message, '10 more problems were left out.');
    assert.equal(mixedReport.problems.filter(problem => problem.message.includes('named by more than one item')).length, 20);
  });
});

test('a warning-only overflow stays a warning', () => {
  withDir(dir => {
    for (let number = 1; number <= 201; number += 1) {
      writePng(path.join(dir, `${SESSION}-${String(number).padStart(3, '0')}.png`));
    }
    const round = writeRound(dir, item(1));
    const checked = checkRound(round);
    assert.equal(checked.report.problems.length, 201);
    assert.equal(checked.report.problems.every(entry => entry.level === 'warning'), true);
    assert.equal(checked.report.problems.at(-1).message, '1 more problems were left out.');
    const result = run([round], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 errors, 201 warnings/);
  });
});

test('a long run of unreadable lines stays a bounded report', () => {
  withDir(dir => {
    const round = path.join(dir, `${SESSION}.md`);
    const fd = openSync(round, 'w');
    try {
      const chunk = Buffer.alloc(64 * 1024, 'x\n');
      let written = 0;
      writeSync(fd, '1.\n');
      written += 3;
      while (written + chunk.length <= MB - 1) {
        written += writeSync(fd, chunk);
      }
      if (written < MB - 1) writeSync(fd, Buffer.alloc(MB - 1 - written, 'x'));
    } finally {
      closeSync(fd);
    }
    const checked = checkRound(round);
    assert.equal(checked.report.items.length, 1);
    assert.equal(checked.report.problems.length, 201);
    assert.equal(checked.report.problems[0].message, 'Could not read line 2.');
    assert.match(checked.report.problems.at(-1).message, /^[1-9]\d{3,} more problems were left out\.$/);
    const result = run([round], dir);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes('Could not check the round file'), false);
    assert.match(result.stdout, /Could not read line 2\./);
  });
});

test('an output that is not a regular file is refused', () => {
  const device = run([FIXTURE, '--json', '/dev/null']);
  assert.equal(device.status, 1);
  assert.match(device.stderr, /not a regular file/);
  assert.equal(device.stdout, '');

  withDir(dir => {
    const fifo = path.join(dir, 'out.fifo');
    const made = spawnSync('mkfifo', [fifo]);
    assert.equal(made.status, 0, made.stderr);
    const round = writeRound(dir, item(1), 'fifo.md');
    const refused = run([round, '--md', fifo], dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not a regular file/);
    assert.equal(refused.stdout, '');
  });
});

test('a missing screenshot follows the volume case rules', () => {
  assert.equal(pathsMatch('/rounds/notes.png', '/rounds/NOTES.PNG', true), true);
  assert.equal(pathsMatch('/rounds/notes.png', '/rounds/NOTES.PNG', false), false);
  assert.equal(pathsMatch('/rounds/notes.png', '/rounds/notes.png', false), true);
  assert.equal(pathsMatch('/rounds/notes.png', '/rounds/other.png', true), false);
  assert.equal(pathsMatch('/rounds/Desk/out.json', '/rounds/desk/out.json', true), true);
  assert.equal(pathsMatch('/rounds/out.json', '/rounds/OUT.JSON', true), true);
  assert.equal(pathsMatch('/tmp/out.json', '/private/tmp/out.json', true), false);

  withDir(dir => {
    const round = writeRound(dir, item(1, 'Screenshot: notes.png'), 'case.md');
    const out = path.join(dir, 'NOTES.PNG');
    const result = run([round, '--json', out], dir);
    const folds = volumeFoldsCase(dir);
    let probed = false;
    const chars = Array.from(dir);
    for (let index = chars.length - 1; index >= 0; index -= 1) {
      const lower = chars[index].toLowerCase();
      const upper = chars[index].toUpperCase();
      if (lower === upper) continue;
      chars[index] = chars[index] === lower ? upper : lower;
      try {
        probed = realpathSync(chars.join('')) === realpathSync(dir);
      } catch {
        probed = false;
      }
      break;
    }
    assert.equal(folds, probed);
    if (folds) {
      assert.match(result.stderr, /Refusing to write/);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(out), false);
    } else {
      assert.equal(result.stderr.includes('Refusing to write'), false);
      assert.equal(existsSync(out), true);
      assert.equal(existsSync(path.join(dir, 'notes.png')), false);
    }

    const writable = writeRound(dir, item(1), 'writable.md');
    const stored = path.join(dir, 'OUT.JSON');
    writeFileSync(stored, 'old-checklist');
    const requested = path.join(dir, 'out.json');
    const cased = run([writable, '--json', requested], dir);
    assert.equal(cased.stderr.includes('symbolic link'), false, cased.stderr);
    if (folds) {
      assert.equal(cased.status, 0, cased.stderr);
      assert.match(readFileSync(stored, 'utf8'), /schemaVersion/);
    } else {
      assert.equal(cased.status, 0, cased.stderr);
      assert.equal(readFileSync(stored, 'utf8'), 'old-checklist');
      assert.match(readFileSync(requested, 'utf8'), /schemaVersion/);
    }

    const realDir = path.join(dir, 'real-case');
    mkdirSync(realDir);
    const via = path.join(dir, 'via-case');
    symlinkSync(realDir, via);
    const linked = run([writable, '--json', path.join(via, 'out.json')], dir);
    assert.match(linked.stderr, /symbolic link/);
    assert.equal(existsSync(path.join(realDir, 'out.json')), false);
  });
});

test('repeated screenshot names stay listed and are compared once', { timeout: 3000 }, () => {
  withDir(dir => {
    const repeats = 'x,'.repeat(50000);
    const round = writeRound(dir, item(1, `Screenshot: ${repeats}`));
    const out = path.join(dir, 'out.json');
    const written = run([round, '--json', out], dir);
    assert.equal(written.status, 1);
    assert.equal(written.stderr, '');
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.items[0].screenshots.length, 50000);
    assert.equal(report.items[0].screenshots.every(shot => shot.name === 'x' && shot.present === false), true);

    const refused = run([round, '--json', path.join(dir, 'x')], dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /same file as an input/);
    assert.equal(existsSync(path.join(dir, 'x')), false);
  });
});

function casingVariant(index) {
  let name = '';
  for (let bit = 0; bit < 16; bit += 1) name += (index & (1 << bit)) === 0 ? 'a' : 'A';
  return name;
}

test('casing variants of one screenshot follow the volume case rules', { timeout: 3000 }, () => {
  const variants = [];
  for (let index = 0; index < 50000; index += 1) variants.push(`/rounds/sample/${casingVariant(index)}`);
  let calls = 0;
  const folded = dedupeProtectedPaths(variants, () => {
    calls += 1;
    return { folds: true, identity: '/rounds/sample' };
  });
  assert.equal(calls, 1);
  assert.equal(folded.length, 1);
  assert.equal(folded[0], variants[0]);
  calls = 0;
  const exact = dedupeProtectedPaths(variants, () => {
    calls += 1;
    return { folds: false, identity: '/rounds/sample' };
  });
  assert.equal(calls, 1);
  assert.equal(exact.length, 50000);
  const folding = { folds: true, identity: '/rounds' };
  const sensitive = { folds: false, identity: '/rounds' };
  const nfc = '/rounds/\u00e9.png';
  const nfd = '/rounds/e\u0301.png';
  assert.equal(dedupeProtectedPaths([nfc, nfd], () => folding).length, 1);
  assert.equal(dedupeProtectedPaths([nfc, nfd], () => sensitive).length, 2);

  const mixed = [
    '/Users/round/shot.png',
    '/Users/round/SHOT.png',
    '/Volumes/CaseSensitive/shot.png',
    '/Volumes/CaseSensitive/SHOT.png',
  ];
  calls = 0;
  const kept = dedupeProtectedPaths(mixed, (resolved) => {
    calls += 1;
    if (resolved.startsWith('/Volumes/CaseSensitive/')) {
      return { folds: false, identity: '/Volumes/CaseSensitive' };
    }
    return { folds: true, identity: '/Users/round' };
  });
  assert.equal(calls, 2);
  assert.deepEqual(kept, [
    '/Users/round/shot.png',
    '/Volumes/CaseSensitive/shot.png',
    '/Volumes/CaseSensitive/SHOT.png',
  ]);

  withDir(dir => {
    const folds = volumeFoldsCase(dir);
    const count = folds ? 50000 : 2;
    const names = [];
    for (let index = 0; index < count; index += 1) names.push(casingVariant(index));
    const round = writeRound(dir, item(1, `Screenshot: ${names.join(',')}`));
    const out = path.join(dir, 'out.json');
    const written = run([round, '--json', out], dir);
    assert.equal(written.status, 1);
    assert.equal(written.stderr, '');
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.items[0].screenshots.length, count);
    assert.equal(report.items[0].screenshots[0].name, names[0]);
    assert.equal(report.items[0].screenshots[count - 1].name, names[count - 1]);

    const other = path.join(dir, casingVariant(1));
    const refused = run([round, '--json', other], dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /same file as an input/);
    assert.equal(existsSync(other), false);

    const sub = path.join(dir, 'elsewhere');
    mkdirSync(sub);
    const here = volumeRules(path.join(dir, 'shot.png'));
    const there = volumeRules(path.join(sub, 'SHOT.png'));
    assert.equal(here.folds, folds);
    assert.equal(there.folds, volumeFoldsCase(sub));
    assert.equal(here.identity, realpathSync(dir));
    assert.equal(there.identity, realpathSync(sub));
    assert.notEqual(here.identity, there.identity);
  });
});

test('many missing screenshot folders reuse one volume lookup', { timeout: 3000 }, () => {
  withDir(dir => {
    const header = item(1, 'Screenshot: ');
    const names = [];
    let size = header.length + 1;
    for (let index = 0; size < 900000; index += 1) {
      const name = `d${index}/x`;
      const extra = names.length === 0 ? name.length : name.length + 1;
      if (size + extra > 900000) break;
      names.push(name);
      size += extra;
    }
    assert.ok(names.length > 50000);
    const round = writeRound(dir, item(1, `Screenshot: ${names.join(',')}`));
    const out = path.join(dir, 'out.json');
    const written = run([round, '--json', out], dir);
    assert.equal(written.status, 1);
    assert.equal(written.stderr, '');
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.items[0].screenshots.length, names.length);
    assert.equal(report.items[0].screenshots[0].name, names[0]);
    assert.equal(report.items[0].screenshots[names.length - 1].name, names[names.length - 1]);

    const kept = path.join(dir, 'kept');
    mkdirSync(kept);
    resetPathCache();
    const first = volumeRules(path.join(dir, names[0]));
    const second = volumeRules(path.join(dir, names[1]));
    assert.deepEqual(first, second);
    assert.equal(first.identity, realpathSync(dir));

    const inside = volumeRules(path.join(kept, 'shot.png'));
    assert.equal(inside.identity, realpathSync(kept));
    assert.notEqual(inside.identity, first.identity);
  });
});

test('the command rejects a missing round and a bad argument', () => {
  const missing = run(['/tmp/does-not-exist-annotation-round.md']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not open/);
  const usage = run([]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage/);
  const unknown = run([FIXTURE, '--nope']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown argument/);
});
