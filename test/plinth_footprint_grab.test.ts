import { expect, it } from 'vitest';
import * as THREE from 'three';
import { isOverPlinthFootprint } from '../src/core/XRManager.ts';

it('lets the trigger grab the model only over its plinth footprint plus 5 cm', () => {
  const root = new THREE.Group();
  root.position.set(0, 0.8, -0.8); root.rotation.y = 0.4; root.scale.setScalar(0.0002);
  // Plinth 2500 m x 2000 m model metres -> 0.5 m x 0.4 m in the room.
  const onModel = root.localToWorld(new THREE.Vector3(1000, 0, -900));
  const justOutside = root.localToWorld(new THREE.Vector3(1250 + 200, 0, 0)); // 4 cm beyond the edge
  const farAway = new THREE.Vector3(5, 0.8, -0.8);
  expect(isOverPlinthFootprint(root, onModel, 2500, 2000)).toBe(true);
  expect(isOverPlinthFootprint(root, justOutside, 2500, 2000)).toBe(true);
  expect(isOverPlinthFootprint(root, farAway, 2500, 2000)).toBe(false);
  expect(isOverPlinthFootprint(root, root.localToWorld(new THREE.Vector3(1250 + 300, 0, 0)), 2500, 2000)).toBe(false);
});
