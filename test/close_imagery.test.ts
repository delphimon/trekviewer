import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { QUALITY_PROFILES } from '../src/terrain/QualityProfile.ts';

afterEach(() => vi.restoreAllMocks());

function fixture(style: 'satellite' | 'topo' = 'satellite') {
  const geometry = new THREE.PlaneGeometry(5000, 5000, 16, 16); geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); mesh.name = 'BaseTerrainMesh';
  const root = new THREE.Group(); root.scale.setScalar(0.0001); root.add(mesh); root.updateMatrixWorld(true);
  const manager = new ImageryLODManager({ terrainMesh: mesh, terrainBaseElevation: 0, elevationSampler: () => 0,
    terrainGeoBounds: { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
      widthMeters: 5000, depthMeters: 5000, minEle: 0, maxEle: 1000, elevationSpan: 1000 },
    textureStyle: style, qualityProfile: QUALITY_PROFILES['desktop-high'] });
  vi.spyOn(manager as any, 'reconcileDesiredTiles').mockImplementation(() => {});
  const camera = new THREE.PerspectiveCamera(60, 1, 1e-7, 10);
  const pose = (distance: number) => { camera.position.set(0, distance, 0); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true); };
  const dispose = () => { manager.dispose(); geometry.dispose(); mesh.material.dispose(); };
  return { manager, root, camera, pose, dispose };
}

it('uses actual close desktop distance and reaches the provider ceiling within the existing patch budget', () => {
  const { manager, root, camera, pose, dispose } = fixture();
  const calculate = vi.spyOn(ImageryLODManager, 'calculateTargetZoom');
  try {
    pose(0.025); manager.update(camera, root, false);
    expect(calculate.mock.lastCall![0]).toBeCloseTo(0.025, 7);
    expect(manager.getDiagnostics().targetZoom).toBe(19);
    expect((manager as any).maxPatches).toBe(QUALITY_PROFILES['desktop-high'].tabletopPatches);
  } finally { dispose(); }
});

it('reevaluates a sub-four-centimeter zoom after the normal interval and promotion dwell', () => {
  let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { manager, root, camera, pose, dispose } = fixture();
  const calculate = vi.spyOn(ImageryLODManager, 'calculateTargetZoom');
  try {
    pose(0.05); manager.update(camera, root, false);
    const initial = manager.getDiagnostics().targetZoom;
    pose(0.025); now += 101; manager.update(camera, root, false);
    expect(calculate).toHaveBeenCalledTimes(2);
    expect(calculate.mock.lastCall![0]).toBeCloseTo(0.025, 7);
    expect(manager.getDiagnostics().targetZoom).toBe(initial); // promotion still dwells
    now += 151; manager.update(camera, root, false);
    expect(manager.getDiagnostics().targetZoom).toBeGreaterThan(initial);
    expect(manager.getDiagnostics().targetZoom).toBe(19);
    now += 101; manager.update(camera, root, false);
    expect(calculate).toHaveBeenCalledTimes(3); // identical pose incurs no additional evaluation
  } finally { dispose(); }
});

it('uses actual close distance in High XR and reevaluates the same pose on returning to desktop', () => {
  let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { manager, root, camera, pose, dispose } = fixture();
  const calculate = vi.spyOn(ImageryLODManager, 'calculateTargetZoom');
  try {
    pose(0.025); manager.update(camera, root, true);
    expect(calculate.mock.lastCall![0]).toBeCloseTo(0.025, 7);
    now += 101; manager.update(camera, root, false);
    expect(calculate.mock.lastCall![0]).toBeCloseTo(0.025, 7);
    expect(calculate).toHaveBeenCalledTimes(2);
  } finally { dispose(); }
});

it('keeps the close view sharp when the XR pointer inspects a distant slope', () => {
  const { manager, root, camera, pose, dispose } = fixture();
  const calculate = vi.spyOn(ImageryLODManager, 'calculateTargetZoom');
  try {
    pose(.025);
    const origin = new THREE.Vector3(1, 1, 1), target = new THREE.Vector3(.2, 0, .2);
    manager.setActiveInteractionRay(new THREE.Ray(origin, target.sub(origin).normalize()));
    manager.update(camera, root, true);
    expect(calculate.mock.lastCall![0]).toBeCloseTo(.025, 7);
    expect(manager.getDiagnostics().targetZoom).toBe(19);
    expect(Math.abs(manager.getInspectedGeo()!.lat - 46.85)).toBeGreaterThan(.001);
    const finest = (manager as any).reconcileDesiredTiles.mock.calls[0][0].filter((tile: any) => tile.zoom === 19);
    expect(finest.length).toBeGreaterThanOrEqual(144);
  } finally { dispose(); }
});

it('caps extremely close Topo selection at that provider ceiling', () => {
  const { manager, root, camera, pose, dispose } = fixture('topo');
  try {
    pose(0.0001); manager.update(camera, root, false);
    expect(manager.getDiagnostics().targetZoom).toBe(16);
  } finally { dispose(); }
});
