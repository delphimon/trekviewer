import { expect, it } from 'vitest';
import * as THREE from 'three';
import { terrainLookupLayout, TerrainImageryMaterial, MAX_TERRAIN_LOOKUP_BYTES } from '../src/terrain/TerrainImageryMaterial.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

const bounds: GeoBounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7,
  centerLat: 46.85, centerLon: -121.75, minEle: 0, maxEle: 4000, elevationSpan: 4000, widthMeters: 8000, depthMeters: 11000 };

it('bounds dense lookup storage and maps the same tile into every zoom level', () => {
  const layout = terrainLookupLayout(bounds);
  expect(layout.width * layout.height * 4).toBeLessThanOrEqual(MAX_TERRAIN_LOOKUP_BYTES);
  for (let i = 0; i < 7; i++) {
    const tile = latLonToTile(bounds.centerLat, bounds.centerLon, 13 + i), level = layout.levels[i];
    expect(tile.x - level.minX).toBeGreaterThanOrEqual(0); expect(tile.x - level.minX).toBeLessThan(level.width);
    expect(tile.y - level.minY).toBeGreaterThanOrEqual(0); expect(tile.y - level.minY).toBeLessThan(level.height);
  }
  expect(() => terrainLookupLayout({ ...bounds, minLon: -170, maxLon: 170 })).toThrow('budget');
});

it('updates page-table visibility without modifying source terrain and restores shader ownership', () => {
  const tile = latLonToTile(bounds.centerLat, bounds.centerLon, 13);
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const original = material.onBeforeCompile, cache = material.customProgramCacheKey;
  let releases = 0; material.addEventListener('dispose', () => releases++);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), material), geometry = mesh.geometry;
  const renderer = new TerrainImageryMaterial(bounds, { zoom: 13, tileXMin: tile.x - 2, tileXMax: tile.x + 2,
    tileYMin: tile.y - 2, tileYMax: tile.y + 2, numTilesX: 5, numTilesY: 5 });
  const patch: any = { mesh: new THREE.Mesh(), zoom: 13, x: tile.x, y: tile.y };
  const bindings: any = { pages: [new THREE.DataArrayTexture()], entries: [{ patch, page: 0, layer: 3 }] };
  renderer.sync(bindings, [mesh]);
  expect(releases).toBe(1); expect(mesh.geometry).toBe(geometry); expect(material.onBeforeCompile).not.toBe(original);
  const data = (renderer as any).lookup.image.data as Uint8Array;
  expect(Array.from(data).filter(v => v !== 0)).toEqual([4]);
  patch.mesh.visible = false; renderer.sync(bindings, [mesh]);
  expect(data.every(v => v === 0)).toBe(true);
  renderer.dispose(); expect(releases).toBe(2); expect(material.onBeforeCompile).toBe(original);
  expect(material.customProgramCacheKey).toBe(cache); geometry.dispose(); material.dispose(); material.map!.dispose();
  bindings.pages[0].dispose();
});

it('fades a newly uploaded tile in over 250 ms and keeps the weight when it only moves layer', () => {
  const tile = latLonToTile(bounds.centerLat, bounds.centerLon, 15);
  const renderer = new TerrainImageryMaterial(bounds, { zoom: 13, tileXMin: tile.x - 8, tileXMax: tile.x + 8,
    tileYMin: tile.y - 8, tileYMax: tile.y + 8, numTilesX: 17, numTilesY: 17 });
  const patch: any = { mesh: new THREE.Mesh(), zoom: 15, x: tile.x, y: tile.y };
  const bindings: any = { pages: [], entries: [{ patch, page: 0, layer: 1 }] };
  expect(renderer.tileWeight(15, tile.x, tile.y)).toBeNull();
  renderer.sync(bindings, [], 1000);
  expect(renderer.tileWeight(15, tile.x, tile.y)).toBe(0);
  renderer.tickFade(1125);
  expect(renderer.tileWeight(15, tile.x, tile.y)).toBeCloseTo(0.5, 1);
  renderer.tickFade(1250);
  expect(renderer.tileWeight(15, tile.x, tile.y)).toBe(1);
  bindings.entries[0].layer = 7; renderer.sync(bindings, [], 2000); // same tile, new array layer
  expect(renderer.tileWeight(15, tile.x, tile.y)).toBe(1);
  patch.mesh.visible = false; renderer.sync(bindings, [], 3000);
  expect(renderer.tileWeight(15, tile.x, tile.y)).toBeNull();
  patch.mesh.visible = true; renderer.sync(bindings, [], 4000); // back again: fades in again
  expect(renderer.tileWeight(15, tile.x, tile.y)).toBe(0);
  renderer.dispose();
});

it('blends fading tiles over coarser imagery in the shader', () => {
  const tile = latLonToTile(bounds.centerLat, bounds.centerLon, 13);
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  const renderer = new TerrainImageryMaterial(bounds, { zoom: 13, tileXMin: tile.x, tileXMax: tile.x,
    tileYMin: tile.y, tileYMax: tile.y, numTilesX: 1, numTilesY: 1 });
  renderer.sync({ pages: [], entries: [] } as never, [mesh]);
  const shader: any = { uniforms: {}, vertexShader: '#include <uv_vertex>', fragmentShader: '#include <map_fragment>\n#include <roughnessmap_fragment>' };
  material.onBeforeCompile(shader, undefined as never);
  expect(shader.fragmentShader).toContain('terrainRemaining *= 1.0 - entry.b');
  expect(shader.fragmentShader).toContain('terrainTexel = terrainAccum + terrainTexel * terrainRemaining');
  expect(material.customProgramCacheKey()).toContain('terrain-imagery-v3');
  renderer.dispose(); material.map!.dispose(); material.dispose(); mesh.geometry.dispose();
});
