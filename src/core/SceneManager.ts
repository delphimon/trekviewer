import * as THREE from 'three';
import type { ViewMode } from '../gpx/TrackTypes.ts';
import { disposeObject3D } from './ResourceLifecycle.ts';
import { TextureProvider } from '../terrain/TextureProvider.ts';
import { updateInspectionClipping } from './InspectionView.ts';

export class SceneManager {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public dioramaRoot: THREE.Group; // Holds terrain, trail, base
  public sunLight: THREE.DirectionalLight;
  public hemiLight: THREE.HemisphereLight;
  public skyMesh: THREE.Mesh;

  private isPassthroughActive: boolean = false;
  private currentViewMode: ViewMode = 'diorama';
  private targetScale: number = 1.0;
  private targetPosition: THREE.Vector3 = new THREE.Vector3();
  private targetRotationY: number = 0;
  private onWindowResizeBound: () => void;
  private readonly vignette: THREE.Mesh;
  private terrainExtent = 1000;

  constructor(container: HTMLElement) {
    // 1. Scene
    this.scene = new THREE.Scene();

    // 2. Diorama Root Group
    this.dioramaRoot = new THREE.Group();
    this.dioramaRoot.name = 'DioramaRoot';
    this.scene.add(this.dioramaRoot);

    // 3. Camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      80000
    );
    this.camera.position.set(0, 1.2, 1.5);

    // 4. Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true, // Required for WebXR AR / Passthrough
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.xr.enabled = true;
    container.appendChild(this.renderer.domElement);
    TextureProvider.setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
    this.vignette = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { strength: { value: 0 } }, transparent: true, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 screenUV; void main(){screenUV=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader: 'varying vec2 screenUV; uniform float strength; void main(){float edge=smoothstep(0.25,0.67,length(screenUV-0.5));if(edge<0.01)discard;gl_FragColor=vec4(0.0,0.0,0.0,edge*strength);}',
    }));
    this.vignette.frustumCulled = false;
    this.vignette.renderOrder = 2000;
    this.vignette.visible = false;
    this.scene.add(this.vignette);

    // 5. Lighting
    this.hemiLight = new THREE.HemisphereLight(0xbae6fd, 0x1e293b, 1.2);
    this.hemiLight.position.set(0, 500, 0);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfffbeb, 2.4);
    this.sunLight.position.set(300, 600, 400);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 4000;
    const d = 1500;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.scene.add(this.sunLight);

    // 6. Procedural Alpine Sky Dome (for VR / Desktop)
    this.skyMesh = this.createSkyDome();
    this.scene.add(this.skyMesh);

    // 7. Subtle mountain haze fog
    this.scene.fog = new THREE.FogExp2(0x93c5fd, 0.00004);

    // Handle Window Resize
    this.onWindowResizeBound = this.onWindowResize.bind(this);
    window.addEventListener('resize', this.onWindowResizeBound);
    this.renderer.xr.addEventListener('sessionend', this.onWindowResizeBound);
  }

  public setPassthrough(active: boolean): void {
    this.isPassthroughActive = active;
    if (active) {
      // Clear background and hide sky so Quest 3 passthrough camera shows through
      this.scene.background = null;
      this.skyMesh.visible = false;
      this.scene.fog = null;
      this.renderer.setClearColor(0x000000, 0);
    } else {
      this.skyMesh.visible = true;
      this.scene.fog = new THREE.FogExp2(0x93c5fd, 0.00004);
      this.renderer.setClearColor(0x0f172a, 1);
    }
  }

  public setXREnergyMode(inXR: boolean): void {
    if (inXR) {
      // Power efficiency for Meta Quest: disable dynamic 2048x2048 shadow map pass
      // Terrain has realistic USGS photographic shaded relief; dynamic PCF shadows only add heat
      this.renderer.shadowMap.enabled = false;
      this.sunLight.castShadow = false;
    } else {
      this.renderer.shadowMap.enabled = true;
      this.sunLight.castShadow = true;
    }
  }

  public setViewMode(mode: ViewMode, extentMeters: number): void {
    this.currentViewMode = mode;
    this.terrainExtent = Math.max(1000, extentMeters);

    if (mode === 'diorama') {
      // Scale down so entire mountain fits on an 0.8m - 1.0m table
      const targetTableSize = 0.85; // meters in VR
      const scale = targetTableSize / Math.max(extentMeters, 1000);
      this.dioramaRoot.scale.set(scale, scale, scale);
      // In WebXR: Natural tabletop height (82cm above floor, 80cm in front of user)
      // On desktop: Position centered in front of desktop camera
      if (this.renderer.xr.isPresenting) {
        this.dioramaRoot.position.set(0, 0.82, -0.80);
      } else {
        this.dioramaRoot.position.set(0, -0.2, -1.1);
      }
      this.dioramaRoot.rotation.set(0, 0, 0);

      // Reset desktop camera for diorama inspection
      if (!this.renderer.xr.isPresenting) {
        this.camera.position.set(0, 0.8, 1.3);
        this.camera.lookAt(0, 0, 0);
      }
    } else {
      // 1:1 Real-world meters scale for First-Person immersion
      this.dioramaRoot.scale.set(1, 1, 1);
      this.dioramaRoot.position.set(0, 0, 0);
      this.dioramaRoot.rotation.set(0, 0, 0);
    }
  }

  public render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  public updateCameraClipping(targetDistance: number): void {
    updateInspectionClipping(this.camera,
      this.currentViewMode === 'diorama' && !this.renderer.xr.isPresenting,
      targetDistance, this.camera.position.distanceTo(this.dioramaRoot.position),
      this.terrainExtent * this.dioramaRoot.scale.length());
  }

  public updateMotionVignette(active: boolean, delta: number): void {
    const uniform = (this.vignette.material as THREE.ShaderMaterial).uniforms.strength;
    const target = active ? 0.8 : 0;
    uniform.value += (target - uniform.value) * (1 - Math.exp(-Math.max(0, delta) * 10));
    this.vignette.visible = this.renderer.xr.isPresenting && uniform.value > 0.005;
  }

  private createSkyDome(): THREE.Mesh {
    const skyGeo = new THREE.SphereGeometry(40000, 32, 16);
    // Invert geometry to view from inside
    skyGeo.scale(-1, 1, 1);

    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    // Mountain zenith deep blue to warm horizon haze
    grad.addColorStop(0, '#0284c7');
    grad.addColorStop(0.5, '#38bdf8');
    grad.addColorStop(0.85, '#bae6fd');
    grad.addColorStop(1, '#f1f5f9');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 256);

    const skyTex = new THREE.CanvasTexture(canvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    const skyMat = new THREE.MeshBasicMaterial({
      map: skyTex,
      depthWrite: false,
    });
    // Sky is a background, independent of the scene's inspection clipping range.
    skyMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\ngl_Position.z = gl_Position.w;');
    };
    skyMat.customProgramCacheKey = () => 'sky-at-far-depth-v1';
    const mesh = new THREE.Mesh(skyGeo, skyMat);
    mesh.frustumCulled = false;
    // Draw the opaque background after terrain; early depth rejection avoids shading covered sky pixels.
    mesh.renderOrder = 1000;
    return mesh;
  }

  private onWindowResize(): void {
    // The XR runtime owns the framebuffer while presenting. Apply the current
    // panel dimensions on session end, after Three.js restores its desktop size.
    if (this.renderer.xr.isPresenting) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /**
   * Diagnostic instrumentation exposing Three.js GPU memory and render counts.
   */
  public getMemoryInfo(): { memory: THREE.WebGLInfo['memory']; render: THREE.WebGLInfo['render'] } {
    return {
      memory: { ...this.renderer.info.memory },
      render: { ...this.renderer.info.render },
    };
  }

  /**
   * Complete teardown of Three.js scene, renderer, event listeners, and GPU resources.
   */
  public dispose(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onWindowResizeBound);
    this.renderer.xr.removeEventListener('sessionend', this.onWindowResizeBound);
    disposeObject3D(this.skyMesh);
    disposeObject3D(this.vignette);
    disposeObject3D(this.dioramaRoot);
    this.sunLight.shadow.map?.dispose();
    this.renderer.dispose();
  }
}
