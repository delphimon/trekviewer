import { expect, it } from 'vitest';
import * as THREE from 'three';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';

it('faces every diorama side outward and grades the rock pedestal toward its base',()=>{
  const plane=new THREE.PlaneGeometry(100,80,2,2);
  plane.rotateX(-Math.PI/2);
  const skirt=(TerrainGenerator as any).createDioramaSkirts(plane,2,2,-20) as THREE.BufferGeometry;
  try {
    const position=skirt.getAttribute('position');
    const normal=skirt.getAttribute('normal');
    const color=skirt.getAttribute('color');
    const index=skirt.getIndex()!;
    const center=new THREE.Vector3();
    for(let quad=0;quad<8;quad++){
      const offset=quad*4;
      const midpoint=new THREE.Vector3().fromBufferAttribute(position,offset)
        .add(new THREE.Vector3().fromBufferAttribute(position,offset+1)).multiplyScalar(0.5);
      const expected=new THREE.Vector3(midpoint.x-center.x,0,midpoint.z-center.z).normalize();
      const n=new THREE.Vector3().fromBufferAttribute(normal,offset);
      expect(n.dot(expected)).toBeGreaterThan(0.25);
      const a=new THREE.Vector3().fromBufferAttribute(position,index.getX(quad*6));
      const b=new THREE.Vector3().fromBufferAttribute(position,index.getX(quad*6+1));
      const c=new THREE.Vector3().fromBufferAttribute(position,index.getX(quad*6+2));
      expect(new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a)).normalize().dot(n)).toBeGreaterThan(0.95);
      const rim=new THREE.Color().fromBufferAttribute(color,offset);
      const base=new THREE.Color().fromBufferAttribute(color,offset+2);
      expect(rim.r+rim.g+rim.b).toBeGreaterThan(base.r+base.g+base.b);
    }
  } finally {skirt.dispose();plane.dispose();}
});
