import { validateAvatarImage } from '../adapters/browser-identity';

export const AVATAR_INPUT_MAX_BYTES = 10 * 1024 * 1024;
export const AVATAR_OUTPUT_SIZE = 256;
export interface AvatarCrop { zoom: number; x: number; y: number }
export const INITIAL_AVATAR_CROP: AvatarCrop = { zoom: 1, x: 0, y: 0 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** x/y describe the image's offset within the available overflow, from -1 to 1. */
export function avatarCropGeometry(width: number, height: number, crop: AvatarCrop) {
  if (![width, height, crop.zoom, crop.x, crop.y].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('The image dimensions could not be read.');
  }
  const zoom = clamp(crop.zoom, 1, 4);
  const size = Math.min(width, height) / zoom;
  return {
    x: (width - size) / 2 * (1 - clamp(crop.x, -1, 1)),
    y: (height - size) / 2 * (1 - clamp(crop.y, -1, 1)),
    size,
    zoom,
  };
}

export function panAvatarCrop(width: number, height: number, viewport: number, crop: AvatarCrop, dx: number, dy: number): AvatarCrop {
  const geometry = avatarCropGeometry(width, height, crop);
  const scale = viewport / geometry.size;
  const excessX = width * scale - viewport;
  const excessY = height * scale - viewport;
  return {
    zoom: geometry.zoom,
    x: excessX > 0 ? clamp(crop.x + 2 * dx / excessX, -1, 1) : 0,
    y: excessY > 0 ? clamp(crop.y + 2 * dy / excessY, -1, 1) : 0,
  };
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The image could not be read.'));
    reader.readAsDataURL(file);
  });
}

/** The selected file stays in the browser; no request or upload is made. */
export async function readAvatarImage(file: File): Promise<HTMLImageElement> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > AVATAR_INPUT_MAX_BYTES || file.size === 0) {
    throw new Error('Choose a PNG, JPEG or WebP photo up to 10 MB.');
  }
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = (offset: number, signature: readonly number[]) => signature.every((byte, index) => bytes[offset + index] === byte);
  const valid = file.type === 'image/png' ? matches(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : file.type === 'image/jpeg' ? matches(0, [0xff, 0xd8, 0xff])
      : matches(0, [0x52, 0x49, 0x46, 0x46]) && matches(8, [0x57, 0x45, 0x42, 0x50]);
  if (!valid) throw new Error('Choose a readable PNG, JPEG or WebP photo.');
  const image = new Image();
  image.src = await readDataUrl(file);
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192
    || image.naturalWidth * image.naturalHeight > 32_000_000) {
    throw new Error('Choose a photo no larger than 8192 pixels on each side and 32 megapixels.');
  }
  return image;
}

/** Saves a bounded square crop; round frames supply the circular presentation. */
export function renderAvatarCrop(image: HTMLImageElement, crop: AvatarCrop): string {
  const geometry = avatarCropGeometry(image.naturalWidth, image.naturalHeight, crop);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_OUTPUT_SIZE;
  canvas.height = AVATAR_OUTPUT_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Photo cropping is unavailable in this browser.');
  context.drawImage(image, geometry.x, geometry.y, geometry.size, geometry.size, 0, 0, canvas.width, canvas.height);
  const result = canvas.toDataURL('image/png');
  const problem = validateAvatarImage(result);
  if (problem) throw new Error(problem);
  return result;
}
