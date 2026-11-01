import './guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import catalog from '../catalog.json' with { type: 'json' };
import { run } from '../src/check.mjs';
import { checkSetup, formatPlain } from '../src/index.mjs';

const UPDATE = 'update macOS to 13 or later';
const SWITCH = 'or switch to a cloud model in settings';
const MEMORY_NOTE = "this Mac's memory is too small for a local model";
const NASTY = 'quote" <script>alert(1)</script> עברית \n\t\u202Eend';

function mac(overrides = {}) {
  const facts = {
    schemaVersion: 1,
    os: { name: 'macOS', version: '15.0' },
    chip: 'apple-silicon',
    memoryGB: 16,
    freeDiskGB: 100,
    ollama: { installed: false, running: false, models: [] },
    cloud: { approved: [] },
  };
  if (overrides.os) facts.os = { ...facts.os, ...overrides.os };
  if (overrides.ollama) {
    facts.ollama = {
      ...facts.ollama,
      ...overrides.ollama,
      models: overrides.ollama.models ?? facts.ollama.models,
    };
  }
  if (overrides.cloud) facts.cloud = { ...facts.cloud, ...overrides.cloud };
  if (Object.hasOwn(overrides, 'preferences')) facts.preferences = overrides.preferences;
  for (const key of ['chip', 'memoryGB', 'freeDiskGB']) {
    if (Object.hasOwn(overrides, key)) facts[key] = overrides[key];
  }
  return facts;
}

function find(result, id) {
  return result.checks.find(check => check.id === id);
}

function setup(overrides, customCatalog) {
  const result = checkSetup(mac(overrides), customCatalog);
  assertWellFormed(result);
  return result;
}

function refusal(input, customCatalog) {
  try {
    checkSetup(input, customCatalog);
  } catch (error) {
    return error.message;
  }
  assert.fail('expected a refusal');
}

function assertWellFormed(result) {
  assert.equal(result.schemaVersion, 1);
  assert.equal(typeof result.ready, 'boolean');
  assert.equal(result.ready, result.nextSteps.length === 0);
  assert.equal(new Set(result.nextSteps).size, result.nextSteps.length);
  assert.ok(['local', 'cloud', 'none'].includes(result.recommendation.route));
  const ids = result.checks.map(check => check.id);
  const expected = ['os', 'chip', 'memory', 'disk', 'ollama', 'model'];
  if (result.recommendation.route === 'cloud') expected.push('cloud');
  assert.deepEqual(ids, expected);
  for (const check of result.checks) {
    assert.ok(['pass', 'info', 'warn', 'stop'].includes(check.state));
    if (check.state === 'warn' || check.state === 'stop') assert.equal(typeof check.fix, 'string');
    else assert.equal(Object.hasOwn(check, 'fix'), false);
  }
  assert.equal(result.summary.includes('\n'), false);
  assert.equal(result.summary.includes('\t'), false);
  assert.equal(result.recommendation.reason.includes('\n'), false);
  const keys = Object.keys(result.recommendation);
  if (result.recommendation.route === 'local') assert.deepEqual(keys, ['route', 'model', 'reason']);
  else if (result.recommendation.model) assert.deepEqual(keys, ['route', 'model', 'host', 'reason']);
  else assert.deepEqual(keys, ['route', 'reason']);
}

function installed(name, sizeGB = 1) {
  return { installed: true, running: true, models: [{ name, sizeGB }] };
}

function cloudChoice(approved, choice = { model: 'invented-cloud', host: 'invented.example' }) {
  return { choice, approved };
}

function command(argv, fileBytes, readFile = () => fileBytes) {
  let out = '';
  let err = '';
  let code = 0;
  const status = run(argv, {
    readFile,
    stdout: text => { out += text; },
    stderr: text => { err += text; },
    exit: value => { code = value; },
  });
  return { status, code, out, err };
}

test('the shipped catalog lists qwen3:8b first and two smaller fallbacks', () => {
  assert.equal(catalog.models.length, 3);
  assert.equal(catalog.models[0].name, 'qwen3:8b');
  assert.ok(catalog.models[0].minMemoryGB >= 16);
  const at8 = catalog.models.filter(model => model.minMemoryGB <= 8);
  const at4 = catalog.models.filter(model => model.minMemoryGB <= 4);
  const smallest = catalog.models.reduce((best, model) => (model.minMemoryGB < best.minMemoryGB ? model : best));
  assert.deepEqual(at8, [smallest]);
  assert.deepEqual(at4, []);
});

test('a new 16 GB Apple-silicon Mac with no Ollama matches the saved result', () => {
  const facts = JSON.parse(readFileSync(new URL('./fixtures/new-mac.json', import.meta.url), 'utf8'));
  const expected = readFileSync(new URL('./fixtures/new-mac.expected.json', import.meta.url), 'utf8');
  const result = checkSetup(facts);
  assertWellFormed(result);
  assert.equal(`${JSON.stringify(result, null, 2)}\n`, expected);
  assert.equal(JSON.stringify(result), JSON.stringify(checkSetup(mac())));
  const saved = JSON.parse(expected);
  assert.equal(saved.recommendation.model, catalog.models[0].name);
  assert.equal(saved.summary.includes(String(catalog.models[0].sizeGB)), true);
  assert.equal(saved.ready, false);
  assert.equal(saved.recommendation.route, 'local');
  const plain = formatPlain(result);
  assert.match(plain, /^This Mac can run a local model\. /);
  assert.equal(plain.includes('✓ macOS 15.0 meets the minimum of 13'), true);
  assert.equal(plain.includes('! Ollama is not installed'), true);
  assert.equal(plain.includes(`ollama pull ${catalog.models[0].name}`), true);
  assert.equal(plain.includes('https://ollama.com/download'), true);
  assert.equal(plain.includes('✗'), false);
  assert.match(plain, /1\. .+\n2\. .+$/);
});

test('macOS 13 and newer pass, and 12 stops on both a none route and a cloud route', () => {
  for (const version of ['13.0', '13.0.0', '13.0.1', '26.1']) {
    assert.equal(find(setup({ os: { version } }), 'os').state, 'pass', version);
  }
  for (const version of ['12.0', '12.6', '12.9', '0.1']) {
    const stopped = setup({ os: { version }, preferences: { mode: 'local' } });
    assert.equal(find(stopped, 'os').state, 'stop', version);
    assert.equal(find(stopped, 'os').fix, UPDATE);
    assert.equal(stopped.recommendation.route, 'none');
    assert.equal(stopped.nextSteps.includes(UPDATE), true);
  }
  const none = setup({ os: { version: '12.6' }, memoryGB: 4, preferences: { mode: 'local' } });
  assert.deepEqual(none.nextSteps, [UPDATE]);
  const cloud = setup({
    os: { version: '12.0' },
    preferences: { mode: 'cloud' },
    cloud: cloudChoice([{ model: 'invented-cloud', host: 'invented.example' }]),
  });
  assert.equal(cloud.recommendation.route, 'cloud');
  assert.equal(cloud.ready, false);
  assert.equal(cloud.nextSteps.includes(UPDATE), true);
  assert.match(cloud.recommendation.reason, /chosen mode is cloud/);
  const either = setup({ os: { version: '12.6' }, preferences: { mode: 'either' } });
  assert.equal(either.recommendation.route, 'cloud');
  assert.equal(either.recommendation.reason.includes('chosen mode is cloud'), false);
  assert.match(either.recommendation.reason, /macOS is earlier than 13/);
});

test('an Intel Mac can be ready on the local route, and the info check has no step', () => {
  const name = catalog.models[0].name;
  const result = setup({ chip: 'intel', ollama: installed(name) });
  const chip = find(result, 'chip');
  assert.equal(chip.state, 'info');
  assert.match(chip.message, /slow/);
  assert.match(chip.message, /cloud model/);
  assert.equal(result.ready, true);
  assert.equal(result.recommendation.route, 'local');
  assert.deepEqual(result.nextSteps, []);
  assert.equal(/\bfast\b/i.test(result.summary), false);
});

test('8 GB fits only the smallest catalog model, and 4 GB fits none', () => {
  const smallest = catalog.models.find(model => model.minMemoryGB <= 8);
  const eight = setup({ memoryGB: 8, freeDiskGB: 100 });
  assert.equal(eight.recommendation.model, smallest.name);
  assert.equal(find(eight, 'model').fix.includes(`ollama pull ${smallest.name}`), true);

  const four = setup({ memoryGB: 4, preferences: { mode: 'local' } });
  assert.equal(find(four, 'disk').state, 'pass');
  assert.equal(find(four, 'disk').message, 'no local model to download');
  assert.equal(find(four, 'memory').state, 'warn');
  assert.equal(find(four, 'memory').message, 'only a cloud model will work');
  assert.equal(find(four, 'model').message, "no local model fits this Mac's memory");
  assert.equal(find(four, 'model').fix, 'use a cloud model');
  assert.equal(`${find(four, 'model').message} ${find(four, 'model').fix}`.includes('ollama'), false);
  assert.equal(four.recommendation.route, 'none');
  assert.deepEqual(four.nextSteps, [MEMORY_NOTE, SWITCH]);
});

test('disk stops when nothing fits, warns when only the model fits, and warns when a fitting model is installed and space is low', () => {
  const smallest = catalog.models.reduce((best, model) => (model.sizeGB < best.sizeGB ? model : best));
  const free = Math.round((smallest.sizeGB - 0.1) * 1000) / 1000;
  const blocked = setup({ freeDiskGB: free, preferences: { mode: 'local' } });
  const amount = Math.ceil((Math.round(smallest.sizeGB * 1000) + 5000 - Math.round(free * 1000)) / 1000);
  assert.equal(find(blocked, 'disk').state, 'stop');
  assert.equal(find(blocked, 'disk').fix, `free up at least ${amount} GB`);
  assert.equal(find(blocked, 'model').message, 'no local model fits the free disk space');
  assert.equal(`${find(blocked, 'model').message} ${find(blocked, 'model').fix}`.includes('ollama'), false);
  assert.equal(blocked.recommendation.route, 'none');
  assert.deepEqual(blocked.nextSteps, [`free up at least ${amount} GB`, SWITCH]);

  const first = catalog.models[0];
  const spare = Math.round((first.sizeGB + 5) * 1000) / 1000;
  const tight = Math.round(((first.sizeGB + 5) * 1000) - 1) / 1000;
  assert.equal(find(setup({ freeDiskGB: spare }), 'disk').state, 'pass');
  const almost = setup({ freeDiskGB: tight });
  assert.equal(find(almost, 'disk').state, 'warn');
  assert.equal(almost.recommendation.route, 'local');
  assert.equal(almost.recommendation.model, first.name);
  assert.match(find(almost, 'model').fix, /ollama pull/);
  assert.equal(find(setup({ freeDiskGB: first.sizeGB }), 'disk').state, 'warn');

  const name = first.name;
  const present = installed(name, 0.1);
  assert.equal(find(setup({ freeDiskGB: 5, ollama: present }), 'disk').state, 'pass');
  const low = setup({ freeDiskGB: 2, ollama: present });
  assert.equal(find(low, 'disk').message, 'disk almost full');
  assert.equal(low.recommendation.route, 'local');
  assert.equal(low.recommendation.model, name);
  assert.equal(low.ready, false);
});

test('the free-up amount uses the smallest memory-fitting model and rounds up', () => {
  const catalogTie = {
    schemaVersion: 1,
    models: [
      { name: 'invented:big', sizeGB: 9, minMemoryGB: 8, note: 'Largest invented model.' },
      { name: 'invented:small', sizeGB: 1.2, minMemoryGB: 8, note: 'Smallest invented model.' },
    ],
  };
  const rounded = setup({ freeDiskGB: 0.1, preferences: { mode: 'local' } }, catalogTie);
  assert.equal(find(rounded, 'disk').fix, 'free up at least 7 GB');
  const exact = setup({ freeDiskGB: 1, preferences: { mode: 'local' } }, {
    schemaVersion: 1,
    models: [{ name: 'invented:two', sizeGB: 2, minMemoryGB: 8, note: 'Whole gigabytes.' }],
  });
  assert.equal(find(exact, 'disk').fix, 'free up at least 6 GB');
});

test('recommendation follows the catalog, the installed models, and the mode', () => {
  const [best, middle, smallest] = catalog.models;
  const running = setup({ ollama: installed(smallest.name) });
  assert.equal(running.recommendation.model, smallest.name);
  assert.equal(running.ready, true);
  assert.equal(JSON.stringify(running.nextSteps).includes('ollama pull'), false);

  const both = [smallest.name, best.name];
  const forward = setup({ ollama: { installed: true, running: true, models: both.map(name => ({ name, sizeGB: 1 })) } });
  const backward = setup({
    ollama: { installed: true, running: true, models: [...both].reverse().map(name => ({ name, sizeGB: 1 })) },
  });
  assert.equal(forward.recommendation.model, best.name);
  assert.equal(JSON.stringify(forward), JSON.stringify(backward));

  const tooBig = setup({
    memoryGB: smallest.minMemoryGB,
    ollama: installed(best.name, best.sizeGB),
  });
  assert.equal(tooBig.recommendation.model, smallest.name);
  assert.notEqual(tooBig.recommendation.model, best.name);

  const skipped = setup({ freeDiskGB: middle.sizeGB });
  assert.equal(skipped.recommendation.model, middle.name);
  assert.notEqual(skipped.recommendation.model, best.name);

  const cloud = setup({
    preferences: { mode: 'cloud' },
    cloud: cloudChoice([{ model: 'invented-cloud', host: 'invented.example' }]),
  });
  assert.equal(cloud.recommendation.route, 'cloud');
  assert.notEqual(cloud.recommendation.model, best.name);
  assert.equal(cloud.ready, true);
  assert.equal(find(cloud, 'ollama').state, 'pass');
  assert.match(find(cloud, 'ollama').message, /skipped/);
  assert.equal(find(cloud, 'ollama').message.includes('cloud'), true);
  assert.equal(JSON.stringify(cloud.nextSteps).includes('ollama'), false);

  const unasked = setup({
    memoryGB: 4,
    preferences: { mode: 'local' },
    cloud: cloudChoice([{ model: 'invented-cloud', host: 'invented.example' }]),
  });
  assert.equal(unasked.recommendation.route, 'none');
  assert.equal(unasked.recommendation.model, undefined);

  const fallback = setup({ memoryGB: 4, preferences: { mode: 'either' } });
  assert.equal(fallback.recommendation.route, 'cloud');
  assert.equal(find(fallback, 'ollama').state, 'warn');
  assert.deepEqual(fallback.nextSteps, ['pick a cloud model']);
  const approvedFallback = setup({
    memoryGB: 4,
    preferences: { mode: 'either' },
    cloud: cloudChoice([{ model: 'invented-cloud', host: 'invented.example' }]),
  });
  assert.equal(approvedFallback.recommendation.route, 'cloud');
  assert.equal(approvedFallback.ready, true);

  const localEither = setup({
    preferences: { mode: 'either' },
    cloud: cloudChoice([]),
  });
  assert.equal(localEither.recommendation.route, 'local');
  assert.equal(localEither.checks.some(check => check.id === 'cloud'), false);
});

test('a cloud choice passes only when that model and that host are both approved', () => {
  const choice = { model: 'invented-cloud', host: 'invented.example' };
  const ready = setup({ preferences: { mode: 'cloud' }, cloud: cloudChoice([choice], choice) });
  assert.equal(ready.ready, true);
  assert.equal(find(ready, 'cloud').state, 'pass');

  const otherModel = setup({
    preferences: { mode: 'cloud' },
    cloud: cloudChoice([{ model: 'other-cloud', host: 'invented.example' }], choice),
  });
  const otherHost = setup({
    preferences: { mode: 'cloud' },
    cloud: cloudChoice([{ model: 'invented-cloud', host: 'other.example' }], choice),
  });
  const differentCase = setup({
    preferences: { mode: 'cloud' },
    cloud: cloudChoice([{ model: 'Invented-cloud', host: 'invented.example' }], choice),
  });
  for (const result of [otherModel, otherHost, differentCase]) {
    assert.equal(find(result, 'cloud').state, 'warn');
    assert.match(find(result, 'cloud').message, /one-time approval/);
    assert.equal(result.ready, false);
    assert.equal(result.recommendation.route, 'cloud');
  }
  const unpicked = setup({ preferences: { mode: 'cloud' } });
  assert.equal(find(unpicked, 'cloud').message, 'pick a cloud model');
  assert.equal(unpicked.ready, false);
});

test('a different catalog changes the recommendation, and a note does not', () => {
  const custom = {
    schemaVersion: 1,
    models: [
      { name: 'invented:first', sizeGB: 1, minMemoryGB: 8, note: 'Listed first on purpose.' },
      { name: 'invented:second', sizeGB: 0.5, minMemoryGB: 8, note: 'Listed second on purpose.' },
    ],
  };
  const flipped = { schemaVersion: 1, models: [...custom.models].reverse() };
  assert.equal(setup({}, custom).recommendation.model, 'invented:first');
  assert.equal(setup({}, flipped).recommendation.model, 'invented:second');
  assert.equal(JSON.stringify(setup({}, custom)).includes('qwen3'), false);
  const noted = structuredClone(custom);
  noted.models[0].note = 'Invented note. '.repeat(40);
  assert.equal(JSON.stringify(checkSetup(mac(), custom)), JSON.stringify(checkSetup(mac(), noted)));
});

test('refusals name the field and produce no result', () => {
  const cases = [
    [{ schemaVersion: 2 }, 'schemaVersion'],
    [{ widget: true }, 'schemaVersion'],
    [{ schemaVersion: 1, widget: true }, 'widget'],
    [mac({ os: { name: 'MacOS' } }), 'name'],
    [mac({ os: { version: '13' } }), 'version'],
    [mac({ os: { version: '013.0' } }), 'version'],
    [mac({ os: { version: '13.0.0.1' } }), 'version'],
    [mac({ chip: 'Apple silicon' }), 'chip'],
    [mac({ memoryGB: 0 }), 'memoryGB'],
    [mac({ memoryGB: 1025 }), 'memoryGB'],
    [mac({ memoryGB: Number.NaN }), 'memoryGB'],
    [{ ...mac(), memoryGB: '16' }, 'memoryGB'],
    [mac({ freeDiskGB: -1 }), 'freeDiskGB'],
    [mac({ freeDiskGB: 100001 }), 'freeDiskGB'],
    [mac({ ollama: { installed: 'yes', running: false, models: [] } }), 'installed'],
    [mac({ ollama: { installed: false, running: true, models: [] } }), 'running'],
    [mac({ ollama: { installed: true, running: true, models: [{ name: 'invented:a', sizeGB: 1 }, { name: 'invented:a', sizeGB: 2 }] } }), 'models'],
    [mac({ ollama: { installed: true, running: true, models: [{ name: '', sizeGB: 1 }] } }), 'name'],
    [mac({ ollama: { installed: true, running: true, models: [{ name: 'invented:a', sizeGB: 0 }] } }), 'sizeGB'],
    [mac({ ollama: { version: '' } }), 'version'],
    [mac({ ollama: { installed: true, running: true, models: Array.from({ length: 201 }, (_, index) => ({ name: `invented-${index}`, sizeGB: 0.1 })) } }), 'models'],
    [mac({ cloud: { approved: Array.from({ length: 21 }, (_, index) => ({ model: `m${index}`, host: 'invented.example' })) } }), 'approved'],
    [mac({ cloud: { approved: [{ model: 'invented-cloud', host: 'invented.example' }, { model: 'invented-cloud', host: 'invented.example' }] } }), 'approved'],
    [mac({ cloud: { choice: { host: 'invented.example' }, approved: [] } }), 'model'],
    [mac({ cloud: { choice: null, approved: [] } }), 'choice'],
    [mac({ preferences: { mode: 'auto' } }), 'mode'],
    [mac({ preferences: null }), 'preferences'],
    [{ ...mac(), os: { name: 'macOS', version: '15.0', build: 'invented' } }, 'build'],
  ];
  for (const [input, field] of cases) {
    const message = refusal(input);
    assert.equal(message.includes(field), true, `${field}: ${message}`);
    assert.equal(message.startsWith('{'), false, message);
  }
  const running = refusal(mac({ ollama: { installed: false, running: true, models: [] } }));
  assert.equal(running.includes('installed'), true);
  assert.match(refusal({ blob: 'x'.repeat(70_000) }), /larger than 64 KB/);
  const loop = mac();
  loop.self = loop;
  assert.match(refusal(loop), /facts/);
  const proto = JSON.parse('{"schemaVersion":1,"__proto__":{"polluted":true}}');
  assert.match(refusal(proto), /__proto__/);
  assert.equal(proto.polluted, undefined);
  assert.match(refusal(mac(), {
    schemaVersion: 1,
    models: [
      { name: 'invented:a', sizeGB: 1, minMemoryGB: 8, note: 'One.' },
      { name: 'invented:a', sizeGB: 1, minMemoryGB: 8, note: 'Two.' },
    ],
  }), /models/);
  assert.match(refusal(mac(), { schemaVersion: 1, models: [{ name: 'invented:a', sizeGB: 1, minMemoryGB: 0, note: 'Too small a floor.' }] }), /minMemoryGB/);
});

test('hostile model and host text stays unchanged in JSON and safe on one line in the summary', () => {
  const hostileCatalog = {
    schemaVersion: 1,
    models: [{ name: NASTY, sizeGB: 1, minMemoryGB: 8, note: 'Invented hostile name.' }],
  };
  const local = checkSetup(mac({ ollama: installed(NASTY) }), hostileCatalog);
  assertWellFormed(local);
  assert.equal(local.recommendation.model, NASTY);
  assert.equal(find(local, 'model').message.includes(NASTY), true);
  assert.equal(local.summary.includes('\n'), false);
  assert.equal(local.summary.includes('\t'), false);
  assert.equal(local.summary.includes('\u202E'), false);
  assert.equal(local.summary.includes('\\n'), true);
  assert.equal(local.summary.includes('\\t'), true);
  assert.equal(local.summary.includes('\\u202e'), true);
  assert.equal(local.summary.includes('<script>'), true);
  assert.equal(local.summary.includes('עברית'), true);
  assert.equal(local.summary.includes('"'), true);
  const parsed = JSON.parse(JSON.stringify(local));
  assert.equal(parsed.recommendation.model, NASTY);
  assert.equal(parsed.checks.find(check => check.id === 'model').message.includes('\n'), true);

  const cloud = checkSetup(mac({
    preferences: { mode: 'cloud' },
    cloud: cloudChoice([{ model: NASTY, host: NASTY }], { model: NASTY, host: NASTY }),
  }));
  assert.equal(cloud.recommendation.model, NASTY);
  assert.equal(cloud.recommendation.host, NASTY);
  assert.equal(find(cloud, 'cloud').message.includes(NASTY), true);
  const plain = formatPlain(cloud);
  assert.equal(plain.includes('\u202E'), false);
  assert.equal(plain.includes('\t'), false);
  assert.equal(plain.includes('\\u202e'), true);
  assert.equal(plain.split('\n').length, 2 + cloud.checks.length);
  const localPlain = formatPlain(local);
  assert.equal(localPlain.split('\n').length, 2 + local.checks.length);
});

test('the same facts produce the same JSON, including shuffled lists, and the clock is not read', () => {
  const choice = { model: 'invented-cloud', host: 'invented.example' };
  const facts = mac({
    ollama: {
      installed: true,
      running: true,
      models: [
        { name: 'invented:extra', sizeGB: 1 },
        { name: catalog.models[0].name, sizeGB: 3 },
      ],
    },
    cloud: cloudChoice([
      { model: 'other-cloud', host: 'invented.example' },
      choice,
    ], choice),
    preferences: { mode: 'either' },
  });
  const shuffled = JSON.parse(JSON.stringify(facts));
  shuffled.ollama.models.reverse();
  shuffled.cloud.approved.reverse();
  const reversed = {};
  for (const key of Object.keys(facts).reverse()) reversed[key] = facts[key];
  const first = JSON.stringify(checkSetup(facts));
  assert.equal(JSON.stringify(checkSetup(shuffled)), first);
  assert.equal(JSON.stringify(checkSetup(reversed)), first);
  assert.equal(JSON.stringify(checkSetup(mac())), JSON.stringify(checkSetup(mac({ preferences: {} }))));
  assert.equal(JSON.stringify(checkSetup(mac())), JSON.stringify(checkSetup(mac({ preferences: { mode: 'local' } }))));
  assert.equal(JSON.stringify(checkSetup(mac())), JSON.stringify(checkSetup(mac({ ollama: { version: 'v'.repeat(500) } }))));

  const untouched = mac();
  const before = JSON.stringify(untouched);
  const result = checkSetup(untouched);
  result.summary = 'changed';
  result.nextSteps.push('extra');
  assert.equal(JSON.stringify(untouched), before);
  assert.equal(checkSetup(mac()).summary.includes('changed'), false);

  const RealDate = Date;
  let tripped = false;
  function BrokenDate(...args) {
    if (args.length === 0) {
      tripped = true;
      throw new Error('the clock was read');
    }
    return new RealDate(...args);
  }
  BrokenDate.now = () => {
    tripped = true;
    throw new Error('the clock was read');
  };
  BrokenDate.parse = RealDate.parse;
  BrokenDate.UTC = RealDate.UTC;
  globalThis.Date = BrokenDate;
  try {
    assert.equal(JSON.stringify(checkSetup(facts)), first);
    assert.equal(tripped, false);
  } finally {
    globalThis.Date = RealDate;
  }
});

test('checkSetup prints nothing and does not exit the process', () => {
  const logs = [];
  const originalLog = console.log;
  const originalExit = process.exit;
  let exited = false;
  console.log = (...args) => logs.push(args);
  process.exit = () => { exited = true; };
  try {
    checkSetup(mac());
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
  }
  assert.deepEqual(logs, []);
  assert.equal(exited, false);
});

test('the package has no dependency, no license, and no network or write code', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  const names = readdirSync(new URL('..', import.meta.url));
  assert.equal(names.some(name => /^licen[sc]e/i.test(name)), false);
  const root = new URL('../src/', import.meta.url);
  for (const name of ['index.mjs', 'check.mjs']) {
    const source = readFileSync(new URL(name, root), 'utf8');
    assert.equal(/\bDate\b|Math\.random|toLocaleString|child_process|\bnode:https?\b|\bnode:net\b|\bnode:dns\b|\bfetch\s*\(|process\.exit\b|writeFile|createWriteStream/.test(source), false, name);
  }
  const index = readFileSync(new URL('index.mjs', root), 'utf8');
  assert.equal(/process\.stdout|console\./.test(index), false);
});

test('the command prints a result or a refusal, and writes nothing', () => {
  const fixture = fileURLToPath(new URL('./fixtures/new-mac.json', import.meta.url));
  const expected = JSON.parse(readFileSync(new URL('./fixtures/new-mac.expected.json', import.meta.url), 'utf8'));
  let out = '';
  let err = '';
  const status = run(['--json', '--facts', fixture], {
    stdout: text => { out += text; },
    stderr: text => { err += text; },
    exit: () => { throw new Error('exit was called'); },
  });
  assert.equal(status, 0);
  assert.equal(err, '');
  assert.deepEqual(JSON.parse(out), expected);

  const file = readFileSync(fixture);
  const fromFile = command(['--facts', 'invented.json', '--json'], file);
  assert.equal(fromFile.status, 0);
  assert.deepEqual(JSON.parse(fromFile.out), expected);
  const text = command(['--json', '--facts', 'invented.json'], file);
  assert.equal(text.status, 0);
  assert.equal(text.out, fromFile.out);

  const report = command(['--facts', 'invented.json'], file);
  assert.equal(report.status, 0);
  assert.equal(report.out, `${formatPlain(expected)}\n`);
  assert.equal(report.code, 0);

  const missing = command(['--json']);
  assert.equal(missing.status, 1);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /facts/);
  assert.equal(missing.out, '');

  const unknown = command(['--facts', 'invented.json', '--widget'], file);
  assert.equal(unknown.status, 1);
  assert.match(unknown.err, /--widget/);
  assert.equal(unknown.out, '');

  const bad = command(['--facts', 'invented.json'], Buffer.from('{', 'utf8'));
  assert.match(bad.err, /not valid JSON/);
  assert.equal(bad.out, '');

  const tooBig = command(['--facts', 'invented.json'], Buffer.alloc(64 * 1024 + 1, 0x20));
  assert.match(tooBig.err, /larger than 64 KB/);
  const boundary = command(['--facts', 'invented.json'], Buffer.alloc(64 * 1024, 0x20));
  assert.match(boundary.err, /not valid JSON/);
  assert.equal(boundary.err.includes('larger than 64 KB'), false);

  const unread = command(['--facts', 'missing.json'], undefined, () => {
    throw new Error('ENOENT');
  });
  assert.match(unread.err, /cannot be read/);
  assert.equal(unread.out, '');
});

test('names are exact, an empty catalog fits nothing, and boundary numbers are accepted', () => {
  const name = catalog.models[0].name;
  const spaced = setup({ ollama: installed(`${name} `) });
  assert.notEqual(spaced.recommendation.model, `${name} `);
  assert.equal(find(spaced, 'model').state, 'warn');

  const distinct = setup({
    ollama: {
      installed: true,
      running: true,
      models: [
        { name: 'Invented:One', sizeGB: 1 },
        { name: 'invented:one', sizeGB: 1 },
      ],
    },
  });
  assert.equal(distinct.recommendation.model, name);

  const empty = setup({ preferences: { mode: 'local' } }, { schemaVersion: 1, models: [] });
  assert.equal(empty.recommendation.route, 'none');
  assert.equal(find(empty, 'disk').message, 'no local model to download');

  assert.equal(typeof setup({ memoryGB: 1, preferences: { mode: 'local' } }).recommendation.route, 'string');
  assert.equal(typeof setup({ memoryGB: 1024 }).ready, 'boolean');
  assert.equal(typeof setup({ freeDiskGB: 0, preferences: { mode: 'local' } }).recommendation.route, 'string');
  assert.equal(typeof setup({ freeDiskGB: 100000 }).ready, 'boolean');
  assert.equal(find(setup({ ollama: { installed: true, running: false, models: [] } }), 'ollama').fix, 'Open the Ollama app');
});
