/**
 * Pure RGBA image helpers shared by the change detector, the privacy pass and the extraction
 * request builder. Isomorphic: no DOM, no node: imports. Pixels are row-major RGBA, 4 bytes each,
 * exactly as `CanvasRenderingContext2D.getImageData` returns them.
 */

export type RgbaImage = { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };

/** Axis-aligned rectangle in pixel coordinates (x, y inclusive; width/height ≥ 1 for a non-empty rect). */
export type Rect = { x: number; y: number; width: number; height: number };

export function createRgba(width: number, height: number): RgbaImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError(`image size must be positive integers, got ${width}×${height}`);
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function assertRgba(image: RgbaImage): void {
  if (image.data.length !== image.width * image.height * 4)
    throw new RangeError(`RGBA buffer has ${image.data.length} bytes, expected ${image.width}×${image.height}×4`);
}

export function cloneRgba(image: RgbaImage): RgbaImage {
  return { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
}

/** `rect` clipped to the image; null when nothing remains. Coordinates are rounded outwards to whole pixels. */
export function clampRect(rect: Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

export function padRect(rect: Rect, padding: number): Rect {
  return { x: rect.x - padding, y: rect.y - padding, width: rect.width + 2 * padding, height: rect.height + 2 * padding };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function cropRgba(image: RgbaImage, rect: Rect): RgbaImage {
  const r = clampRect(rect, image.width, image.height);
  if (r === null) throw new RangeError("crop rectangle lies outside the image");
  const out = createRgba(r.width, r.height);
  for (let row = 0; row < r.height; row += 1) {
    const start = ((r.y + row) * image.width + r.x) * 4;
    out.data.set(image.data.subarray(start, start + r.width * 4), row * r.width * 4);
  }
  return out;
}

/** Size that fits within `maxLongEdge` keeping the aspect ratio; never upscales. */
export function fitLongEdge(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Area-average downscale (box filter over each target pixel's source footprint, with fractional
 * edge weights). Used for the ≤1568 px upload; upscaling is refused because it only adds bytes.
 */
export function resizeRgba(image: RgbaImage, width: number, height: number): RgbaImage {
  assertRgba(image);
  if (width > image.width || height > image.height) throw new RangeError("resizeRgba only downscales");
  if (width === image.width && height === image.height) return cloneRgba(image);
  const out = createRgba(width, height);
  const sx = image.width / width;
  const sy = image.height / height;
  const acc = new Float64Array(4);
  for (let ty = 0; ty < height; ty += 1) {
    const y0 = ty * sy;
    const y1 = y0 + sy;
    for (let tx = 0; tx < width; tx += 1) {
      const x0 = tx * sx;
      const x1 = x0 + sx;
      acc.fill(0);
      let total = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
          const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const i = (y * image.width + x) * 4;
          acc[0] = (acc[0] ?? 0) + (image.data[i] ?? 0) * w;
          acc[1] = (acc[1] ?? 0) + (image.data[i + 1] ?? 0) * w;
          acc[2] = (acc[2] ?? 0) + (image.data[i + 2] ?? 0) * w;
          acc[3] = (acc[3] ?? 0) + (image.data[i + 3] ?? 0) * w;
          total += w;
        }
      }
      const o = (ty * width + tx) * 4;
      for (let c = 0; c < 4; c += 1) out.data[o + c] = Math.round((acc[c] ?? 0) / total);
    }
  }
  return out;
}

/** Standard-tier vision limit (Haiku 4.5, api-notes §10): larger images are downscaled server-side anyway. */
export const MAX_UPLOAD_LONG_EDGE = 1568;

/** Below this share of the frame area, the changed region is also sent as a native-resolution crop. */
export const CROP_MAX_AREA_SHARE = 0.5;

export type UploadImages = {
  /** Full frame, downscaled so its long edge is ≤ `maxLongEdge`. */
  frame: RgbaImage;
  /** Changed region at native resolution (itself capped at `maxLongEdge`), with its rect in source-frame pixels. */
  crop: { image: RgbaImage; rect: Rect } | null;
};

/**
 * What a frame upload carries (plan §7.1): the downscaled full frame plus, when the change is local
 * (bbox under half the frame), a high-resolution crop of it so small text stays legible.
 */
export function prepareUpload(image: RgbaImage, bbox: Rect | null, maxLongEdge = MAX_UPLOAD_LONG_EDGE): UploadImages {
  const size = fitLongEdge(image.width, image.height, maxLongEdge);
  const frame = resizeRgba(image, size.width, size.height);
  const rect = bbox === null ? null : clampRect(bbox, image.width, image.height);
  if (rect === null || rect.width * rect.height >= CROP_MAX_AREA_SHARE * image.width * image.height) return { frame, crop: null };
  const native = cropRgba(image, rect);
  const cropSize = fitLongEdge(native.width, native.height, maxLongEdge);
  return { frame, crop: { image: resizeRgba(native, cropSize.width, cropSize.height), rect } };
}
