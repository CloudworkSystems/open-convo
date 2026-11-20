// A local workflow is JSON. The prompt is placed by replacing one field's
// value, then serialising the object. It is never spliced into the text.

import { LOCAL_NODES } from './nodes.mjs';
import { REASONS, refusedNode } from './reasons.mjs';

const TOKEN = {
  '{{prompt}}': 'prompt',
  '{{seconds}}': 'seconds',
  '{{width}}': 'width',
  '{{height}}': 'height',
  '{{reference_file}}': 'reference_file',
};

const NODE_ID = /^(?!constructor$|prototype$|__proto__$)[A-Za-z0-9_-]{1,64}$/;
const INPUT_KEY = /^(?!constructor$|prototype$|__proto__$)[A-Za-z0-9_]{1,64}$/;
const MAX_NODES = 200;
const MAX_INPUTS = 50;
const MAX_TEXT = 10_000;

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plainInput(value) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= MAX_TEXT;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!Array.isArray(value) || value.length > 4096) return false;
  const link = value.length === 2
    && typeof value[0] === 'string'
    && NODE_ID.test(value[0])
    && Number.isInteger(value[1])
    && value[1] >= 0
    && value[1] <= 64;
  if (link) return true;
  return value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

/**
 * Check the workflow without copying the prompt in. `request` says which
 * optional values the person set, so a missing or spare placeholder is
 * refused rather than leaving the template's own value.
 */
export function inspectWorkflow(workflow, request) {
  if (!plain(workflow)) return { ok: false, reason: REASONS.workflow };
  for (const key of Object.keys(workflow)) {
    if (key !== 'kind' && key !== 'prompt') return { ok: false, reason: REASONS.workflow };
  }
  if (workflow.kind !== 'image' && workflow.kind !== 'video') return { ok: false, reason: REASONS.workflowKind };
  if (workflow.kind !== request.kind) return { ok: false, reason: REASONS.workflowKind };
  const graph = workflow.prompt;
  if (!plain(graph)) return { ok: false, reason: REASONS.workflow };
  const ids = Object.keys(graph);
  if (ids.length === 0 || ids.length > MAX_NODES) return { ok: false, reason: REASONS.workflow };
  const counts = { prompt: 0, seconds: 0, width: 0, height: 0, reference_file: 0 };
  for (const id of ids) {
    if (!NODE_ID.test(id)) return { ok: false, reason: REASONS.workflow };
    const node = graph[id];
    if (!plain(node)) return { ok: false, reason: REASONS.workflow };
    for (const key of Object.keys(node)) {
      if (key !== 'class_type' && key !== 'inputs' && key !== '_meta') return { ok: false, reason: REASONS.workflow };
    }
    if (typeof node.class_type !== 'string' || !LOCAL_NODES.has(node.class_type)) {
      return { ok: false, reason: refusedNode(node.class_type) };
    }
    if (!plain(node.inputs)) return { ok: false, reason: REASONS.workflow };
    const inputKeys = Object.keys(node.inputs);
    if (inputKeys.length > MAX_INPUTS) return { ok: false, reason: REASONS.workflow };
    for (const key of inputKeys) {
      if (!INPUT_KEY.test(key)) return { ok: false, reason: REASONS.workflow };
      const value = node.inputs[key];
      if (typeof value === 'string' && Object.hasOwn(TOKEN, value)) {
        counts[TOKEN[value]] += 1;
        continue;
      }
      if (!plainInput(value)) return { ok: false, reason: REASONS.workflow };
    }
  }
  if (counts.prompt !== 1) return { ok: false, reason: REASONS.workflowPrompt };
  const needed = [
    ['seconds', request.hasSeconds],
    ['width', request.hasWidth],
    ['height', request.hasHeight],
    ['reference_file', request.hasReference],
  ];
  for (const [name, wanted] of needed) {
    const count = counts[name];
    if (wanted && count !== 1) return { ok: false, reason: REASONS.workflowValue };
    if (!wanted && count !== 0) return { ok: false, reason: REASONS.workflowValue };
  }
  return { ok: true };
}

/** A graph safe to serialise. The caller's object is left as it was. */
export function fillWorkflow(workflow, values) {
  const prompt = Object.create(null);
  for (const id of Object.keys(workflow.prompt)) {
    const node = workflow.prompt[id];
    const inputs = Object.create(null);
    for (const key of Object.keys(node.inputs)) {
      const value = node.inputs[key];
      if (typeof value === 'string' && Object.hasOwn(TOKEN, value)) {
        inputs[key] = values[TOKEN[value]];
      } else if (Array.isArray(value)) {
        inputs[key] = value.slice();
      } else {
        inputs[key] = value;
      }
    }
    prompt[id] = { class_type: node.class_type, inputs };
  }
  return prompt;
}
