import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { DioramaBase } from '../src/visualization/DioramaBase';
import { GPXWaypoint, TrackStats } from '../src/gpx/TrackTypes';
import { SpatialHUD } from '../src/ui/SpatialHUD';
import { DesktopOverlay } from '../src/ui/DesktopOverlay';

describe('Stage T4: Waypoint Marker Redesign & Landmark UX', () => {
  const sampleWaypoints: GPXWaypoint[] = [
    { name: 'Trailhead', lat: 46.852, lon: -121.760, ele: 1650, type: 'start', distanceMeters: 0 },
    { name: 'Panorama Point', lat: 46.810, lon: -121.720, ele: 2080, distanceMeters: 3200 },
    { name: 'Camp Muir', lat: 46.835, lon: -121.730, ele: 3070, type: 'camp', distanceMeters: 7400 },
    { name: 'Columbia Crest', lat: 46.852, lon: -121.758, ele: 4392, type: 'summit', distanceMeters: 14200 },
  ];

  const samplePoints = [
    { lat: 46.852, lon: -121.760, ele: 1650, time: new Date(0), distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
    { lat: 46.810, lon: -121.720, ele: 2080, time: new Date(3600000), distanceFromStart: 3200, elapsedSeconds: 3600, playbackSeconds: 3600, index: 1 },
    { lat: 46.835, lon: -121.730, ele: 3070, time: new Date(7200000), distanceFromStart: 7400, elapsedSeconds: 7200, playbackSeconds: 7200, index: 2 },
    { lat: 46.852, lon: -121.758, ele: 4392, time: new Date(14400000), distanceFromStart: 14200, elapsedSeconds: 14400, playbackSeconds: 14400, index: 3 },
  ];

  const mockBounds = {
    minLat: 46.80,
    maxLat: 46.86,
    minLon: -121.77,
    maxLon: -121.71,
    minEle: 1650,
    maxEle: 4392,
    elevationSpan: 4392 - 1650,
    centerLat: 46.83,
    centerLon: -121.74,
    widthMeters: 5000,
    depthMeters: 7000,
  };

  const mockTrack: TrackStats = {
    name: 'Mount Rainier Skyline & Muir',
    totalDistance: 14200,
    elevationGain: 2742,
    elevationLoss: 2742,
    maxElevation: 4392,
    minElevation: 1650,
    movingTime: 14400,
    totalPlaybackSeconds: 14400,
    avgSpeed: 0.98,
    maxSpeed: 2.5,
    bounds: mockBounds,
    points: samplePoints,
    segments: [],
    waypoints: sampleWaypoints,
    landmarks: [
      { name: 'Columbia Crest', lat: 46.852, lon: -121.758, ele: 4392, type: 'summit' },
      { name: 'Trailhead', lat: 46.852, lon: -121.760, ele: 1650, type: 'start' },
    ],
    warnings: [],
  };

  let globalMockCtx: any;

  beforeEach(() => {
    globalMockCtx = {
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

    (globalThis as any).document = {
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        getContext: () => globalMockCtx,
        width: 1024,
        height: 680,
        style: {},
      }),
    };
  });

  describe('Diorama Waypoint Markers (Sections 21, 22, 26, 27)', () => {
    it('creates compact visual marker, invisible hit target sphere, and billboard label', () => {
      const diorama = DioramaBase.create(mockBounds, -80, sampleWaypoints, 1650, undefined, 1.0);

      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      expect(wpGroup).toBeDefined();
      expect(wpGroup.children.length).toBe(4);

      const pin = wpGroup.children[0] as THREE.Group;
      expect(pin.name).toContain('Waypoint_');

      // Visual diamond mesh
      const visualMesh = pin.getObjectByName('WaypointPinMesh');
      expect(visualMesh).toBeDefined();

      // Invisible hit target (Section 26)
      const hitTarget = pin.getObjectByName('WaypointHitTarget') as THREE.Mesh;
      expect(hitTarget).toBeDefined();
      expect(hitTarget.geometry).toBeInstanceOf(THREE.SphereGeometry);
      const sphereGeo = hitTarget.geometry as THREE.SphereGeometry;
      expect(sphereGeo.parameters.radius).toBe(24);
      expect((hitTarget.material as THREE.Material).visible).toBe(false);

      // Billboard label sprite (Section 22: hidden by default)
      const label = pin.getObjectByName('WaypointLabelSprite') as THREE.Sprite;
      expect(label).toBeDefined();
      expect(label.visible).toBe(false);
    });

    it('compensates marker local scale across diorama zoom levels to maintain ~2.2cm apparent size (Section 21)', () => {
      const diorama = DioramaBase.create(mockBounds, -80, sampleWaypoints, 1650, undefined, 1.0);
      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      camera.position.set(0, 1, 1);

      const testScales = [0.1, 0.5, 1.0, 2.5, 5.0];
      for (const dScale of testScales) {
        DioramaBase.updateWaypoints(diorama, camera, dScale, 0.016);
        for (const child of wpGroup.children) {
          const pin = child as THREE.Group;
          const apparentWorldSize = pin.scale.x * dScale;
          // Target apparent world size is ~0.022m (between 0.015m and 0.03m)
          expect(apparentWorldSize).toBeGreaterThanOrEqual(0.015);
          expect(apparentWorldSize).toBeLessThanOrEqual(0.03);
        }
      }
    });

    it('handles hover and select lifecycle with timeouts and automatic hide (Section 27)', () => {
      const diorama = DioramaBase.create(mockBounds, -80, sampleWaypoints, 1650, undefined, 1.0);
      const wpGroup = diorama.getObjectByName('Waypoints') as THREE.Group;
      const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      camera.position.set(0, 1, 1);

      const pin0 = wpGroup.children[0] as THREE.Group;
      const label0 = pin0.getObjectByName('WaypointLabelSprite') as THREE.Sprite;

      // 1. Initial state: hidden
      DioramaBase.updateWaypoints(diorama, camera, 1.0, 0.016);
      expect(label0.visible).toBe(false);

      // 2. Hover activates label immediately
      DioramaBase.onHoverWaypoint(diorama, pin0);
      expect(label0.visible).toBe(true);

      // 3. Unhover starts 0.8s timeout
      DioramaBase.onUnhoverWaypoint(diorama);
      expect(pin0.userData.hoverTimeout).toBe(0.8);

      // Advance 0.5s: still visible
      DioramaBase.updateWaypoints(diorama, camera, 1.0, 0.5);
      expect(label0.visible).toBe(true);

      // Advance another 0.4s: timeout expires (0.9s > 0.8s) -> hidden
      DioramaBase.updateWaypoints(diorama, camera, 1.0, 0.4);
      expect(label0.visible).toBe(false);

      // 4. Select pin by name: sets 4.0s timeout and shows label
      DioramaBase.selectWaypointByName(diorama, 'Camp Muir');
      const muirPin = wpGroup.children.find((c) => c.userData.waypoint.name === 'Camp Muir') as THREE.Group;
      const muirLabel = muirPin.getObjectByName('WaypointLabelSprite') as THREE.Sprite;
      expect(muirLabel.visible).toBe(true);
      expect(muirPin.userData.selectTimeout).toBe(4.0);

      // Advance 3.0s: still visible
      DioramaBase.updateWaypoints(diorama, camera, 1.0, 3.0);
      expect(muirLabel.visible).toBe(true);

      // Advance another 1.2s: expires (4.2s > 4.0s) -> hidden
      DioramaBase.updateWaypoints(diorama, camera, 1.0, 1.2);
      expect(muirLabel.visible).toBe(false);
    });
  });

  describe('SpatialHUD Landmark Navigation (Sections 28, 29)', () => {

    it('extracts, deduplicates, and sorts landmarks by route distance', () => {
      const callbacks = {
        onTogglePlay: vi.fn(),
        onScrub: vi.fn(),
        onSetSpeed: vi.fn(),
        onToggleViewMode: vi.fn(),
        onSetTextureStyle: vi.fn(),
        onSetTrailColorMode: vi.fn(),
        onCycleVerticalExaggeration: vi.fn(),
        onStepSeconds: vi.fn(),
        onFocusHiker: vi.fn(),
        onToggleTexture: vi.fn(),
        onReset: vi.fn(),
        onExitMR: vi.fn(),
        onSelectWaypoint: vi.fn(),
      };

      const hud = new SpatialHUD(mockTrack, callbacks);
      const landmarks = (hud as any).allLandmarksSorted;
      expect(landmarks.length).toBeGreaterThan(0);

      // Verify sorted in ascending order of progress
      for (let i = 1; i < landmarks.length; i++) {
        expect(landmarks[i].progress).toBeGreaterThanOrEqual(landmarks[i - 1].progress);
      }
    });

    it('implements jumpToPreviousLandmark, jumpToNextLandmark, and getNearestLandmark', () => {
      const selectedWaypoints: string[] = [];
      const callbacks = {
        onTogglePlay: vi.fn(),
        onScrub: vi.fn(),
        onSetSpeed: vi.fn(),
        onToggleViewMode: vi.fn(),
        onSetTextureStyle: vi.fn(),
        onSetTrailColorMode: vi.fn(),
        onCycleVerticalExaggeration: vi.fn(),
        onStepSeconds: vi.fn(),
        onFocusHiker: vi.fn(),
        onToggleTexture: vi.fn(),
        onReset: vi.fn(),
        onExitMR: vi.fn(),
        onSelectWaypoint: (name: string) => selectedWaypoints.push(name),
      };

      const hud = new SpatialHUD(mockTrack, callbacks);

      // Start at 0 progress (Trailhead)
      hud.updateState(0.0, 1650, false, 'diorama', 'satellite');
      const nearestStart = hud.getNearestLandmark();
      expect(nearestStart?.name).toBe('Trailhead');

      // Jump to next landmark -> Panorama Point or Camp Muir
      hud.jumpToNextLandmark();
      expect(selectedWaypoints.length).toBe(1);
      expect(selectedWaypoints[0]).toBe('Panorama Point');

      // Update HUD progress to Camp Muir (~0.52 progress)
      hud.updateState(0.52, 3070, false, 'diorama', 'satellite');
      const nearestMuir = hud.getNearestLandmark();
      expect(nearestMuir?.name).toBe('Camp Muir');

      // Jump to previous landmark -> Panorama Point
      hud.jumpToPreviousLandmark();
      expect(selectedWaypoints.length).toBe(2);
      expect(selectedWaypoints[1]).toBe('Panorama Point');

      // Jump to next landmark -> Columbia Crest
      hud.jumpToNextLandmark();
      expect(selectedWaypoints.length).toBe(3);
      expect(selectedWaypoints[2]).toBe('Columbia Crest');
    });
  });

  describe('DesktopOverlay Landmark Dropdown & Elevation Profile Interaction (Sections 28, 30)', () => {
    let container: HTMLElement;
    let selectElement: any;
    let canvasChart: any;
    let elements: Map<string, any>;

    beforeEach(() => {
      elements = new Map();
      const mockCanvasCtx = {
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
        createLinearGradient: () => ({ addColorStop: vi.fn() }),
        drawImage: vi.fn(),
      };

      (globalThis as any).document = {
        createElement: (tag: string) => {
          const listeners: Record<string, ((e?: any) => void)[]> = {};
          const el: any = {
            tagName: tag.toUpperCase(),
            style: {},
            classList: {
              add: vi.fn(),
              remove: vi.fn(),
              toggle: vi.fn(),
            },
            appendChild: (child: any) => {
              if (el.tagName === 'SELECT' && child.tagName === 'OPTION') {
                el.options.push(child);
              }
            },
            removeChild: vi.fn(),
            children: [],
            options: [],
            addEventListener: (evt: string, fn: any) => {
              listeners[evt] = listeners[evt] || [];
              listeners[evt].push(fn);
            },
            dispatchEvent: (event: any) => {
              (listeners[event.type] || []).forEach((fn) => fn(event));
            },
            getContext: () => mockCanvasCtx,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 70 }),
            width: 800,
            height: 70,
            value: '',
            selectedIndex: 0,
          };
          return el;
        },
        getElementById: (id: string) => {
          if (!elements.has(id)) {
            const el = (globalThis as any).document.createElement(id.includes('canvas') ? 'canvas' : id.includes('Select') || id.includes('select') ? 'select' : 'div');
            el.id = id;
            elements.set(id, el);
          }
          return elements.get(id);
        },
        querySelectorAll: () => [],
      };

      (globalThis as any).window = {
        addEventListener: vi.fn(),
        setTimeout: vi.fn(),
        clearTimeout: vi.fn(),
      };

      container = (globalThis as any).document.createElement('div');
    });

    it('populates selectLandmark dropdown and fires onSelectWaypoint on selection (Section 28)', () => {
      let selectedWaypoint: { name: string; lat: number; lon: number } | null = null;
      const callbacks = {
        onSelectRoute: vi.fn(),
        onUploadGPX: vi.fn(),
        onEnterXR: vi.fn(),
        onToggleViewMode: vi.fn(),
        onTogglePlay: vi.fn(),
        onSetSpeed: vi.fn(),
        onScrub: vi.fn(),
        onSetTextureStyle: vi.fn(),
        onSetTrailColorMode: vi.fn(),
        onSelectWaypoint: (name: string, lat: number, lon: number) => {
          selectedWaypoint = { name, lat, lon };
        },
      };

      const overlay = new DesktopOverlay(container, callbacks);
      overlay.updateTrack(mockTrack);

      const selectLandmark = (globalThis as any).document.getElementById('selectLandmark');
      expect(selectLandmark).toBeDefined();
      expect(selectLandmark.options.length).toBeGreaterThan(1);

      // Select Camp Muir
      const muirOptionIndex = selectLandmark.options.findIndex((opt: any) => opt.textContent.includes('Camp Muir'));
      expect(muirOptionIndex).toBeGreaterThan(0);

      selectLandmark.selectedIndex = muirOptionIndex;
      selectLandmark.value = selectLandmark.options[muirOptionIndex].value;
      selectLandmark.dispatchEvent({ type: 'change' });

      expect(selectedWaypoint).not.toBeNull();
      expect(selectedWaypoint!.name).toBe('Camp Muir');
      expect(selectedWaypoint!.lat).toBeCloseTo(46.835, 2);
    });

    it('supports interactive elevation profile landmark click jump (Section 30)', () => {
      let selectedWaypoint: { name: string; lat: number; lon: number } | null = null;
      let scrubbedProgress: number | null = null;

      const callbacks = {
        onSelectRoute: vi.fn(),
        onUploadGPX: vi.fn(),
        onEnterXR: vi.fn(),
        onToggleViewMode: vi.fn(),
        onTogglePlay: vi.fn(),
        onSetSpeed: vi.fn(),
        onScrub: (p: number) => {
          scrubbedProgress = p;
        },
        onSetTextureStyle: vi.fn(),
        onSetTrailColorMode: vi.fn(),
        onSelectWaypoint: (name: string, lat: number, lon: number) => {
          selectedWaypoint = { name, lat, lon };
        },
      };

      const overlay = new DesktopOverlay(container, callbacks);
      overlay.updateTrack(mockTrack);

      const chartLandmarks = (overlay as any).chartLandmarks;
      expect(chartLandmarks.length).toBeGreaterThan(0);

      const muirChartLm = chartLandmarks.find((cl: any) => cl.landmark.name === 'Camp Muir');
      expect(muirChartLm).toBeDefined();

      const canvasChart = (globalThis as any).document.getElementById('canvasChart');

      // Click directly on Camp Muir pin on chart
      canvasChart.dispatchEvent({
        type: 'click',
        clientX: muirChartLm.x,
        clientY: muirChartLm.y,
      });

      expect(selectedWaypoint).not.toBeNull();
      expect(selectedWaypoint!.name).toBe('Camp Muir');

      // Click away from any landmark pin (e.g. x: 400, y: 10) -> triggers scrub
      selectedWaypoint = null;
      canvasChart.dispatchEvent({
        type: 'click',
        clientX: 400,
        clientY: 10,
      });
      expect(selectedWaypoint).toBeNull();
      expect(scrubbedProgress).toBeCloseTo(400 / 800, 2);
    });
  });
});
