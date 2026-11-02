// The capability.json contract (docs/plans/media-generation-capability.md,
// part 1). validateCapability() checks one parsed record and returns every
// problem it finds. It reads no files, contacts no host and changes nothing.

export const MAX_RECORD_BYTES = 64 * 1024;

export const STATUSES = ['draft', 'tested', 'retired'];
export const GATE_OUTCOMES = ['not run yet', 'native', 'partial', 'needed'];
export const ROUTE_KINDS = ['upload', 'local', 'own_key', 'sign_in'];
export const FREE_KINDS = ['upload', 'local'];
export const COST_UNITS = ['per_run', 'per_second', 'per_image', 'per_credit'];
export const INPUT_TYPES = ['string', 'integer', 'number', 'boolean', 'enum', 'files'];
export const OUTPUT_TYPES = ['file', 'receipt', 'text', 'data'];

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const AMOUNT = /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/;
const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

const TOP_FIELDS = new Set([
  'id', 'skill_id', 'title', 'version', 'status', 'created', 'body', 'kind',
  'trigger_phrases', 'scripts', 'inputs', 'outputs', 'routes', 'recipe',
  'actions_needing_approval', 'install_gate', 'example_runs', 'models_passed',
  'not_proven', 'credit',
]);

/**
 * @param {unknown} record a parsed capability.json
 * @returns {{ ok: boolean, errors: { path: string, message: string }[] }}
 */
export function validateCapability(record) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });

  if (!isPlainObject(record)) {
    fail('', 'the record must be a JSON object');
    return { ok: false, errors };
  }
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(record), 'utf8');
  } catch {
    fail('', 'the record must be plain JSON');
    return { ok: false, errors };
  }
  if (size > MAX_RECORD_BYTES) {
    fail('', `the record is ${size} bytes; the most is ${MAX_RECORD_BYTES}`);
    return { ok: false, errors };
  }

  unknownFields(record, TOP_FIELDS, '', fail);

  // Identity. `skill_id` is the name today's skill records use; a record
  // carries exactly one of the two.
  const hasId = has(record, 'id');
  const hasSkillId = has(record, 'skill_id');
  if (hasId && hasSkillId) fail('skill_id', 'use either id or skill_id, not both');
  else if (!hasId && !hasSkillId) fail('id', 'required');
  else {
    const key = hasId ? 'id' : 'skill_id';
    idString(record[key], key, fail);
  }

  text(record, 'title', '', fail, { required: true, max: 120 });
  if (required(record, 'version', '', fail) && !(typeof record.version === 'string' && VERSION.test(record.version))) {
    fail('version', 'must be a version like 0.1.0');
  }
  if (required(record, 'status', '', fail)) oneOf(record.status, STATUSES, 'status', fail);
  if (has(record, 'created')) date(record.created, 'created', fail);
  if (has(record, 'body')) relativePath(record.body, 'body', fail, '.md');
  if (has(record, 'example_runs')) relativePath(record.example_runs, 'example_runs', fail, '.md');
  if (has(record, 'recipe')) {
    if (relativePath(record.recipe, 'recipe', fail, '.md') && !/(^|\/)SKILL\.md$/.test(record.recipe)) {
      fail('recipe', 'must point to a SKILL.md file');
    }
  }
  text(record, 'kind', '', fail, { max: 40 });
  if (has(record, 'trigger_phrases')) textList(record.trigger_phrases, 'trigger_phrases', fail, { max: 200, maxItems: 50 });
  if (has(record, 'scripts')) {
    // Imported scripts don't run until a tested permission boundary exists
    // (portable-capability-layer.md), so the list stays empty for now.
    if (!Array.isArray(record.scripts)) fail('scripts', 'must be a list');
    else if (record.scripts.length) fail('scripts', 'must be empty: no capability ships scripts until the permission boundary exists');
  }
  if (required(record, 'actions_needing_approval', '', fail)) {
    textList(record.actions_needing_approval, 'actions_needing_approval', fail, { max: 200, maxItems: 50 });
  }
  if (required(record, 'install_gate', '', fail)) installGate(record.install_gate, fail);
  if (required(record, 'models_passed', '', fail)) {
    textList(record.models_passed, 'models_passed', fail, { max: 120, maxItems: 100, unique: true });
  }
  if (required(record, 'not_proven', '', fail)) textList(record.not_proven, 'not_proven', fail, { max: 400, maxItems: 50 });
  text(record, 'credit', '', fail, { max: 400 });

  if (record.status === 'tested' && Array.isArray(record.models_passed) && record.models_passed.length === 0) {
    fail('models_passed', 'a tested capability names at least one model it passed on');
  }

  if (has(record, 'inputs')) inputs(record.inputs, fail);
  if (has(record, 'outputs')) outputs(record.outputs, fail);
  if (has(record, 'routes')) routes(record.routes, fail);

  return { ok: errors.length === 0, errors };
}

/** One line per problem, for people reading a terminal. */
export function formatErrors(errors) {
  return errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n');
}

function installGate(gate, fail) {
  const p = 'install_gate';
  if (!isPlainObject(gate)) return fail(p, 'must be an object');
  unknownFields(gate, new Set(['outcome', 'expected', 'note']), p, fail);
  if (required(gate, 'outcome', p, fail)) oneOf(gate.outcome, GATE_OUTCOMES, `${p}.outcome`, fail);
  if (has(gate, 'expected')) oneOf(gate.expected, GATE_OUTCOMES.slice(1), `${p}.expected`, fail);
  text(gate, 'note', p, fail, { max: 1000 });
}

// Inputs: each field has a type and a limit.
function inputs(value, fail) {
  const p = 'inputs';
  if (!isPlainObject(value)) return fail(p, 'must be an object of named fields');
  const names = Object.keys(value);
  if (names.length === 0) fail(p, 'list at least one field, or leave inputs out');
  if (names.length > 30) fail(p, 'at most 30 fields');
  for (const name of names) {
    const q = `${p}.${name}`;
    if (!FIELD_NAME.test(name) || name.length > 40) {
      fail(q, 'field names are lower-case letters, digits and _, starting with a letter');
      continue;
    }
    const field = value[name];
    if (!isPlainObject(field)) {
      fail(q, 'must be an object');
      continue;
    }
    const type = field.type;
    if (!INPUT_TYPES.includes(type)) {
      fail(`${q}.type`, `must be one of ${INPUT_TYPES.join(', ')}`);
      continue;
    }
    const allowed = { string: ['max_length'], integer: ['min', 'max'], number: ['min', 'max'], boolean: [], enum: ['values'], files: ['max_items', 'max_bytes', 'types'] }[type];
    unknownFields(field, new Set(['type', 'required', 'description', ...allowed]), q, fail);
    if (has(field, 'required') && typeof field.required !== 'boolean') fail(`${q}.required`, 'must be true or false');
    text(field, 'description', q, fail, { max: 300 });
    if (type === 'string') {
      if (required(field, 'max_length', q, fail)) wholeNumber(field.max_length, `${q}.max_length`, fail, 1, 100000);
    } else if (type === 'integer' || type === 'number') {
      const integer = type === 'integer';
      const okMin = required(field, 'min', q, fail) && finite(field.min, `${q}.min`, fail, integer);
      const okMax = required(field, 'max', q, fail) && finite(field.max, `${q}.max`, fail, integer);
      if (okMin && okMax && field.min > field.max) fail(`${q}.max`, 'must not be below min');
    } else if (type === 'enum') {
      if (required(field, 'values', q, fail)) {
        textList(field.values, `${q}.values`, fail, { max: 60, maxItems: 50, unique: true });
        if (Array.isArray(field.values) && field.values.length === 0) fail(`${q}.values`, 'list at least one value');
      }
    } else if (type === 'files') {
      if (required(field, 'max_items', q, fail)) wholeNumber(field.max_items, `${q}.max_items`, fail, 1, 100);
      if (required(field, 'max_bytes', q, fail)) wholeNumber(field.max_bytes, `${q}.max_bytes`, fail, 1, 10 * 1024 ** 3);
      if (required(field, 'types', q, fail)) {
        if (!Array.isArray(field.types) || field.types.length === 0) fail(`${q}.types`, 'list at least one file type, like image/png');
        else {
          if (new Set(field.types).size !== field.types.length) fail(`${q}.types`, 'each type appears once');
          field.types.forEach((t, i) => {
            if (typeof t !== 'string' || !MIME.test(t)) fail(`${q}.types[${i}]`, 'must be a file type like image/png');
          });
        }
      }
    }
  }
}

function outputs(value, fail) {
  const p = 'outputs';
  if (!isPlainObject(value)) return fail(p, 'must be an object of named outputs');
  const names = Object.keys(value);
  if (names.length === 0) fail(p, 'list at least one output, or leave outputs out');
  if (names.length > 10) fail(p, 'at most 10 outputs');
  for (const name of names) {
    const q = `${p}.${name}`;
    if (!FIELD_NAME.test(name) || name.length > 40) {
      fail(q, 'output names are lower-case letters, digits and _, starting with a letter');
      continue;
    }
    const out = value[name];
    if (!isPlainObject(out)) {
      fail(q, 'must be an object');
      continue;
    }
    unknownFields(out, new Set(['type', 'folder', 'description']), q, fail);
    if (!OUTPUT_TYPES.includes(out.type)) fail(`${q}.type`, `must be one of ${OUTPUT_TYPES.join(', ')}`);
    // A file lands in a named folder the app owns, never a path the record picks.
    if (out.type === 'file') {
      if (required(out, 'folder', q, fail)) idString(out.folder, `${q}.folder`, fail);
    } else if (has(out, 'folder')) fail(`${q}.folder`, 'only a file output names a folder');
    text(out, 'description', q, fail, { max: 300 });
  }
}

const ROUTE_FIELDS = new Set(['id', 'kind', 'title', 'provider', 'model', 'hosts', 'leaves_machine', 'cost', 'needs', 'terms', 'license']);

function routes(value, fail) {
  const p = 'routes';
  if (!Array.isArray(value)) return fail(p, 'must be a list');
  if (value.length === 0) return fail(p, 'list at least one route, or leave routes out');
  if (value.length > 20) fail(p, 'at most 20 routes');
  const ids = new Set();
  let free = 0;
  let paid = 0;
  value.forEach((route, i) => {
    const q = `${p}[${i}]`;
    if (!isPlainObject(route)) return fail(q, 'must be an object');
    unknownFields(route, ROUTE_FIELDS, q, fail);
    if (required(route, 'id', q, fail) && idString(route.id, `${q}.id`, fail)) {
      if (ids.has(route.id)) fail(`${q}.id`, `the route id ${route.id} appears twice`);
      ids.add(route.id);
    }
    text(route, 'title', q, fail, { max: 120 });
    if (!required(route, 'kind', q, fail) || !oneOf(route.kind, ROUTE_KINDS, `${q}.kind`, fail)) return;
    const isFree = FREE_KINDS.includes(route.kind);
    if (isFree) free += 1;
    else paid += 1;

    // Who runs it. An upload is the person's own file, so it names nobody.
    const needsProvider = route.kind !== 'upload';
    text(route, 'provider', q, fail, { required: needsProvider, max: 80 });
    text(route, 'model', q, fail, { required: needsProvider, max: 120 });

    // Every outside host it contacts.
    if (required(route, 'hosts', q, fail)) {
      const hostsOk = hostList(route.hosts, `${q}.hosts`, fail);
      if (hostsOk && isFree && route.hosts.length) fail(`${q}.hosts`, `a ${route.kind} route contacts no outside host, so this list is empty`);
      if (hostsOk && !isFree && route.hosts.length === 0) fail(`${q}.hosts`, `a ${route.kind} route names every host it contacts`);
    }

    // What leaves the machine, in plain words.
    if (required(route, 'leaves_machine', q, fail) && text(route, 'leaves_machine', q, fail, { max: 400 })) {
      const said = route.leaves_machine.trim().toLowerCase();
      if (isFree && route.leaves_machine !== 'nothing') fail(`${q}.leaves_machine`, `must be "nothing" for a ${route.kind} route`);
      if (!isFree && said === 'nothing') fail(`${q}.leaves_machine`, `a ${route.kind} route sends something; say exactly what`);
    }

    if (required(route, 'cost', q, fail)) {
      if (isFree) {
        if (route.cost !== 'free') fail(`${q}.cost`, `must be "free" for a ${route.kind} route`);
      } else {
        paidCost(route.cost, `${q}.cost`, fail);
      }
    }

    if (has(route, 'needs')) needs(route.needs, `${q}.needs`, fail);

    // Sign-in only where the provider's terms allow it: no link, no route.
    if (route.kind === 'sign_in') {
      if (required(route, 'terms', q, fail)) terms(route.terms, `${q}.terms`, fail);
    } else if (has(route, 'terms')) fail(`${q}.terms`, 'only a sign_in route has terms');

    // A local model's license is checked before adoption.
    if (route.kind === 'local') {
      if (required(route, 'license', q, fail)) license(route.license, `${q}.license`, fail);
    } else if (has(route, 'license')) fail(`${q}.license`, 'only a local route has a license');
  });
  // Paid media is never mandatory: a paid route always sits beside a free one.
  if (paid > 0 && free === 0) fail(p, 'a capability with a paid route also needs an upload or local route');
}

function paidCost(cost, p, fail) {
  if (!isPlainObject(cost)) return fail(p, 'must be an object with unit, price, source, checked and max_per_run');
  unknownFields(cost, new Set(['unit', 'price', 'source', 'checked', 'max_per_run', 'note']), p, fail);
  if (required(cost, 'unit', p, fail)) oneOf(cost.unit, COST_UNITS, `${p}.unit`, fail);
  const price = required(cost, 'price', p, fail) && money(cost.price, `${p}.price`, fail);
  if (required(cost, 'source', p, fail)) httpsUrl(cost.source, `${p}.source`, fail);
  if (required(cost, 'checked', p, fail)) date(cost.checked, `${p}.checked`, fail);
  const max = required(cost, 'max_per_run', p, fail) && money(cost.max_per_run, `${p}.max_per_run`, fail);
  if (max && Number(cost.max_per_run.amount) <= 0) fail(`${p}.max_per_run.amount`, 'must be more than 0');
  if (price && max && cost.price.currency !== cost.max_per_run.currency) {
    fail(`${p}.max_per_run.currency`, 'must be the same currency as the price');
  }
  text(cost, 'note', p, fail, { max: 400 });
}

// Amounts are decimal text, so 0.1 + 0.2 never drifts, and always name an
// ISO 4217 currency.
function money(value, p, fail) {
  if (!isPlainObject(value)) {
    fail(p, 'must be an object with amount and currency');
    return false;
  }
  unknownFields(value, new Set(['amount', 'currency']), p, fail);
  let ok = true;
  if (!required(value, 'amount', p, fail) || !(typeof value.amount === 'string' && AMOUNT.test(value.amount))) {
    if (has(value, 'amount')) fail(`${p}.amount`, 'must be decimal text like "0.40"');
    ok = false;
  }
  if (!required(value, 'currency', p, fail)) ok = false;
  else if (typeof value.currency !== 'string' || !CURRENCY.test(value.currency) || !KNOWN_CURRENCIES.has(value.currency)) {
    fail(`${p}.currency`, 'must be an ISO 4217 currency code like USD');
    ok = false;
  }
  return ok;
}

function needs(value, p, fail) {
  if (!isPlainObject(value)) return fail(p, 'must be an object');
  unknownFields(value, new Set(['memory_gb', 'disk_gb', 'server', 'downloads']), p, fail);
  if (has(value, 'memory_gb')) finite(value.memory_gb, `${p}.memory_gb`, fail, false, 0, 1024, true);
  if (has(value, 'disk_gb')) finite(value.disk_gb, `${p}.disk_gb`, fail, false, 0, 100000, true);
  text(value, 'server', p, fail, { max: 80 });
  if (has(value, 'downloads')) {
    if (!Array.isArray(value.downloads)) return fail(`${p}.downloads`, 'must be a list');
    if (value.downloads.length > 20) fail(`${p}.downloads`, 'at most 20 downloads');
    value.downloads.forEach((d, i) => {
      const q = `${p}.downloads[${i}]`;
      if (!isPlainObject(d)) return fail(q, 'must be an object');
      unknownFields(d, new Set(['what', 'size_gb', 'from']), q, fail);
      text(d, 'what', q, fail, { required: true, max: 120 });
      if (required(d, 'size_gb', q, fail)) finite(d.size_gb, `${q}.size_gb`, fail, false, 0, 100000, true);
      if (required(d, 'from', q, fail)) httpsUrl(d.from, `${q}.from`, fail);
    });
  }
}

function terms(value, p, fail) {
  if (!isPlainObject(value)) return fail(p, 'must be an object with url and checked');
  unknownFields(value, new Set(['url', 'checked', 'note']), p, fail);
  if (required(value, 'url', p, fail)) httpsUrl(value.url, `${p}.url`, fail);
  if (required(value, 'checked', p, fail)) date(value.checked, `${p}.checked`, fail);
  text(value, 'note', p, fail, { max: 400 });
}

function license(value, p, fail) {
  if (!isPlainObject(value)) return fail(p, 'must be an object with name, checked and allows_intended_use');
  unknownFields(value, new Set(['name', 'url', 'checked', 'allows_intended_use', 'note']), p, fail);
  text(value, 'name', p, fail, { required: true, max: 120 });
  if (has(value, 'url')) httpsUrl(value.url, `${p}.url`, fail);
  if (required(value, 'checked', p, fail)) date(value.checked, `${p}.checked`, fail);
  if (required(value, 'allows_intended_use', p, fail) && typeof value.allows_intended_use !== 'boolean') {
    fail(`${p}.allows_intended_use`, 'must be true or false');
  }
  text(value, 'note', p, fail, { max: 400 });
}

// Bare host names only: lower case, no scheme, port, path or wildcard.
function hostList(value, p, fail) {
  if (!Array.isArray(value)) {
    fail(p, 'must be a list of host names');
    return false;
  }
  if (value.length > 20) fail(p, 'at most 20 hosts');
  if (new Set(value).size !== value.length) fail(p, 'each host appears once');
  let ok = true;
  value.forEach((host, i) => {
    if (!isHostName(host)) {
      fail(`${p}[${i}]`, 'must be a bare lower-case host name like api.example.com');
      ok = false;
    }
  });
  return ok;
}

function isHostName(host) {
  if (typeof host !== 'string' || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => HOST_LABEL.test(l))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

function httpsUrl(value, p, fail) {
  let url;
  try {
    url = typeof value === 'string' && value.length <= 2000 ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || !isHostName(url.hostname)) {
    fail(p, 'must be an https link');
    return false;
  }
  return true;
}

function date(value, p, fail) {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) return true;
  }
  fail(p, 'must be a date like 2026-11-02');
  return false;
}

function relativePath(value, p, fail, ext) {
  const ok = typeof value === 'string' && value.length > 0 && value.length <= 200
    && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    && value.endsWith(ext);
  if (!ok) fail(p, `must be a ${ext} file inside the capability's folder, like SKILL.md`);
  return ok;
}

function idString(value, p, fail) {
  if (typeof value === 'string' && value.length <= 64 && ID.test(value)) return true;
  fail(p, 'must be lower-case words joined by hyphens, like make-media');
  return false;
}

function text(obj, key, parent, fail, { required: req = false, max }) {
  const p = parent ? `${parent}.${key}` : key;
  if (!has(obj, key)) {
    if (req) fail(p, 'required');
    return false;
  }
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') {
    fail(p, 'must be text');
    return false;
  }
  if (v.length > max) {
    fail(p, `at most ${max} characters`);
    return false;
  }
  return true;
}

function textList(value, p, fail, { max, maxItems, unique = false }) {
  if (!Array.isArray(value)) return fail(p, 'must be a list');
  if (value.length > maxItems) fail(p, `at most ${maxItems} entries`);
  if (unique && new Set(value).size !== value.length) fail(p, 'each entry appears once');
  value.forEach((v, i) => {
    if (typeof v !== 'string' || v.trim() === '') fail(`${p}[${i}]`, 'must be text');
    else if (v.length > max) fail(`${p}[${i}]`, `at most ${max} characters`);
  });
}

function oneOf(value, allowed, p, fail) {
  if (allowed.includes(value)) return true;
  fail(p, `must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
  return false;
}

function wholeNumber(value, p, fail, min, max) {
  if (Number.isInteger(value) && value >= min && value <= max) return true;
  fail(p, `must be a whole number from ${min} to ${max}`);
  return false;
}

function finite(value, p, fail, integer, min = -1e12, max = 1e12, aboveZero = false) {
  const ok = typeof value === 'number' && Number.isFinite(value) && (!integer || Number.isInteger(value))
    && value >= min && value <= max && (!aboveZero || value > 0);
  if (!ok) fail(p, integer ? 'must be a whole number' : aboveZero ? `must be a number above 0, at most ${max}` : 'must be a number');
  return ok;
}

function required(obj, key, parent, fail) {
  if (has(obj, key)) return true;
  fail(parent ? `${parent}.${key}` : key, 'required');
  return false;
}

function unknownFields(obj, allowed, parent, fail) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(parent ? `${parent}.${key}` : key, 'unknown field');
  }
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
