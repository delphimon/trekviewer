import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createCRC32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
}

const crcTable = createCRC32Table();
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writePNG(filePath: string, width: number, height: number, renderPixel: (x: number, y: number) => [number, number, number, number]): void {
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(height * rowSize);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = renderPixel(x, y);
      const pxOffset = rowOffset + 1 + x * 4;
      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(rawData);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const ihdrChunk = createChunk('IHDR', ihdrData);
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  const pngFile = Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
  fs.writeFileSync(filePath, pngFile);
}

function createChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcBuf = Buffer.alloc(4);
  const toCrc = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(toCrc), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function drawMountainIcon(size: number, outPath: string) {
  writePNG(outPath, size, size, (x, y) => {
    const nx = x / size;
    const ny = y / size;

    // Background gradient: dark navy #090d16 to slate #1e293b
    const bgR = Math.round(9 + (30 - 9) * ny);
    const bgG = Math.round(13 + (41 - 13) * ny);
    const bgB = Math.round(22 + (59 - 22) * ny);

    // Mountain 1 (Center Peak)
    const peakX = 0.5;
    const peakY = 0.22;
    const m1Slope = 1.4;
    const m1Dist = Math.abs(nx - peakX) * m1Slope;
    const inM1 = ny >= (peakY + m1Dist) && ny <= 0.85;

    // Mountain 2 (Left Ridge)
    const p2X = 0.28;
    const p2Y = 0.42;
    const m2Dist = Math.abs(nx - p2X) * 1.2;
    const inM2 = ny >= (p2Y + m2Dist) && ny <= 0.85;

    // Mountain 3 (Right Ridge)
    const p3X = 0.72;
    const p3Y = 0.38;
    const m3Dist = Math.abs(nx - p3X) * 1.3;
    const inM3 = ny >= (p3Y + m3Dist) && ny <= 0.85;

    // Trail curve (Glowing cyan line winding from summit to base)
    let trailDist = 999;
    for (let t = 0; t <= 1; t += 0.01) {
      const tx = 0.5 + 0.16 * Math.sin(t * 6.0) * (0.2 + 0.8 * t);
      const ty = 0.26 + 0.52 * t;
      const d = Math.hypot(nx - tx, ny - ty);
      if (d < trailDist) trailDist = d;
    }

    // Glow trail
    const trailWidth = 0.022;
    if (trailDist < trailWidth) {
      const intensity = 1 - (trailDist / trailWidth);
      return [
        Math.round(56 + (255 - 56) * intensity),
        Math.round(189 + (255 - 189) * intensity),
        255,
        255
      ];
    } else if (trailDist < trailWidth * 2.8) {
      const glow = 1 - (trailDist - trailWidth) / (trailWidth * 1.8);
      return [
        Math.round(bgR + 56 * glow * 0.7),
        Math.round(bgG + 189 * glow * 0.7),
        Math.round(bgB + 248 * glow * 0.7),
        255
      ];
    }

    if (inM1) {
      const isSun = nx < peakX;
      return isSun ? [226, 232, 240, 255] : [148, 163, 184, 255];
    }

    if (inM3) return [100, 116, 139, 255];
    if (inM2) return [148, 163, 184, 255];

    return [bgR, bgG, bgB, 255];
  });
}

console.log('Generating 192x192 icon...');
drawMountainIcon(192, path.resolve('public/icon-192.png'));
console.log('Generating 512x512 icon...');
drawMountainIcon(512, path.resolve('public/icon-512.png'));
console.log('✓ Icons generated successfully in public/');
