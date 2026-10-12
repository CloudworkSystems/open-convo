import assert from 'node:assert/strict';
import test from 'node:test';
import { avatarCropGeometry, INITIAL_AVATAR_CROP, panAvatarCrop } from '../../src/features/avatar-crop';

test('avatar crops stay inside portrait and landscape photos at every permitted edge and zoom', () => {
  for (const [width, height] of [[600, 300], [300, 600], [256, 256]]) {
    for (const zoom of [1, 2, 4]) {
      for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
        const crop = avatarCropGeometry(width, height, { zoom, x, y });
        assert.ok(crop.x >= 0 && crop.y >= 0);
        assert.ok(crop.x + crop.size <= width && crop.y + crop.size <= height);
        assert.equal(crop.size, Math.min(width, height) / zoom);
      }
    }
  }
  assert.deepEqual(avatarCropGeometry(600, 300, INITIAL_AVATAR_CROP), { x: 150, y: 0, size: 300, zoom: 1 });
});

test('pointer panning clamps at image bounds and never exposes empty frame pixels', () => {
  const initial = { zoom: 2, x: 0, y: 0 };
  assert.deepEqual(panAvatarCrop(600, 300, 220, initial, 10_000, -10_000), { zoom: 2, x: 1, y: -1 });
  assert.deepEqual(panAvatarCrop(300, 300, 220, INITIAL_AVATAR_CROP, 100, 100), INITIAL_AVATAR_CROP);
  const shifted = panAvatarCrop(600, 300, 220, initial, 25, 25);
  assert.ok(shifted.x > 0 && shifted.x < 1);
  assert.ok(shifted.y > 0 && shifted.y < 1);
  const geometry = avatarCropGeometry(600, 300, shifted);
  assert.ok(geometry.x < 225 && geometry.y < 75, 'Moving the image right/down chooses pixels farther left/up.');
});

test('invalid dimensions fail before cropping and excessive controls clamp to the supported range', () => {
  for (const [width, height] of [[0, 300], [300, 0], [NaN, 300], [Infinity, 300]]) {
    assert.throws(() => avatarCropGeometry(width, height, INITIAL_AVATAR_CROP));
  }
  assert.throws(() => avatarCropGeometry(300, 300, { zoom: NaN, x: 0, y: 0 }));
  assert.deepEqual(avatarCropGeometry(300, 300, { zoom: 10, x: 20, y: -20 }), { x: 0, y: 225, size: 75, zoom: 4 });
});
