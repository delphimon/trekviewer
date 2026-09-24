import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { DioramaBase } from '../src/visualization/DioramaBase';
import { XRManager, ALL_HAND_JOINTS, WAYPOINT_HOVER_RADIUS, WAYPOINT_TOUCH_RADIUS, WAYPOINT_REARM_RADIUS } from '../src/core/XRManager';
import { GPXWaypoint } from '../src/gpx/TrackTypes';
import { TrekSession } from '../src/core/TrekSession';
import { TrekViewerApp } from '../src/main';

describe('Stage V2: Waypoint Touch Latching, Rearm Hysteresis & Elevation Precision', () => {
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

  describe('2.1 Touch Latching & Rearm Hysteresis', () => {
    it('fires selection callback exactly once when held over marker for 72 frames, and rearms on exit', () => {
      const mockCamera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      const mockDioramaRoot = new THREE.Group();
      const mockScene = new THREE.Scene();
      const mockControllers = [new THREE.Group(), new THREE.Group()];
      const mockGrips = [new THREE.Group(), new THREE.Group()];
      const mockHands: THREE.Group[] = [];

      for (let i = 0; i < 2; i++) {
        const h = new THREE.Group();
        const joints: any = {};
        for (const jName of ALL_HAND_JOINTS) {
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
            getSession: () => ({ inputSources: [] }),
            getController: (idx: number) => mockControllers[idx],
            getControllerGrip: (idx: number) => mockGrips[idx],
            getHand: (idx: number) => mockHands[idx],
            isPresenting: true,
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
      const sampleWp: GPXWaypoint = { lat: 46.85, lon: -121.75, ele: 1500, name: 'Camp 3' };
      const diorama = DioramaBase.create(mockBounds, -80, [sampleWp], 1000);
      mockSceneManager.dioramaRoot.add(diorama);
      mockSceneManager.dioramaRoot.position.set(0, 0.82, -0.80);
      mockSceneManager.dioramaRoot.updateMatrixWorld(true);

      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      const pin = wpGroup.children[0] as THREE.Group;
      const hitTarget = pin.getObjectByName('WaypointHitTarget') as THREE.Mesh;
      const hitWorldPos = new THREE.Vector3();
      hitTarget.getWorldPosition(hitWorldPos);

      let selectCount = 0;
      let lastSelectedName = '';
      xrManager.setCallbacks({
        onSelectWaypoint: (name) => {
          selectCount++;
          lastSelectedName = name;
        },
      });

      const handState = (xrManager as any).hands[0];
      handState.visualOutline.group.visible = true;

      // 1. Move fingertip directly into TOUCH radius (e.g. 2 cm away, <= WAYPOINT_TOUCH_RADIUS 3.5cm)
      const touchPos = hitWorldPos.clone().add(new THREE.Vector3(0, 0.02, 0));
      handState.jointPosMap.set('index-finger-tip', touchPos);
      handState.indexTipWorldPos.copy(touchPos);
      handState.pinchWorldPos.copy(touchPos);
      handState.isPinching = false;

      // Frame 1: Touch begins -> selection fires once
      (xrManager as any).processHandGrabs();
      expect(selectCount).toBe(1);
      expect(lastSelectedName).toBe('Camp 3');
      expect(handState.isTouchingWaypoint).toBe(true);
      expect(handState.activeInteraction).toBe('waypoint');

      // 2. Remain in touch radius for 72 consecutive frames (~1 second at 72Hz)
      for (let frame = 0; frame < 72; frame++) {
        // slight jitter (1mm) within touch zone
        const jitterPos = touchPos.clone().add(new THREE.Vector3(0.001 * Math.sin(frame), 0, 0));
        handState.jointPosMap.set('index-finger-tip', jitterPos);
        handState.indexTipWorldPos.copy(jitterPos);
        handState.pinchWorldPos.copy(jitterPos);

        const grabs = (xrManager as any).processHandGrabs();
        expect(grabs.length).toBe(0); // Never drags diorama
        expect(selectCount).toBe(1); // Selection callback MUST NOT fire again!
      }

      // 3. Move finger outward to 6.0 cm (>= WAYPOINT_REARM_RADIUS 5.0cm, but <= WAYPOINT_HOVER_RADIUS 8.0cm)
      const rearmPos = hitWorldPos.clone().add(new THREE.Vector3(0, 0.06, 0));
      handState.jointPosMap.set('index-finger-tip', rearmPos);
      handState.indexTipWorldPos.copy(rearmPos);
      handState.pinchWorldPos.copy(rearmPos);

      (xrManager as any).processHandGrabs();
      // Rearm hysteresis triggers: isTouchingWaypoint resets to false
      expect(handState.isTouchingWaypoint).toBe(false);
      expect(handState.isHoveringWaypoint).toBe(true);
      expect(selectCount).toBe(1);

      // 4. Move finger back to touch position (2.0 cm)
      handState.jointPosMap.set('index-finger-tip', touchPos);
      handState.indexTipWorldPos.copy(touchPos);
      handState.pinchWorldPos.copy(touchPos);

      (xrManager as any).processHandGrabs();
      // Selection callback fires exactly once more!
      expect(selectCount).toBe(2);
      expect(handState.isTouchingWaypoint).toBe(true);
    });
  });

  describe('2.2 Hover Transition Exclusivity (A -> B)', () => {
    it('immediately unhovers waypoint A when hover moves to waypoint B', () => {
      const mockDioramaRoot = new THREE.Group();
      const mockBounds = {
        minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7,
        minEle: 1000, maxEle: 2000, centerLat: 46.85, centerLon: -121.75,
        widthMeters: 5000, depthMeters: 5000, elevationSpan: 1000,
      };
      const wpA: GPXWaypoint = { lat: 46.82, lon: -121.78, ele: 1200, name: 'Pin A' };
      const wpB: GPXWaypoint = { lat: 46.88, lon: -121.72, ele: 1800, name: 'Pin B' };
      const diorama = DioramaBase.create(mockBounds, -80, [wpA, wpB], 1000);
      mockDioramaRoot.add(diorama);

      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      const pinA = wpGroup.children[0] as THREE.Group;
      const pinB = wpGroup.children[1] as THREE.Group;

      const labelA = pinA.getObjectByName('WaypointLabelSprite') as THREE.Sprite;
      const haloA = pinA.getObjectByName('WaypointHaloMesh') as THREE.Mesh;
      const labelB = pinB.getObjectByName('WaypointLabelSprite') as THREE.Sprite;
      const haloB = pinB.getObjectByName('WaypointHaloMesh') as THREE.Mesh;

      // Initially neither is hovered
      expect(pinA.userData.isHovered).toBeFalsy();
      expect(pinB.userData.isHovered).toBeFalsy();

      // 1. Hover on Pin A
      DioramaBase.onHoverWaypoint(mockDioramaRoot, pinA);
      expect(pinA.userData.isHovered).toBe(true);
      expect(labelA.visible).toBe(true);
      expect(haloA.visible).toBe(true);
      expect(pinB.userData.isHovered).toBeFalsy();
      expect(labelB.visible).toBe(false);

      // 2. Direct transition to Pin B
      DioramaBase.onHoverWaypoint(mockDioramaRoot, pinB);
      // Pin A must IMMEDIATELY lose hover and hide label/halo
      expect(pinA.userData.isHovered).toBe(false);
      expect(labelA.visible).toBe(false);
      expect(haloA.visible).toBe(false);

      // Pin B is now hovered
      expect(pinB.userData.isHovered).toBe(true);
      expect(labelB.visible).toBe(true);
      expect(haloB.visible).toBe(true);
    });
  });

  describe('2.3 Waypoint Jump Absolute Elevation Bug', () => {
    it('sets session progress with absolute elevation (meters above sea level), not local rendered Y', () => {
      const session = new TrekSession();
      const mockContainer = { appendChild: vi.fn() } as any;

      // Setup app context
      const app = Object.create(TrekViewerApp.prototype);
      app.session = session;
      app.overlay = { showStatus: vi.fn() };
      app.spatialHUD = { showStatus: vi.fn() };
      app.sceneManager = { dioramaRoot: new THREE.Group() };

      const track = {
        name: 'Camp Muir Trek',
        points: [
          { lat: 46.78, lon: -121.73, ele: 1650, distanceFromStart: 0 },
          { lat: 46.83, lon: -121.73, ele: 3070, distanceFromStart: 7200 },
        ],
        segments: [],
        totalDistance: 7200,
        elevationGain: 1420,
        elevationLoss: 0,
        minElevation: 1650,
        maxElevation: 3070,
        bounds: {
          minLat: 46.78, maxLat: 46.83, minLon: -121.73, maxLon: -121.73,
          minEle: 1650, maxEle: 3070, centerLat: 46.805, centerLon: -121.73,
          widthMeters: 1000, depthMeters: 6000, elevationSpan: 1420,
        },
        waypoints: [
          { lat: 46.83, lon: -121.73, ele: 3070, name: 'Camp Muir' },
        ],
        landmarks: [],
        movingTime: 7200,
        totalPlaybackSeconds: 7200,
        avgSpeed: 1.0,
        maxSpeed: 2.0,
        warnings: [],
      };

      const mockActiveTrek = {
        track,
        trailResult: {
          routeGeometry: {
            projectGeoPointToVisualRoute: (lat: number, lon: number) => ({
              progress: 1.0,
              routeDistanceMeters: 7200,
              distanceToRouteMeters: 0,
            }),
            getTelemetryAtDistance: (dist: number) => ({
              position: new THREE.Vector3(0, 142.0, -500), // Rendered Y = 142m
              tangent: new THREE.Vector3(0, 0, -1),
              forward: new THREE.Vector3(0, 0, -1),
              currentPoint: {
                lat: 46.83,
                lon: -121.73,
                ele: 3070, // Absolute elevation in meters!
                distanceFromStart: 7200,
                elapsedSeconds: 7200,
                playbackSeconds: 7200,
              },
              segmentIndex: 0,
              smoothedGrade: 0.15,
              smoothedSpeed: 1.0,
            }),
          },
        },
      };

      app.routeLoader = {
        getActiveTrek: () => mockActiveTrek,
      };

      // Jump to Camp Muir
      app.jumpToWaypoint('Camp Muir');

      // Invariant: Session elevation must be 3070m, NOT local 142.0m!
      const sessionState = session.getState();
      expect(sessionState.progress).toBe(1.0);
      expect(sessionState.currentElevation).toBe(3070);
      expect(sessionState.currentElevation).not.toBe(142.0);
    });
  });
});
