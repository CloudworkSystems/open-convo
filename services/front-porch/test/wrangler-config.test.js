import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unstable_readConfig as readConfig } from 'wrangler';

const config = (env) => readConfig({ config: new URL('../wrangler.toml', import.meta.url).pathname, env });

test('ordinary deploys answer only at the custom domain and leave its routes alone', () => {
  const production = config(undefined);
  assert.equal(production.name, 'front-porch');
  assert.equal(production.workers_dev, false);
  assert.equal(production.preview_urls, false);
  assert.equal(production.route, undefined);
  assert.equal(production.routes, undefined);
});

test('the staging settings are the same Worker with only workers.dev turned on', () => {
  const staging = config('staging');
  assert.equal(staging.name, 'front-porch');
  assert.equal(staging.workers_dev, true);
  assert.equal(staging.preview_urls, false);
  assert.equal(staging.route, undefined);
  assert.equal(staging.routes, undefined);
});
