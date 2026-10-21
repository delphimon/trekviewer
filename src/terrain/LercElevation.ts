import * as Lerc from 'lerc';
import wasmUrl from 'lerc/lerc-wasm.wasm?url';

export interface RasterSampleWindow { minX: number; maxX: number; minY: number; maxY: number }
export interface LercElevationInput { buffer: ArrayBuffer; width: number; height: number; requiredWindow?: RasterSampleWindow }
export interface DecodedElevation { data: Float32Array; min: number; max: number; validCount: number; requiredValidCount?: number }

/** Lossless floating-point samples, decoded in the shared terrain worker. */
export async function decodeLercElevation(input: LercElevationInput): Promise<DecodedElevation> {
  const { buffer, width, height, requiredWindow } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
    || width * height > 2048 * 2048 || buffer.byteLength > 32 * 1024 * 1024) {
    throw new RangeError('Elevation response exceeds the raster budget.');
  }
  if (requiredWindow && ([requiredWindow.minX, requiredWindow.maxX, requiredWindow.minY, requiredWindow.maxY].some(value => !Number.isInteger(value))
    || requiredWindow.minX < 0 || requiredWindow.minY < 0 || requiredWindow.maxX >= width || requiredWindow.maxY >= height
    || requiredWindow.minX > requiredWindow.maxX || requiredWindow.minY > requiredWindow.maxY)) {
    throw new RangeError('Invalid required elevation sample window.');
  }
  await Lerc.load({ locateFile: () => wasmUrl });
  const header = Lerc.getBlobInfo(buffer);
  if (header.width !== width || header.height !== height || header.bandCount !== 1 || header.depthCount !== 1) {
    throw new RangeError('Unexpected elevation raster dimensions or bands.');
  }
  const decoded = Lerc.decode(buffer);
  const data = new Float32Array(width * height);
  let min = Infinity, max = -Infinity, validCount = 0;
  let requiredValidCount = requiredWindow
    ? (requiredWindow.maxX - requiredWindow.minX + 1) * (requiredWindow.maxY - requiredWindow.minY + 1) : undefined;
  for (let i = 0; i < data.length; i++) {
    const value = decoded.pixels[0][i];
    if ((!decoded.mask || decoded.mask[i]) && Number.isFinite(value) && value >= -1000 && value <= 9000) {
      data[i] = value; min = Math.min(min, value); max = Math.max(max, value); validCount++;
    } else {
      data[i] = NaN;
      if (requiredWindow) {
        const row = Math.floor(i / width), column = i % width;
        if (column >= requiredWindow.minX && column <= requiredWindow.maxX
          && row >= requiredWindow.minY && row <= requiredWindow.maxY) requiredValidCount = requiredValidCount! - 1;
      }
    }
  }
  return { data, min, max, validCount, ...(requiredWindow ? { requiredValidCount } : {}) };
}
