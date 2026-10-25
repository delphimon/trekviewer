import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { TiledTerrainStreamer } from '../src/terrain/TiledTerrainStreamer.ts';
import { TerrainImageryMaterial } from '../src/terrain/TerrainImageryMaterial.ts';
import { ImageryBatchRenderer } from '../src/terrain/ImageryBatchRenderer.ts';
import { ImageryLODManager, type ImageryPatch } from '../src/terrain/ImageryLODManager.ts';
import { OfflineStore, hashOfflineBlob } from '../src/offline/OfflineStore.ts';
import { planOfflineRoute, type OfflinePlan } from '../src/offline/OfflinePlan.ts';
import { OfflineDownloadsPanel } from '../src/offline/OfflineDownloadsPanel.ts';
import { offlineGeographicKey } from '../src/offline/OfflineSourceIdentity.ts';
import { exportOfflineArchive, inspectOfflineArchive, offlineArchiveSource } from '../src/offline/OfflineArchive.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import { SurfaceVertexIndex } from '../src/visualization/SurfaceVertexIndex.ts';
import { DioramaBase } from '../src/visualization/DioramaBase.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { GPXValidator } from '../src/gpx/GPXValidator.ts';
import { calculateElevationStats } from '../src/gpx/ElevationStats.ts';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { TrekSession } from '../src/core/TrekSession.ts';
import type { ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import type { TrackStats } from '../src/gpx/TrackTypes.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createMockElevationGrid(ele = 1800): ElevationGrid {
  const width = 512;
  const height = 512;
  return {
    zoom: 13,
    tileXMin: 1324,
    tileXMax: 1325,
    tileYMin: 2886,
    tileYMax: 2887,
    numTilesX: 2,
    numTilesY: 2,
    width,
    height,
    data: new Float32Array(width * height).fill(ele),
    tileValidity: new Uint8Array(4).fill(1),
    minElevation: ele - 200,
    maxElevation: ele + 200,
    isRealDEM: true,
    source: 'USGS 3DEP 1m',
  };
}

describe('Architecture Review Fixes (Phases 1-10)', () => {
  it('1. LocalTerrainChunk strips raw DEM buffers after sampling and supports dynamic outerEdges blending', () => {
    const rawGrid = createMockElevationGrid(2000);
    expect(rawGrid.data.length).toBeGreaterThan(0);

    const chunk = new LocalTerrainChunk({
      localGrid: rawGrid,
      centerLat: 46.855,
      centerLon: -121.755,
      referenceCenterLat: 46.855,
      referenceCenterLon: -121.755,
      terrainBaseElevation: 1000,
      radiusMeters: 200,
      segments: 8,
      initialExaggeration: 1.0,
      baseElevationSampler: () => 500,
      outerEdges: { north: true, south: false, east: false, west: false },
    });

    // Summarized grid strips multi-MB Float32Array and Uint8Array buffers
    const retained = (chunk as any).currentGrid as ElevationGrid;
    expect(retained.data.length).toBe(0);
    expect(retained.tileValidity.length).toBe(0);
    expect(retained.minElevation).toBe(1800);
    expect(retained.maxElevation).toBe(2200);
    expect(retained.source).toBe('USGS 3DEP 1m');

    // North outer edge (iz = 0) blends to baseElevationSampler (500), while South inner edge (iz = segments) stays at DEM (2000 - 1000 = 1000)
    const pos = chunk.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const northMidIdx = 4; // row 0, col 4
    const southMidIdx = 8 * 9 + 4; // row 8, col 4
    expect(pos.getY(northMidIdx)).toBeCloseTo(500, 1);
    expect(pos.getY(southMidIdx)).toBeCloseTo(1000, 1);

    // Dynamically promote south edge to an outer boundary -> blends south edge to baseElevationSampler (500)
    expect(chunk.setOuterEdges({ north: true, south: true, east: false, west: false })).toBe(true);
    expect(pos.getY(southMidIdx)).toBeCloseTo(500, 1);

    chunk.dispose();
  });

  it('2. TiledTerrainStreamer.activeVisibleChunk returns the most recently prioritized visible chunk and computes neighbor outerEdges', () => {
    const streamer: any = Object.create(TiledTerrainStreamer.prototype);
    const setOuterEdges0 = vi.fn().mockReturnValue(true);
    const setOuterEdges1 = vi.fn().mockReturnValue(true);
    const chunkOld = { mesh: { visible: true }, id: 'old', setOuterEdges: setOuterEdges0 };
    const chunkNew = { mesh: { visible: true }, id: 'new', setOuterEdges: setOuterEdges1 };
    streamer.chunks = new Map([
      ['2:3', chunkOld],
      ['3:3', chunkNew],
    ]);
    streamer.focusTileId = null;
    expect(streamer.activeVisibleChunk).toBe(chunkNew);

    streamer.focusTileId = '2:3';
    expect(streamer.activeVisibleChunk).toBe(chunkOld);

    // Tile 2:3 has visible neighbor 3:3 to its east; tile 3:3 has visible neighbor 2:3 to its west
    expect(streamer.computeOuterEdgesForTile('2:3')).toEqual({
      north: true,
      south: true,
      east: false,
      west: true,
    });
    expect(streamer.computeOuterEdgesForTile('3:3')).toEqual({
      north: true,
      south: true,
      east: true,
      west: false,
    });
    expect(streamer.syncNeighborOuterEdges()).toBe(true);
    expect(setOuterEdges0).toHaveBeenCalledWith({ north: true, south: true, east: false, west: true });
    expect(setOuterEdges1).toHaveBeenCalledWith({ north: true, south: true, east: true, west: false });
  });

  it('3. TerrainImageryMaterial preserves shadow receiving and avoids +0.04m vertex elevation shift', () => {
    const bounds = {
      minLat: 46.8,
      maxLat: 46.9,
      minLon: -121.8,
      maxLon: -121.7,
      centerLat: 46.85,
      centerLon: -121.75,
      widthMeters: 6000,
      depthMeters: 9000,
      minEle: 1000,
      maxEle: 2500,
      elevationSpan: 1500,
    };
    const grid = { zoom: 14, tileXMin: 2650, tileXMax: 2653, tileYMin: 5774, tileYMax: 5777, numTilesX: 4, numTilesY: 4 };
    const mat = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), mat);
    const tim = new TerrainImageryMaterial(bounds, grid);
    tim.sync({ pages: [], entries: [] }, [mesh]);

    const shader: any = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <uv_vertex>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>\nbool test = a && receiveShadow;',
    };
    mat.onBeforeCompile(shader, {} as any);
    expect(shader.vertexShader).not.toContain('transformed.y += 0.04');
    expect(shader.fragmentShader).toContain('&& receiveShadow');
    expect(shader.fragmentShader).not.toContain('&& !terrainTilePresent');
    tim.dispose();
    mesh.geometry.dispose();
    mat.dispose();
  });

  it('4. ImageryBatchRenderer skips BatchedMesh allocation and packs cross-zoom tiles when directSurface is enabled', () => {
    const renderer = new ImageryBatchRenderer(4, true);
    const page1 = (renderer as any).createPage({ zoom: 15, texture: { anisotropy: 4 }, mesh: { renderOrder: 1 } }, 256, 256, 256 * 256 * 4 * 32);

    expect(page1.mesh).toBeUndefined();
    const diag = renderer.getDiagnostics();
    expect(diag.pages).toBe(1);
    expect(diag.geometryBytes).toBe(0);
    expect(renderer.group.children.length).toBe(0);

    renderer.clear();
  });

  it('5. ImageryLODManager builds lightweight terrain-sampled bounds geometry when terrainImagery is active', () => {
    const bounds = {
      minLat: 46.8,
      maxLat: 46.9,
      minLon: -121.8,
      maxLon: -121.7,
      centerLat: 46.85,
      centerLon: -121.75,
      widthMeters: 6000,
      depthMeters: 9000,
      minEle: 1000,
      maxEle: 2500,
      elevationSpan: 1500,
    };
    const terrainMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 9000, 4, 4),
      new THREE.MeshStandardMaterial()
    );
    const manager: any = new ImageryLODManager({
      experimentalTerrainImagery: true,
      terrainMesh,
      terrainGeoBounds: bounds,
      terrainBaseElevation: 1000,
      elevationSampler: (x, z) => 500 + x * 0.01 + z * 0.01,
      verticalExaggeration: 2.0,
    });

    const geo: THREE.BufferGeometry = manager.buildLightweightBoundsGeometry(15, 5300, 11548);
    expect(geo.boundingBox).not.toBeNull();
    expect(geo.boundingBox!.min.y).toBeGreaterThan(800);
    expect(geo.boundingBox!.max.y).toBeGreaterThan(geo.boundingBox!.min.y);

    geo.dispose();
    manager.dispose();
    terrainMesh.geometry.dispose();
    (terrainMesh.material as THREE.Material).dispose();
  });

  it('6. OfflineStore.read skips per-tile SHA-256 digest hashing, indexes geographic keys, and exports portable .tar archives', async () => {
    const url = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export?bbox=-13547950.402958488%2C5918272.071436257%2C-13546956.33033472%2C5919266.14406156&bboxSR=3857&imageSR=3857&size=512%2C512';
    const altServiceUrl = 'https://imagery.geoplatform.gov/iipp/rest/services/NAIP/NAIP_plus/ImageServer/exportImage?bbox=-13547950.402958488%2C5918272.071436258%2C-13546956.33033472%2C5919266.14406156&bboxSR=3857&imageSR=3857&size=512%2C512';
    expect(offlineGeographicKey(url)).toBe('geo:image:3857:-13547950.403,5918272.071,-13546956.330,5919266.144:512,512');
    expect(offlineGeographicKey(altServiceUrl)).toBe(offlineGeographicKey(url));

    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    const sha = await hashOfflineBlob(blob);
    vi.spyOn(OfflineStore, 'available').mockReturnValue(true);
    (OfflineStore as any).readyIds = Promise.resolve(new Set(['pack-1']));
    vi.spyOn(OfflineStore as any, 'transaction').mockResolvedValue({
      key: 'pack-1\n' + url,
      packId: 'pack-1',
      urls: [url],
      sourceUrl: url,
      bytes: 4,
      sha256: sha,
      blob,
    });
    const digestSpy = vi.spyOn(crypto.subtle, 'digest');

    const result = await OfflineStore.read(url);
    expect(result).toBe(blob);
    expect(digestSpy).not.toHaveBeenCalled();

    // Verify exportOfflineArchive round-trips a ready pack into a valid USTAR .tar Blob
    const miniPlan: OfflinePlan = {
      id: 'pack-1',
      routeId: 'rainier-emmons',
      routeHash: 'a'.repeat(64),
      name: 'Rainier Mini',
      version: 2,
      coverage: 'full-model',
      maxZoom: 19,
      estimatedBytes: 4,
      resources: [{ kind: 'image', width: 512, height: 512, urls: [url] }],
    };
    vi.spyOn(OfflineStore, 'state').mockResolvedValue({
      id: 'pack-1',
      routeId: 'rainier-emmons',
      name: 'Rainier Mini',
      routeHash: 'a'.repeat(64),
      state: 'ready',
      total: 1,
      completed: 1,
      bytes: 4,
      estimatedBytes: 4,
      message: 'Ready',
      updated: Date.now(),
    });
    vi.spyOn(OfflineStore, 'stored').mockResolvedValue({
      key: 'pack-1\n' + url,
      packId: 'pack-1',
      urls: [url],
      sourceUrl: url,
      bytes: 4,
      sha256: sha,
      blob,
    });
    const tarBlob = await exportOfflineArchive(miniPlan);
    const archiveIndex = await inspectOfflineArchive(tarBlob);
    expect(archiveIndex.manifest.planId).toBe('pack-1');
    const archiveSource = await offlineArchiveSource(tarBlob, archiveIndex, miniPlan);
    const loaded = await archiveSource.load(0, new AbortController().signal);
    expect(loaded.sourceUrl).toBe(url);
    expect(loaded.blob.size).toBe(4);
    (OfflineStore as any).readyIds = undefined;
  });

  it('7. planOfflineRoute supports corridor-v3 mode with significantly smaller footprint while preserving full-v2 default', () => {
    const xml = `<gpx><trk><name>Rainier</name><trkseg>
      <trkpt lat="46.852" lon="-121.760"><ele>1400</ele></trkpt>
      <trkpt lat="46.858" lon="-121.752"><ele>2200</ele></trkpt>
    </trkseg></trk></gpx>`;
    const track = GPXParser.parse(xml);
    const hash = 'b'.repeat(64);

    const v2Plan = planOfflineRoute(track, 'rainier-emmons', hash);
    const v3Plan = planOfflineRoute(track, 'rainier-emmons', hash, {
      mode: 'corridor-v3',
      corridorMeters: 800,
      maxImageryZoom: 18,
    });

    expect(v2Plan.version).toBe(2);
    expect(v2Plan.coverage).toBe('full-model');
    expect(v2Plan.maxZoom).toBe(19);

    expect(v3Plan.version).toBe(3);
    expect(v3Plan.coverage).toBe('corridor');
    expect(v3Plan.maxZoom).toBe(18);
    expect(v3Plan.resources.length).toBeLessThan(v2Plan.resources.length);
    expect(v3Plan.estimatedBytes).toBeLessThan(v2Plan.estimatedBytes);

    // OfflineDownloadsPanel getSelectedMode defaults to full-v2 and switches to corridor-v3 when selected
    const panel: any = Object.create(OfflineDownloadsPanel.prototype);
    panel.modeSelect = { value: 'full-v2' };
    expect(panel.getSelectedMode()).toBe('full-v2');
    panel.modeSelect.value = 'corridor-v3';
    expect(panel.getSelectedMode()).toBe('corridor-v3');
  });

  it('8. FlyoverController advances across stationary GPS points in first-person mode without freezing', () => {
    const xml = `<gpx><trk><name>Stationary Test</name><trkseg>
      <trkpt lat="46.8500" lon="-121.7500"><ele>1500</ele><time>2026-07-01T10:00:00Z</time></trkpt>
      <trkpt lat="46.8500" lon="-121.7500"><ele>1500</ele><time>2026-07-01T10:00:05Z</time></trkpt>
      <trkpt lat="46.8510" lon="-121.7500"><ele>1520</ele><time>2026-07-01T10:01:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const track = GPXParser.parse(xml);
    const trail = TrailMesh.create(track, () => 1500);
    const controller = new FlyoverController(trail, track, () => 1500);
    const dioramaRoot = new THREE.Group();
    const camera = new THREE.PerspectiveCamera();

    controller.setViewMode('first-person');
    controller.play();
    // Advance across the 5-second stationary segment into the moving segment
    controller.update(6.0, camera, dioramaRoot);
    expect(controller.getProgress()).toBeGreaterThan(0);
    trail.dispose();
  });

  it('9. SurfaceVertexIndex emits multi-span updateRanges for disjoint loop vertices and shrinks boundingBox on full update', () => {
    const positions = new Float32Array(300 * 3);
    for (let i = 0; i < 300; i++) {
      positions[i * 3] = i * 10;
      positions[i * 3 + 1] = 500;
      positions[i * 3 + 2] = 0;
    }
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    geo.setAttribute('position', posAttr);

    const index = new SurfaceVertexIndex(geo, 100, false);
    expect(geo.boundingBox!.max.y).toBe(500);

    // Disjoint updates at vertex 0 and vertex 250 (> 64 vertices apart)
    posAttr.setY(0, 600);
    posAttr.setY(250, 650);
    index.updatePositions([0, 250]);
    expect(posAttr.updateRanges).toEqual([
      { start: 0, count: 3 },
      { start: 750, count: 3 },
    ]);

    // Lowering all vertices shrinks boundingBox.max.y
    const all: number[] = [];
    for (let i = 0; i < 300; i++) {
      posAttr.setY(i, 100);
      all.push(i);
    }
    index.updatePositions(all);
    expect(geo.boundingBox!.max.y).toBe(100);
    expect(geo.boundingBox!.min.y).toBe(100);

    geo.dispose();
  });

  it('10. TrailMesh creates a distinct mid-route summit beacon and defers first-person normal updates until mode switch', () => {
    const xml = `<gpx><trk><name>Out and Back Peak</name><trkseg>
      <trkpt lat="46.850" lon="-121.750"><ele>1000</ele></trkpt>
      <trkpt lat="46.860" lon="-121.750"><ele>2500</ele></trkpt>
      <trkpt lat="46.850" lon="-121.750"><ele>1000</ele></trkpt>
    </trkseg></trk></gpx>`;
    const track = GPXParser.parse(xml);
    const trail = TrailMesh.create(track, () => 1000);

    expect(trail.summitBeacon).not.toBe(trail.finishBeacon);

    // Reproject while in diorama mode -> defers first-person normal updates until setViewMode('first-person')
    trail.reprojectToSurface?.((_x, z) => 1200 + z * 0.2, {
      minX: -5000,
      maxX: 5000,
      minZ: -5000,
      maxZ: 5000,
    });
    trail.setViewMode('first-person');
    const fpGeo = trail.trailMesh.geometry;
    const expected = fpGeo.clone();
    expected.computeVertexNormals();
    for (let i = 0; i < fpGeo.attributes.normal.array.length; i++) {
      expect(fpGeo.attributes.normal.array[i]).toBeCloseTo(expected.attributes.normal.array[i], 5);
    }

    expected.dispose();
    trail.dispose();
  });

  it('11. DioramaBase updates off-route connector lines, prioritizes exact waypoint names, and labels ScaleBar', () => {
    const xml = `<gpx>
      <wpt lat="46.850" lon="-121.750"><name>Camp Muir</name><ele>3000</ele></wpt>
      <wpt lat="46.855" lon="-121.720"><name>Camp</name><ele>2200</ele></wpt>
      <trk><name>Rainier</name><trkseg>
        <trkpt lat="46.850" lon="-121.750"><ele>1500</ele></trkpt>
        <trkpt lat="46.860" lon="-121.750"><ele>2500</ele></trkpt>
      </trkseg></trk>
    </gpx>`;
    const track = GPXParser.parse(xml);
    const routeGeo = new RouteGeometry(track, track.bounds.minEle);
    for (const wp of track.waypoints) {
      wp.projection = routeGeo.projectGeoPointToVisualRoute(wp.lat, wp.lon);
    }
    const base = DioramaBase.create(
      track.bounds,
      -80,
      track.waypoints,
      track.bounds.minEle,
      () => 500,
      1.0
    );

    const scaleBar = base.getObjectByName('ScaleBar');
    expect(scaleBar?.userData.scaleMeters).toBe(1000);
    expect(scaleBar?.userData.label).toBe('1 km');

    // Exact match 'Camp' should select 'Camp' rather than substring match 'Camp Muir'
    DioramaBase.selectWaypointByName(base, 'Camp');
    const wpGroup = base.getObjectByName('Waypoints')!;
    const campMuirPin = wpGroup.getObjectByName('Waypoint_Camp Muir')!;
    const campPin = wpGroup.getObjectByName('Waypoint_Camp')!;
    expect(campPin.userData.isSelected).toBe(true);
    expect(campMuirPin.userData.isSelected).toBe(false);

    // Off-route connector line updates on vertical exaggeration
    const connector = base.getObjectByName('WaypointConnectorLine') as THREE.Line;
    expect(connector).toBeDefined();
    const posBefore = (connector.geometry.attributes.position as THREE.BufferAttribute).getY(0);
    DioramaBase.setVerticalExaggeration(base, 2.0);
    const posAfter = (connector.geometry.attributes.position as THREE.BufferAttribute).getY(0);
    expect(posAfter).toBeCloseTo(posBefore * 2.0, 1);
  });

  it('12. GPXParser preserves trek name over waypoint name, and GPXValidator replaces corrupted first point and clamps non-monotonic time', () => {
    const xml = `<gpx>
      <wpt lat="46.85" lon="-121.75"><name>Trailhead Toilet</name><ele>invalid</ele></wpt>
      <trk><name>Iconic Alpine Traverse</name><trkseg>
        <trkpt lat="0.000" lon="0.000"><ele>1000</ele><time>2026-07-01T10:00:00Z</time></trkpt>
        <trkpt lat="46.850" lon="-121.750"><ele>1500</ele><time>2026-07-01T10:01:00Z</time></trkpt>
        <trkpt lat="46.852" lon="-121.750"><ele>1550</ele><time>2026-07-01T10:00:30Z</time></trkpt>
      </trkseg></trk>
    </gpx>`;
    const track = GPXParser.parse(xml);
    expect(track.name).toBe('Iconic Alpine Traverse');
    expect(track.waypoints[0].ele).toBeUndefined();
    // Corrupted (0, 0) startup point was replaced by the valid trailhead coordinate
    expect(track.points[0].lat).toBeCloseTo(46.85, 3);
    // Non-monotonic timestamp was clamped so elapsedSeconds is non-decreasing
    for (let i = 1; i < track.points.length; i++) {
      expect(track.points[i].elapsedSeconds).toBeGreaterThanOrEqual(track.points[i - 1].elapsedSeconds);
    }
  });

  it('13. calculateElevationStats supports peak/trough extremum tracking when trackExtrema is enabled', () => {
    const pts = [
      { ele: 100, distanceFromStart: 0 },
      { ele: 106, distanceFromStart: 100 },
      { ele: 110, distanceFromStart: 200 },
      { ele: 100, distanceFromStart: 300 },
    ];
    const standard = calculateElevationStats(pts, { windowMeters: 1, hysteresisMeters: 5 });
    const extrema = calculateElevationStats(pts, { windowMeters: 1, hysteresisMeters: 5, trackExtrema: true });
    expect(extrema.elevationGain).toBe(10);
    expect(extrema.elevationLoss).toBe(10);
    expect(extrema.elevationGain).toBeGreaterThan(standard.elevationGain);
  });

  it('14. SpatialHUD supports setTrack reuse, landmark chart pin clicks, and TrekSession horizonLocked state', () => {
    const session = new TrekSession();
    expect(session.getState().horizonLocked).toBe(true);
    session.setHorizonLocked(false);
    expect(session.getState().horizonLocked).toBe(false);

    const hud: any = Object.create(SpatialHUD.prototype);
    hud.canvas = { width: 1024, height: 768 };
    hud.interactiveAreas = [];
    hud.drawHUD = vi.fn();
    hud.isDraggingScrubber = false;
    hud.scrubPointer = null;
    hud.track = { minElevation: 1000, maxElevation: 2000 };
    hud.allLandmarksSorted = [
      { name: 'Summit Peak', lat: 46.85, lon: -121.75, ele: 2000, progress: 0.5, type: 'summit' },
    ];
    const onSelectWaypoint = vi.fn();
    const onScrub = vi.fn();
    hud.callbacks = { onSelectWaypoint, onScrub };

    // Landmark at progress = 0.5, ele = 2000 -> lx = 53 + 0.5 * 918 = 512, ly = 195 + 190 - 24 - 1.0 * 142 = 219
    const uv = new THREE.Vector2(512 / 1024, 1 - 219 / 768);
    expect(hud.onPointerClick(uv, 'left')).toBe(true);
    expect(onSelectWaypoint).toHaveBeenCalledWith('Summit Peak', 46.85, -121.75, 0.5);
    expect(onScrub).not.toHaveBeenCalled();
  });
});
