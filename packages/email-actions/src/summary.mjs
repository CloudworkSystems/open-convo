import { oneLine } from './rules.mjs';

export function formatSummary(plan) {
  const lines = [...plan.summary];
  for (const action of plan.actions) {
    if (action.groups.length === 0) continue;
    lines.push(`${action.action}:`);
    for (const group of action.groups) lines.push(`  ${group.pile} / ${oneLine(group.label)}: ${group.count}`);
  }
  if (plan.blocked.length > 0) {
    lines.push('Blocked:');
    for (const blocked of plan.blocked) lines.push(`  Request ${blocked.position}: ${oneLine(blocked.reason)}`);
  }
  return `${lines.join('\n')}\n`;
}
