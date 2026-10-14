import { it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { releaseGraphicsResources } from '../src/core/GraphicsResources.ts';

it('releases shared GPU handles once while retaining geometry, canvas pixels, instance data and scene hierarchy', () => {
  const scene = new THREE.Scene(), group = new THREE.Group(); scene.add(group);
  const geometry = new THREE.BoxGeometry(), positions = geometry.attributes.position.array;
  const canvas = { width: 512, height: 256, getContext: () => ({}) };
  const texture = new THREE.CanvasTexture(canvas as any);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const shader = new THREE.ShaderMaterial({ uniforms: { maps: { value: [texture, texture] } } });
  const instance = new THREE.InstancedMesh(geometry, material, 2), matrices = instance.instanceMatrix.array;
  group.add(new THREE.Mesh(geometry, [material, shader]), instance);
  scene.background = texture; scene.environment = texture;
  const shadow = new THREE.WebGLRenderTarget(64, 64);
  const disposeGeometry = vi.spyOn(geometry, 'dispose'), disposeMaterial = vi.spyOn(material, 'dispose');
  const disposeShader = vi.spyOn(shader, 'dispose'), disposeTexture = vi.spyOn(texture, 'dispose');
  const disposeInstance = vi.spyOn(instance, 'dispose'), disposeShadow = vi.spyOn(shadow, 'dispose');
  const cachedGeometry = new THREE.PlaneGeometry(), cachedTexture = new THREE.CanvasTexture(canvas as any);
  const disposeCachedGeometry = vi.spyOn(cachedGeometry, 'dispose'), disposeCachedTexture = vi.spyOn(cachedTexture, 'dispose');
  releaseGraphicsResources([scene, group], shadow, [geometry, texture, cachedGeometry, cachedTexture]);
  for (const dispose of [disposeGeometry, disposeMaterial, disposeShader, disposeTexture, disposeInstance, disposeShadow]) expect(dispose).toHaveBeenCalledTimes(1);
  expect(group.parent).toBe(scene); expect(group.children.length).toBe(2);
  expect(geometry.attributes.position.array).toBe(positions); expect(instance.instanceMatrix.array).toBe(matrices);
  expect(material.map).toBe(texture); expect(texture.source.data).toBe(canvas);
  expect(canvas.width).toBe(512); expect(canvas.height).toBe(256);
  expect(disposeCachedGeometry).toHaveBeenCalledTimes(1); expect(disposeCachedTexture).toHaveBeenCalledTimes(1);
});
