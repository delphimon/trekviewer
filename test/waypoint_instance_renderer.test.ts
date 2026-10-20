import { expect, it } from 'vitest';
import * as THREE from 'three';
import { DioramaBase } from '../src/visualization/DioramaBase.ts';
import { WaypointInstanceRenderer } from '../src/visualization/WaypointInstanceRenderer.ts';

it('preserves marker transforms, colors, glow and hit targets while compacting hidden pins', () => {
  const bounds: any = { centerLat: 47, centerLon: -122, widthMeters: 1000, depthMeters: 1000, minEle: 0 };
  const base = DioramaBase.create(bounds, -80, [
    { name: 'Start', type: 'start', lat: 47, lon: -122, ele: 0 },
    { name: 'Peak', type: 'summit', lat: 47.001, lon: -122.001, ele: 100 },
  ] as any);
  base.position.set(0.3, 0.8, -1); base.scale.setScalar(0.0001); base.rotation.y = 0.3;
  const waypoints = base.getObjectByName('Waypoints')!, pins = waypoints.children;
  pins[0].scale.setScalar(10); pins[1].scale.setScalar(12);
  const diamond = pins[0].getObjectByName('WaypointPinMesh') as THREE.Mesh;
  (diamond.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.6;
  const target = pins[0].getObjectByName('WaypointHitTarget')!;
  const renderer = new WaypointInstanceRenderer(base, waypoints);
  base.updateMatrixWorld(true);
  const batch = base.getObjectByName('WaypointDiamondInstances') as THREE.InstancedMesh;
  expect(batch.count).toBe(2); expect(diamond.layers.mask).toBe(0); expect(target.layers.mask).toBe(1);
  const matrix = new THREE.Matrix4(); batch.getMatrixAt(0, matrix); matrix.premultiply(batch.matrixWorld);
  for (let i = 0; i < 16; i++) expect(matrix.elements[i]).toBeCloseTo(diamond.matrixWorld.elements[i], 5);
  const color = new THREE.Color(); batch.getColorAt(0, color);
  expect(color.r).toBeCloseTo((diamond.material as THREE.MeshStandardMaterial).color.r);
  expect(batch.geometry.getAttribute('instanceGlow').getX(0)).toBeCloseTo(1.6);
  pins[0].visible = false; renderer.update(); expect(batch.count).toBe(1);
  expect(pins[0].getObjectByName('WaypointHitTarget')).toBe(target);
  renderer.dispose(); expect(base.getObjectByName('WaypointDiamondInstances')).toBeUndefined();
  expect(diamond.layers.mask).toBe(1); expect(target.layers.mask).toBe(1);
  base.traverse(object => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose(); if (mesh.material && !Array.isArray(mesh.material)) mesh.material.dispose(); });
});
