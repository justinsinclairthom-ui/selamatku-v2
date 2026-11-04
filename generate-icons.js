/* Generate PWA icons as simple colored squares with shield emoji */
const fs = require('fs');
const path = require('path');

// Create a minimal valid PNG using raw pixel data
// We'll create solid color icons with a simple pattern

function createPNG(width, height, r, g, b) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 2;   // color type: RGB
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // Image data — fill with gradient
  const rawData = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 3)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      // Blue gradient from top-left to bottom-right
      const t = (x + y) / (width + height);
      rawData[offset]     = Math.round(r + (13 - r) * t);
      rawData[offset + 1] = Math.round(g + (71 - g) * t);
      rawData[offset + 2] = Math.round(b + (161 - b) * t);
    }
  }

  // Compress with zlib
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressed);

  // IEND
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf) {
  let table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const sizes = [192, 512];
const outDir = path.join(__dirname, 'icons');

sizes.forEach(size => {
  // Regular icon (blue gradient)
  const png = createPNG(size, size, 26, 115, 232);
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`Created icon-${size}.png (${size}x${size})`);

  // Maskable icon (same but with more padding — solid background)
  const maskable = createPNG(size, size, 13, 71, 161);
  fs.writeFileSync(path.join(outDir, `maskable-${size}.png`), maskable);
  console.log(`Created maskable-${size}.png (${size}x${size})`);
});

console.log('All icons generated!');
