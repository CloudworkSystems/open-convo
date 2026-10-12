import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canvasConnectorPath, emptyCanvasLayout, nodeAnchor, parseCanvasLayout, shapeBounds, zoomCanvasView,
  type CanvasNodeLayout, type CanvasPoint,
} from '../../src/domain/canvas-layout';

const rectangle: CanvasNodeLayout = { x: 100, y: 200, width: 240, height: 120, shape: 'rectangle', positionLocked: false, shapeLocked: false };
const record = () => ({ version: 1, revision: 2, nodes: { 'domain:invented-folder': { ...rectangle } } });

function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`); }
function nearPoint(actual: CanvasPoint, expected: CanvasPoint) { near(actual.x, expected.x); near(actual.y, expected.y); }
function pathPoints(path: string): number[] { return path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number); }

test('empty canvas layout is independent and valid; reading a saved record copies geometry without repairing it', () => {
  const empty = emptyCanvasLayout();
  assert.deepEqual(empty, { version: 1, revision: 0, nodes: {} });
  assert.deepEqual(parseCanvasLayout(empty), empty);
  empty.nodes['session:new'] = { ...rectangle };
  assert.deepEqual(emptyCanvasLayout().nodes, {});
  const original = record();
  const parsed = parseCanvasLayout(original)!;
  assert.deepEqual(parsed, original);
  assert.notEqual(parsed, original);
  assert.notEqual(parsed.nodes, original.nodes);
  assert.notEqual(parsed.nodes['domain:invented-folder'], original.nodes['domain:invented-folder']);
  parsed.nodes['domain:invented-folder'].x = 101;
  assert.equal(original.nodes['domain:invented-folder'].x, 100);
});

test('canvas layout root rejects missing/new fields, unsupported versions and invalid revisions without changing input', () => {
  for (const raw of [
    null, [], 'serialized records are parsed by the adapter', {},
    { ...record(), version: 2 }, { ...record(), revision: -1 }, { ...record(), revision: 0.5 },
    { ...record(), revision: NaN }, { ...record(), revision: Infinity }, { ...record(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...record(), extra: true }, { ...record(), nodes: [] }, { ...record(), nodes: null },
    { version: 1, nodes: {} }, { version: 1, revision: 0 },
  ]) {
    const before = structuredClone(raw);
    assert.equal(parseCanvasLayout(raw), null);
    assert.deepEqual(raw, before);
  }
  assert.equal(parseCanvasLayout({ ...record(), revision: Number.MAX_SAFE_INTEGER })?.revision, Number.MAX_SAFE_INTEGER);
});

test('canvas layouts retain all stable workspace node kinds and accept exact numeric bounds', () => {
  const nodes = Object.fromEntries(['domain', 'session', 'work', 'note', 'next-step'].map((kind) => [
    `${kind}:invented-id`, { ...rectangle, x: 20_000, y: 0, width: 96, height: 1000 },
  ]));
  const raw = { version: 1, revision: 0, nodes };
  assert.deepEqual(parseCanvasLayout(raw), raw);
  const emptyNullMap = { version: 1, revision: 0, nodes: Object.create(null) };
  assert.deepEqual(parseCanvasLayout(emptyNullMap), emptyCanvasLayout());
});

test('malformed geometry, unknown fields and false-shaped squares/circles fail closed instead of being normalized on read', () => {
  for (const update of [
    { x: -0.1 }, { x: 20_001 }, { x: NaN }, { y: Infinity }, { y: -1 },
    { width: 95.9 }, { width: 1001 }, { height: 95 }, { height: 1001 }, { height: '120' },
    { shape: 'hexagon' }, { shape: 'circle' }, { shape: 'square' },
    { positionLocked: 'true' }, { shapeLocked: null }, { unexpected: 'new-version-data' },
  ]) {
    const raw = record();
    Object.assign(raw.nodes['domain:invented-folder'], update);
    const before = structuredClone(raw);
    assert.equal(parseCanvasLayout(raw), null);
    assert.deepEqual(raw, before);
  }
  const missing = { ...rectangle } as Partial<CanvasNodeLayout>;
  delete missing.positionLocked;
  assert.equal(parseCanvasLayout({ version: 1, revision: 0, nodes: { 'session:invented': missing } }), null);
  for (const shape of ['circle', 'square', 'triangle'] as const) {
    const node = { ...rectangle, shape, width: 96, height: 96, positionLocked: true, shapeLocked: true };
    assert.deepEqual(parseCanvasLayout({ version: 1, revision: 0, nodes: { 'note:invented': node } })?.nodes['note:invented'], node);
  }
});

test('prototype keys, inherited records, symbols and accessors cannot enter the canvas geometry map', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', 'session:__proto__', 'session:constructor', 'session:prototype', 'domain:', 'unknown:invented', 'session:with space']) {
    const raw = { version: 1, revision: 0, nodes: JSON.parse(`{"${id}":${JSON.stringify(rectangle)}}`) };
    assert.equal(parseCanvasLayout(raw), null);
  }
  assert.equal(parseCanvasLayout(Object.assign(Object.create({ inherited: true }), record())), null);
  const inheritedNodes = Object.create({ 'domain:hidden': rectangle });
  assert.equal(parseCanvasLayout({ version: 1, revision: 0, nodes: inheritedNodes }), null);
  const symbolRoot = { ...record(), [Symbol('unknown')]: 3 };
  assert.equal(parseCanvasLayout(symbolRoot), null);
  const nonenumerable = record();
  Object.defineProperty(nonenumerable, 'secret', { value: true });
  assert.equal(parseCanvasLayout(nonenumerable), null);
  let accessed = false;
  const accessorRoot = { version: 1, revision: 0, get nodes() { accessed = true; return {}; } };
  assert.equal(parseCanvasLayout(accessorRoot), null);
  assert.equal(accessed, false);
  assert.equal(parseCanvasLayout(new Proxy({}, { getPrototypeOf() { throw new Error('Invalid input'); } })), null);
  assert.equal(Object.hasOwn({}, 'polluted'), false);
});

test('shape changes enforce limits and equal square/circle sides while retaining rectangular/triangular proportions', () => {
  assert.deepEqual(shapeBounds('rectangle', 230, 96), { width: 230, height: 96 });
  assert.deepEqual(shapeBounds('triangle', 40, 5000), { width: 96, height: 1000 });
  assert.deepEqual(shapeBounds('square', 240, 120), { width: 240, height: 240 });
  assert.deepEqual(shapeBounds('circle', 4000, 32), { width: 1000, height: 1000 });
  assert.throws(() => shapeBounds('circle', NaN, 96), RangeError);
  assert.throws(() => shapeBounds('triangle', 96, Infinity), RangeError);
});

test('rectangular connectors meet each visible edge and follow the resized boundary in every direction', () => {
  nearPoint(nodeAnchor(rectangle, { x: 1000, y: 260 }), { x: 340, y: 260 });
  nearPoint(nodeAnchor(rectangle, { x: 0, y: 260 }), { x: 100, y: 260 });
  nearPoint(nodeAnchor(rectangle, { x: 220, y: 0 }), { x: 220, y: 200 });
  nearPoint(nodeAnchor(rectangle, { x: 220, y: 1000 }), { x: 220, y: 320 });
  nearPoint(nodeAnchor(rectangle, { x: 460, y: 380 }), { x: 340, y: 320 });
  nearPoint(nodeAnchor({ ...rectangle, x: 0, y: 0, width: 1000, height: 200 }, { x: 1000, y: 500 }), { x: 625, y: 200 });
  nearPoint(nodeAnchor(rectangle, { x: 220, y: 260 }), { x: 340, y: 260 });
});

test('circle/ellipse connectors meet the curved boundary instead of its rectangular corner', () => {
  for (const node of [
    { ...rectangle, width: 200, height: 200, shape: 'circle' as const },
    { ...rectangle, shape: 'circle' as const },
  ]) {
    for (const direction of [{ x: 1, y: 1 }, { x: -1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 0, y: -1 }]) {
      const origin = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
      const anchor = nodeAnchor(node, { x: origin.x + direction.x * 1000, y: origin.y + direction.y * 1000 });
      near(((anchor.x - origin.x) / (node.width / 2)) ** 2 + ((anchor.y - origin.y) / (node.height / 2)) ** 2, 1);
      near((anchor.x - origin.x) * direction.y, (anchor.y - origin.y) * direction.x);
    }
  }
});

test('triangle connectors meet the sloping sides, rounded apex and base as nodes resize and move', () => {
  const node = { ...rectangle, shape: 'triangle' as const };
  nearPoint(nodeAnchor(node, { x: 1000, y: 260 }), { x: 280, y: 260 });
  nearPoint(nodeAnchor(node, { x: 0, y: 260 }), { x: 160, y: 260 });
  nearPoint(nodeAnchor(node, { x: 220, y: 0 }), { x: 220, y: 200 + 120 * .165 });
  nearPoint(nodeAnchor(node, { x: 220, y: 1000 }), { x: 220, y: 320 });
  const roundedCorner = 1 - .33 * (2 - Math.SQRT2) ** 2;
  nearPoint(nodeAnchor(node, { x: 340, y: 320 }), { x: 100 + 240 * roundedCorner, y: 200 + 120 * roundedCorner });
  for (const width of [96, 250, 1000]) {
    for (const height of [96, 400, 1000]) {
      const resized = { ...node, x: 2000, y: 3000, width, height };
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 12) {
        const origin = { x: resized.x + width / 2, y: resized.y + height / 2 };
        const anchor = nodeAnchor(resized, { x: origin.x + Math.cos(angle) * 2000, y: origin.y + Math.sin(angle) * 2000 });
        const normalizedX = (anchor.x - resized.x) / width;
        const normalizedY = (anchor.y - resized.y) / height;
        assert.ok(normalizedY <= 1 + 1e-8 && normalizedX >= .5 - normalizedY / 2 - 1e-8 && normalizedX <= .5 + normalizedY / 2 + 1e-8);
        near((anchor.x - origin.x) * Math.sin(angle), (anchor.y - origin.y) * Math.cos(angle));
        assert.ok(normalizedX >= -1e-8 && normalizedX <= 1 + 1e-8 && normalizedY >= -1e-8 && normalizedY <= 1 + 1e-8);
      }
    }
  }
});

test('rounded square and triangle rays attach to independently evaluated corner curves', () => {
  for (const shape of ['square', 'triangle'] as const) {
    for (const width of [96, 250, 1000]) {
      for (const height of shape === 'square' ? [width] : [96, 400, 1000]) {
        const node = { ...rectangle, x: 2000, y: 3000, shape, width, height };
        const origin = { x: node.x + width / 2, y: node.y + height / 2 };
        const corners = shape === 'triangle' ? [
          [{ x: .335, y: .33 }, { x: .5, y: 0 }, { x: .665, y: .33 }],
          [{ x: .835, y: .67 }, { x: 1, y: 1 }, { x: .67, y: 1 }],
        ] : [[{ x: 1, y: .67 }, { x: 1, y: 1 }, { x: .67, y: 1 }]];
        for (const [start, corner, end] of corners) {
          for (const t of [0, .2, .5, .8, 1]) {
            const x = (1 - t) ** 2 * start.x + 2 * (1 - t) * t * corner.x + t * t * end.x;
            const y = (1 - t) ** 2 * start.y + 2 * (1 - t) * t * corner.y + t * t * end.y;
            const expected = { x: node.x + width * x, y: node.y + height * y };
            const target = { x: origin.x + 5 * (expected.x - origin.x), y: origin.y + 5 * (expected.y - origin.y) };
            nearPoint(nodeAnchor(node, target), expected);
            const path = pathPoints(canvasConnectorPath(node, { ...rectangle, x: target.x, y: target.y }));
            assert.ok(path.every(Number.isFinite));
          }
        }
      }
    }
  }
});

test('cubic paths retain boundary endpoints after crossing, moving and reshaping nodes', () => {
  for (const target of [
    { ...rectangle, x: 1000 }, { ...rectangle, x: 0, y: 0 }, { ...rectangle, x: 100, y: 1000 },
    { ...rectangle, x: 500, y: 0, width: 200, height: 200, shape: 'circle' as const },
    { ...rectangle, x: 0, y: 600, width: 96, height: 1000, shape: 'triangle' as const },
  ]) {
    const path = canvasConnectorPath(rectangle, target);
    assert.match(path, /^M .+ C .+, .+, .+$/);
    const points = pathPoints(path);
    assert.equal(points.length, 8);
    assert.ok(points.every(Number.isFinite));
    nearPoint({ x: points[0], y: points[1] }, nodeAnchor(rectangle, { x: target.x + target.width / 2, y: target.y + target.height / 2 }));
    nearPoint({ x: points[6], y: points[7] }, nodeAnchor(target, { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 }));
  }
  const coincident = pathPoints(canvasConnectorPath(rectangle, rectangle));
  nearPoint({ x: coincident[0], y: coincident[1] }, { x: 340, y: 260 });
  nearPoint({ x: coincident[6], y: coincident[7] }, { x: 100, y: 260 });
  assert.ok(coincident.every(Number.isFinite));
  assert.throws(() => canvasConnectorPath(rectangle, { ...rectangle, width: NaN }), RangeError);
});

test('different-row folder/session connectors curve away from their boundary edges and reverse when nodes cross', () => {
  const session = { ...rectangle, x: 500, y: 280 };
  const points = pathPoints(canvasConnectorPath(rectangle, session));
  const [startX, startY, firstX, firstY, secondX, secondY, endX, endY] = points;
  assert.notEqual(startY, endY);
  near(firstY, startY);
  near(secondY, endY);
  assert.ok(firstX > startX, 'The curve leaves the folder through its right edge');
  assert.ok(secondX < endX, 'The curve approaches the session through its left edge');
  const chord = { x: endX - startX, y: endY - startY };
  assert.ok(Math.abs((firstX - startX) * chord.y - (firstY - startY) * chord.x) > 1,
    'The control point must leave the endpoint chord so the spline is visibly curved');
  const reverse = pathPoints(canvasConnectorPath(session, rectangle));
  nearPoint({ x: reverse[0], y: reverse[1] }, { x: endX, y: endY });
  nearPoint({ x: reverse[6], y: reverse[7] }, { x: startX, y: startY });
  assert.ok(reverse[2] < reverse[0], 'A folder moved to the right leaves through its left edge');
  assert.ok(reverse[4] > reverse[6], 'The target moved to the left is approached through its right edge');
});

test('zoom preserves the canvas point under the pointer through pan and bounds clamping', () => {
  const view = { x: -310, y: 140, scale: 1.25 };
  const point = { x: 380, y: 225 };
  const canvasPoint = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
  for (const scale of [0.001, 0.25, 0.8, 1.25, 2, 3, 1000]) {
    const next = zoomCanvasView(view, point, scale);
    assert.ok(next.scale >= 0.25 && next.scale <= 3);
    nearPoint({ x: canvasPoint.x * next.scale + next.x, y: canvasPoint.y * next.scale + next.y }, point);
  }
  assert.deepEqual(zoomCanvasView(view, point, view.scale), view);
  assert.equal(zoomCanvasView(view, point, -1).scale, 0.25);
  assert.throws(() => zoomCanvasView(view, point, NaN), RangeError);
  assert.throws(() => zoomCanvasView({ ...view, scale: 0 }, point, 1), RangeError);
  assert.throws(() => zoomCanvasView(view, { x: Infinity, y: 0 }, 1), RangeError);
});
