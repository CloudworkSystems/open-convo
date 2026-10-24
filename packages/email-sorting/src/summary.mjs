// The command's plain summary. Text from mail is printed on one line:
// a backslash becomes \\, line feed \n, tab \t, and the Unicode line and
// paragraph separators \u2028 and \u2029, so one printed line is always one
// line of mail text.

import { PILE_NAMES } from './rules.mjs';

export function oneLine(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatSummary(result) {
  const lines = [];
  for (const pile of result.piles) {
    const name = PILE_NAMES[pile.category];
    if (pile.count === 0) {
      lines.push(`${name}: 0`);
      continue;
    }
    lines.push(`${name}: ${pile.count} from ${plural(pile.groups.length, 'sender', 'senders')}`);
    for (const group of pile.groups) lines.push(`  ${oneLine(group.label)}: ${group.count}`);
  }
  if (result.problems.length > 0) {
    lines.push('Problems:');
    for (const problem of result.problems) lines.push(`  ${oneLine(problem)}`);
  }
  return `${lines.join('\n')}\n`;
}
