export type CanvasNodeShape = 'rectangle' | 'square' | 'circle' | 'triangle';

/** x and y are the top-left corner in canvas coordinates. */
export interface CanvasNodeLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  shape: CanvasNodeShape;
  positionLocked: boolean;
  shapeLocked: boolean;
}

/** Geometry is separate from the workspace records and their identities. */
export interface CanvasLayoutRecord {
  version: 1;
  revision: number;
  nodes: Record<string, CanvasNodeLayout>;
}

export interface CanvasPoint { x: number; y: number }
/** x and y translate canvas coordinates into local viewport pixels. */
export interface CanvasView extends CanvasPoint { scale: number }

const MIN_SIZE = 96;
const MAX_SIZE = 1000;
const MAX_POSITION = 20_000;
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const SHAPES: readonly CanvasNodeShape[] = ['rectangle', 'square', 'circle', 'triangle'];
const ROOT_KEYS = ['version', 'revision', 'nodes'];
const NODE_KEYS = ['x', 'y', 'width', 'height', 'shape', 'positionLocked', 'shapeLocked'];
const NODE_ID = /^(domain|session|work|note|next-step):([A-Za-z0-9][A-Za-z0-9_-]{0,179})$/;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);

function plainDataObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function emptyCanvasLayout(): CanvasLayoutRecord {
  return { version: 1, revision: 0, nodes: {} };
}

/** Reject damaged or newer records without repairing or changing their contents. */
export function parseCanvasLayout(raw: unknown): CanvasLayoutRecord | null {
  try {
    if (!plainDataObject(raw) || !exactKeys(raw, ROOT_KEYS)
      || raw.version !== 1 || typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 0
      || !plainDataObject(raw.nodes)) return null;
    const nodes: Record<string, CanvasNodeLayout> = {};
    for (const [id, node] of Object.entries(raw.nodes)) {
      const match = NODE_ID.exec(id);
      if (!match || RESERVED_IDS.has(match[2]) || !plainDataObject(node) || !exactKeys(node, NODE_KEYS)
        || !bounded(node.x, 0, MAX_POSITION) || !bounded(node.y, 0, MAX_POSITION)
        || !bounded(node.width, MIN_SIZE, MAX_SIZE) || !bounded(node.height, MIN_SIZE, MAX_SIZE)
        || !SHAPES.includes(node.shape as CanvasNodeShape)
        || typeof node.positionLocked !== 'boolean' || typeof node.shapeLocked !== 'boolean'
        || ((node.shape === 'square' || node.shape === 'circle') && node.width !== node.height)) return null;
      nodes[id] = {
        x: node.x, y: node.y, width: node.width, height: node.height,
        shape: node.shape as CanvasNodeShape, positionLocked: node.positionLocked, shapeLocked: node.shapeLocked,
      };
    }
    return { version: 1, revision: raw.revision, nodes };
  } catch {
    // Unknown objects (including hostile proxies) cannot bypass the read boundary.
    return null;
  }
}

/** Keep square/circle geometry equal-sided when a shape or size changes. */
export function shapeBounds(shape: CanvasNodeShape, width: number, height: number): { width: number; height: number } {
  if (!SHAPES.includes(shape) || !Number.isFinite(width) || !Number.isFinite(height)) throw new RangeError('Invalid canvas shape bounds');
  const boundedWidth = Math.min(MAX_SIZE, Math.max(MIN_SIZE, width));
  const boundedHeight = Math.min(MAX_SIZE, Math.max(MIN_SIZE, height));
  if (shape === 'square' || shape === 'circle') {
    const side = Math.max(boundedWidth, boundedHeight);
    return { width: side, height: side };
  }
  return { width: boundedWidth, height: boundedHeight };
}

function center(node: CanvasNodeLayout): CanvasPoint {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function cross(a: CanvasPoint, b: CanvasPoint): number { return a.x * b.y - a.y * b.x; }

interface OutlineSegment { start: CanvasPoint; end: CanvasPoint; control?: CanvasPoint }
const CORNER_FRACTION = .33;

/** Trim one third of each adjoining edge; the curve retains the geometric corner as its control point. */
function roundedOutline(node: CanvasNodeLayout): OutlineSegment[] {
  const vertices = node.shape === 'triangle' ? [
    { x: node.x + node.width / 2, y: node.y },
    { x: node.x + node.width, y: node.y + node.height },
    { x: node.x, y: node.y + node.height },
  ] : [
    { x: node.x, y: node.y }, { x: node.x + node.width, y: node.y },
    { x: node.x + node.width, y: node.y + node.height }, { x: node.x, y: node.y + node.height },
  ];
  const towards = (corner: CanvasPoint, neighbor: CanvasPoint) => ({
    x: corner.x + (neighbor.x - corner.x) * CORNER_FRACTION,
    y: corner.y + (neighbor.y - corner.y) * CORNER_FRACTION,
  });
  return vertices.flatMap((corner, index) => {
    const previous = vertices[(index + vertices.length - 1) % vertices.length];
    const next = vertices[(index + 1) % vertices.length];
    return [
      { start: towards(corner, previous), control: corner, end: towards(corner, next) },
      { start: towards(corner, next), end: towards(next, corner) },
    ];
  });
}

/** Rendering, clipping and connector geometry share exactly the same rounded outline. */
export function roundedNodePath(node: CanvasNodeLayout): string {
  const segments = roundedOutline(node);
  return `M ${segments[0].start.x} ${segments[0].start.y} ${segments.map(({ end, control }) =>
    control ? `Q ${control.x} ${control.y} ${end.x} ${end.y}` : `L ${end.x} ${end.y}`).join(' ')} Z`;
}

function roundedIntersection(node: CanvasNodeLayout, target: CanvasPoint): { anchor: CanvasPoint; normal: CanvasPoint } {
  const origin = center(node);
  const delta = { x: target.x - origin.x, y: target.y - origin.y };
  if (delta.x === 0 && delta.y === 0) delta.x = 1;
  let nearest = Infinity;
  let intersection: { anchor: CanvasPoint; normal: CanvasPoint } | undefined;
  for (const { start, end, control } of roundedOutline(node)) {
    // B(t) = a t² + b t + start. Intersect its supporting ray by cross(B(t) - origin, delta) = 0.
    const a = control ? { x: start.x - 2 * control.x + end.x, y: start.y - 2 * control.y + end.y } : { x: 0, y: 0 };
    const b = control ? { x: 2 * (control.x - start.x), y: 2 * (control.y - start.y) } : { x: end.x - start.x, y: end.y - start.y };
    const quadratic = cross(a, delta);
    const linear = cross(b, delta);
    const constant = cross({ x: start.x - origin.x, y: start.y - origin.y }, delta);
    const discriminant = linear * linear - 4 * quadratic * constant;
    // The conventional quadratic formula loses the small root for near-axis
    // rays. Form one root without cancellation and derive the other by product.
    const q = -.5 * (linear + (linear < 0 ? -1 : 1) * Math.sqrt(Math.max(0, discriminant)));
    const roots = Math.abs(quadratic) < 1e-10 ? Math.abs(linear) < 1e-10 ? [] : [-constant / linear]
      : discriminant < 0 ? [] : q === 0 ? [0] : [q / quadratic, constant / q];
    for (const root of roots) {
      if (root < -1e-10 || root > 1 + 1e-10) continue;
      const t = Math.max(0, Math.min(1, root));
      const anchor = { x: a.x * t * t + b.x * t + start.x, y: a.y * t * t + b.y * t + start.y };
      const distance = ((anchor.x - origin.x) * delta.x + (anchor.y - origin.y) * delta.y) / (delta.x * delta.x + delta.y * delta.y);
      if (distance < 0 || distance >= nearest) continue;
      nearest = distance;
      const tangent = { x: 2 * a.x * t + b.x, y: 2 * a.y * t + b.y };
      intersection = { anchor, normal: unit({ x: tangent.y, y: -tangent.x }) };
    }
  }
  if (!intersection) throw new RangeError('Invalid rounded canvas boundary');
  return intersection;
}

/** Intersect a center-directed ray with the actual rendered shape boundary. */
export function nodeAnchor(node: CanvasNodeLayout, targetCenter: CanvasPoint): CanvasPoint {
  if (![node.x, node.y, node.width, node.height, targetCenter.x, targetCenter.y].every(Number.isFinite)
    || node.width <= 0 || node.height <= 0 || !SHAPES.includes(node.shape)) throw new RangeError('Invalid canvas connector geometry');
  const origin = center(node);
  const delta = { x: targetCenter.x - origin.x, y: targetCenter.y - origin.y };
  if (delta.x === 0 && delta.y === 0) delta.x = 1;
  if (node.shape === 'circle') {
    const factor = 1 / Math.hypot(delta.x / (node.width / 2), delta.y / (node.height / 2));
    return { x: origin.x + delta.x * factor, y: origin.y + delta.y * factor };
  }
  if (node.shape === 'triangle' || node.shape === 'square') return roundedIntersection(node, targetCenter).anchor;
  const factor = Math.min(delta.x === 0 ? Infinity : node.width / (2 * Math.abs(delta.x)),
    delta.y === 0 ? Infinity : node.height / (2 * Math.abs(delta.y)));
  return { x: origin.x + delta.x * factor, y: origin.y + delta.y * factor };
}

function unit(vector: CanvasPoint): CanvasPoint {
  const length = Math.hypot(vector.x, vector.y);
  return { x: vector.x / length, y: vector.y / length };
}

/** Leave a node along its surface normal so unequal rows retain curved splines. */
function anchorNormal(node: CanvasNodeLayout, anchor: CanvasPoint): CanvasPoint {
  const origin = center(node);
  if (node.shape === 'triangle' || node.shape === 'square') return roundedIntersection(node, anchor).normal;
  if (node.shape === 'circle') return unit({
    x: (anchor.x - origin.x) / (node.width / 2) ** 2,
    y: (anchor.y - origin.y) / (node.height / 2) ** 2,
  });
  const sides = [
    [{ x: node.x, y: node.y }, { x: node.x + node.width, y: node.y }],
    [{ x: node.x + node.width, y: node.y }, { x: node.x + node.width, y: node.y + node.height }],
    [{ x: node.x + node.width, y: node.y + node.height }, { x: node.x, y: node.y + node.height }],
    [{ x: node.x, y: node.y + node.height }, { x: node.x, y: node.y }],
  ];
  const candidates = sides.map(([first, last]) => {
    const edge = { x: last.x - first.x, y: last.y - first.y };
    const relative = { x: anchor.x - first.x, y: anchor.y - first.y };
    return { distance: Math.abs(cross(relative, edge)) / Math.hypot(edge.x, edge.y), normal: unit({ x: edge.y, y: -edge.x }) };
  });
  const nearest = Math.min(...candidates.map((side) => side.distance));
  const normals = candidates.filter((side) => side.distance <= nearest + 1e-8).map((side) => side.normal);
  return unit(normals.reduce((sum, normal) => ({ x: sum.x + normal.x, y: sum.y + normal.y }), { x: 0, y: 0 }));
}

/** Connector endpoints stay on their nodes after moving, resizing or reshaping. */
export function canvasConnectorPath(source: CanvasNodeLayout, target: CanvasNodeLayout): string {
  const sourceCenter = center(source);
  const targetCenter = center(target);
  const delta = { x: targetCenter.x - sourceCenter.x, y: targetCenter.y - sourceCenter.y };
  const distance = Math.hypot(delta.x, delta.y);
  const start = nodeAnchor(source, distance === 0 ? { x: sourceCenter.x + 1, y: sourceCenter.y } : targetCenter);
  const end = nodeAnchor(target, distance === 0 ? { x: targetCenter.x - 1, y: targetCenter.y } : sourceCenter);
  const sourceNormal = anchorNormal(source, start);
  const targetNormal = anchorNormal(target, end);
  const bend = Math.max(24, Math.min(180, distance / 3));
  const first = { x: start.x + sourceNormal.x * bend, y: start.y + sourceNormal.y * bend };
  const second = { x: end.x + targetNormal.x * bend, y: end.y + targetNormal.y * bend };
  return `M ${start.x} ${start.y} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${end.x} ${end.y}`;
}

/** Zoom around a local viewport point without moving the canvas point under it. */
export function zoomCanvasView(view: CanvasView, point: CanvasPoint, scale: number): CanvasView {
  if (![view.x, view.y, view.scale, point.x, point.y, scale].every(Number.isFinite) || view.scale <= 0) throw new RangeError('Invalid canvas zoom');
  const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const ratio = nextScale / view.scale;
  return { x: point.x + (view.x - point.x) * ratio, y: point.y + (view.y - point.y) * ratio, scale: nextScale };
}
