// Draws the app icon (three book spines on a shelf) as PNGs, with no dependencies.
// iPhone home-screen icons must be PNG, so the SVG alone isn't enough.
// Run: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const PAPER = [246, 241, 231], OX = [138, 59, 46], GREEN = [63, 107, 75], GOLD = [196, 138, 26], SHELF = [95, 86, 74];

// Shapes on a 100×100 canvas: [x, y, w, h, colour]
const SHAPES = [
  [22, 24, 15, 54, OX],
  [39, 16, 15, 62, GREEN],
  [56, 28, 12, 50, GOLD],
  [16, 78, 68, 6, SHELF],
  [22, 34, 15, 3, PAPER], [22, 66, 15, 3, PAPER],
  [39, 26, 15, 3, PAPER], [39, 66, 15, 3, PAPER],
];

function draw(size, pad = 0) {
  const px = Buffer.alloc(size * size * 4);
  const s = (size * (1 - 2 * pad)) / 100, o = size * pad;
  const SS = 4; // supersample for smooth edges
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS - o) / s, v = (y + (sy + 0.5) / SS - o) / s;
      let c = PAPER;
      for (const [rx, ry, rw, rh, col] of SHAPES) {
        // the gold book leans
        let uu = u, vv = v;
        if (col === GOLD) { const a = -0.2, cx = 62, cy = 78; const dx = u - cx, dy = v - cy; uu = cx + dx * Math.cos(a) - dy * Math.sin(a); vv = cy + dx * Math.sin(a) + dy * Math.cos(a); }
        if (uu >= rx && uu < rx + rw && vv >= ry && vv < ry + rh) c = col;
      }
      acc = acc.map((t, i) => t + c[i]);
    }
    const i = (y * size + x) * 4;
    px[i] = acc[0] / SS ** 2; px[i + 1] = acc[1] / SS ** 2; px[i + 2] = acc[2] / SS ** 2; px[i + 3] = 255;
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c;
}

mkdirSync('icons', { recursive: true });
writeFileSync('icons/apple-touch-icon.png', draw(180, 0.06));
writeFileSync('icons/icon-192.png', draw(192, 0.06));
writeFileSync('icons/icon-512.png', draw(512, 0.12)); // extra padding: also the maskable icon
writeFileSync('icons/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="rgb(${PAPER})"/>${SHAPES.map(([x, y, w, h, c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgb(${c})"${c === GOLD ? ' transform="rotate(-11.5 62 78)"' : ''}/>`).join('')}</svg>\n`);
console.log('icons written');
