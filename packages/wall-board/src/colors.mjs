// Eight named colors. Each theme pairs a fill with the text drawn on it.
// Both pairs clear 4.5:1. The page chrome is separate and is not a person color.

export const COLOR_NAMES = Object.freeze([
  'teal', 'coral', 'gold', 'blue', 'green', 'plum', 'rust', 'slate',
]);

const INK = Object.freeze({ light: '#ffffff', dark: '#1a120c' });

function swatch(lightFill, darkFill) {
  return Object.freeze({
    light: Object.freeze({ fill: lightFill, text: INK.light }),
    dark: Object.freeze({ fill: darkFill, text: INK.dark }),
  });
}

export const COLORS = Object.freeze({
  teal: swatch('#0e5c58', '#8ef0e6'),
  coral: swatch('#a33b32', '#ffb8ae'),
  gold: swatch('#7a5200', '#ffd56a'),
  blue: swatch('#1c4e96', '#c5d8ff'),
  green: swatch('#1c6630', '#a6e8b8'),
  plum: swatch('#6b3878', '#f0c6ff'),
  rust: swatch('#8a3d10', '#ffc7a8'),
  slate: swatch('#3a4654', '#d5dee8'),
});

export const PAGE = Object.freeze({
  light: Object.freeze({
    background: '#f4f0e8',
    text: '#1b1714',
    warning: '#8a2e0b',
    warningBackground: '#f6e2c4',
  }),
  dark: Object.freeze({
    background: '#14110f',
    text: '#f6f1ea',
    warning: '#ffc2a2',
    warningBackground: '#3a2418',
  }),
});
