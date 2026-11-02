import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { run } from '../src/check.mjs';
import { MAX_RECORD_BYTES, formatErrors, validateCapability } from '../src/index.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const skillsDir = join(here, '..', '..', '..', 'docs', 'skills');
const mediaPath = join(here, 'fixtures', 'make-media.json');
const media = () => JSON.parse(readFileSync(mediaPath, 'utf8'));

// Applies `change` to a fresh copy of the media record and returns its errors.
function errorsAfter(change) {
  const record = media();
  change(record);
  return validateCapability(record).errors;
}

function assertRefused(change, path, words) {
  const errors = errorsAfter(change);
  const hit = errors.find((e) => e.path === path && (!words || words.test(e.message)));
  assert.ok(hit, `expected a problem at ${path}${words ? ` matching ${words}` : ''}, got:\n${formatErrors(errors) || '(none)'}`);
}

const route = (record, id) => record.routes.find((r) => r.id === id);

test('every skill record in docs/skills still validates', () => {
  const folders = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const records = folders.map((d) => join(skillsDir, d.name, 'capability.json')).filter(existsSync);
  assert.ok(records.some((p) => p.includes('first-principles-decision')), 'first-principles-decision record not found');
  for (const path of records) {
    const result = validateCapability(JSON.parse(readFileSync(path, 'utf8')));
    assert.deepEqual(result, { ok: true, errors: [] }, `${path}\n${formatErrors(result.errors)}`);
  }
});

test('the invented media record with upload, local and own-key routes validates', () => {
  assert.deepEqual(validateCapability(media()), { ok: true, errors: [] });
});

test('a record must be a plain JSON object within the size limit', () => {
  for (const bad of [null, [], 'text', 3, new Date()]) {
    assert.equal(validateCapability(bad).ok, false);
  }
  const big = media();
  big.not_proven = Array.from({ length: 200 }, () => 'x'.repeat(390));
  const result = validateCapability(big);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, new RegExp(String(MAX_RECORD_BYTES)));
});

test('identity: exactly one of id and skill_id, kebab-case', () => {
  assertRefused((r) => delete r.id, 'id', /required/);
  assertRefused((r) => { r.skill_id = 'make-media'; }, 'skill_id', /not both/);
  assertRefused((r) => { r.id = 'Make Media'; }, 'id');
  assertRefused((r) => { r.id = '__proto__'; }, 'id');
});

test('version, status, dates and paths are checked', () => {
  assertRefused((r) => { r.version = '1.0'; }, 'version');
  assertRefused((r) => { r.status = 'live'; }, 'status');
  assertRefused((r) => { r.created = '2026-02-30'; }, 'created');
  assertRefused((r) => { r.recipe = '../SKILL.md'; }, 'recipe');
  assertRefused((r) => { r.recipe = 'notes.md'; }, 'recipe', /SKILL\.md/);
  assertRefused((r) => { r.body = '/etc/SKILL.md'; }, 'body');
});

test('unknown fields are refused at every level', () => {
  assertRefused((r) => { r.extra = 1; }, 'extra', /unknown/);
  assertRefused((r) => { r.inputs.prompt.pattern = '.*'; }, 'inputs.prompt.pattern', /unknown/);
  assertRefused((r) => { route(r, 'upload').auto_approve = true; }, 'routes[0].auto_approve', /unknown/);
  assertRefused((r) => { route(r, 'own-key-example').cost.always_allow = true; }, 'routes[2].cost.always_allow', /unknown/);
  // JSON.parse keeps "__proto__" as an ordinary own key; it is refused as unknown.
  const raw = readFileSync(mediaPath, 'utf8').trimStart();
  assert.equal(raw[0], '{');
  const withProto = JSON.parse(`{"__proto__": {"x": 1},${raw.slice(1)}`);
  const result = validateCapability(withProto);
  assert.ok(result.errors.some((e) => e.path === '__proto__' && /unknown/.test(e.message)), formatErrors(result.errors));
});

test('scripts stay empty until the permission boundary exists', () => {
  assertRefused((r) => { r.scripts = ['run.sh']; }, 'scripts', /empty/);
  assert.deepEqual(errorsAfter((r) => { r.scripts = []; }), []);
});

test('a tested capability names the models it passed on', () => {
  assertRefused((r) => { r.status = 'tested'; }, 'models_passed', /at least one/);
  assert.deepEqual(errorsAfter((r) => { r.status = 'tested'; r.models_passed = ['qwen3:8b']; }), []);
});

test('install gate outcome is one of the four', () => {
  assertRefused((r) => { r.install_gate.outcome = 'maybe'; }, 'install_gate.outcome');
  assertRefused((r) => { r.install_gate.expected = 'not run yet'; }, 'install_gate.expected');
  assertRefused((r) => delete r.install_gate, 'install_gate', /required/);
});

test('every input has a type and a limit', () => {
  assertRefused((r) => delete r.inputs.prompt.max_length, 'inputs.prompt.max_length', /required/);
  assertRefused((r) => delete r.inputs.seconds.max, 'inputs.seconds.max', /required/);
  assertRefused((r) => { r.inputs.seconds.min = 20; }, 'inputs.seconds.max', /below min/);
  assertRefused((r) => { r.inputs.seconds.max = 2.5; }, 'inputs.seconds.max', /whole/);
  assertRefused((r) => { r.inputs.kind.values = []; }, 'inputs.kind.values');
  assertRefused((r) => delete r.inputs.reference_files.max_bytes, 'inputs.reference_files.max_bytes');
  assertRefused((r) => { r.inputs.reference_files.types = ['png']; }, 'inputs.reference_files.types[0]');
  assertRefused((r) => { r.inputs.prompt.type = 'any'; }, 'inputs.prompt.type');
  assertRefused((r) => { r.inputs.Prompt = r.inputs.prompt; }, 'inputs.Prompt');
});

test('a file output lands in a named app folder, not a path', () => {
  assertRefused((r) => delete r.outputs.file.folder, 'outputs.file.folder', /required/);
  assertRefused((r) => { r.outputs.file.folder = '/Users/someone/Desktop'; }, 'outputs.file.folder');
  assertRefused((r) => { r.outputs.receipt.folder = 'media'; }, 'outputs.receipt.folder');
});

test('upload and local routes contact nobody, send nothing and are free', () => {
  assertRefused((r) => { route(r, 'upload').hosts = ['api.example.com']; }, 'routes[0].hosts', /empty/);
  assertRefused((r) => { route(r, 'local-video').hosts = ['api.example.com']; }, 'routes[1].hosts', /empty/);
  assertRefused((r) => { route(r, 'upload').leaves_machine = 'your file'; }, 'routes[0].leaves_machine', /nothing/);
  assertRefused((r) => { route(r, 'local-video').cost = route(r, 'own-key-example').cost; }, 'routes[1].cost', /free/);
  assertRefused((r) => delete route(r, 'upload').hosts, 'routes[0].hosts', /required/);
});

test('a local route names its model and its checked license', () => {
  assertRefused((r) => delete route(r, 'local-video').license, 'routes[1].license', /required/);
  assertRefused((r) => delete route(r, 'local-video').license.checked, 'routes[1].license.checked');
  assertRefused((r) => { route(r, 'local-video').license.allows_intended_use = 'yes'; }, 'routes[1].license.allows_intended_use');
  assertRefused((r) => delete route(r, 'local-video').model, 'routes[1].model', /required/);
  assertRefused((r) => { route(r, 'upload').license = route(r, 'local-video').license; }, 'routes[0].license', /only a local/);
  assertRefused((r) => { route(r, 'local-video').needs.downloads[0].from = 'http://models.example.com/x'; }, 'routes[1].needs.downloads[0].from', /https/);
  assertRefused((r) => { route(r, 'local-video').needs.memory_gb = 0; }, 'routes[1].needs.memory_gb');
});

test('a paid route names its hosts and exactly what leaves the machine', () => {
  assertRefused((r) => { route(r, 'own-key-example').hosts = []; }, 'routes[2].hosts', /names every host/);
  for (const host of ['https://api.example.com', 'api.example.com:443', 'API.example.com', '*.example.com', 'localhost', '10.0.0.1', 'api.example.com/v1']) {
    assertRefused((r) => { route(r, 'own-key-example').hosts = [host]; }, 'routes[2].hosts[0]');
  }
  assertRefused((r) => { route(r, 'own-key-example').hosts = ['api.example.com', 'api.example.com']; }, 'routes[2].hosts', /once/);
  assertRefused((r) => { route(r, 'own-key-example').leaves_machine = 'Nothing'; }, 'routes[2].leaves_machine', /exactly/);
  assertRefused((r) => delete route(r, 'own-key-example').leaves_machine, 'routes[2].leaves_machine', /required/);
});

test('a paid route has a dated, sourced price and a most-per-run, each with a currency', () => {
  const cost = (r) => route(r, 'own-key-example').cost;
  assertRefused((r) => { route(r, 'own-key-example').cost = 'free'; }, 'routes[2].cost');
  assertRefused((r) => delete cost(r).max_per_run, 'routes[2].cost.max_per_run', /required/);
  assertRefused((r) => delete cost(r).checked, 'routes[2].cost.checked', /required/);
  assertRefused((r) => delete cost(r).source, 'routes[2].cost.source', /required/);
  assertRefused((r) => { cost(r).unit = 'per_minute'; }, 'routes[2].cost.unit');
  assertRefused((r) => delete cost(r).price.currency, 'routes[2].cost.price.currency', /required/);
  assertRefused((r) => { cost(r).price.currency = 'usd'; }, 'routes[2].cost.price.currency', /ISO 4217/);
  assertRefused((r) => { cost(r).price.currency = 'XYZ'; }, 'routes[2].cost.price.currency', /ISO 4217/);
  assertRefused((r) => { cost(r).price.amount = 0.08; }, 'routes[2].cost.price.amount', /decimal text/);
  assertRefused((r) => { cost(r).price.amount = '-1'; }, 'routes[2].cost.price.amount');
  assertRefused((r) => { cost(r).price.amount = '1e3'; }, 'routes[2].cost.price.amount');
  assertRefused((r) => { cost(r).max_per_run.amount = '0'; }, 'routes[2].cost.max_per_run.amount', /more than 0/);
  assertRefused((r) => { cost(r).max_per_run.currency = 'EUR'; }, 'routes[2].cost.max_per_run.currency', /same currency/);
  assertRefused((r) => { cost(r).source = 'javascript:alert(1)'; }, 'routes[2].cost.source', /https/);
});

test('a sign-in route needs a link to terms that allow it', () => {
  const signIn = (r) => {
    const s = { ...route(r, 'own-key-example'), id: 'sign-in-example', kind: 'sign_in' };
    r.routes.push(s);
    return s;
  };
  assertRefused((r) => signIn(r), 'routes[3].terms', /required/);
  assert.deepEqual(errorsAfter((r) => { signIn(r).terms = { url: 'https://example.com/terms', checked: '2026-11-02' }; }), []);
  assertRefused((r) => { route(r, 'own-key-example').terms = { url: 'https://example.com/terms', checked: '2026-11-02' }; }, 'routes[2].terms', /only a sign_in/);
});

test('paid is never mandatory: a paid route needs a free one beside it', () => {
  assertRefused((r) => { r.routes = r.routes.filter((x) => x.kind === 'own_key'); }, 'routes', /upload or local/);
});

test('upload is always present, once, and lands a file', () => {
  assertRefused((r) => { r.routes = r.routes.filter((x) => x.kind !== 'upload'); }, 'routes', /always has an upload/);
  assertRefused((r) => { r.routes.push({ ...route(r, 'upload'), id: 'upload-two' }); }, 'routes', /only one upload/);
  assertRefused((r) => delete r.outputs.file, 'outputs', /file output/);
  assertRefused((r) => delete r.outputs, 'outputs', /file output/);
  assert.deepEqual(errorsAfter((r) => { r.routes = r.routes.filter((x) => x.kind === 'upload'); }), []);
});

test('route ids are unique and kinds are known', () => {
  assertRefused((r) => { route(r, 'local-video').id = 'upload'; }, 'routes[1].id', /twice/);
  assertRefused((r) => { route(r, 'upload').kind = 'browser'; }, 'routes[0].kind');
  assertRefused((r) => { r.routes = []; }, 'routes');
});

test('all problems are reported at once, with paths', () => {
  const errors = errorsAfter((r) => { r.version = 'x'; r.status = 'x'; route(r, 'upload').cost = 1; });
  assert.deepEqual(errors.map((e) => e.path).sort(), ['routes[0].cost', 'status', 'version']);
});

test('the validator does not change the record', () => {
  const record = media();
  const before = JSON.stringify(record);
  validateCapability(record);
  assert.equal(JSON.stringify(record), before);
});

test('the command checks files and sets the exit code', () => {
  const good = run([mediaPath, join(skillsDir, 'first-principles-decision', 'capability.json')]);
  assert.equal(good.code, 0);
  assert.ok(good.lines.every((l) => l.endsWith(': ok')));
  const missing = run([join(here, 'fixtures', 'no-such-file.json')]);
  assert.equal(missing.code, 1);
  assert.match(missing.lines.join('\n'), /could not be read/);
  assert.equal(run([]).code, 1);
});
