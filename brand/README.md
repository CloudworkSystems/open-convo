# True Convo Brand: Ember

Brought into Open Convo on October 14, 2026 from the old workspace's
`true_convo/brand` (rewritten for this repo). **Owner decisions, October 14,
2026:** Ember becomes the Desk's look, and the logo kit lives in this repo.

## Decision

True Convo's palette is **Ember**: a warm near-black product shell, cream text,
and a magenta-to-coral-to-amber gradient accent. Ember governs every surface,
including operational and agent screens; there is one brand system. If a
surface later needs a calmer variant, it is derived from these tokens and
recorded here first.

## Files

- `tokens.css`: the color, type and contrast tokens. Every frontend imports it
  or maps to its names.
- `fonts/`: Atkinson Hyperlegible Next and JetBrains Mono, self-hosted (no
  font CDN), with `fonts.css` and each font's SIL Open Font License
  (`OFL-*.txt`). The licenses stay next to the fonts.
- `logo/`: full logo, icon only and grayscale, each with and without padding
  and transparency; text only, with and without padding (opaque only, no
  transparent version yet); plus print SVG, PDF and EPS.
- `ember-palette-preview.svg`: a swatch board of the palette.

## Palette Shape

- Identity accent: magenta, coral and amber as one Ember gradient.
- Product shell: warm near-black and warm dark-brown surfaces.
- Text: cream primary, warm body and muted taupe secondary.
- Status colors: restrained success, warning, danger and info. Green is for
  status only, never the brand identity.

## Usage Rules

1. The Ember gradient marks primary actions, active identity, selected states,
   major progress moments and restrained glow.
2. Warm near-black surfaces carry app shells, sidebars, drawers, panels and
   terminal areas.
3. Semantic colors carry meaning (success, warning, danger, info); semantic
   green never becomes the identity.
4. No dark green, sage, teal, cyan, blue-slate, beige-only or monochrome
   palettes for True Convo surfaces unless the owner approves a new candidate.
5. Domain apps (a medical study tool, say) may use domain colors inside content
   views; the shell still inherits Ember.

## Surface Mapping

- Navigation: warm near-black base, cream labels, Ember active item.
- Agents and orchestration: warm dark surfaces, Ember selected state, semantic
  status pills.
- Runtime and terminal areas: dark base, Ember focus ring and primary action.
- Review and import screens: neutral base first; Ember marks the active source,
  approved action or current focus.

## Type And Contrast (Decided August 8, 2026)

- **Fonts:** Atkinson Hyperlegible Next for display and text, JetBrains Mono
  for code, chosen by the owner after three rendered rounds.
- **Text never sits on the gradient in the dark shell** (the magenta stop is
  3.7:1 under dark ink). Primary buttons are white on solid magenta (5.1:1);
  the gradient is a hover glow or border only.
- **Light theme inks:** accent `#d85a2e` (large text only), success `#2f7a58`,
  danger `#a33a3a`, warning `#7d5a10`; the light focus ring is solid deep coral.

## Illustration Direction (Summary)

The old brand record also set a direction for illustrations: no single mascot,
but a cast of children painted in a storybook watercolor style keyed to Ember,
with warm amber "memory dots" drifting through scenes, and applied motion only
(slow float, parallax, crossfade) inside reduced-motion guards. The full
character and generation brief stays in the old workspace until a surface needs
it (onboarding, empty states, the website).

## Implementation Contract

- Import `brand/tokens.css` or copy its token names and values into the
  runtime, citing this file. Do not create a new palette file without marking it
  a candidate and linking it here.
- Load `brand/fonts/fonts.css` before relying on the font tokens.
- The Desk (`apps/desk`) moves to Ember as a building-session task; the Mac
  app's native surfaces follow.

## Logo

The logo is the True Convo mark. Whether others may use it, and on what terms,
is part of the open license and trademark decision (PLAN.md, Open Questions);
until then, treat it as all rights reserved.
