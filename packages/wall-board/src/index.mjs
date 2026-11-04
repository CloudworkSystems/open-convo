import { readBoard } from './validate.mjs';
import { renderPage } from './render.mjs';

export { WallBoardError, FILE_BYTES, LIMITS, LINE_CAPS, SCHEMA_VERSION } from './errors.mjs';
export { COLORS, COLOR_NAMES, PAGE } from './colors.mjs';

export function renderBoard(board) {
  const model = readBoard(board);
  return {
    html: renderPage(model),
    counts: model.counts,
    warnings: model.warnings,
  };
}
