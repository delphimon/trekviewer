import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';

it('keeps tabletop detail focused on visible lower-screen terrain when the center ray clears a ridge', () => {
  const geometry = new THREE.PlaneGeometry(100, 100, 10, 10);
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const z = -positions.getY(i);
    positions.setXYZ(i, x, 0, z);
  }
  positions.needsUpdate = true;
  geometry.computeBoundingBox();
  const terrain = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  terrain.name = 'BaseTerrainMesh';
  const terrainGroup = new THREE.Group();
  terrainGroup.name = 'TerrainGroup';
  terrainGroup.add(terrain);
  const root = new THREE.Group();
  root.add(terrainGroup);
  root.updateWorldMatrix(true, true);

  const manager = new ImageryLODManager({
    terrainGeoBounds: {
      minLat: 46.84, maxLat: 46.86, minLon: -121.76, maxLon: -121.74,
      centerLat: 46.85, centerLon: -121.75, minEle: 0, maxEle: 100,
      widthMeters: 100, depthMeters: 100, elevationSpan: 100,
    },
    terrainBaseElevation: 0,
    elevationSampler: () => 0,
    terrainMesh: terrain,
    enableFadeIn: false,
  });
  vi.spyOn(manager as any, 'reconcileDesiredTiles').mockImplementation(() => {});
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 0, -10); // both center and lower rays intersect terrain
  camera.updateWorldMatrix(true, false);

  try {
    (manager as any).evaluateLOD(camera, root);
    expect(manager.getFocusSource()).toBe('center');

    camera.lookAt(0, 3, -10); // center ray points above the horizontal terrain
    camera.updateWorldMatrix(true, false);
    (manager as any).evaluateLOD(camera, root);
    expect(manager.getFocusSource()).toBe('lower');
    const focused = manager.getInspectedGeo();
    expect(focused).not.toBeNull();
    expect(focused!.lat).not.toBeCloseTo(46.85, 5);

    camera.lookAt(0, 20, -10); // all visible rays miss; keep the last real hit
    camera.updateWorldMatrix(true, false);
    (manager as any).evaluateLOD(camera, root);
    expect(manager.getFocusSource()).toBe('retained');
    expect(manager.getInspectedGeo()).toEqual(focused);
  } finally {
    manager.dispose();
    geometry.dispose();
    (terrain.material as THREE.Material).dispose();
  }
});
