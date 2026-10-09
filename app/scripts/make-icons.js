// Draws the MySync logo (two chasing arrows on a rounded square) and tray status icons,
// then writes PNG and ICO files. Pure Node: no image libraries needed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'build');

// ---------------------------------------------------------------- PNG / ICO encoding

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// ---------------------------------------------------------------- drawing

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => a + (b - a) * t;

/** Signed-distance-style coverage tests, in a coordinate system where the icon spans [-1, 1]. */
function inRoundedSquare(x, y, half, radius) {
  const dx = Math.max(Math.abs(x) - (half - radius), 0);
  const dy = Math.max(Math.abs(y) - (half - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

function inTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const p = [px, py];
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const DEG = Math.PI / 180;
const RING = { center: 0.42, half: 0.075 };
const ARCS = [
  { from: 200 * DEG, to: 338 * DEG },
  { from: 20 * DEG, to: 158 * DEG },
];

function inGlyph(x, y) {
  const r = Math.hypot(x, y);
  let theta = Math.atan2(y, x);
  if (theta < 0) theta += 2 * Math.PI;

  if (Math.abs(r - RING.center) <= RING.half) {
    for (const arc of ARCS) if (theta >= arc.from && theta <= arc.to) return true;
  }
  for (const arc of ARCS) {
    const a = arc.to;
    const wing = RING.half * 2.1;
    const b1 = [(RING.center + wing) * Math.cos(a), (RING.center + wing) * Math.sin(a)];
    const b2 = [(RING.center - wing) * Math.cos(a), (RING.center - wing) * Math.sin(a)];
    const tip = [RING.center * Math.cos(a + 0.62), RING.center * Math.sin(a + 0.62)];
    if (inTriangle(x, y, b1, b2, tip)) return true;
  }
  return false;
}

/**
 * @param {number} size pixels
 * @param {{ dot?: string|null, glyphOnly?: boolean }} [options] dot: status colour drawn bottom-right
 */
function render(size, { dot = null } = {}) {
  const top = hex('#3b82f6');
  const bottom = hex('#0891b2');
  const SS = 4; // supersampling per axis
  const rgba = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / SS) / size) * 2 - 1;
          let color = null;
          if (inRoundedSquare(x, y, 0.96, 0.42)) {
            const t = (y + 1) / 2;
            color = [lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t)];
            if (inGlyph(x, y)) color = [255, 255, 255];
          }
          if (dot) {
            const d = Math.hypot(x - 0.52, y - 0.52);
            if (d <= 0.42) color = [255, 255, 255];
            if (d <= 0.3) color = hex(dot);
          }
          if (color) {
            r += color[0]; g += color[1]; b += color[2]; a += 1;
          }
        }
      }
      const i = (py * size + px) * 4;
      const n = SS * SS;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return encodePng(size, rgba);
}

// ---------------------------------------------------------------- outputs

fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'icon.png'), render(512));
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(icoSizes.map((size) => ({ size, png: render(size) }))));

const states = {
  idle: null,
  synced: '#22c55e',
  syncing: '#38bdf8',
  attention: '#f59e0b',
  paused: '#94a3b8',
};
for (const [name, dot] of Object.entries(states)) {
  fs.writeFileSync(path.join(outDir, `tray-${name}.png`), render(16, { dot }));
  fs.writeFileSync(path.join(outDir, `tray-${name}@1.5x.png`), render(24, { dot }));
  fs.writeFileSync(path.join(outDir, `tray-${name}@2x.png`), render(32, { dot }));
}
console.log(`icons written to ${outDir}`);
