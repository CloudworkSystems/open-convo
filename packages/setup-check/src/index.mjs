/**
 * Setup check engine. A description of a computer goes in, and a checklist
 * and a recommendation come out. It runs nothing, installs nothing, reads
 * no clock, and does not touch the network or the disk.
 *
 * The caller passes the facts. `catalog` defaults to this package's
 * catalog.json. The same facts and catalog always produce the same result.
 */

import defaultCatalog from '../catalog.json' with { type: 'json' };

const FACTS_LIMIT = 64 * 1024;
const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:\.(0|[1-9]\d{0,3}))?$/;
const MODES = ['local', 'cloud', 'either'];
const FACTS_KEYS = ['schemaVersion', 'os', 'chip', 'memoryGB', 'freeDiskGB', 'ollama', 'cloud', 'preferences'];
const UPDATE_MACOS = 'update macOS to 13 or later';
const SWITCH_TO_CLOUD = 'or switch to a cloud model in settings';
const OPEN_OLLAMA = 'Open the Ollama app';
const INSTALL_OLLAMA = 'Download Ollama from https://ollama.com/download';
const PICK_CLOUD = 'pick a cloud model';
const MEMORY_NOTE = "this Mac's memory is too small for a local model";
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

const fail = message => {
  throw new Error(message);
};

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function milli(value) {
  return Math.round(value * 1000);
}

function formatGb(value) {
  const rounded = Math.abs(milli(value));
  const whole = Math.trunc(rounded / 1000);
  const fraction = String(rounded % 1000).padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function wholeGbRoundedUp(sizeGB, freeDiskGB) {
  return Math.ceil((milli(sizeGB) + 5000 - milli(freeDiskGB)) / 1000);
}

function fitsOnDisk(freeDiskGB, sizeGB) {
  return milli(freeDiskGB) >= milli(sizeGB);
}

function hasSpare(freeDiskGB, sizeGB) {
  return milli(freeDiskGB) >= milli(sizeGB) + 5000;
}

/** One line for the summary and the printed report. The JSON fields keep the original text. */
function oneLine(text) {
  return String(text)
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(BIDI, char => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function requireKeys(value, keys, prefix) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${prefix}${key} is an unknown field.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${prefix}${key} is missing.`);
  }
}

function optionalKeys(value, keys, prefix) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${prefix}${key} is an unknown field.`);
  }
}

function textField(value, label) {
  if (typeof value !== 'string') fail(`${label} must be text.`);
  if (value.length === 0) fail(`${label} is out of range.`);
  return value;
}

function numberField(value, label, min, max) {
  if (typeof value !== 'number') fail(`${label} must be a number.`);
  if (!Number.isFinite(value) || value < min || value > max) fail(`${label} is out of range.`);
}

function sizeField(value, label) {
  if (typeof value !== 'number') fail(`${label} must be a number.`);
  if (!Number.isFinite(value) || value <= 0 || value > 100000) fail(`${label} is out of range.`);
}

function listField(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be a list.`);
}

function withinBytes(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(`${label} must be plain data.`);
  }
  if (typeof encoded !== 'string') fail(`${label} must be plain data.`);
  if (Buffer.byteLength(encoded) > FACTS_LIMIT) fail(`${label} is larger than 64 KB.`);
}

function schemaVersion(value, label) {
  if (!Object.hasOwn(value, 'schemaVersion')) fail(`${label}schemaVersion is missing.`);
  if (value.schemaVersion !== 1) fail(`${label}schemaVersion must be 1.`);
}

function pairList(entries, label, limit) {
  listField(entries, label);
  if (entries.length > limit) fail(`${label} is out of range.`);
  const seen = new Set();
  return entries.map((entry, index) => {
    const prefix = `${label}.${index}.`;
    if (!plainObject(entry)) fail(`${prefix.slice(0, -1)} must be an object.`);
    requireKeys(entry, ['name', 'sizeGB'], prefix);
    const name = textField(entry.name, `${prefix}name`);
    sizeField(entry.sizeGB, `${prefix}sizeGB`);
    if (seen.has(name)) fail(`${label} has a repeated name.`);
    seen.add(name);
    return { name, sizeGB: entry.sizeGB };
  });
}

function approvedList(entries) {
  listField(entries, 'cloud.approved');
  if (entries.length > 20) fail('cloud.approved is out of range.');
  const seen = new Set();
  return entries.map((entry, index) => {
    const prefix = `cloud.approved.${index}.`;
    if (!plainObject(entry)) fail(`cloud.approved.${index} must be an object.`);
    requireKeys(entry, ['model', 'host'], prefix);
    const model = textField(entry.model, `${prefix}model`);
    const host = textField(entry.host, `${prefix}host`);
    const key = JSON.stringify([model, host]);
    if (seen.has(key)) fail('cloud.approved has a repeated pair.');
    seen.add(key);
    return { model, host };
  });
}

function validateFacts(facts) {
  if (!plainObject(facts)) fail('facts must be an object.');
  withinBytes(facts, 'facts');
  schemaVersion(facts, '');
  optionalKeys(facts, FACTS_KEYS, '');
  for (const key of ['os', 'chip', 'memoryGB', 'freeDiskGB', 'ollama', 'cloud']) {
    if (!Object.hasOwn(facts, key)) fail(`${key} is missing.`);
  }

  if (!plainObject(facts.os)) fail('os must be an object.');
  requireKeys(facts.os, ['name', 'version'], 'os.');
  if (facts.os.name !== 'macOS') fail('os.name must be macOS.');
  textField(facts.os.version, 'os.version');
  if (!VERSION.test(facts.os.version)) fail('os.version is out of range.');

  if (facts.chip !== 'apple-silicon' && facts.chip !== 'intel') fail('chip must be apple-silicon or intel.');
  numberField(facts.memoryGB, 'memoryGB', 1, 1024);
  numberField(facts.freeDiskGB, 'freeDiskGB', 0, 100000);

  if (!plainObject(facts.ollama)) fail('ollama must be an object.');
  optionalKeys(facts.ollama, ['installed', 'running', 'version', 'models'], 'ollama.');
  for (const key of ['installed', 'running', 'models']) {
    if (!Object.hasOwn(facts.ollama, key)) fail(`ollama.${key} is missing.`);
  }
  if (typeof facts.ollama.installed !== 'boolean') fail('ollama.installed must be true or false.');
  if (typeof facts.ollama.running !== 'boolean') fail('ollama.running must be true or false.');
  if (facts.ollama.running && !facts.ollama.installed) {
    fail('ollama.running cannot be true when ollama.installed is false.');
  }
  if (Object.hasOwn(facts.ollama, 'version')) textField(facts.ollama.version, 'ollama.version');
  const models = pairList(facts.ollama.models, 'ollama.models', 200);

  if (!plainObject(facts.cloud)) fail('cloud must be an object.');
  optionalKeys(facts.cloud, ['choice', 'approved'], 'cloud.');
  if (!Object.hasOwn(facts.cloud, 'approved')) fail('cloud.approved is missing.');
  let choice;
  if (Object.hasOwn(facts.cloud, 'choice')) {
    if (!plainObject(facts.cloud.choice)) fail('cloud.choice must be an object.');
    requireKeys(facts.cloud.choice, ['model', 'host'], 'cloud.choice.');
    choice = {
      model: textField(facts.cloud.choice.model, 'cloud.choice.model'),
      host: textField(facts.cloud.choice.host, 'cloud.choice.host'),
    };
  }
  const approved = approvedList(facts.cloud.approved);

  let mode = 'local';
  if (Object.hasOwn(facts, 'preferences')) {
    if (!plainObject(facts.preferences)) fail('preferences must be an object.');
    optionalKeys(facts.preferences, ['mode'], 'preferences.');
    if (Object.hasOwn(facts.preferences, 'mode')) {
      if (!MODES.includes(facts.preferences.mode)) fail('preferences.mode must be local, cloud, or either.');
      mode = facts.preferences.mode;
    }
  }

  return {
    os: { name: 'macOS', version: facts.os.version },
    chip: facts.chip,
    memoryGB: facts.memoryGB,
    freeDiskGB: facts.freeDiskGB,
    ollama: { installed: facts.ollama.installed, running: facts.ollama.running, models },
    cloud: choice ? { choice, approved } : { approved },
    mode,
  };
}

function validateCatalog(catalog) {
  if (!plainObject(catalog)) fail('catalog must be an object.');
  withinBytes(catalog, 'catalog');
  schemaVersion(catalog, 'catalog.');
  requireKeys(catalog, ['schemaVersion', 'models'], 'catalog.');
  listField(catalog.models, 'catalog.models');
  const seen = new Set();
  const models = catalog.models.map((entry, index) => {
    const prefix = `catalog.models.${index}.`;
    if (!plainObject(entry)) fail(`catalog.models.${index} must be an object.`);
    requireKeys(entry, ['name', 'sizeGB', 'minMemoryGB', 'note'], prefix);
    const name = textField(entry.name, `${prefix}name`);
    sizeField(entry.sizeGB, `${prefix}sizeGB`);
    numberField(entry.minMemoryGB, `${prefix}minMemoryGB`, 1, 1024);
    textField(entry.note, `${prefix}note`);
    if (seen.has(name)) fail('catalog.models has a repeated name.');
    seen.add(name);
    return { name, sizeGB: entry.sizeGB, minMemoryGB: entry.minMemoryGB };
  });
  return { models };
}

function row(id, state, message, fix) {
  const check = { id, state, message };
  if (state === 'warn' || state === 'stop') check.fix = fix;
  return check;
}

function memoryFitting(catalog, memoryGB) {
  return catalog.models.filter(model => memoryGB >= model.minMemoryGB);
}

function chooseModels(facts, catalog) {
  const fitting = memoryFitting(catalog, facts.memoryGB);
  const installed = fitting.find(model => facts.ollama.models.some(entry => entry.name === model.name));
  if (installed) return { fitting, chosen: installed, installed: true };
  const download = fitting.find(model => fitsOnDisk(facts.freeDiskGB, model.sizeGB)) ?? null;
  return { fitting, chosen: download, installed: false };
}

function smallestModel(models) {
  return models.reduce((best, model) => (milli(model.sizeGB) < milli(best.sizeGB) ? model : best));
}

function osCheck(facts) {
  const major = Number(facts.os.version.split('.')[0]);
  if (major >= 13) return row('os', 'pass', `macOS ${facts.os.version} meets the minimum of 13`);
  return row('os', 'stop', `macOS ${facts.os.version} is earlier than 13`, UPDATE_MACOS);
}

function chipCheck(facts) {
  if (facts.chip === 'apple-silicon') return row('chip', 'pass', 'Apple silicon');
  return row('chip', 'info', 'local models will be slow on Intel, and a cloud model may suit better');
}

function memoryCheck(choice) {
  if (choice.fitting.length > 0) return row('memory', 'pass', 'enough memory for a local model');
  return row('memory', 'warn', 'only a cloud model will work', MEMORY_NOTE);
}

function diskCheck(facts, choice) {
  if (choice.fitting.length === 0) return row('disk', 'pass', 'no local model to download');
  if (choice.installed) {
    if (milli(facts.freeDiskGB) >= 5000) return row('disk', 'pass', 'enough free disk space');
    return row('disk', 'warn', 'disk almost full', 'free up disk space so at least 5 GB stays free');
  }
  if (!choice.chosen) {
    const amount = wholeGbRoundedUp(smallestModel(choice.fitting).sizeGB, facts.freeDiskGB);
    return row('disk', 'stop', 'not enough free disk for a local model', `free up at least ${amount} GB`);
  }
  const name = choice.chosen.name;
  if (hasSpare(facts.freeDiskGB, choice.chosen.sizeGB)) {
    return row('disk', 'pass', `enough disk space for ${name} with 5 GB spare`);
  }
  return row('disk', 'warn', `room for ${name} but not 5 GB spare`, 'free up disk space so the download has 5 GB spare');
}

function ollamaCheck(facts) {
  if (facts.mode === 'cloud') return row('ollama', 'pass', 'skipped because the mode is cloud');
  if (facts.ollama.installed && facts.ollama.running) return row('ollama', 'pass', 'Ollama is installed and running');
  if (facts.ollama.installed) return row('ollama', 'warn', 'installed but not running', OPEN_OLLAMA);
  return row('ollama', 'warn', 'Ollama is not installed', INSTALL_OLLAMA);
}

function modelCheck(choice) {
  if (choice.fitting.length === 0) {
    return row('model', 'warn', "no local model fits this Mac's memory", 'use a cloud model');
  }
  if (choice.installed) return row('model', 'pass', `${choice.chosen.name} is installed`);
  if (!choice.chosen) {
    return row('model', 'warn', 'no local model fits the free disk space', 'free up disk space for a local model');
  }
  const size = formatGb(choice.chosen.sizeGB);
  const name = choice.chosen.name;
  return row('model', 'warn', `${name} is not installed`, `Download ${name} (${size} GB): ollama pull ${name}`);
}

function cloudCheck(facts) {
  const choice = facts.cloud.choice;
  if (!choice) return row('cloud', 'warn', PICK_CLOUD, PICK_CLOUD);
  const approved = facts.cloud.approved.some(pair => pair.model === choice.model && pair.host === choice.host);
  if (!approved) {
    return row(
      'cloud',
      'warn',
      `${choice.model} on ${choice.host} needs the owner's one-time approval first`,
      `approve ${choice.model} on ${choice.host}`,
    );
  }
  return row('cloud', 'pass', `${choice.model} on ${choice.host} is approved`);
}

function localWorks(checks, choice) {
  return choice.fitting.length > 0 && checks.every(check => check.state !== 'stop');
}

function routeFor(mode, works) {
  if (mode === 'cloud') return 'cloud';
  if (mode === 'local') return works ? 'local' : 'none';
  return works ? 'local' : 'cloud';
}

function addFix(steps, check) {
  if (!check || (check.state !== 'warn' && check.state !== 'stop')) return;
  if (!steps.includes(check.fix)) steps.push(check.fix);
}

function stepsFor(route, checks) {
  const byId = Object.fromEntries(checks.map(check => [check.id, check]));
  const steps = [];
  if (route === 'local') {
    for (const check of checks) if (check.id !== 'cloud') addFix(steps, check);
    return steps;
  }
  if (route === 'cloud') {
    addFix(steps, byId.os);
    addFix(steps, byId.cloud);
    return steps;
  }
  addFix(steps, byId.os);
  if (byId.os.state !== 'pass') return steps;
  if (byId.memory.state === 'warn') addFix(steps, byId.memory);
  else if (byId.disk.state === 'stop') addFix(steps, byId.disk);
  if (byId.os.state === 'pass' && (byId.memory.state === 'warn' || byId.disk.state === 'stop') && !steps.includes(SWITCH_TO_CLOUD)) {
    steps.push(SWITCH_TO_CLOUD);
  }
  return steps;
}

function reasonFor(route, checks, mode) {
  const byId = Object.fromEntries(checks.map(check => [check.id, check]));
  if (route === 'none') {
    if (byId.os.state === 'stop') return 'macOS is earlier than 13, so nothing can be set up yet.';
    if (byId.memory.state === 'warn') return "No catalog model fits this Mac's memory.";
    return 'No catalog model fits the free disk space.';
  }
  if (route === 'cloud') {
    if (byId.os.state === 'stop') {
      return mode === 'cloud'
        ? 'The chosen mode is cloud, and macOS is earlier than 13.'
        : 'macOS is earlier than 13, so a local model cannot be set up.';
    }
    if (byId.memory.state === 'warn' || byId.disk.state === 'stop') {
      return 'A local model cannot run here, so a cloud model is recommended.';
    }
    return 'The chosen mode is cloud, so a cloud model is recommended.';
  }
  return 'A catalog model fits and no check stops a local model.';
}

function summaryFor(route, checks, recommendation) {
  const byId = Object.fromEntries(checks.map(check => [check.id, check]));
  if (route === 'none') {
    if (byId.os.state === 'stop') return 'This Mac needs macOS 13 or later before setup can continue.';
    if (byId.memory.state === 'warn') return "No local model fits this Mac's memory. Only a cloud model will work.";
    const amount = byId.disk.fix.slice('free up at least '.length);
    return `No local model fits the free disk space. Free up at least ${amount}, or switch to a cloud model.`;
  }
  if (route === 'cloud') {
    const parts = ['This Mac will use a cloud model.'];
    if (byId.os.state === 'stop') parts.push('Update macOS to 13 or later first.');
    if (!recommendation.model) parts.push('Pick a cloud model.');
    else if (byId.cloud.state === 'warn') {
      parts.push(`${recommendation.model} on ${recommendation.host} needs the owner's one-time approval.`);
    } else {
      parts.push(`${recommendation.model} on ${recommendation.host} is approved.`);
    }
    return oneLine(parts.join(' '));
  }
  const name = recommendation.model;
  const size = formatGb(recommendation.sizeGB);
  const parts = ['This Mac can run a local model.'];
  const downloading = byId.model.state === 'warn';
  if (byId.ollama.message === 'Ollama is not installed' && downloading) {
    parts.push(`Install Ollama, then download ${name} (${size} GB).`);
  } else if (byId.ollama.message === 'Ollama is not installed') {
    parts.push('Install Ollama.');
  } else if (byId.ollama.message === 'installed but not running' && downloading) {
    parts.push(`Open the Ollama app, then download ${name} (${size} GB).`);
  } else if (byId.ollama.message === 'installed but not running') {
    parts.push('Open the Ollama app.');
  } else if (downloading) {
    parts.push(`Download ${name} (${size} GB).`);
  } else {
    parts.push(`${name} is installed and ready.`);
  }
  if (byId.disk.state === 'warn') {
    parts.push(byId.disk.message === 'disk almost full'
      ? 'The disk is almost full.'
      : 'Free up disk space so 5 GB stays free after the download.');
  }
  return oneLine(parts.join(' '));
}

function recommendationFor(route, facts, choice, checks) {
  const recommendation = { route };
  if (route === 'local') {
    recommendation.model = choice.chosen.name;
    recommendation.sizeGB = choice.chosen.sizeGB;
  } else if (route === 'cloud' && facts.cloud.choice) {
    recommendation.model = facts.cloud.choice.model;
    recommendation.host = facts.cloud.choice.host;
  }
  recommendation.reason = reasonFor(route, checks, facts.mode);
  return recommendation;
}

function publicRecommendation(recommendation) {
  const result = { route: recommendation.route };
  if (Object.hasOwn(recommendation, 'model')) result.model = recommendation.model;
  if (Object.hasOwn(recommendation, 'host')) result.host = recommendation.host;
  result.reason = recommendation.reason;
  return result;
}

/**
 * @param {object} facts Facts for one computer. See the package README.
 * @param {object} [catalog] Model catalog. Defaults to the package catalog.
 * @returns {object} The checklist and recommendation. Throws a plain Error when the input is refused.
 */
export function checkSetup(facts, catalog = defaultCatalog) {
  const cleanFacts = validateFacts(facts);
  const cleanCatalog = validateCatalog(catalog);
  const choice = chooseModels(cleanFacts, cleanCatalog);
  const checks = [
    osCheck(cleanFacts),
    chipCheck(cleanFacts),
    memoryCheck(choice),
    diskCheck(cleanFacts, choice),
    ollamaCheck(cleanFacts),
    modelCheck(choice),
  ];
  const works = localWorks(checks, choice);
  const route = routeFor(cleanFacts.mode, works);
  if (cleanFacts.mode === 'cloud' || (cleanFacts.mode === 'either' && !works)) checks.push(cloudCheck(cleanFacts));
  const recommendation = recommendationFor(route, cleanFacts, choice, checks);
  const nextSteps = stepsFor(route, checks);
  return {
    schemaVersion: 1,
    ready: nextSteps.length === 0,
    summary: summaryFor(route, checks, recommendation),
    checks,
    recommendation: publicRecommendation(recommendation),
    nextSteps,
  };
}

const MARK = { pass: '✓', info: 'i', warn: '!', stop: '✗' };

/** The command's plain report: summary, one line per check, then numbered steps. */
export function formatPlain(result) {
  const lines = [oneLine(result.summary), ''];
  for (const check of result.checks) lines.push(`${MARK[check.state]} ${oneLine(check.message)}`);
  if (result.nextSteps.length) {
    lines.push('');
    result.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${oneLine(step)}`));
  }
  return lines.join('\n');
}
