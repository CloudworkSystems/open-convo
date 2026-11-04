import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderBoard } from '../src/index.mjs';
import { board, person, timed } from './helpers.mjs';

describe('escaping', () => {
  it('escapes markup and writes controls out', () => {
    const title = 'A <script>alert(1)</script> & "quote" \'tick\'\nline \\path \u0001\u202Eend';
    const value = board({
      title: 'Maple & Co <main>',
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        events: [timed('odd', title, 9, 10, 'Family', { location: 'Room <b>4</b>' })],
      })],
    });
    const html = renderBoard(value).html;
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('alert(1)'), true);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp;/);
    assert.match(html, /&quot;quote&quot;/);
    assert.match(html, /&#39;tick&#39;/);
    assert.match(html, /\\nline/);
    assert.match(html, /\\\\path/);
    assert.match(html, /\\u0001/);
    assert.match(html, /\\u202e/);
    assert.equal(html.includes('\u0001'), false);
    assert.equal(html.includes('\u202E'), false);
    assert.match(html, /Maple &amp; Co &lt;main&gt;/);
    assert.match(html, /Room &lt;b&gt;4&lt;\/b&gt;/);
    assert.match(html, /overflow-wrap: anywhere/);
    assert.match(html, /minmax\(0, 1fr\)/);
  });
});
