import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const levelEuler = new THREE.Euler(0, 0, 0, 'YXZ');

/** Remove model pitch and roll without changing its heading, position or scale. */
export function levelHorizon(model: THREE.Object3D): void {
  levelEuler.setFromQuaternion(model.quaternion, 'YXZ');
  levelEuler.set(0, levelEuler.y, 0, 'YXZ');
  model.quaternion.setFromEuler(levelEuler);
}

export function configureDesktopInspection(controls: OrbitControls): void {
  // Tabletop units: the old 20 cm floor prevented inspecting small terrain features.
  controls.minDistance = 0.00001;
  controls.maxDistance = Infinity;
  controls.zoomToCursor = true;
}

export interface InspectionArea { left: number; right: number; top: number; bottom: number; }

/** Fit the eight projected box corners inside the space left by the desktop controls. */
export function fitInspectionBounds(
  camera: THREE.PerspectiveCamera, target: THREE.Vector3, bounds: THREE.Box3,
  width: number, height: number, area: InspectionArea,
): boolean {
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray(), width, height,
    area.left, area.right, area.top, area.bottom].every(Number.isFinite) || width <= 0 || height <= 0) return false;
  const left = Math.max(0, area.left), right = Math.min(width, area.right);
  const top = Math.max(0, area.top), bottom = Math.min(height, area.bottom);
  if (right <= left || bottom <= top) return false;
  const halfFov = THREE.MathUtils.degToRad(camera.getEffectiveFOV() / 2);
  const tanY = Math.tan(halfFov), tanX = tanY * width / height;
  if (!(tanX > 0 && tanY > 0) || !Number.isFinite(tanX + tanY)) return false;
  const l = left * 2 / width - 1, r = right * 2 / width - 1;
  const t = 1 - top * 2 / height, b = 1 - bottom * 2 / height;
  const cx = (l + r) / 2, cy = (t + b) / 2;
  const center = bounds.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(0, 0.85, 1).normalize();
  const screenRight = new THREE.Vector3(1, 0, 0);
  const screenUp = new THREE.Vector3(0, 1, -0.85).normalize();
  let distance = 1e-4;
  const corner = new THREE.Vector3();
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    corner.set(x, y, z).sub(center);
    const vx = corner.dot(screenRight), vy = corner.dot(screenUp), vz = corner.dot(offset);
    distance = Math.max(distance, vz + 1e-4,
      (vx / tanX + r * vz) / (r - cx), (-vx / tanX - l * vz) / (cx - l),
      (vy / tanY + t * vz) / (t - cy), (-vy / tanY - b * vz) / (cy - b));
  }
  if (!Number.isFinite(distance)) return false;
  // Move the camera's optical axis so the box lands in the available screen area.
  target.copy(center).addScaledVector(screenRight, -cx * distance * tanX).addScaledVector(screenUp, -cy * distance * tanY);
  camera.position.copy(target).addScaledVector(offset, distance);
  camera.up.set(0, 1, 0);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return true;
}

/** Keep tabletop clipping in tabletop units; retain metre-scale ranges for walking/XR. */
export function updateInspectionClipping(
  camera: THREE.PerspectiveCamera,
  tabletop: boolean,
  targetDistance: number,
  modelDistance: number,
  modelRadius: number,
): void {
  const near = tabletop ? THREE.MathUtils.clamp(targetDistance * 0.005, 1e-7, 0.001) : 0.1;
  const far = tabletop ? Math.max(10, modelDistance + modelRadius * 2, targetDistance * 2) : 80000;
  // Static views incur no projection rebuild; avoid inspecting geometry every frame.
  if (camera.near === near && camera.far === far) return;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
}

export function readHorizonLock(): boolean {
  try { return localStorage.getItem('trekviewer.horizonLocked') !== 'false'; }
  catch { return true; }
}

export function saveHorizonLock(locked: boolean): void {
  try { localStorage.setItem('trekviewer.horizonLocked', String(locked)); }
  catch { /* Storage can be unavailable in private browsing. */ }
}
