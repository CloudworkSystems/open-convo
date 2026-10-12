import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tokens = readFileSync(new URL("../../brand/tokens.css", import.meta.url), "utf8");

const token = (name) => {
  const match = tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `Expected ${name} to resolve to a hex token`);
  return match[1];
};

const luminance = (hex) => {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrast = (foreground, background) => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};

test("the dark-shell text and action token pairs meet AA contrast", () => {
  const pairs = [
    ["primary text on the page", token("tca-text-primary"), token("tca-surface-page")],
    ["body text on the page", token("tca-text-body"), token("tca-surface-page")],
    ["muted text on the page", token("tca-text-muted"), token("tca-surface-page")],
    ["amber context label on surface 1", token("tca-ember-amber"), token("tca-surface-1")],
    ["white primary button label on magenta", "#ffffff", token("tca-ember-magenta")],
    ["success state on surface 0", token("tca-status-success"), token("tca-surface-0")]
  ];

  for (const [name, foreground, background] of pairs) {
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${name} must be at least 4.5:1; received ${ratio.toFixed(2)}:1`);
  }
});
