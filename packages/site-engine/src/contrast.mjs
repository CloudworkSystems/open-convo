import { SiteEngineError } from "./errors.mjs";

// Ember defaults from brand/tokens.css (October 2026):
// background --tca-surface-page, text --tca-text-primary, accent --tca-ember-coral.
// Coral is the default accent because it clears WCAG AA as small text on the
// near-black page. Magenta on that page does not, so it is not the default ink.
export const EMBER = Object.freeze({
  background: "#15110f",
  text: "#f7f2ee",
  accent: "#f37a4a",
});

const TEXT_CONTRAST = 4.5;

export function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(raw)) return null;
  if (raw.length === 4) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return raw;
}

function channel(hex, offset) {
  const byte = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return byte <= 0.04045 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const color = normalizeHex(hex);
  return 0.2126 * channel(color, 1) + 0.7152 * channel(color, 3) + 0.0722 * channel(color, 5);
}

export function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

export function resolveBrand(brand = {}) {
  return {
    background: normalizeHex(brand.background) ?? EMBER.background,
    text: normalizeHex(brand.text) ?? EMBER.text,
    accent: normalizeHex(brand.accent) ?? EMBER.accent,
  };
}

export function assertContrast(colors) {
  const pairs = [
    ["text", colors.text],
    ["accent", colors.accent],
  ];
  const failures = [];
  for (const [role, color] of pairs) {
    const ratio = contrastRatio(color, colors.background);
    if (ratio < TEXT_CONTRAST) {
      failures.push(
        `${role} ${color} on background ${colors.background} is ${ratio.toFixed(2)}:1`,
      );
    }
  }
  if (failures.length > 0) {
    throw new SiteEngineError(
      `Brand colors fail WCAG AA contrast (need ${TEXT_CONTRAST}:1): ${failures.join("; ")}.`,
    );
  }
}

export function colorScheme(background) {
  return relativeLuminance(background) > 0.4 ? "light" : "dark";
}
