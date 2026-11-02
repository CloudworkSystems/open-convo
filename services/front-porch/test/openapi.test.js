import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Validator } from '@seriousme/openapi-schema-validator';

test('openapi.json is valid OpenAPI 3.1', async () => {
  const validator = new Validator();
  const result = await validator.validate(new URL('../openapi.json', import.meta.url).pathname);
  assert.equal(validator.version, '3.1');
  assert.deepEqual(result, { valid: true });
});
