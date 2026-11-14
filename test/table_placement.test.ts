import { expect, it } from 'vitest';
import * as THREE from 'three';
import { TablePlacement } from '../src/xr/TablePlacement.ts';
import { DioramaBase, plinthBottomDepth } from '../src/visualization/DioramaBase.ts';

function frameWithTable(y: number): XRFrame {
  const plane = { planeSpace: {}, orientation: 'horizontal', semanticLabel: 'table',
    polygon: [{ x: -0.4, z: -0.3 }, { x: 0.4, z: -0.3 }, { x: 0.4, z: 0.3 }, { x: -0.4, z: 0.3 }] };
  return { detectedPlanes: new Set([plane]),
    getPose: () => ({ transform: { position: { x: 0.2, y, z: -0.6 } } }) } as unknown as XRFrame;
}

it('reports the plinth bottom depth from the real plinth geometry', () => {
  const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
    widthMeters: 3000, depthMeters: 3000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
  const base = DioramaBase.create(bounds);
  const box = new THREE.Box3().setFromObject(base.children[0]);
  expect(plinthBottomDepth()).toBeCloseTo(-box.min.y, 6);
  expect(plinthBottomDepth()).toBe(105);
});

it('rests the plinth bottom on the detected table instead of sinking it', () => {
  const placement = new TablePlacement(), root = new THREE.Group();
  root.scale.setScalar(0.0005);
  placement.start(0);
  const message = placement.update(frameWithTable(0.74), {} as XRSpace, root, new THREE.Vector3(0, 1.6, 0), 10, 105);
  expect(message).not.toBeNull();
  const plinthBottomWorldY = root.position.y - 105 * root.scale.y;
  expect(Math.abs(plinthBottomWorldY - (0.74 + 0.01))).toBeLessThan(0.001);
  expect(root.position.x).toBeCloseTo(0.2); expect(root.position.z).toBeCloseTo(-0.6);
});
