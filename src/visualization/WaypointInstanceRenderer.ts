import * as THREE from 'three';

interface Member { pin: THREE.Object3D; mesh: THREE.Mesh; layers: number }
interface Batch { mesh: THREE.InstancedMesh; members: Member[]; glow?: THREE.InstancedBufferAttribute }

/** Share identical opaque marker shapes. Keep the original hit targets, labels,
 * transparent rings/halos and logical pins under their existing owner. */
export class WaypointInstanceRenderer {
  private readonly batches: Batch[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly pinMatrix = new THREE.Matrix4();

  constructor(private readonly root: THREE.Group, private readonly waypoints: THREE.Object3D) {
    for (const diamond of [true, false]) {
      const members: Member[] = [];
      for (const pin of waypoints.children) for (const child of pin.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        if (diamond ? child.name !== 'WaypointPinMesh' : child.name !== 'WaypointStalkMesh') continue;
        members.push({ pin, mesh: child, layers: child.layers.mask });
      }
      if (members.length < 2) continue;
      const material = (members[0].mesh.material as THREE.Material).clone();
      const geometry = members[0].mesh.geometry.clone();
      const mesh = new THREE.InstancedMesh(geometry, material, members.length);
      mesh.name = diamond ? 'WaypointDiamondInstances' : 'WaypointStalkInstances';
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false;
      // Interaction continues through the existing per-pin spheres.
      mesh.raycast = () => {};
      const batch: Batch = { mesh, members };
      if (diamond) {
        const mat = material as THREE.MeshStandardMaterial;
        mat.color.setHex(0xffffff); mat.emissive.setHex(0xffffff); mat.emissiveIntensity = 1;
        const glow = new THREE.InstancedBufferAttribute(new Float32Array(members.length), 1);
        glow.setUsage(THREE.DynamicDrawUsage); geometry.setAttribute('instanceGlow', glow); batch.glow = glow;
        mat.customProgramCacheKey = () => 'waypoint-diamond-instances-v1';
        mat.onBeforeCompile = shader => {
          shader.vertexShader = 'attribute float instanceGlow; varying float vMarkerGlow;\n' + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvMarkerGlow = instanceGlow;');
          shader.fragmentShader = 'varying float vMarkerGlow;\n' + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vColor.rgb * vMarkerGlow;');
        };
      }
      for (const member of members) member.mesh.layers.mask = 0;
      root.add(mesh); this.batches.push(batch);
    }
    this.update();
  }

  public update(): void {
    this.waypoints.updateMatrix();
    for (const batch of this.batches) {
      let index = 0;
      batch.mesh.visible = this.waypoints.visible;
      for (const member of batch.members) {
        const material = member.mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        if (!member.pin.visible || !member.mesh.visible || !material.visible) continue;
        member.pin.updateMatrix(); member.mesh.updateMatrix();
        this.pinMatrix.multiplyMatrices(this.waypoints.matrix, member.pin.matrix);
        this.matrix.multiplyMatrices(this.pinMatrix, member.mesh.matrix);
        batch.mesh.setMatrixAt(index, this.matrix);
        if (batch.glow) {
          batch.mesh.setColorAt(index, material.color);
          batch.glow.setX(index, (material as THREE.MeshStandardMaterial).emissiveIntensity);
        }
        index++;
      }
      batch.mesh.count = index; batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
      if (batch.glow) batch.glow.needsUpdate = true;
    }
  }

  public dispose(): void {
    for (const batch of this.batches) {
      for (const member of batch.members) member.mesh.layers.mask = member.layers;
      this.root.remove(batch.mesh); batch.mesh.dispose(); batch.mesh.geometry.dispose();
      (batch.mesh.material as THREE.Material).dispose();
    }
    this.batches.length = 0;
  }
}
