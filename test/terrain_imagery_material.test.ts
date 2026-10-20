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
