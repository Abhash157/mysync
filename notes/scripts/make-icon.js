// Draws the MyNotes icon (a purple rounded square with a page and a ticked line) and writes
// build/icon.png and build/icon.ico. Pure Node: no image libraries needed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SIZE = 256;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Signed-distance helpers, anti-aliased with 1px smoothing.
const rrect = (x, y, x0, y0, x1, y1, r) => {
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r)), dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return Math.hypot(dx, dy) - r;
};
const seg = (x, y, ax, ay, bx, by) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - t * dx, py - t * dy);
};
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d));

const buf = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let [r, g, b] = [123, 108, 217];
    const shade = y / SIZE * 28;
    r -= shade; g -= shade; b -= shade * 0.5;
    let a = cover(rrect(x, y, 8, 8, 248, 248, 56));
    const page = cover(rrect(x, y, 68, 52, 188, 204, 14));
    r = r + (255 - r) * page; g = g + (255 - g) * page; b = b + (255 - b) * page;
    const line = (ax, ay, bx, by, w) => cover(seg(x, y, ax, ay, bx, by) - w);
    const ink = Math.max(line(112, 96, 168, 96, 5), line(88, 132, 92, 136, 0), line(100, 152, 168, 152, 5), line(100, 178, 150, 178, 5));
    const tick = Math.max(line(84, 130, 92, 138, 5), line(92, 138, 106, 120, 5));
    const k = Math.max(ink, tick) * page;
    r = r + (123 - r) * k; g = g + (108 - g) * k; b = b + (217 - b) * k;
    buf.set([r, g, b, Math.round(a * 255)], (y * SIZE + x) * 4);
  }
}

const data = png(SIZE, buf);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), data);
const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 0; head[7] = 0; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(data.length, 14); head.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([head, data]));
console.log('wrote build/icon.png and build/icon.ico');
