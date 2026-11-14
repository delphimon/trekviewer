import { expect, it } from 'vitest';

it('centres the comfort vignette on each eye\'s view direction', async () => {
  const { VIGNETTE_VERTEX_SHADER, VIGNETTE_FRAGMENT_SHADER } = await import('../src/core/SceneManager.ts');
  expect(VIGNETTE_VERTEX_SHADER).toContain('inverse(projectionMatrix)');
  expect(VIGNETTE_FRAGMENT_SHADER).not.toContain('screenUV');
  // An off-axis eye: the view direction (centre of the vignette) is not the viewport centre.
  const THREE = await import('three');
  const eye = new THREE.PerspectiveCamera(90, 1, 0.1, 100); eye.setViewOffset(200, 100, 0, 0, 100, 100);
  const forward = new THREE.Vector3(0, 0, -1).applyMatrix4(eye.projectionMatrix);
  expect(Math.abs(forward.x)).toBeGreaterThan(0.1);
});
