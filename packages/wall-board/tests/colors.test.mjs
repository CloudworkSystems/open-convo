import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COLOR_NAMES, COLORS, PAGE, renderBoard } from '../src/index.mjs';
import { board } from './helpers.mjs';

function channel(hex, offset) {
  const byte = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return byte <= 0.04045 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4;
}

function contrast(foreground, background) {
  const luminance = (hex) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('colors', () => {
  it('gives each of the 8 colors 4.5:1 contrast in both themes', () => {
    assert.equal(COLOR_NAMES.length, 8);
    for (const name of COLOR_NAMES) {
      for (const theme of ['light', 'dark']) {
        const swatch = COLORS[name][theme];
        const ratio = contrast(swatch.text, swatch.fill);
        assert.ok(ratio >= 4.5, `${name} ${theme} is ${ratio.toFixed(2)}`);
      }
    }
    for (const theme of ['light', 'dark']) {
      const page = PAGE[theme];
      assert.ok(contrast(page.text, page.background) >= 4.5);
      assert.ok(contrast(page.warning, page.warningBackground) >= 4.5);
    }
  });

  it('paints the page with those same colors', () => {
    const html = renderBoard(board()).html;
    for (const name of COLOR_NAMES) {
      assert.equal(html.includes(COLORS[name].light.fill), true, name);
      assert.equal(html.includes(COLORS[name].dark.fill), true, name);
    }
  });
});
