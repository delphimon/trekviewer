import { expect, it } from 'vitest';
import * as THREE from 'three';
import { snapshotSurfaceMesh } from '../src/terrain/SurfacePromotion.ts';
import { encodeSurfaceSources, resolveSurfaceSources } from '../src/terrain/SurfaceSourceTransport.ts';

it('reuses unchanged vertex arrays across source reordering while replacing holes and placement metadata', () => {
  const first = new THREE.Mesh(new THREE.PlaneGeometry(100, 100, 8, 8));
  const second = new THREE.Mesh(new THREE.PlaneGeometry(50, 50, 4, 4));
  const previous = [snapshotSurfaceMesh(first), snapshotSurfaceMesh(second)];
  const workerPrevious = resolveSurfaceSources(structuredClone(encodeSurfaceSources(previous, null)));
  first.position.x = 10;
  first.geometry.userData.surfaceHoles = [{ minX: 1, maxX: 5, minZ: 2, maxZ: 6 }];
  const current = [snapshotSurfaceMesh(second), snapshotSurfaceMesh(first)];
  const updates = encodeSurfaceSources(current, previous);
  expect(updates.map(update => 'reuseSource' in update ? update.reuseSource : -1)).toEqual([1, 0]);
  const resolved = resolveSurfaceSources(structuredClone(updates), workerPrevious);
  expect(resolved).toEqual(current);
  expect(resolved[0].positions).toBe(workerPrevious[1].positions);
  expect(resolved[1].normals).toBe(workerPrevious[0].normals);
  expect(resolved[1].holes).not.toEqual(workerPrevious[0].holes);
  // Dropped sources are absent from the replacement cache; no historical registry.
  const retained = resolveSurfaceSources(structuredClone(encodeSurfaceSources([current[0]], current)), resolved);
  expect(retained).toHaveLength(1);
  first.geometry.dispose(); second.geometry.dispose();
});

it('resends position or normal edits even when the typed array identities remain unchanged', () => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(100, 100, 8, 8));
  const previous = [snapshotSurfaceMesh(mesh)];
  const workerPrevious = resolveSurfaceSources(structuredClone(encodeSurfaceSources(previous, null)));
  const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  position.setY(0, 123); position.needsUpdate = true;
  const changed = [snapshotSurfaceMesh(mesh)];
  expect(encodeSurfaceSources(changed, previous)[0]).toHaveProperty('positions');
  const workerChanged = resolveSurfaceSources(structuredClone(encodeSurfaceSources(changed, previous)), workerPrevious);
  expect(workerChanged[0].positions[1]).toBe(123);
  mesh.geometry.computeVertexNormals();
  expect(encodeSurfaceSources([snapshotSurfaceMesh(mesh)], changed)[0]).toHaveProperty('normals');
  mesh.geometry.dispose();
});

it('rejects missing source references instead of constructing terrain from a different grid', () => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry());
  const sources = [snapshotSurfaceMesh(mesh)];
  const updates = encodeSurfaceSources(sources, sources);
  expect(() => resolveSurfaceSources(updates)).toThrow('no referenced surface');
  mesh.geometry.dispose();
});
