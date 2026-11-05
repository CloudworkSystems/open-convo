import test from 'node:test';
import assert from 'node:assert/strict';
import { recallSource } from '../src/sources.mjs';
const title = text => recallSource().read([{ path: 'invented-card.md', text }]).items[0].title;
const cases = [
  ['H2 before H1 selects H1', '## Summary\n# Actual title\n', 'Actual title'],
  ['only H2s use filename', '## Summary\n\n## Details\n', 'invented-card'],
  ['setext H1 counts', 'Actual title\n===\n', 'Actual title'],
  ['setext H2 uses filename', 'Summary\n---\n', 'invented-card'],
  ['code H1 never counts', '```\n# Fake\n```\n', 'invented-card'],
  ['HTML H1 never counts', '<pre>\n# Fake\n</pre>\n', 'invented-card'],
  ['front matter H1 never counts', '---\nnote: # Fake\n---\n', 'invented-card'],
  ['quote H1 keeps 92a2eda filename behavior', '> # Quoted\n', 'invented-card'],
  ['list H1 keeps 92a2eda filename behavior', '- # Listed\n', 'invented-card'],
  ['list continuation H1 keeps 92a2eda three-space allowance', '- Intro\n  # Actual title\n', 'Actual title'],
  ['quoted setext H1 is excluded', '> Quoted\n> ===\n', 'invented-card'],
  ['listed setext H1 is excluded', '- Listed\n  ===\n', 'invented-card'],
  ['front matter title still wins', '---\ntitle: Explicit\n---\n# Actual title\n', 'Explicit']
];
for (const [name, body, expected] of cases) test(`Title level table: ${name}`, () => assert.equal(title(body), expected));
