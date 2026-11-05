import assert from 'node:assert/strict';
import { test } from 'node:test';

import { realLinksPage } from '../src/page.mjs';

const HASH = 'ab'.repeat(32);

test('the page escapes every field and keeps only the given https links', () => {
  const url = 'https://give.example/river?x=1&y=2';
  const html = realLinksPage({
    creatorName: 'A <script>alert("x")</script> & Co',
    intro: 'Hello <b>there</b> & "friends"',
    updatedAt: '2026-03-01 <script>',
    ledgerHash: HASH,
    links: [{
      label: 'Give <script> "now" & thanks',
      url,
      kind: 'donate',
    }],
  });
  assert.match(html, /These are the only real donation links for A &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; Co\./);
  assert.match(html, /Anything else asking for money in my name is not me\./);
  assert.match(html, /Proof code: ababab/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<form/i);
  assert.doesNotMatch(html, /src=/i);
  assert.doesNotMatch(html, /url\(/i);
  assert.doesNotMatch(html, /name="robots"/i);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(hrefs, ['https://give.example/river?x=1&amp;y=2']);
  assert.match(html, /class="address">https:\/\/give\.example\/river\?x=1&amp;y=2</);
});

test('http and javascript links are refused', () => {
  const base = {
    creatorName: 'River Lane',
    updatedAt: '2026-03-01',
    links: [{ label: 'Give', url: 'http://give.example/river', kind: 'donate' }],
  };
  assert.throws(() => realLinksPage(base), /Only https links/);
  assert.throws(() => realLinksPage({
    ...base,
    links: [{ label: 'Give', url: 'javascript:alert(1)', kind: 'donate' }],
  }), /Only https links/);
});
