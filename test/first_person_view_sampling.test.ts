import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';

it('samples terrain in the first-person view for off-route imagery selection', () => {
  const geometry = new THREE.PlaneGeometry(1000, 1000, 10, 10);
  geometry.rotateX(-Math.PI / 2);
  const terrain = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  terrain.name = 'BaseTerrainMesh';
  const group = new THREE.Group();
  group.name = 'TerrainGroup';
  group.add(terrain);
  const root = new THREE.Group();
  root.add(group);
  root.updateWorldMatrix(true, true);

  const manager = new ImageryLODManager({
    terrainGeoBounds: {
      minLat: 46.84, maxLat: 46.86, minLon: -121.76, maxLon: -121.74,
      centerLat: 46.85, centerLon: -121.75, minEle: 0, maxEle: 100,
      widthMeters: 1000, depthMeters: 1000, elevationSpan: 100,
    },
    terrainBaseElevation: 0,
    elevationSampler: () => 0,
    terrainMesh: terrain,
    viewMode: 'first-person',
    enableFadeIn: false,
  });
  const reconcile = vi.spyOn(manager as any, 'reconcileDesiredTiles').mockImplementation(() => {});
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 2000);
  camera.position.set(0, 5, 0);
  camera.lookAt(0, 0, -100);
  camera.updateWorldMatrix(true, false);

  try {
    (manager as any).evaluateFirstPersonLOD(camera, root);
    expect(manager.getDiagnostics().firstPersonViewSamples).toBeGreaterThan(0);
    expect(reconcile).toHaveBeenCalledOnce();
    const candidates = reconcile.mock.calls[0][0] as unknown[];
    expect(candidates.length).toBeGreaterThan(0);
  } finally {
    manager.dispose();
    geometry.dispose();
    (terrain.material as THREE.Material).dispose();
  }
});
