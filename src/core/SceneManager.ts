import * as THREE from 'three';
import type { ViewMode } from '../gpx/TrackTypes.ts';
import { disposeObject3D } from './ResourceLifecycle.ts';

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
      this.renderer.xr.setFramebufferScaleFactor(1.0);
    } else {
      this.renderer.shadowMap.enabled = true;
      this.sunLight.castShadow = true;
    }
  }

  public setViewMode(mode: ViewMode, extentMeters: number): void {
    this.currentViewMode = mode;

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
    const skyMat = new THREE.MeshBasicMaterial({
      map: skyTex,
      depthWrite: false,
    });
    return new THREE.Mesh(skyGeo, skyMat);
  }

  private onWindowResize(): void {
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
    window.removeEventListener('resize', this.onWindowResizeBound);
    disposeObject3D(this.skyMesh);
    disposeObject3D(this.dioramaRoot);
    this.sunLight.shadow.map?.dispose();
    this.renderer.dispose();
  }
}
