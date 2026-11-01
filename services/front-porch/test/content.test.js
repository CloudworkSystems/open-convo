import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check } from './schema-check.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const content = load('content.json');
const schema = load('content.schema.json');

test('content.json matches content.schema.json', () => {
  assert.deepEqual(check(schema, content), []);
});

test('the schema checker catches mistakes', () => {
  const broken = structuredClone(content);
  broken.features[0].status = 'shipping soon';
  delete broken.about.summary;
  broken.extra = true;
  const errors = check(schema, broken);
  assert.ok(errors.some((e) => e.includes('shipping soon')));
  assert.ok(errors.some((e) => e.includes('missing "summary"')));
  assert.ok(errors.some((e) => e.includes('unexpected "extra"')));
});

test('ids are unique', () => {
  for (const list of [content.features, content.faq]) {
    const ids = list.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test('content gives no instructions to a model', () => {
  const text = JSON.stringify(content).toLowerCase();
  for (const phrase of ['ignore previous', 'ignore all', 'you must', 'system prompt', 'assistant:', 'disregard']) {
    assert.ok(!text.includes(phrase), `content contains "${phrase}"`);
  }
});

test('nothing claims to be available while the app is unreleased', () => {
  assert.equal(content.status.stage, 'in development');
  assert.ok(content.features.every((f) => f.status !== 'available'));
});
