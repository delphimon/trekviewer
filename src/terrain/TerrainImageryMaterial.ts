import * as THREE from 'three';
import { latLonToTile } from '../gpx/Coordinates.ts';
import type { GeoBounds } from '../gpx/TrackTypes.ts';
import type { TileGridBounds } from './TextureProvider.ts';
import type { ImageryBatchRenderer } from './ImageryBatchRenderer.ts';

const LEVELS = 7, PAGES = 11;
export const MAX_TERRAIN_LOOKUP_BYTES = 16 * 1024 * 1024;
/** A newly uploaded tile fades in over the coarser imagery beneath it instead of popping. */
export const TERRAIN_TILE_FADE_MS = 250;
interface Level { minX: number; minY: number; width: number; height: number; row: number }

/** A dense, bounded page table; source XYZ coordinates remain independent of mesh subdivision. */
export function terrainLookupLayout(bounds: GeoBounds) {
  const origin = latLonToTile(bounds.centerLat, bounds.centerLon, 13);
  let rows = 0, width = 1;
  const levels: Level[] = [];
  for (let z = 13; z <= 19; z++) {
    const nw = latLonToTile(bounds.maxLat, bounds.minLon, z), se = latLonToTile(bounds.minLat, bounds.maxLon, z);
    const level = { minX: nw.x - 1, minY: nw.y - 1, width: se.x - nw.x + 3, height: se.y - nw.y + 3, row: rows };
    if (level.width < 1 || level.height < 1) throw new RangeError('Unsupported imagery footprint');
    levels.push(level); rows += level.height; width = Math.max(width, level.width);
  }
  if (width * rows * 4 > MAX_TERRAIN_LOOKUP_BYTES) throw new RangeError('Terrain imagery lookup exceeds budget');
  return { origin, levels, width, height: rows };
}

/** Sample streamed imagery on the authoritative terrain, without overlay geometry. */
/** Avalanche-style slope bands (degrees, lower bound inclusive) and their linear-RGB tints. */
export const SLOPE_BANDS: readonly { min: number; label: string; css: string; linear: readonly [number, number, number] }[] = [
  { min: 27, label: '27-30°', css: '#facc15', linear: [0.955, 0.604, 0.008] },
  { min: 30, label: '30-35°', css: '#f97316', linear: [0.939, 0.216, 0.008] },
  { min: 35, label: '35-45°', css: '#ef4444', linear: [0.871, 0.054, 0.054] },
  { min: 45, label: '45°+', css: '#a855f7', linear: [0.392, 0.074, 0.913] },
];

/** True slope (degrees) from a model-space normal of a surface exaggerated vertically by `exaggeration`. */
export function trueSlopeDegrees(normal: { x: number; y: number; z: number }, exaggeration: number): number {
  return Math.atan2(Math.hypot(normal.x, normal.z), Math.max(normal.y, 1e-4) * exaggeration) * 180 / Math.PI;
}

/** Band for a slope angle, or null below 27 degrees (no tint). */
export function slopeBand(angleDegrees: number) {
  let band: (typeof SLOPE_BANDS)[number] | null = null;
  for (const b of SLOPE_BANDS) if (angleDegrees >= b.min) band = b;
  return band;
}

function slopeTintGlsl(): string {
  const f = (n: number) => n.toFixed(3);
  return [...SLOPE_BANDS].reverse().reduce((rest, b) =>
    `(terrainAngle >= ${f(b.min)} ? vec4(${b.linear.map(f).join(', ')}, 1.0) : ${rest})`, 'vec4(0.0)');
}

export class TerrainImageryMaterial {
  private readonly layout;
  private readonly lookup: THREE.DataTexture;
  private readonly placeholder: THREE.DataArrayTexture;
  private readonly cells = new Map<number, number>();
  /** Lookup offset -> fade start (ms) for tiles still fading in; alpha lives in the B channel. */
  private readonly fading = new Map<number, number>();
  private readonly materials = new Map<THREE.MeshStandardMaterial, {
    compile: THREE.Material['onBeforeCompile']; cache: THREE.Material['customProgramCacheKey'];
  }>();
  private readonly uniforms: Record<string, { value: unknown }>;

  public static supported(renderer: THREE.WebGLRenderer): boolean {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    return typeof gl.texImage3D === 'function' && renderer.capabilities.maxTextures >= 16
      && gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) >= 32;
  }

  constructor(bounds: GeoBounds, grid: TileGridBounds, maxDimension = Infinity) {
    this.layout = terrainLookupLayout(bounds);
    const { width, height, levels, origin } = this.layout;
    if (width > maxDimension || height > maxDimension) throw new RangeError('Terrain imagery lookup exceeds device limits');
    this.lookup = new THREE.DataTexture(new Uint8Array(width * height * 4), width, height);
    this.lookup.minFilter = this.lookup.magFilter = THREE.NearestFilter; this.lookup.needsUpdate = true;
    this.placeholder = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1); this.placeholder.needsUpdate = true;
    const scale = 2 ** (13 - grid.zoom);
    this.uniforms = {
      terrainSlope: { value: 0 },
      terrainExaggeration: { value: 1 },
      terrainLookup: { value: this.lookup },
      terrainLevels: { value: levels.map((l, i) => new THREE.Vector4(l.minX - origin.x * 2 ** i, l.minY - origin.y * 2 ** i, l.width, l.height)) },
      terrainRows: { value: levels.map(l => l.row) },
      terrainEnabled: { value: Array(LEVELS).fill(0) },
      terrainGrid: { value: new THREE.Vector4(grid.numTilesX * scale, grid.numTilesY * scale,
        grid.tileXMin * scale - origin.x, grid.tileYMin * scale - origin.y) },
    };
    for (let i = 0; i < PAGES; i++) this.uniforms['terrainPage' + i] = { value: this.placeholder };
  }

  public get lookupBytes(): number { return this.layout.width * this.layout.height * 4; }

  public sync(bindings: ReturnType<ImageryBatchRenderer['getTextureBindings']>, surfaces: readonly THREE.Mesh[], now = performance.now()): void {
    for (let i = 0; i < PAGES; i++) this.uniforms['terrainPage' + i].value = bindings.pages[i] ?? this.placeholder;
    const wanted = new Map<number, number>();
    const enabled = this.uniforms.terrainEnabled.value as number[]; enabled.fill(0);
    for (const { patch, page, layer } of bindings.entries) {
      if (!patch.mesh.visible || patch.zoom < 13 || patch.zoom > 19) continue;
      const l = this.layout.levels[patch.zoom - 13], x = patch.x - l.minX, y = patch.y - l.minY;
      if (x < 0 || x >= l.width || y < 0 || y >= l.height) continue;
      wanted.set(((l.row + y) * this.layout.width + x) * 4, page * 32 + layer + 1);
      enabled[patch.zoom - 13] = 1;
    }
    const pixels = this.lookup.image.data as Uint8Array;
    let changed = false;
    const write = (offset: number, value: number, alpha: number) => {
      pixels[offset] = value & 255; pixels[offset + 1] = value >> 8; pixels[offset + 2] = alpha;
      this.lookup.addUpdateRange(offset, 4); changed = true;
    };
    for (const [offset] of this.cells) if (!wanted.has(offset)) { write(offset, 0, 0); this.fading.delete(offset); }
    for (const [offset, value] of wanted) {
      const previous = this.cells.get(offset);
      if (previous === value) continue;
      // An offset is one source tile (zoom/x/y), so a changed value is the same imagery moved
      // to another array layer: keep its current weight. Only a new tile fades in.
      if (previous === undefined) { write(offset, value, 0); this.fading.set(offset, now); }
      else write(offset, value, pixels[offset + 2]);
    }
    this.cells.clear(); for (const [offset, value] of wanted) this.cells.set(offset, value);
    if (changed) this.lookup.needsUpdate = true;
    const present = new Set(surfaces.map(mesh => mesh.material));
    for (const [material, previous] of this.materials) if (!present.has(material)) this.restore(material, previous);
    for (const mesh of surfaces) {
      const material = mesh.material;
      if (!(material instanceof THREE.MeshStandardMaterial) || this.materials.has(material)) continue;
      const previous = { compile: material.onBeforeCompile, cache: material.customProgramCacheKey };
      // Three caches one uniform set per material across program variants.
      // A hook adding sampler types must discard the old program association,
      // rather than reusing a legacy uniform list with the terrain program.
      material.dispose();
      this.materials.set(material, previous);
      material.customProgramCacheKey = () => previous.cache.call(material) + '/terrain-imagery-v3';
      material.onBeforeCompile = (shader, renderer) => {
        previous.compile.call(material, shader, renderer);
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = 'varying vec2 vTerrainTileCoord; varying vec3 vTerrainObjectNormal; uniform vec4 terrainGrid;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvTerrainTileCoord = vec2(uv.x, 1.0 - uv.y) * terrainGrid.xy + terrainGrid.zw;\nvTerrainObjectNormal = normal;');
        shader.fragmentShader = this.fragmentPrefix() + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
          vec4 terrainTexel = vec4(1.0);
          #ifdef USE_MAP
            terrainTexel = texture2D(map, vMapUv);
          #endif
          vec2 terrainDx = dFdx(vTerrainTileCoord), terrainDy = dFdy(vTerrainTileCoord);
          // Finest first; a tile still fading in (weight < 1) lets coarser levels, and finally
          // the base texture, show through in proportion.
          vec4 terrainAccum = vec4(0.0); float terrainRemaining = 1.0;
          for (int i = ${LEVELS - 1}; i >= 0; i--) {
            if (terrainEnabled[i] < 0.5) continue;
            vec2 p = vTerrainTileCoord * exp2(float(i)) - terrainLevels[i].xy;
            vec2 cell = floor(p);
            if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, terrainLevels[i].zw))) continue;
            vec4 entry = texelFetch(terrainLookup, ivec2(cell.x, terrainRows[i] + cell.y), 0);
            float id = floor(entry.r * 255.0 + 0.5) + floor(entry.g * 255.0 + 0.5) * 256.0 - 1.0;
            if (id < 0.0 || entry.b <= 0.0) continue;
            vec2 uvTile = vec2(fract(p.x), 1.0 - fract(p.y));
            terrainAccum += terrainRead(id, uvTile, terrainDx * exp2(float(i)), terrainDy * exp2(float(i))) * (terrainRemaining * entry.b);
            terrainRemaining *= 1.0 - entry.b;
            terrainTilePresent = true;
            if (terrainRemaining < 0.004) break;
          }
          terrainTexel = terrainAccum + terrainTexel * terrainRemaining;
          diffuseColor *= terrainTexel;
          if (terrainSlope > 0.5) {
            // Model-space normal of the exaggerated surface; divide the exaggeration back out.
            vec3 terrainN = normalize(vTerrainObjectNormal);
            float terrainAngle = degrees(atan(length(terrainN.xz), max(terrainN.y, 1e-4) * terrainExaggeration));
            vec4 terrainTint = ${slopeTintGlsl()};
            diffuseColor.rgb = mix(diffuseColor.rgb, terrainTint.rgb, terrainTint.a * 0.5);
          }
        `);
        shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (terrainTilePresent) roughnessFactor = 0.9;');
      };
      material.needsUpdate = true;
    }
  }

  /** Advance tile fade-ins; call once per frame. Allocation-free and a no-op when idle. */
  public tickFade(now: number): void {
    if (this.fading.size === 0) return;
    const pixels = this.lookup.image.data as Uint8Array;
    for (const [offset, start] of this.fading) {
      const t = Math.min(1, Math.max(0, (now - start) / TERRAIN_TILE_FADE_MS));
      const alpha = Math.round(t * t * (3 - 2 * t) * 255);
      if (pixels[offset + 2] !== alpha) { pixels[offset + 2] = alpha; this.lookup.addUpdateRange(offset, 4); }
      if (t >= 1) this.fading.delete(offset);
    }
    this.lookup.needsUpdate = true;
  }

  /** Fade weight (0-1) of a source tile in the lookup, or null when it is not drawn. */
  public tileWeight(zoom: number, x: number, y: number): number | null {
    const l = this.layout.levels[zoom - 13];
    if (!l || x < l.minX || y < l.minY || x >= l.minX + l.width || y >= l.minY + l.height) return null;
    const offset = ((l.row + y - l.minY) * this.layout.width + x - l.minX) * 4;
    return this.cells.has(offset) ? (this.lookup.image.data as Uint8Array)[offset + 2] / 255 : null;
  }

  private fragmentPrefix(): string {
    return `varying vec2 vTerrainTileCoord; varying vec3 vTerrainObjectNormal;
      uniform float terrainSlope, terrainExaggeration;
      uniform sampler2D terrainLookup;
      uniform vec4 terrainLevels[${LEVELS}]; uniform float terrainRows[${LEVELS}], terrainEnabled[${LEVELS}];
      bool terrainTilePresent = false;
      ${Array.from({ length: PAGES }, (_, i) => `uniform highp sampler2DArray terrainPage${i};`).join('\n')}
      vec4 terrainRead(float id, vec2 uvTile, vec2 dx, vec2 dy) {
        float page = floor(id / 32.0); float layer = mod(id, 32.0);
        dx.y = -dx.y; dy.y = -dy.y;
        ${Array.from({ length: PAGES - 1 }, (_, i) => `if (page < ${i + 0.5}) return textureGrad(terrainPage${i}, vec3(uvTile, layer), dx, dy);`).join('\n')}
        return textureGrad(terrainPage${PAGES - 1}, vec3(uvTile, layer), dx, dy);
      }\n`;
  }

  private restore(material: THREE.MeshStandardMaterial, previous: { compile: THREE.Material['onBeforeCompile']; cache: THREE.Material['customProgramCacheKey'] }): void {
    material.dispose();
    material.onBeforeCompile = previous.compile; material.customProgramCacheKey = previous.cache;
    material.needsUpdate = true; this.materials.delete(material);
  }

  /** Slope-angle tint over the imagery; `exaggeration` is the current vertical exaggeration. */
  public setSlopeShading(enabled: boolean, exaggeration: number): void {
    this.uniforms.terrainSlope.value = enabled ? 1 : 0;
    this.uniforms.terrainExaggeration.value = Math.max(exaggeration, 1e-3);
  }

  public dispose(): void {
    for (const [material, previous] of this.materials) this.restore(material, previous);
    this.lookup.dispose(); this.placeholder.dispose(); this.cells.clear(); this.fading.clear();
  }
}
