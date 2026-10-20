import * as THREE from 'three';
import { latLonToTile } from '../gpx/Coordinates.ts';
import type { GeoBounds } from '../gpx/TrackTypes.ts';
import type { TileGridBounds } from './TextureProvider.ts';
import type { ImageryBatchRenderer } from './ImageryBatchRenderer.ts';

const LEVELS = 7, PAGES = 11;
export const MAX_TERRAIN_LOOKUP_BYTES = 16 * 1024 * 1024;
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
export class TerrainImageryMaterial {
  private readonly layout;
  private readonly lookup: THREE.DataTexture;
  private readonly placeholder: THREE.DataArrayTexture;
  private readonly cells = new Map<number, number>();
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

  public sync(bindings: ReturnType<ImageryBatchRenderer['getTextureBindings']>, surfaces: readonly THREE.Mesh[]): void {
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
    const write = (offset: number, value: number) => {
      pixels[offset] = value & 255; pixels[offset + 1] = value >> 8;
      this.lookup.addUpdateRange(offset, 4); changed = true;
    };
    for (const [offset] of this.cells) if (!wanted.has(offset)) write(offset, 0);
    for (const [offset, value] of wanted) if (this.cells.get(offset) !== value) write(offset, value);
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
      material.customProgramCacheKey = () => previous.cache.call(material) + '/terrain-imagery-v1';
      material.onBeforeCompile = (shader, renderer) => {
        previous.compile.call(material, shader, renderer);
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = 'varying vec2 vTerrainTileCoord; uniform vec4 terrainGrid;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvTerrainTileCoord = vec2(uv.x, 1.0 - uv.y) * terrainGrid.xy + terrainGrid.zw;');
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += 0.04;');
        shader.fragmentShader = this.fragmentPrefix() + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
          vec4 terrainTexel = vec4(1.0);
          #ifdef USE_MAP
            terrainTexel = texture2D(map, vMapUv);
          #endif
          vec2 terrainDx = dFdx(vTerrainTileCoord), terrainDy = dFdy(vTerrainTileCoord);
          for (int i = ${LEVELS - 1}; i >= 0; i--) {
            if (terrainEnabled[i] < 0.5) continue;
            vec2 p = vTerrainTileCoord * exp2(float(i)) - terrainLevels[i].xy;
            vec2 cell = floor(p);
            if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, terrainLevels[i].zw))) continue;
            vec4 entry = texelFetch(terrainLookup, ivec2(cell.x, terrainRows[i] + cell.y), 0);
            float id = floor(entry.r * 255.0 + 0.5) + floor(entry.g * 255.0 + 0.5) * 256.0 - 1.0;
            if (id < 0.0) continue;
            vec2 uvTile = vec2(fract(p.x), 1.0 - fract(p.y));
            terrainTexel = terrainRead(id, uvTile, terrainDx * exp2(float(i)), terrainDy * exp2(float(i)));
            terrainTilePresent = true; break;
          }
          diffuseColor *= terrainTexel;
        `);
        shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (terrainTilePresent) roughnessFactor = 0.9;');
        // Legacy imagery patches do not receive shadows; retain ordinary
        // terrain shadows where no streamed tile is available.
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>',
          THREE.ShaderChunk.lights_fragment_begin.replaceAll('&& receiveShadow', '&& receiveShadow && !terrainTilePresent'));
      };
      material.needsUpdate = true;
    }
  }

  private fragmentPrefix(): string {
    return `varying vec2 vTerrainTileCoord;
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

  public dispose(): void {
    for (const [material, previous] of this.materials) this.restore(material, previous);
    this.lookup.dispose(); this.placeholder.dispose(); this.cells.clear();
  }
}
