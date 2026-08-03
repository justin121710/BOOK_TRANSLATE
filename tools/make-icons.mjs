/* 產生 PWA 圖示。零依賴：自己組 PNG（RGBA + zlib deflate）。
   `node tools/make-icons.mjs` 之後 icons/ 就會有檔案。 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(fileURLToPath(new URL('../icons', import.meta.url)));

const GOLD = [0xd9, 0xa4, 0x41];
const DARK = [0x1a, 0x16, 0x11];

function draw(size) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };

  const u = size / 100;                 // 以百分比為單位比較好調
  const roundRect = (x0, y0, w, h, r) => (x, y) => {
    if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return false;
    const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
    const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  // 底：金色滿版（maskable 需要滿版，內容留在中央 80% 內）
  const cover = roundRect(22 * u, 16 * u, 56 * u, 68 * u, 5 * u);   // 書封
  const spine = roundRect(22 * u, 16 * u, 7 * u, 68 * u, 3 * u);    // 書背

  // 書封上的四行字，長度遞減，暗示內文
  const lines = [
    roundRect(35 * u, 33 * u, 32 * u, 4.5 * u, 2.2 * u),
    roundRect(35 * u, 43 * u, 32 * u, 4.5 * u, 2.2 * u),
    roundRect(35 * u, 53 * u, 24 * u, 4.5 * u, 2.2 * u),
    roundRect(35 * u, 63 * u, 15 * u, 4.5 * u, 2.2 * u),
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = GOLD;
      if (cover(x, y)) c = DARK;
      if (spine(x, y)) c = GOLD;
      for (const l of lines) if (l(x, y)) { c = GOLD; break; }
      set(x, y, c);
    }
  }
  return px;
}

function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                       // filter type 0
    Buffer.from(rgba.buffer, y * size * 4, size * 4)
      .copy(raw, y * (size * 4 + 1) + 1);
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, draw(size)));
  console.log('寫入', file, fs.statSync(file).size, 'bytes');
}
