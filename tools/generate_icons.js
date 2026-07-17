const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const dir = path.join(__dirname, "..", "icons");
fs.mkdirSync(dir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePng(size) {
  const w = size;
  const h = size;
  const row = 1 + w * 3;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < w; x++) {
      const cx = x - w / 2;
      const cy = y - h / 2;
      const d = Math.hypot(cx, cy);
      let R = 26;
      let G = 115;
      let B = 232;
      if (d < size * 0.38) {
        R = 255;
        G = 255;
        B = 255;
      } else if (d < size * 0.45) {
        R = 21;
        G = 87;
        B = 176;
      }
      const i = y * row + 1 + x * 3;
      raw[i] = R;
      raw[i + 1] = G;
      raw[i + 2] = B;
    }
  }
  const comp = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", comp),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${s}.png`), makePng(s));
}
console.log("Icons written to", dir);
