// The command's plain view. One section per list, in a fixed order.

const SECTIONS = [
  ['overdue', 'Overdue'],
  ['dueToday', 'Due today'],
  ['comingUp', 'Coming up'],
  ['missingItem', 'Missing item'],
  ['done', 'Done'],
];

function line(row) {
  const overdue = row.daysOverdue === undefined
    ? ''
    : `  ${row.daysOverdue} ${row.daysOverdue === 1 ? 'day' : 'days'} overdue`;
  return `${row.dueOn}${overdue}  ${row.title}  ${row.itemKind} ${row.itemId}  ${row.id}`;
}

export function formatView(view) {
  const parts = [];
  for (const [key, heading] of SECTIONS) {
    const rows = view[key];
    const lines = [`${heading} (${rows.length})`];
    if (rows.length === 0) lines.push('(none)');
    for (const row of rows) lines.push(line(row));
    parts.push(lines.join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}
