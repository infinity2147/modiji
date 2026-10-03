/**
 * Minimal PNG codec for the Node evaluation scripts (no image dependency in this package): decodes
 * 8-bit, non-interlaced grayscale/RGB/gray+alpha/RGBA PNGs — what Playwright screenshots and our
 * fixtures use — and encodes RGBA. The browser uses canvas instead.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { createRgba, type RgbaImage } from "../src/image";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Colour type → channels, for the supported 8-bit types. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(file: Uint8Array): RgbaImage {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      channels = CHANNELS[colour ?? -1] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0)
        throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colour}, interlace ${interlace}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (width === 0 || idat.length === 0) throw new Error("PNG has no IHDR/IDAT");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x] ?? 0;
      const left = x >= channels ? (pixels[dst + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[dst - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[dst - stride + x - channels] ?? 0) : 0;
      const predicted =
        filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : -1;
      if (predicted < 0) throw new Error(`bad PNG filter ${filter}`);
      pixels[dst + x] = (value + predicted) & 0xff;
    }
  }
  const image = createRgba(width, height);
  for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
    const o = i * 4;
    const [a, b, c, d] = [pixels[p] ?? 0, pixels[p + 1] ?? 0, pixels[p + 2] ?? 0, pixels[p + 3] ?? 0];
    if (channels === 1 || channels === 2) image.data.set([a, a, a, channels === 2 ? b : 255], o);
    else image.data.set([a, b, c, channels === 4 ? d : 255], o);
  }
  return image;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA PNG, filter "none" on every row (UI screenshots compress well without prediction). */
export function encodePng(image: RgbaImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y += 1) raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}
