import './guard.mjs';

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLIP_BYTES,
  CaptureError,
  FILE_BYTES,
  ONLY_MEDIA,
  TEXT_BYTES,
  formatDrop,
  oneLine,
  sortDrop,
} from '../src/index.mjs';
import { main } from '../src/sort.mjs';
import { takeCalls } from './guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'mixed.json');
const expectedJson = join(here, 'expected', 'mixed.json');
const expectedText = join(here, 'expected', 'mixed.txt');
const srcDir = join(here, '..', 'src');

const AT = '2026-11-01T12:00:00Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function makeDrop(items, known = []) {
  return { schemaVersion: 1, items, known };
}

function textItem(id, body, extra = {}) {
  return {
    id,
    name: 'note.txt',
    addedAt: AT,
    kind: 'text',
    text: body,
    ...extra,
  };
}

function clipItem(id, extra = {}) {
  const { file: fileExtra, ...rest } = extra;
  const file = {
    sizeBytes: 10,
    type: 'public.mpeg-4',
    sha256: SHA_A,
    ...fileExtra,
  };
  // A test passes sha256: undefined to mean the field is absent.
  if (file.sha256 === undefined) delete file.sha256;
  return {
    id,
    name: 'clip.mp4',
    addedAt: AT,
    kind: 'file',
    ...rest,
    file,
  };
}

function cleaned(body, extra = {}) {
  const result = sortDrop(makeDrop([textItem('a', body, extra)]));
  assert.equal(result.refused.length, 0, JSON.stringify(result.refused));
  assert.equal(result.sources.length, 1);
  return result.sources[0];
}

function refusal(item) {
  const result = sortDrop(makeDrop([item]));
  assert.equal(result.sources.length, 0, JSON.stringify(result.sources));
  assert.equal(result.duplicates.length, 0);
  assert.equal(result.refused.length, 1);
  return result.refused[0].reason;
}

function fileRefusal(value) {
  let message = '';
  assert.throws(() => sortDrop(value), (error) => {
    assert.ok(error instanceof CaptureError, error && error.message);
    message = error.message;
    return true;
  });
  return message;
}

function assertShape(result, itemCount) {
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.counts.items, itemCount);
  assert.equal(result.counts.sources, result.sources.length);
  assert.equal(result.counts.duplicates, result.duplicates.length);
  assert.equal(result.counts.refused, result.refused.length);
  assert.equal(result.counts.links + result.counts.clips, result.counts.sources);
  assert.equal(result.counts.sources + result.counts.duplicates + result.counts.refused, itemCount);
  for (const source of result.sources) {
    if (source.kind === 'link') {
      assert.equal(source.sourceKey, source.url);
      assert.equal(typeof source.site, 'string');
      assert.equal(Object.hasOwn(source, 'file'), false);
    } else {
      assert.equal(source.kind, 'clip');
      assert.equal(source.sourceKey, `clip:${source.file.sha256}`);
      assert.equal(Object.hasOwn(source, 'site'), false);
      assert.equal(Object.hasOwn(source, 'url'), false);
    }
    assert.equal(source.title.length <= 80, true);
  }
}

function capture() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: { write(text) { out.stdout += text; } },
      stderr: { write(text) { out.stderr += text; } },
    },
  };
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) freeze(value[key]);
}

describe('1. mixed drop', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  it('matches the saved JSON and summary exactly', () => {
    const result = sortDrop(fixture);
    assert.equal(`${JSON.stringify(result, null, 2)}\n`, readFileSync(expectedJson, 'utf8'));
    assert.equal(formatDrop(result), readFileSync(expectedText, 'utf8'));
    assertShape(result, 8);
    assert.deepEqual(result.counts, {
      items: 8,
      sources: 5,
      links: 3,
      clips: 2,
      duplicates: 1,
      refused: 2,
      droppedWords: 3,
    });
    assert.deepEqual(result.sources.map((source) => source.id), [
      'webloc-reel', 'url-video', 'plain-note', 'clip-a', 'clip-b',
    ]);
    assert.equal(result.sources[0].sourceKey, 'https://example.com/reel');
    assert.equal(result.sources[1].sourceKey, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=12s');
    assert.equal(result.sources[1].title, 'youtube www.youtube.com/watch');
    assert.equal(result.sources[3].title, 'holiday');
    assert.equal(result.sources[4].title, 'interview');
    assert.deepEqual(result.duplicates, [{
      id: 'reel-again',
      sourceKey: 'https://example.com/reel',
      repeats: 'webloc-reel',
    }]);
    assert.deepEqual(result.refused.map((item) => item.id), ['milk', 'photo']);
    for (const item of result.refused) assert.equal(item.reason, ONLY_MEDIA);
    const flat = JSON.stringify(result);
    for (const gone of ['utm_', 'fbclid', 'gclid', 'Remember', 'Loved', 'sun.jpg', 'si=', 'buy milk', 'AAA', 'BBB']) {
      assert.equal(flat.includes(gone), false, gone);
    }
  });

  it('prints that result from the command', () => {
    const cap = capture();
    assert.equal(main(['--drop', fixturePath], cap.io), 0);
    assert.equal(cap.out.stderr, '');
    assert.equal(cap.out.stdout, readFileSync(expectedText, 'utf8'));
    const json = capture();
    assert.equal(main(['--json', '--drop', fixturePath], json.io), 0);
    assert.equal(json.out.stdout, readFileSync(expectedJson, 'utf8'));
  });
});

describe('2. link formats and dropped words', () => {
  it('reads a webloc URL, a url file, and plain text', () => {
    const webloc = cleaned(
      '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>URL</key><string>https://example.com/from-webloc</string></dict></plist>',
      { name: 'reel.WEBLOC' },
    );
    assert.equal(webloc.url, 'https://example.com/from-webloc');
    const urlFile = cleaned('[internetshortcut]\nurl = https://example.com/from-url\n', { name: 'card.URL' });
    assert.equal(urlFile.url, 'https://example.com/from-url');
    const plain = cleaned('Loved this https://example.com/notes/1 today');
    assert.equal(plain.url, 'https://example.com/notes/1');
    assert.equal(sortDrop(makeDrop([textItem('a', 'Loved this https://example.com/notes/1 today')])).counts.droppedWords, 3);
  });

  it('refuses a webloc with no URL and a url file with no URL= line', () => {
    const webloc = '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Title</key><string>Hi</string></dict></plist>';
    assert.equal(refusal(textItem('a', webloc, { name: 'empty.webloc' })), 'The webloc has no URL.');
    const urlFile = '[InternetShortcut]\nIconFile=card.ico\n';
    assert.equal(refusal(textItem('a', urlFile, { name: 'empty.url' })), 'The .url file has no URL= line.');
    const noSection = 'URL=https://example.com/outside\n';
    assert.equal(
      refusal(textItem('a', noSection, { name: 'loose.url' })),
      'The .url file has no [InternetShortcut] section.',
    );
    assert.equal(JSON.stringify(sortDrop(makeDrop([textItem('a', noSection, { name: 'loose.url' })]))).includes('outside'), false);
  });

  it('keeps only the link from text that also has other words', () => {
    const result = sortDrop(makeDrop([
      textItem('good', 'Hello https://example.com/ok there'),
      textItem('bad', 'javascript:alert(1) extra words here'),
    ]));
    assert.equal(result.counts.droppedWords, 2);
    assert.equal(result.sources[0].url, 'https://example.com/ok');
    const flat = JSON.stringify(result);
    assert.equal(flat.includes('Hello'), false);
    assert.equal(flat.includes('alert'), false);
    assert.equal(flat.includes('extra'), false);
  });
});

describe('3. cleaning', () => {
  const cases = [
    ['https://example.com/a?utm_source=s&keep=1&utm_medium=m&utm_campaign=c&utm_content=d&utm_term=t&utm_id=i&utm_custom=z', 'https://example.com/a?keep=1'],
    ['https://example.com/a?UTM_Source=s&keep=1', 'https://example.com/a?keep=1'],
    ['https://example.com/a?fbclid=1&gclid=2&igsh=3&igshid=4&mc_eid=5&keep=6', 'https://example.com/a?keep=6'],
    ['https://example.com/a?b=1&utm_source=x&a=2&fbclid=z&b=3', 'https://example.com/a?b=1&a=2&b=3'],
    ['https://example.com/a?si=1&keep=2', 'https://example.com/a?si=1&keep=2'],
    ['https://www.youtube.com/watch?v=aaaaaaaaaaa&si=zzz', 'https://www.youtube.com/watch?v=aaaaaaaaaaa'],
    ['https://youtu.be/aaaaaaaaaaa', 'https://www.youtube.com/watch?v=aaaaaaaaaaa'],
    ['https://youtu.be/aaaaaaaaaaa?t=43', 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=43'],
    ['https://www.youtube.com/shorts/aaaaaaaaaaa?t=1m2s', 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=1m2s'],
    ['https://m.youtube.com/watch?v=aaaaaaaaaaa&t=10&list=PL1', 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=10'],
    ['https://youtube.com/watch?v=aaaaaaaaaaa&si=zzz&t=2', 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=2'],
    ['https://www.youtu.be/aaaaaaaaaaa?t=1', 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=1'],
    ['https://m.youtube.com/playlist?list=PL123&utm_source=x', 'https://m.youtube.com/playlist?list=PL123'],
    ['https://M.YouTube.com/playlist?list=PL123', 'https://m.youtube.com/playlist?list=PL123'],
    ['https://m.youtube.com/channel/UCexampleexampleexample', 'https://m.youtube.com/channel/UCexampleexampleexample'],
    ['https://m.youtube.com/@examplechannel', 'https://m.youtube.com/@examplechannel'],
    ['https://www.youtube.com/embed/aaaaaaaaaaa', 'https://www.youtube.com/embed/aaaaaaaaaaa'],
    ['https://music.youtube.com/watch?v=aaaaaaaaaaa&si=q', 'https://music.youtube.com/watch?v=aaaaaaaaaaa'],
    ['https://youtu.be/abc', 'https://youtu.be/abc'],
    ['https://Twitter.com/example/status/1?s=20', 'https://x.com/example/status/1?s=20'],
    ['https://www.twitter.com/example', 'https://x.com/example'],
    ['https://mobile.twitter.com/example', 'https://mobile.x.com/example'],
    ['https://WWW.INSTAGRAM.COM/reel/EXAMPLE/?igsh=zzz&utm_source=ig', 'https://instagram.com/reel/EXAMPLE/'],
    ['https://www.tiktok.com/@example/video/1?is_from_webapp=1&sender_device=pc', 'https://tiktok.com/@example/video/1?is_from_webapp=1&sender_device=pc'],
    ['https://EXAMPLE.com:443/Path', 'https://example.com/Path'],
    ['http://EXAMPLE.com:80/Path', 'http://example.com/Path'],
    ['https://example.com:444/Path', 'https://example.com:444/Path'],
    ['https://example.com:0443/a', 'https://example.com/a'],
    ['http://example.com:00080/a', 'http://example.com/a'],
    ['https://example.com/a#', 'https://example.com/a'],
    ['https://example.com/#', 'https://example.com/'],
    ['https://example.com/#/post/1', 'https://example.com/#/post/1'],
    ['https://example.com#/post/1', 'https://example.com/#/post/1'],
    ['HTTPS://Example.COM/A', 'https://example.com/A'],
    ['https://example.com/a?b=1&&c=2', 'https://example.com/a?b=1&c=2'],
    ['https://example.com/a?', 'https://example.com/a'],
    ['https://[2001:DB8::1]/a', 'https://[2001:db8::1]/a'],
  ];

  for (const [input, output] of cases) {
    it(`cleans ${input}`, () => {
      assert.equal(cleaned(input).sourceKey, output);
    });
  }

  it('keeps two hash routes as two sources and keeps t on a YouTube rewrite', () => {
    const result = sortDrop(makeDrop([
      textItem('one', 'https://example.com/#/post/1', { addedAt: '2026-11-01T10:00:00Z' }),
      textItem('two', 'https://example.com/#/post/2', { addedAt: '2026-11-01T11:00:00Z' }),
      textItem('clip', 'https://youtu.be/aaaaaaaaaaa?t=43&feature=share', { addedAt: '2026-11-01T12:00:00Z' }),
    ]));
    assert.deepEqual(result.sources.map((source) => source.sourceKey), [
      'https://example.com/#/post/1',
      'https://example.com/#/post/2',
      'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=43',
    ]);
    assert.equal(result.duplicates.length, 0);
    assert.equal(result.sources[0].title, 'web example.com/#/post/1');
    assert.equal(result.sources[2].site, 'youtube');
    assert.equal(result.sources[2].title, 'youtube www.youtube.com/watch');
  });
});

describe('4. refusals', () => {
  for (const body of [
    'javascript:alert(1)',
    'file:///tmp/clip.mov',
    'data:text/plain,hi',
    'ftp://files.example/a',
    'mailto:person@example.com',
    'vbscript:msgbox(1)',
  ]) {
    it(`refuses the scheme in ${body}`, () => {
      const scheme = body.slice(0, body.indexOf(':'));
      const reason = refusal(textItem('a', body));
      assert.equal(reason, `The link uses the ${scheme} scheme. Only http and https are kept.`);
      const flat = JSON.stringify(sortDrop(makeDrop([textItem('a', body)])));
      assert.equal(flat.includes('alert'), false);
      assert.equal(flat.includes('msgbox'), false);
      assert.equal(flat.includes('/tmp/'), false);
    });
  }

  it('refuses a user name or password and does not store it', () => {
    for (const body of [
      'https://ada-user:s3cret-token@example.com/a',
      'https://ada-user@example.com/a',
      'https://:s3cret-token@example.com/a',
    ]) {
      assert.equal(refusal(textItem('a', body)), 'The link has a user name or password, so it was not kept.');
      const flat = JSON.stringify(sortDrop(makeDrop([textItem('a', body)])));
      assert.equal(flat.includes('s3cret-token'), false);
      assert.equal(flat.includes('ada-user'), false);
    }
  });

  it('refuses each bad name', () => {
    const cases = [
      ['', 'The name is empty.'],
      ['.', 'The name is ".".'],
      ['..', 'The name is "..".'],
      ['../outside', 'The name contains a slash.'],
      ['a\\b', 'The name contains a backslash.'],
      ['a\nb', 'The name contains a control character.'],
      [`a${'x'.repeat(255)}`, 'The name is longer than 255 bytes.'],
    ];
    for (const [name, reason] of cases) {
      assert.equal(refusal(textItem('a', 'https://example.com/a', { name })), reason);
      assert.equal(JSON.stringify(sortDrop(makeDrop([textItem('a', 'https://example.com/secret-path', { name })]))).includes('secret-path'), false);
    }
    assert.equal(cleaned('https://example.com/ok', { name: 'a'.repeat(255) }).url, 'https://example.com/ok');
    assert.equal(cleaned('https://example.com/ok', { name: '\u202Eclip.txt' }).url, 'https://example.com/ok');
  });

  it('refuses an image, an unknown type, and an over-size clip', () => {
    assert.equal(refusal(clipItem('img', { name: 'sun.jpg', file: { type: 'public.jpeg', sha256: undefined } })), ONLY_MEDIA);
    assert.equal(refusal(clipItem('png', { file: { type: 'public.png' } })), ONLY_MEDIA);
    assert.equal(refusal(clipItem('odd', { file: { type: 'com.example.archive' } })), ONLY_MEDIA);
    assert.equal(refusal(clipItem('caps', { file: { type: 'Public.mpeg-4' } })), ONLY_MEDIA);
    assert.equal(refusal(clipItem('big', { file: { sizeBytes: CLIP_BYTES + 1 } })), 'The clip is larger than 8 GB.');
    assert.equal(
      refusal(clipItem('huge-photo', { file: { type: 'public.jpeg', sizeBytes: CLIP_BYTES + 1, sha256: undefined } })),
      ONLY_MEDIA,
    );
    const kept = sortDrop(makeDrop([clipItem('edge', { file: { sizeBytes: CLIP_BYTES } })]));
    assert.equal(kept.sources[0].file.sizeBytes, CLIP_BYTES);
    assert.equal(JSON.stringify(sortDrop(makeDrop([clipItem('img', { name: 'sun.jpg', file: { type: 'public.jpeg' } })]))).includes('sun.jpg'), false);
  });
});

describe('5. duplicates', () => {
  it('keeps two clips that share a name and size when the sha256 differs', () => {
    const result = sortDrop(makeDrop([
      clipItem('c1', { name: 'holiday.mp4', addedAt: '2026-11-01T10:00:00Z', file: { sizeBytes: 1200, sha256: SHA_A } }),
      clipItem('c2', { name: 'holiday.mp4', addedAt: '2026-11-01T11:00:00Z', file: { sizeBytes: 1200, type: 'com.apple.quicktime-movie', sha256: SHA_B } }),
    ]));
    assert.deepEqual(result.sources.map((source) => source.sourceKey), [`clip:${SHA_A}`, `clip:${SHA_B}`]);
    assert.equal(result.duplicates.length, 0);
    assert.equal(result.sources[0].title, 'holiday');
    assert.equal(result.sources[1].title, 'holiday');
  });

  it('treats the same sha256 under two names as a duplicate', () => {
    const result = sortDrop(makeDrop([
      clipItem('later', { name: 'second-name.mov', addedAt: '2026-11-01T11:00:00Z', file: { sha256: SHA_A, type: 'com.apple.quicktime-movie' } }),
      clipItem('earlier', { name: 'first-name.mp4', addedAt: '2026-11-01T10:00:00Z', file: { sha256: SHA_A } }),
    ]));
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].id, 'earlier');
    assert.equal(result.sources[0].title, 'first-name');
    assert.deepEqual(result.duplicates, [{ id: 'later', sourceKey: `clip:${SHA_A}`, repeats: 'earlier' }]);
    assert.equal(JSON.stringify(result).includes('second-name'), false);
  });

  it('collapses the same reel with different tracking tags, and the earliest item wins', () => {
    const result = sortDrop(makeDrop([
      textItem('later', 'Wow https://example.com/reel?utm_source=ig please', { addedAt: '2026-11-01T15:00:00Z' }),
      textItem('earlier', 'https://example.com/reel?gclid=BBB&fbclid=AAA', { addedAt: '2026-11-01T14:00:00Z' }),
    ]));
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].id, 'earlier');
    assert.equal(result.sources[0].sourceKey, 'https://example.com/reel');
    assert.deepEqual(result.duplicates, [{ id: 'later', sourceKey: 'https://example.com/reel', repeats: 'earlier' }]);
    assert.equal(result.counts.droppedWords, 2);
  });

  it('reports a key already in known as repeats known', () => {
    const result = sortDrop(makeDrop([
      textItem('b', 'https://example.com/reel?utm_campaign=spring', { addedAt: '2026-11-01T10:00:00Z' }),
      textItem('a', 'https://example.com/reel', { addedAt: '2026-11-01T09:00:00Z' }),
    ], ['https://example.com/reel']));
    assert.equal(result.sources.length, 0);
    assert.deepEqual(result.duplicates, [
      { id: 'a', sourceKey: 'https://example.com/reel', repeats: 'known' },
      { id: 'b', sourceKey: 'https://example.com/reel', repeats: 'known' },
    ]);
  });

  it('breaks a tie on the same instant by id, not by input order', () => {
    const result = sortDrop(makeDrop([
      textItem('m', 'https://example.com/r', { addedAt: '2026-11-01T18:00:00Z' }),
      textItem('a', 'https://example.com/r', { addedAt: '2026-11-01T13:00:00-05:00' }),
    ]));
    assert.equal(result.sources[0].id, 'a');
    assert.equal(result.sources[0].addedAt, '2026-11-01T13:00:00-05:00');
    assert.equal(result.duplicates[0].repeats, 'a');
  });
});

describe('6. input checks', () => {
  it('names the item position for a bad instant, a repeated id, an unknown field, and a missing field', () => {
    const good = textItem('good', 'https://example.com/a');
    assert.match(fileRefusal(makeDrop([good, textItem('bad', 'https://example.com/b', { addedAt: '2026-02-29T00:00:00Z' })])), /items, item 2: addedAt/);
    assert.match(fileRefusal(makeDrop([good, textItem('bad', 'https://example.com/b', { addedAt: '2026-11-01T00:00:00' })])), /items, item 2/);
    assert.match(fileRefusal(makeDrop([good, textItem('bad', 'https://example.com/b', { addedAt: 'not-a-date' })])), /items, item 2: addedAt must be an RFC 3339 instant/);
    assert.equal(
      fileRefusal(makeDrop([good, textItem('other', 'https://example.com/b'), textItem('good', 'https://example.com/c')])),
      'items, item 3: repeated id "good".',
    );
    assert.equal(
      fileRefusal(makeDrop([good, { ...textItem('bad', 'https://example.com/b'), extra: true }])),
      'items, item 2: unknown field "extra".',
    );
    assert.equal(fileRefusal(makeDrop([{ name: 'n.txt', addedAt: AT, kind: 'text', text: 'https://example.com' }])), 'items, item 1: id is missing.');
    assert.equal(fileRefusal(makeDrop([textItem('a', 'https://example.com', { kind: 'note' })])), 'items, item 1: kind must be text or file.');
    assert.equal(fileRefusal({ schemaVersion: 1, items: [], known: [], notes: true }), 'drop: unknown field "notes".');
    assert.equal(fileRefusal({ schemaVersion: 2, items: [], known: [] }), 'drop: schemaVersion must be 1.');
    assert.equal(fileRefusal({ schemaVersion: '1', items: [], known: [] }), 'drop: schemaVersion must be 1.');
    assert.equal(fileRefusal({ items: [], known: [] }), 'drop: schemaVersion must be 1.');
    assert.equal(fileRefusal(null), 'drop: the drop must be a JSON object.');
    assert.match(fileRefusal({ schemaVersion: 1, known: [] }), /items is missing/);
    assert.match(fileRefusal({ schemaVersion: 1, items: [], known: 'nope' }), /known must be a list/);
    assert.equal(fileRefusal({ schemaVersion: 1, items: [], known: ['ok', 2] }), 'known, item 2: sourceKey must be text.');
  });

  it('refuses a repeated id before any result is returned', () => {
    let returned = false;
    assert.throws(() => {
      const result = sortDrop(makeDrop([textItem('same', 'https://example.com/a'), textItem('same', 'https://example.com/b')]));
      returned = result;
    }, CaptureError);
    assert.equal(returned, false);
  });

  it('refuses text over 64 KB, a bad sha256, and lists past their limits', () => {
    const big = `https://example.com/${'x'.repeat(TEXT_BYTES)}`;
    assert.match(fileRefusal(makeDrop([textItem('a', big)])), /items, item 1: text is \d+ bytes/);
    assert.match(
      fileRefusal(makeDrop([clipItem('a', { file: { sha256: SHA_A.toUpperCase() } })])),
      /items, item 1: file.sha256 must be 64 lowercase hex characters/,
    );
    assert.match(fileRefusal(makeDrop([clipItem('a', { file: { sha256: null } })])), /sha256/);
    assert.match(fileRefusal(makeDrop([clipItem('a', { file: { sha256: '' } })])), /sha256/);
    assert.match(fileRefusal(makeDrop([clipItem('a', { file: { sha256: 'abc' } })])), /file.sha256/);
    assert.match(fileRefusal(makeDrop([clipItem('a', { file: { sizeBytes: -0 } })])), /sizeBytes/);
    assert.match(fileRefusal(makeDrop([clipItem('a', { file: { sizeBytes: 1.5 } })])), /sizeBytes/);
    assert.match(fileRefusal({ schemaVersion: 1, items: Array(501).fill(1), known: [] }), /501 items/);
    assert.match(fileRefusal({ schemaVersion: 1, items: [], known: Array(50001).fill('k') }), /50001 items/);
    const full = sortDrop(makeDrop(Array.from({ length: 500 }, (_, index) => textItem(`i${index}`, `https://example.com/${index}`))));
    assert.equal(full.counts.sources, 500);
    const known = sortDrop({ schemaVersion: 1, items: [], known: Array.from({ length: 50000 }, (_, index) => `k${index}`) });
    assert.equal(known.counts.items, 0);
  });
});

describe('7. hostile text and a 64 KB item', () => {
  it('returns hostile link text and clip names unchanged, on one summary line', () => {
    const path = '/a<b>"\'<script>😀\u202E\u202D\t\nعربي';
    const url = `https://example.com${path}`;
    const xml = `<?xml version="1.0"?>\n<plist version="1.0"><dict><!-- https://example.com/decoy --><key>URL</key><string>${url.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</string></dict></plist>`;
    const decoded = url;
    const clipName = 'quote " <tag> 😀 عربي\u202E\u202D.mov';
    const big = `https://example.com/${'x'.repeat(TEXT_BYTES - 'https://example.com/'.length)}`;
    assert.equal(Buffer.byteLength(big), TEXT_BYTES);
    const result = sortDrop(makeDrop([
      textItem('hostile', xml, { name: 'reel.webloc', addedAt: '2026-11-01T10:00:00Z' }),
      clipItem('named', { name: clipName, addedAt: '2026-11-01T11:00:00Z', file: { sha256: SHA_C, type: 'com.apple.quicktime-movie' } }),
      textItem('big', big, { name: 'big.txt', addedAt: '2026-11-01T12:00:00Z' }),
    ]));
    assert.equal(result.sources[0].url, decoded);
    assert.equal(result.sources[0].sourceKey, decoded);
    assert.equal(JSON.parse(JSON.stringify(result)).sources[0].url, decoded);
    assert.equal(result.sources[1].title, 'quote " <tag> 😀 عربي\u202E\u202D');
    assert.equal(result.sources[2].sourceKey, big);
    assert.equal(JSON.stringify(result).includes('decoy'), false);
    const summary = formatDrop(result);
    const lines = summary.split('\n');
    const linkLine = lines.find((line) => line.includes('https://example.com/a'));
    const clipLine = lines.find((line) => line.startsWith('clip  '));
    const bigLine = lines.find((line) => line.includes(big.slice(0, 40)));
    assert.ok(linkLine);
    assert.equal(linkLine.includes('\t'), false);
    assert.equal(linkLine.includes('\u202E'), false);
    assert.equal(linkLine.includes('\u202D'), false);
    assert.match(linkLine, /\\t/);
    assert.match(linkLine, /\\n/);
    assert.match(linkLine, /\\u202e/);
    assert.match(linkLine, /\\u202d/);
    assert.match(linkLine, /<script>/);
    assert.match(linkLine, /😀/);
    assert.match(linkLine, /عربي/);
    assert.ok(clipLine);
    assert.equal(clipLine.includes('\u202E'), false);
    assert.match(clipLine, /\\u202e/);
    assert.match(clipLine, /😀/);
    assert.ok(bigLine.includes(big));
    assert.equal(oneLine('a\\\nb\t\u202E'), 'a\\\\\\nb\\t\\u202e');
  });
});

describe('8. determinism and no clock', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  it('gives byte-identical JSON when items and known are shuffled', () => {
    const original = JSON.stringify(sortDrop(fixture));
    const reversed = structuredClone(fixture);
    reversed.items.reverse();
    reversed.known.reverse();
    const rotated = structuredClone(fixture);
    rotated.items.push(rotated.items.shift());
    rotated.known.push(rotated.known.shift());
    assert.equal(JSON.stringify(sortDrop(reversed)), original);
    assert.equal(JSON.stringify(sortDrop(rotated)), original);
    assert.equal(`${JSON.stringify(sortDrop(fixture), null, 2)}\n`, readFileSync(expectedJson, 'utf8'));
  });

  it('does not mutate its input, including a frozen drop', () => {
    const drop = structuredClone(fixture);
    const before = JSON.stringify(drop);
    sortDrop(drop);
    assert.equal(JSON.stringify(drop), before);
    const frozen = structuredClone(fixture);
    freeze(frozen);
    assert.equal(JSON.stringify(sortDrop(frozen)), JSON.stringify(sortDrop(fixture)));
  });

  it('runs with Date.now, an argument-less Date, locale and random stubbed to throw', () => {
    const RealDate = globalThis.Date;
    const thrown = [];
    const localNames = [
      'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
      'getMilliseconds', 'getTimezoneOffset', 'setFullYear', 'setMonth', 'setDate', 'setHours',
      'toString', 'toDateString', 'toTimeString', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
    ];
    const originals = new Map(localNames.map((name) => [name, RealDate.prototype[name]]));
    for (const name of localNames) {
      RealDate.prototype[name] = function stubbed() {
        thrown.push(name);
        throw new Error(name);
      };
    }
    const originalNow = RealDate.now;
    const originalParse = RealDate.parse;
    RealDate.now = () => {
      thrown.push('now');
      throw new Error('now');
    };
    RealDate.parse = () => {
      thrown.push('parse');
      throw new Error('parse');
    };
    function WrappedDate(...args) {
      if (!new.target || args.length === 0) {
        thrown.push('Date');
        throw new Error('Date');
      }
      return new RealDate(...args);
    }
    WrappedDate.prototype = RealDate.prototype;
    WrappedDate.now = RealDate.now;
    WrappedDate.UTC = RealDate.UTC;
    WrappedDate.parse = RealDate.parse;
    const calls = [];
    const originalRandom = Math.random;
    const originalLocale = String.prototype.localeCompare;
    const originalLower = String.prototype.toLocaleLowerCase;
    const originalsConsole = { log: console.log, error: console.error, warn: console.warn, exit: process.exit };
    const originalWrite = process.stdout.write;
    console.log = () => calls.push('log');
    console.error = () => calls.push('error');
    console.warn = () => calls.push('warn');
    process.exit = () => {
      calls.push('exit');
      throw new Error('exit');
    };
    process.stdout.write = () => {
      calls.push('stdout');
      return true;
    };
    Math.random = () => {
      thrown.push('random');
      throw new Error('random');
    };
    String.prototype.localeCompare = () => {
      thrown.push('localeCompare');
      throw new Error('localeCompare');
    };
    String.prototype.toLocaleLowerCase = () => {
      thrown.push('toLocaleLowerCase');
      throw new Error('toLocaleLowerCase');
    };
    globalThis.Date = WrappedDate;
    try {
      const result = sortDrop(fixture);
      assert.equal(result.counts.sources, 5);
      assert.deepEqual(thrown, []);
      assert.deepEqual(calls, []);
    } finally {
      globalThis.Date = RealDate;
      RealDate.now = originalNow;
      RealDate.parse = originalParse;
      for (const [name, fn] of originals) RealDate.prototype[name] = fn;
      console.log = originalsConsole.log;
      console.error = originalsConsole.error;
      console.warn = originalsConsole.warn;
      process.exit = originalsConsole.exit;
      process.stdout.write = originalWrite;
      Math.random = originalRandom;
      String.prototype.localeCompare = originalLocale;
      String.prototype.toLocaleLowerCase = originalLower;
    }
  });
});

describe('9. nothing fetched and nothing written', () => {
  it('makes a network entry point throw', () => {
    assert.throws(() => globalThis.fetch('http://example.test'), /Blocked in tests: fetch/);
    assert.deepEqual(takeCalls(), ['fetch']);
  });

  it('reads a drop file and writes nothing', () => {
    const cap = capture();
    assert.equal(main(['--drop', fixturePath, '--json'], cap.io), 0);
    assert.equal(cap.out.stdout.startsWith('{'), true);
  });

  it('does not refer to the network, the clock, or process.exit', () => {
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.mjs')) continue;
      const text = readFileSync(join(srcDir, name), 'utf8');
      assert.equal(text.includes('process.exit('), false, name);
      assert.equal(text.includes('Date.now'), false, name);
      assert.equal(text.includes('fetch('), false, name);
      assert.equal(text.includes('node:http'), false, name);
      assert.equal(text.includes('node:net'), false, name);
      assert.equal(text.includes('node:https'), false, name);
    }
  });

  it('refuses a missing file, bad JSON, a file over 8 MB, and unknown arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-inbox-'));
    try {
      const missing = capture();
      assert.equal(main(['--drop', join(dir, 'missing.json')], missing.io), 1);
      assert.equal(missing.out.stdout, '');
      assert.match(missing.out.stderr, /Couldn't open the drop file/);
      assert.match(missing.out.stderr, /Usage: node packages\/capture-inbox\/src\/sort.mjs --drop <drop.json> \[--json\]/);

      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{');
      const badCap = capture();
      assert.equal(main(['--drop', bad], badCap.io), 1);
      assert.equal(badCap.out.stdout, '');
      assert.match(badCap.out.stderr, /not valid JSON/);

      const bom = join(dir, 'bom.json');
      writeFileSync(bom, '\uFEFF{"schemaVersion":1,"items":[],"known":[]}');
      const bomCap = capture();
      assert.equal(main(['--drop', bom], bomCap.io), 1);
      assert.match(bomCap.out.stderr, /not valid JSON/);

      const dup = join(dir, 'dup.json');
      writeFileSync(dup, '{"schemaVersion":2,"schemaVersion":1,"items":[],"known":[]}');
      const dupCap = capture();
      assert.equal(main(['--drop', dup, '--json'], dupCap.io), 0);
      assert.equal(JSON.parse(dupCap.out.stdout).schemaVersion, 1);

      const exact = join(dir, 'exact.json');
      const core = '{"schemaVersion":1,"items":[],"known":[]}';
      writeFileSync(exact, core + ' '.repeat(FILE_BYTES - Buffer.byteLength(core)));
      const exactCap = capture();
      assert.equal(main(['--drop', exact, '--json'], exactCap.io), 0);
      assert.equal(JSON.parse(exactCap.out.stdout).counts.items, 0);

      const huge = join(dir, 'huge.json');
      writeFileSync(huge, Buffer.alloc(FILE_BYTES + 1, 0x78));
      const hugeCap = capture();
      assert.equal(main(['--drop', huge], hugeCap.io), 1);
      assert.equal(hugeCap.out.stdout, '');
      assert.match(hugeCap.out.stderr, /8388608 bytes/);

      const twice = capture();
      assert.equal(main(['--drop', fixturePath, '--drop', fixturePath], twice.io), 1);
      assert.match(twice.out.stderr, /--drop was given twice/);
      const flag = capture();
      assert.equal(main(['--json', '--json', '--drop', fixturePath], flag.io), 1);
      assert.match(flag.out.stderr, /--json was given twice/);
      const unknown = capture();
      assert.equal(main(['--day', fixturePath], unknown.io), 1);
      assert.match(unknown.out.stderr, /Unknown option/);
      const needed = capture();
      assert.equal(main([], needed.io), 1);
      assert.match(needed.out.stderr, /--drop is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a value whose JSON text is over 8 MB', () => {
    function sized(bytes) {
      const prefix = '{"schemaVersion":1,"items":[],"known":["';
      const suffix = '"]}';
      const fill = bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      return JSON.parse(prefix + 'a'.repeat(fill) + suffix);
    }
    assert.equal(sortDrop(sized(FILE_BYTES)).counts.items, 0);
    assert.match(fileRefusal(sized(FILE_BYTES + 1)), /8388608 bytes/);
  });
});

describe('edge cases', () => {
  it('sorts a bad item into refused and keeps the good items', () => {
    const result = sortDrop(makeDrop([
      textItem('good', 'https://example.com/good', { addedAt: '2026-11-01T10:00:00Z' }),
      textItem('bad', 'https://example.com/secret', { name: '../x', addedAt: '2026-11-01T11:00:00Z' }),
      clipItem('clip', { addedAt: '2026-11-01T12:00:00Z' }),
    ]));
    assertShape(result, 3);
    assert.deepEqual(result.sources.map((source) => source.id), ['good', 'clip']);
    assert.equal(result.refused[0].id, 'bad');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });

  it('counts an emoji id as two characters and allows 200', () => {
    assert.equal(cleaned('https://example.com/a', { id: '😀'.repeat(100) }).id, '😀'.repeat(100));
    assert.match(fileRefusal(makeDrop([textItem('😀'.repeat(101), 'https://example.com/a')])), /1 to 200 characters/);
    assert.match(fileRefusal(makeDrop([textItem('', 'https://example.com/a')])), /1 to 200 characters/);
  });

  it('refuses empty text because it has no link, and measures text in UTF-8 bytes', () => {
    assert.equal(refusal(textItem('a', '')), ONLY_MEDIA);
    assert.equal(refusal(textItem('a', '   \n  ')), ONLY_MEDIA);
    const emoji = '😀';
    assert.equal(Buffer.byteLength(emoji), 4);
    const body = `https://example.com/${emoji.repeat((TEXT_BYTES - 'https://example.com/'.length) / 4)}`;
    assert.equal(Buffer.byteLength(body), TEXT_BYTES);
    assert.equal(cleaned(body).url, body);
  });

  it('keeps fraction digits only for ordering and accepts a real leap day', () => {
    const result = sortDrop(makeDrop([
      textItem('late', 'https://example.com/late', { addedAt: '2026-11-01T00:00:00.500Z' }),
      textItem('early', 'https://example.com/early', { addedAt: '2026-11-01T00:00:00.4009Z' }),
      textItem('b', 'https://example.com/b', { addedAt: '2026-11-01T01:00:00.1001Z' }),
      textItem('a', 'https://example.com/a', { addedAt: '2026-11-01T01:00:00.1009Z' }),
    ]));
    assert.deepEqual(result.sources.map((source) => source.id), ['early', 'late', 'a', 'b']);
    assert.equal(result.sources[0].addedAt, '2026-11-01T00:00:00.4009Z');
    assert.equal(cleaned('https://example.com/leap', { addedAt: '2024-02-29T00:00:00Z' }).addedAt, '2024-02-29T00:00:00Z');
    assert.match(fileRefusal(makeDrop([textItem('a', 'https://example.com/a', { addedAt: '2026-11-01T24:00:00Z' })])), /addedAt/);
    assert.match(fileRefusal(makeDrop([textItem('a', 'https://example.com/a', { addedAt: '0000-01-01T00:00:00Z' })])), /addedAt/);
    assert.equal(cleaned('https://example.com/old', { addedAt: '0001-01-01T00:00:00Z' }).addedAt, '0001-01-01T00:00:00Z');
  });

  it('refuses a clip with no sha256 and allows the field to be absent on other files', () => {
    assert.equal(refusal(clipItem('a', { file: { sha256: undefined } })), 'A clip needs a sha256 of its bytes.');
    const image = { id: 'img', name: 'sun.jpg', addedAt: AT, kind: 'file', file: { sizeBytes: 4, type: 'public.jpeg' } };
    assert.equal(refusal(image), ONLY_MEDIA);
    assert.doesNotThrow(() => sortDrop(makeDrop([image])));
  });

  it('allows a 0-byte clip and a name of 255 UTF-8 bytes', () => {
    const zero = sortDrop(makeDrop([clipItem('z', { file: { sizeBytes: 0 } })]));
    assert.equal(zero.sources[0].file.sizeBytes, 0);
    const name = `${'é'.repeat(127)}a`;
    assert.equal(Buffer.byteLength(name), 255);
    assert.equal(sortDrop(makeDrop([clipItem('n', { name })])).sources[0].title, name);
    assert.equal(refusal(clipItem('n', { name: 'é'.repeat(128) })), 'The name is longer than 255 bytes.');
  });

  it('chooses webloc and url from the final extension only', () => {
    assert.equal(cleaned('https://example.com/plain', { name: 'notes.webloc.txt' }).url, 'https://example.com/plain');
    assert.equal(cleaned('https://example.com/hidden', { name: '.webloc' }).url, 'https://example.com/hidden');
    assert.match(refusal(textItem('a', 'bplist00not-xml', { name: 'reel.webloc' })), /binary property list/);
    assert.match(refusal(textItem('a', '<plist>not really\u0000</plist>', { name: 'reel.webloc' })), /binary property list/);
    assert.equal(refusal(textItem('a', 'hello', { name: 'reel.webloc' })), 'The webloc is not an XML property list.');
  });

  it('ignores a webloc comment and a URL= line outside the section', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE plist SYSTEM "http://example.com/PropertyList.dtd">
<plist version="1.0"><dict>
<!-- <key>URL</key><string>https://example.com/decoy</string> -->
<key>URL</key><string>https://example.com/real?utm_source=x&amp;keep=1</string>
</dict></plist>`;
    const source = cleaned(xml, { name: 'reel.webloc' });
    assert.equal(source.url, 'https://example.com/real?keep=1');
    const custom = '<?xml version="1.0"?><plist version="1.0"><dict><key>URL</key><string>https://example.com/keep&unknown;end</string></dict></plist>';
    assert.equal(cleaned(custom, { name: 'a.webloc' }).url, 'https://example.com/keep&unknown;end');
    const urlFile = '[Other]\nURL=https://example.com/decoy\n[InternetShortcut]\nURL=https://example.com/kept\n[Later]\nURL=https://example.com/after\n';
    assert.equal(cleaned(urlFile, { name: 'card.url' }).url, 'https://example.com/kept');
    assert.equal(sortDrop(makeDrop([textItem('a', xml, { name: 'reel.webloc' })])).counts.droppedWords, 0);
  });

  it('keeps the first http(s) link when an earlier scheme is also present', () => {
    const result = sortDrop(makeDrop([textItem('a', 'See javascript:alert(1) then https://example.com/ok later')]));
    assert.equal(result.sources[0].url, 'https://example.com/ok');
    assert.equal(result.counts.droppedWords, 4);
    assert.equal(JSON.stringify(result).includes('alert'), false);
    assert.equal(refusal(textItem('a', 'Note: hello there')), ONLY_MEDIA);
    assert.equal(refusal(textItem('a', 'http:not-a-url')), 'The link is not an http or https address.');
  });

  it('strips trailing punctuation and an unmatched closing paren', () => {
    assert.equal(cleaned('See (https://example.com/a). please').url, 'https://example.com/a');
    assert.equal(cleaned('https://example.com/a/b).').url, 'https://example.com/a/b');
    assert.equal(cleaned('https://example.com/path_(keep)').url, 'https://example.com/path_(keep)');
    assert.equal(sortDrop(makeDrop([textItem('a', 'See (https://example.com/a). please')])).counts.droppedWords, 2);
  });

  it('does not treat an @ in the path as a user name', () => {
    assert.equal(cleaned('https://example.com/a@b').url, 'https://example.com/a@b');
    assert.equal(cleaned('https://tiktok.com/@example/video/1').site, 'tiktok');
  });

  it('refuses a port that is not 1 to 5 digits or is above 65535', () => {
    assert.equal(refusal(textItem('a', 'https://example.com:99999/a')), "The link's port is not valid.");
    assert.equal(refusal(textItem('a', 'https://example.com:000443/a')), "The link's port is not valid.");
    assert.equal(cleaned('https://example.com:0080/a').url, 'https://example.com:80/a');
  });

  it('labels the host table, including subdomains, after rewriting', () => {
    assert.equal(cleaned('https://shop.instagram.com/example').site, 'instagram');
    assert.equal(cleaned('https://shop.instagram.com/example').url, 'https://shop.instagram.com/example');
    assert.equal(cleaned('https://m.facebook.com/example').site, 'facebook');
    assert.equal(cleaned('https://fb.watch/example').site, 'facebook');
    assert.equal(cleaned('https://www.facebook.com/example/posts/1').url, 'https://www.facebook.com/example/posts/1');
    assert.equal(cleaned('https://x.com/example').site, 'x');
    assert.equal(cleaned('https://music.youtube.com/watch?v=aaaaaaaaaaa').site, 'youtube');
    assert.equal(cleaned('https://notyoutube.com/watch?v=aaaaaaaaaaa').site, 'web');
    assert.equal(cleaned('https://youtube-nocookie.com/embed/aaaaaaaaaaa').site, 'youtube');
    assert.equal(cleaned('https://youtube-nocookie.com/embed/aaaaaaaaaaa').url, 'https://youtube-nocookie.com/embed/aaaaaaaaaaa');
  });

  it('caps a link title at 80 characters and does not cut a surrogate pair', () => {
    const fitted = `https://example.com/${'a'.repeat(64)}`;
    assert.equal(cleaned(fitted).title, `web example.com/${'a'.repeat(64)}`);
    assert.equal(cleaned(fitted).title.length, 80);
    const long = `https://example.com/${'a'.repeat(64)}q`;
    const longTitle = cleaned(long).title;
    assert.equal(longTitle.length, 80);
    assert.equal(longTitle.endsWith('…'), true);
    assert.equal(longTitle.includes('q'), false);
    assert.equal(cleaned(long).sourceKey.includes('q'), true);
    const rest = `example.com/${'a'.repeat(62)}😀bbb`;
    const marked = cleaned(`https://${rest}`);
    assert.equal(marked.title.includes('😀'), false);
    assert.equal(marked.sourceKey.includes('😀'), true);
    assert.equal(marked.title.length <= 80, true);
    for (let i = 0; i < marked.title.length; i += 1) {
      const code = marked.title.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = marked.title.charCodeAt(i + 1);
        assert.equal(next >= 0xDC00 && next <= 0xDFFF, true);
      }
    }
  });

  it('builds a clip title from the name, leaving a leading dot in place', () => {
    assert.equal(sortDrop(makeDrop([clipItem('a', { name: 'my.clip.mov' })])).sources[0].title, 'my.clip');
    assert.equal(sortDrop(makeDrop([clipItem('a', { name: 'noext' })])).sources[0].title, 'noext');
    assert.equal(sortDrop(makeDrop([clipItem('a', { name: '.hidden' })])).sources[0].title, '.hidden');
    assert.equal(sortDrop(makeDrop([clipItem('a', { name: '.hidden.mp4' })])).sources[0].title, '.hidden');
    assert.equal(sortDrop(makeDrop([clipItem('a', { name: '...' })])).sources[0].title, '..');
    assert.equal(sortDrop(makeDrop([clipItem('a', { name: 'file.' })])).sources[0].title, 'file');
    assert.equal(sortDrop(makeDrop([clipItem('a', { name: ' a ' })])).sources[0].title, ' a ');
    assert.equal(sortDrop(makeDrop([clipItem('a', { name: 'a／b.mp4' })])).sources[0].title, 'a／b');
  });

  it('orders refusals by instant and then id', () => {
    const result = sortDrop(makeDrop([
      textItem('b', 'no link here', { name: 'b.txt', addedAt: '2026-11-01T10:00:00Z' }),
      textItem('a', 'also no link', { name: 'a.txt', addedAt: '2026-11-01T10:00:00Z' }),
      textItem('c', 'later note', { name: 'c.txt', addedAt: '2026-11-01T11:00:00Z' }),
    ]));
    assert.deepEqual(result.refused.map((item) => item.id), ['a', 'b', 'c']);
  });

  it('does not match known against a raw URL that still has tracking tags', () => {
    const result = sortDrop(makeDrop(
      [textItem('a', 'https://example.com/reel')],
      ['https://example.com/reel?utm_source=x'],
    ));
    assert.equal(result.sources.length, 1);
    assert.equal(result.duplicates.length, 0);
  });

  it('treats https://example.com and https://example.com/ as the same source', () => {
    const result = sortDrop(makeDrop([
      textItem('slash', 'https://example.com/', { addedAt: '2026-11-01T11:00:00Z' }),
      textItem('bare', 'https://example.com', { addedAt: '2026-11-01T10:00:00Z' }),
    ]));
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].id, 'bare');
    assert.equal(result.sources[0].sourceKey, 'https://example.com/');
    assert.equal(result.duplicates[0].repeats, 'bare');
  });

  it('keeps the first t and a bare t on a YouTube rewrite', () => {
    assert.equal(cleaned('https://youtu.be/aaaaaaaaaaa?t=1&t=2').url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=1');
    assert.equal(cleaned('https://youtu.be/aaaaaaaaaaa?t').url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t');
    assert.equal(
      cleaned('https://www.youtube.com/watch?V=aaaaaaaaaaa').url,
      'https://www.youtube.com/watch?V=aaaaaaaaaaa',
    );
  });

  it('copies clip file details and does not share the object with the input', () => {
    const item = clipItem('c');
    const result = sortDrop(makeDrop([item]));
    assert.notEqual(result.sources[0].file, item.file);
    item.file.sizeBytes = 99;
    assert.equal(result.sources[0].file.sizeBytes, 10);
    assert.deepEqual(result.sources[0].file, { sizeBytes: 10, type: 'public.mpeg-4', sha256: SHA_A });
  });

  it('refuses a link with no host', () => {
    assert.equal(refusal(textItem('a', 'https://')), 'The link has no host.');
    assert.equal(refusal(textItem('a', 'https:///missing')), 'The link has no host.');
  });
});
