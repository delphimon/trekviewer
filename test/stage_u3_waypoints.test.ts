import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as fs from 'fs';
import * as path from 'path';
import { RouteGeometry } from '../src/visualization/RouteGeometry';
import { DioramaBase, BASE_MARKER_DIAMETER_LOCAL, DESIRED_MARKER_DIAMETER_WORLD, ON_ROUTE_THRESHOLD_METERS } from '../src/visualization/DioramaBase';
import { GPXParser } from '../src/gpx/GPXParser';
import { TrailMesh } from '../src/visualization/TrailMesh';
import { XRManager } from '../src/core/XRManager';
import { TrackStats, GPXWaypoint } from '../src/gpx/TrackTypes';

describe('Stage U3: Waypoint Anchoring, Projection & Physical Interaction UX', () => {

  beforeEach(() => {
    const mockCtx: any = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      measureText: () => ({ width: 80 }),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      setLineDash: vi.fn(),
      drawImage: vi.fn(),
      roundRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    };

    (globalThis as any).window = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    (globalThis as any).document = {
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        getContext: () => mockCtx,
        width: 384,
        height: 128,
        style: {},
      }),
    };
  });

  describe('RouteGeometry.projectGeoPointToVisualRoute (Sections 24, 25, 26, 28)', () => {
    it('projects points onto continuous line segments with exact closest-point math', () => {
      // Create a simple track heading East from (47.0, -121.0) to (47.0, -120.9)
      const points = [
        { lat: 47.0, lon: -121.0, ele: 1000, distanceFromStart: 0 },
        { lat: 47.0, lon: -120.95, ele: 1100, distanceFromStart: 3800 },
        { lat: 47.0, lon: -120.9, ele: 1200, distanceFromStart: 7600 },
      ];
      const track: TrackStats = {
        name: 'Test Line',
        points: points as any,
        segments: [{ points: points as any, distance: 7600, elevationGain: 200, elevationLoss: 0, startIndex: 0, endIndex: 2 }],
        totalDistance: 7600,
        elevationGain: 200,
        elevationLoss: 0,
        minElevation: 1000,
        maxElevation: 1200,
        bounds: {
          minLat: 47.0,
          maxLat: 47.0,
          minLon: -121.0,
          maxLon: -120.9,
          minEle: 1000,
          maxEle: 1200,
          centerLat: 47.0,
          centerLon: -120.95,
          widthMeters: 7600,
          depthMeters: 500,
          elevationSpan: 200,
        },
        waypoints: [],
        landmarks: [],
        movingTime: 7600,
        totalPlaybackSeconds: 7600,
        avgSpeed: 1.0,
        maxSpeed: 2.0,
        warnings: [],
      };

      const routeGeometry = new RouteGeometry(track, 1000);

      // Query a point slightly North of the midpoint: lat 47.0005, lon -120.95 (~55 meters off-route)
      const proj = routeGeometry.projectGeoPointToVisualRoute(47.0005, -120.95);

      expect(proj.progress).toBeGreaterThan(0.4);
      expect(proj.progress).toBeLessThan(0.6);
      expect(proj.routeDistanceMeters).toBeGreaterThan(3000);
      expect(proj.routeDistanceMeters).toBeLessThan(4500);
      expect(proj.offRouteDistanceMeters).toBeGreaterThan(40);
      expect(proj.offRouteDistanceMeters).toBeLessThan(70);
      expect(proj.visualPosition).toBeDefined();
    });

    it('guarantees Camp 3 in OlympusBaileyTraverse2026.gpx projects within threshold and coincides with hiker', () => {
      const gpxPath = path.resolve(__dirname, '../public/routes/OlympusBaileyTraverse2026.gpx');
      const xml = fs.readFileSync(gpxPath, 'utf8');
      const raw = GPXParser.parseRaw(xml);
      const track = GPXParser.finalizeWithDEM(raw);

      const camp3Wp = track.waypoints.find((w) => w.name === 'Camp 3');
      expect(camp3Wp).toBeDefined();

      const trail = TrailMesh.create(track);
      const routeGeometry = trail.routeGeometry;

      // Project Camp 3
      const proj = routeGeometry.projectGeoPointToVisualRoute(camp3Wp!.lat, camp3Wp!.lon);
      expect(proj.offRouteDistanceMeters).toBeLessThanOrEqual(ON_ROUTE_THRESHOLD_METERS);

      // Verify diorama base creation snaps Camp 3 to visual route
      camp3Wp!.projection = proj;
      const diorama = DioramaBase.create(track.bounds, -80, [camp3Wp!], track.minElevation);
      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      const pin = wpGroup.children[0] as THREE.Group;

      // When snapped to visual route, horizontal position matches projected visual position
      expect(pin.position.x).toBeCloseTo(proj.visualPosition.x, 3);
      expect(pin.position.z).toBeCloseTo(proj.visualPosition.z, 3);

      // When hiker moves to this waypoint's progress:
      trail.updateHikerPosition(proj.progress);
      const hikerPos = trail.hikerMarker.position;

      // The hiker position and waypoint anchor position coincide identically in X and Z!
      expect(hikerPos.x).toBeCloseTo(pin.position.x, 1);
      expect(hikerPos.z).toBeCloseTo(pin.position.z, 1);
      const horizontalDelta = Math.hypot(hikerPos.x - pin.position.x, hikerPos.z - pin.position.z);
      expect(horizontalDelta).toBeLessThan(0.01); // Within 1 cm in diorama space!
    });
  });

  describe('Physical Marker Sizing & Separate Hit Volume (Sections 29, 30)', () => {
    it('guarantees actual diamond geometry transformed bounding box is ~2.5 cm world diameter', () => {
      const mockBounds = {
        minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7,
        minEle: 1000, maxEle: 2000, centerLat: 46.85, centerLon: -121.75,
        widthMeters: 5000, depthMeters: 5000, elevationSpan: 1000,
      };
      const sampleWp: GPXWaypoint = { lat: 46.85, lon: -121.75, ele: 1500, name: 'Peak Diamond' };
      const diorama = DioramaBase.create(mockBounds, -80, [sampleWp], 1000);
      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      const pin = wpGroup.children[0] as THREE.Group;
      const diamond = pin.getObjectByName('WaypointPinMesh') as THREE.Mesh;
      const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);

      const testScales = [0.05, 0.25, 0.75, 1.0, 2.5, 4.0];
      for (const scale of testScales) {
        diorama.scale.setScalar(scale);
        diorama.updateMatrixWorld(true);
        DioramaBase.updateWaypoints(diorama, camera, scale, 0.016);
        diorama.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(diamond);
        const size = box.getSize(new THREE.Vector3());
        const diameter = Math.max(size.x, size.y, size.z);

        // Expected diameter is ~0.025m (2.5 cm) (within 2-3.5 cm)
        expect(diameter).toBeGreaterThanOrEqual(0.02);
        expect(diameter).toBeLessThanOrEqual(0.035);
      }
    });

    it('guarantees separate invisible hit target sphere is ~5 cm world radius (~10 cm diameter)', () => {
      const mockBounds = {
        minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7,
        minEle: 1000, maxEle: 2000, centerLat: 46.85, centerLon: -121.75,
        widthMeters: 5000, depthMeters: 5000, elevationSpan: 1000,
      };
      const sampleWp: GPXWaypoint = { lat: 46.85, lon: -121.75, ele: 1500, name: 'Target Test' };
      const diorama = DioramaBase.create(mockBounds, -80, [sampleWp], 1000);
      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      const pin = wpGroup.children[0] as THREE.Group;
      const hitTarget = pin.getObjectByName('WaypointHitTarget') as THREE.Mesh;
      const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);

      diorama.scale.setScalar(1.0);
      diorama.updateMatrixWorld(true);
      DioramaBase.updateWaypoints(diorama, camera, 1.0, 0.016);
      diorama.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(hitTarget);
      const size = box.getSize(new THREE.Vector3());
      const hitDiameter = Math.max(size.x, size.y, size.z);

      // Hit sphere diameter is ~10 cm (0.10m), radius ~5 cm (within 4-7 cm radius)
      expect(hitDiameter).toBeGreaterThanOrEqual(0.08);
      expect(hitDiameter).toBeLessThanOrEqual(0.12);
    });
  });

  describe('Angular Label Sizing & Persistent Selection (Sections 32, 33, 34, 35)', () => {
    it('scales label by angular visual angle up to 0.85m when viewed from afar', () => {
      const mockBounds = {
        minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7,
        minEle: 1000, maxEle: 2000, centerLat: 46.85, centerLon: -121.75,
        widthMeters: 5000, depthMeters: 5000, elevationSpan: 1000,
      };
      const sampleWp: GPXWaypoint = { lat: 46.85, lon: -121.75, ele: 1000, name: 'Camp Far' };
      const diorama = DioramaBase.create(mockBounds, -80, [sampleWp], 1000);
      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      const pin = wpGroup.children[0] as THREE.Group;
      const label = pin.getObjectByName('WaypointLabelSprite') as THREE.Sprite;
      expect(label).toBeDefined();

      const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);

      // Select pin
      DioramaBase.onSelectWaypoint(diorama, pin);
      expect(pin.userData.isSelected).toBe(true);
      expect(pin.userData.selectTimeout).toBe(12.0); // 12 seconds persistent timeout (Section 35)

      // Test at ~1.0 meter distance directly in front of the label
      camera.position.set(pin.position.x, pin.position.y, pin.position.z + 1.0);
      diorama.position.set(0, 0, 0);
      diorama.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      DioramaBase.updateWaypoints(diorama, camera, 1.0, 0.016);
      diorama.updateMatrixWorld(true);

      const worldScaleClose = new THREE.Vector3();
      label.getWorldScale(worldScaleClose);
      expect(worldScaleClose.x).toBeGreaterThanOrEqual(0.12);
      expect(worldScaleClose.x).toBeLessThanOrEqual(0.25);

      // Test at ~4.0 meters distance (viewed from across room)
      camera.position.set(pin.position.x, pin.position.y, pin.position.z + 4.0);
      camera.updateMatrixWorld(true);
      DioramaBase.updateWaypoints(diorama, camera, 1.0, 0.016);
      diorama.updateMatrixWorld(true);

      const worldScaleFar = new THREE.Vector3();
      label.getWorldScale(worldScaleFar);
      // Angular scaling does not clamp at 0.35m anymore — reaches ~0.70m!
      expect(worldScaleFar.x).toBeGreaterThan(0.50);
      expect(worldScaleFar.x).toBeLessThanOrEqual(0.85);
    });
  });

  describe('Fingertip Waypoint Interaction & Diorama Grab Gating (Section 31)', () => {
    it('claims waypoint hover and select without dragging the diorama', () => {
      const mockCamera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      const mockDioramaRoot = new THREE.Group();
      const mockScene = new THREE.Scene();
      const mockControllers: THREE.Group[] = [new THREE.Group(), new THREE.Group()];
      const mockControllerGrips: THREE.Group[] = [new THREE.Group(), new THREE.Group()];
      const mockHands: THREE.Group[] = [];

      for (let i = 0; i < 2; i++) {
        const h = new THREE.Group();
        const joints: any = {};
        for (const jName of [
          'wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
          'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
          'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
          'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
          'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'
        ]) {
          const jointObj = new THREE.Object3D();
          jointObj.visible = true;
          joints[jName] = jointObj;
          h.add(jointObj);
        }
        (h as any).joints = joints;
        mockHands.push(h);
      }

      const mockSceneManager: any = {
        renderer: {
          xr: {
            getSession: () => null,
            getController: (idx: number) => mockControllers[idx] || new THREE.Group(),
            getControllerGrip: (idx: number) => mockControllerGrips[idx] || new THREE.Group(),
            getHand: (idx: number) => mockHands[idx] || new THREE.Group(),
            isPresenting: false,
            getCamera: () => mockCamera,
          },
        },
        camera: mockCamera,
        dioramaRoot: mockDioramaRoot,
        scene: mockScene,
      };

      const xrManager = new XRManager(mockSceneManager);

      const mockBounds = {
        minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7,
        minEle: 1000, maxEle: 2000, centerLat: 46.85, centerLon: -121.75,
        widthMeters: 5000, depthMeters: 5000, elevationSpan: 1000,
      };
      const sampleWp: GPXWaypoint = { lat: 46.85, lon: -121.75, ele: 1500, name: 'Glacier Camp' };
      const diorama = DioramaBase.create(mockBounds, -80, [sampleWp], 1000);
      mockSceneManager.dioramaRoot.add(diorama);
      mockSceneManager.dioramaRoot.position.set(0, 0.82, -0.80);
      mockSceneManager.dioramaRoot.updateMatrixWorld(true);

      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      const pin = wpGroup.children[0] as THREE.Group;
      const hitTarget = pin.getObjectByName('WaypointHitTarget') as THREE.Mesh;
      const hitWorldPos = new THREE.Vector3();
      hitTarget.getWorldPosition(hitWorldPos);

      let selectedWaypointName = '';
      xrManager.setCallbacks({
        onSelectWaypoint: (name) => {
          selectedWaypointName = name;
        },
      });

      // Simulate a hand hovering near the waypoint (5 cm away, within 8 cm hover radius)
      const handState = (xrManager as any).hands[0];
      handState.visualOutline.group.visible = true;
      const fingerPos = hitWorldPos.clone().add(new THREE.Vector3(0, 0.05, 0));
      handState.jointPosMap.set('index-finger-tip', fingerPos);
      handState.indexTipWorldPos.copy(fingerPos);
      handState.pinchWorldPos.copy(fingerPos);
      handState.isPinching = false;

      // Process hand grabs
      const grabsHover = (xrManager as any).processHandGrabs();
      // Should not grab diorama
      expect(grabsHover.length).toBe(0);
      expect(pin.userData.isHovered).toBe(true);

      // Now move fingertip to touch the marker (2 cm away, within 3.5 cm touch radius)
      const touchPos = hitWorldPos.clone().add(new THREE.Vector3(0, 0.02, 0));
      handState.jointPosMap.set('index-finger-tip', touchPos);
      handState.indexTipWorldPos.copy(touchPos);
      handState.pinchWorldPos.copy(touchPos);

      const grabsTouch = (xrManager as any).processHandGrabs();
      // Should select waypoint and claim interaction
      expect(grabsTouch.length).toBe(0); // Zero diorama grabs!
      expect(selectedWaypointName).toBe('Glacier Camp');
      expect(pin.userData.isSelected).toBe(true);
      expect(handState.activeInteraction).toBe('waypoint');
    });
  });
});
