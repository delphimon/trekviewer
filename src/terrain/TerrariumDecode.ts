export interface TerrariumDecodeInput {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  validity: Uint8Array;
}

/** Decode exactly the original DEM samples; failed/black tiles remain invalid. */
export function decodeTerrarium(input: TerrariumDecodeInput): { data: Float32Array; min: number; max: number } {
  const { width, height, pixels, validity } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width * height > 64 * 256 * 256 || pixels.length !== width * height * 4
    || width % 256 !== 0 || height % 256 !== 0 || validity.length !== width * height / (256 * 256)) {
    throw new RangeError('Invalid or oversized Terrarium pixel buffer.');
  }
  const data = new Float32Array(width * height);
  const tilesX = width / 256;
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const value = pixels[i * 4] * 256 + pixels[i * 4 + 1] + pixels[i * 4 + 2] / 256 - 32768;
      if (!validity[Math.floor(y / 256) * tilesX + Math.floor(x / 256)] || value < -1000) {
        data[i] = NaN;
      } else {
        data[i] = value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }
  return { data, min, max };
}
