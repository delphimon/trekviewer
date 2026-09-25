import * as THREE from 'three';
import type { GeoBounds, TextureStyle, ViewMode, TrackStats } from '../gpx/TrackTypes.ts';
import type { RouteGeometry } from '../visualization/RouteGeometry.ts';
import {
  geoToLocalMeters,
  localMetersToGeo,
  latLonToTile,
  degToRad,
  radToDeg,
  clampLatitude,
  metersPerPixelAtZoom,
  tileBounds,
} from '../gpx/Coordinates.ts';
import type { ImageryProvider } from './providers/ImageryProvider.ts';
import { TextureProvider } from './TextureProvider.ts';
import { TileImageCache, TilePriority } from './TileImageCache.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';
import { type QualityProfile, QualityProfileManager } from './QualityProfile.ts';
import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';

export const ENABLE_ADAPTIVE_IMAGERY_LOD = true;

export type RefinementGroupState = 'parent' | 'loading' | 'promoting' | 'children';

export interface RefinementGroup {
  parentKey: string;
  style: TextureStyle;
  parentZoom: number;
  parentX: number;
  parentY: number;
  childZoom: number;
  fourChildKeys: [string, string, string, string];
  readyChildren: Set<string>;
  state: RefinementGroupState;
  requestStartTime?: number;
}

export interface ImageryPatch {
  key: string;
  zoom: number;
  x: number;
  y: number;
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  lastUsed: number;
  centerDist: number;
  creationTime: number;
  isFading: boolean;
  fadeDurationMs: number;
  outlineMesh?: THREE.LineSegments;
  dispose: () => void;
}

export interface ImageryLODManagerOptions {
  terrainGeoBounds: GeoBounds;
  terrainBaseElevation: number;
  elevationSampler: (x: number, z: number) => number;
  routeGeometry?: RouteGeometry;
  track?: TrackStats;
  viewMode?: ViewMode;
  verticalExaggeration?: number;
  textureStyle?: TextureStyle;
  maxPatches?: number;
  maxConcurrency?: number;
  enableInXR?: boolean;
  enableFadeIn?: boolean;
  debugPatchBounds?: boolean;
  terrainMesh?: THREE.Mesh;
  qualityProfile?: QualityProfile;
}

export interface ImageryLODDiagnostics {
  activePatchesCount: number;
  targetZoom: number;
  calculatedDesiredZoom: number;
  effectiveProviderClampedZoom: number;
  providerMaxZoom: number;
  inFlightRequests: number;
  requestQueueLength: number;
  pendingRequestsCount: number;
  patchesCreatedTotal: number;
  patchesDisposedTotal: number;
  generation: number;
  viewMode?: ViewMode;
  currentProgress?: number;
  debugPatchBounds?: boolean;
  // Stage U4 additions (Section 47)
  visibleByZoom: Map<number, number>;
  desiredZoom: number;
  readyHighResCount: number;
  totalDesiredHighResCount: number;
  requestedCount: number;
  readyCount: number;
  visibleCount: number;
  coveragePercent: number;
  z19AheadDistanceMeters: number;
  residentWarmCount: number;
  evictionsTotal: number;
  cacheHitRate: number;
  lastTimeToSharpMs: number;
}

interface PendingTileRequest {
  key: string;
  zoom: number;
  x: number;
  y: number;
  dist: number;
  style: TextureStyle;
  abortController: AbortController;
  priority?: TilePriority;
}

interface QueuedTile {
  key: string;
  zoom: number;
  x: number;
  y: number;
  dist: number;
  style: TextureStyle;
  priority?: TilePriority;
}

export interface XRViewMetrics {
  worldPosition: THREE.Vector3;
  forward: THREE.Vector3;
  verticalFov: number;
  viewportHeightPx: number;
}

/**
 * Derives representative viewing metrics from XR ArrayCamera or PerspectiveCamera (Section 45).
 */
export function getViewMetrics(
  camera: THREE.Camera,
  renderer?: THREE.WebGLRenderer
): XRViewMetrics {
  const worldPosition = new THREE.Vector3();
  camera.getWorldPosition(worldPosition);

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);

  let verticalFov = 60;
  let viewportHeightPx = typeof window !== 'undefined' ? window.innerHeight : 1080;

  // 1. Check if camera is an ArrayCamera with subcameras (WebXR stereo)
  const arrayCam = camera as THREE.ArrayCamera;
  if (arrayCam.cameras && arrayCam.cameras.length > 0) {
    const subCam = arrayCam.cameras[0];
    if (subCam.projectionMatrix && subCam.projectionMatrix.elements[5] > 0) {
      // elements[5] = 1 / tan(fovY / 2)
      verticalFov = 2 * Math.atan(1 / subCam.projectionMatrix.elements[5]) * (180 / Math.PI);
    }
    if ((subCam as any).viewport && (subCam as any).viewport.w) {
      viewportHeightPx = (subCam as any).viewport.w;
    }
  } else if ((camera as THREE.PerspectiveCamera).fov) {
    verticalFov = (camera as THREE.PerspectiveCamera).fov;
  } else if (camera.projectionMatrix && camera.projectionMatrix.elements[5] > 0) {
    verticalFov = 2 * Math.atan(1 / camera.projectionMatrix.elements[5]) * (180 / Math.PI);
  }

  // 2. Check WebXR framebuffer height from renderer if presenting
  if (renderer?.xr?.isPresenting) {
    const session = renderer.xr.getSession?.();
    const baseLayer = (renderer.xr as any).getBaseLayer
      ? (renderer.xr as any).getBaseLayer()
      : (session as any)?.renderState?.baseLayer;
    if (baseLayer?.framebufferHeight) {
      viewportHeightPx = baseLayer.framebufferHeight;
    }
  } else if (renderer?.domElement) {
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    if (size.y > 0) {
      viewportHeightPx = size.y;
    }
  }

  return {
    worldPosition,
    forward,
    verticalFov,
    viewportHeightPx,
  };
}

/**
 * Dynamic patch subdivision scaling (Section 44).
 * Matches base terrain geometry without inventing redundant terrain vertices on Quest.
 */
export function getPatchSubdivisionSegments(zoom: number): number {
  if (zoom >= 18) return 4;
  if (zoom >= 16) return 6;
  return 8;
}

/**
 * Pure tile key helper utilities.
 */
export function getTileKey(style: TextureStyle, zoom: number, x: number, y: number): string {
  return `${style}:${zoom}:${x}:${y}`;
}

export function parseTileKey(key: string): { style: TextureStyle; zoom: number; x: number; y: number } {
  const parts = key.split(':');
  return {
    style: parts[0] as TextureStyle,
    zoom: parseInt(parts[1], 10),
    x: parseInt(parts[2], 10),
    y: parseInt(parts[3], 10),
  };
}

export function getParentTileKey(style: TextureStyle, zoom: number, x: number, y: number): string | null {
  if (zoom <= 13) return null;
  return `${style}:${zoom - 1}:${Math.floor(x / 2)}:${Math.floor(y / 2)}`;
}

export function getChildTileKeys(style: TextureStyle, zoom: number, x: number, y: number): string[] {
  const nextZ = zoom + 1;
  const cx = x * 2;
  const cy = y * 2;
  return [
    `${style}:${nextZ}:${cx}:${cy}`,
    `${style}:${nextZ}:${cx + 1}:${cy}`,
    `${style}:${nextZ}:${cx}:${cy + 1}`,
    `${style}:${nextZ}:${cx + 1}:${cy + 1}`,
  ];
}

export interface CoherentTileCandidate {
  x: number;
  y: number;
  zoom: number;
  dist: number;
  isHighRes?: boolean;
}

/**
 * Selects coherent refinement rings (Sections 38, 39, 62).
 * Eliminates random checkerboard holes:
 * - Central focus: contiguous grid at zHigh (e.g. 3x3)
 * - Surrounding ring: contiguous perimeter ring at zMid
 * - Bounded strictly to maxPatches
 */
export function computeCoherentLODTiles(
  centerLat: number,
  centerLon: number,
  targetZoom: number,
  maxPatches: number,
  bounds: GeoBounds,
  secondaryCenterGeo?: { lat: number; lon: number },
  gazeVector?: { dx: number; dy: number }
): CoherentTileCandidate[] {
  if (targetZoom <= 13) {
    const centerTile = latLonToTile(centerLat, centerLon, targetZoom);
    const candidates: CoherentTileCandidate[] = [];
    let r = 0;
    while (candidates.length < maxPatches && r <= 6) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = centerTile.x + dx;
          const ty = centerTile.y + dy;
          if (ImageryLODManager.tileIntersectsBounds(tx, ty, targetZoom, bounds)) {
            candidates.push({
              x: tx,
              y: ty,
              zoom: targetZoom,
              dist: Math.hypot(dx, dy),
            });
            if (candidates.length >= maxPatches) break;
          }
        }
        if (candidates.length >= maxPatches) break;
      }
      r++;
    }
    return candidates;
  }

  const zHigh = targetZoom;
  const zMid = zHigh - 1;
  const centerTile = latLonToTile(centerLat, centerLon, zHigh);

  const centerParentX = Math.floor(centerTile.x / 2);
  const centerParentY = Math.floor(centerTile.y / 2);

  // Quadrant or gaze-directed step to find the primary 2x2 parent quadtree block (Stage W3)
  let stepX = centerTile.x % 2 === 0 ? -1 : 1;
  let stepY = centerTile.y % 2 === 0 ? -1 : 1;
  if (gazeVector) {
    if (Math.abs(gazeVector.dx) > 0.05) {
      stepX = gazeVector.dx > 0 ? 1 : -1;
    }
    if (Math.abs(gazeVector.dy) > 0.05) {
      stepY = gazeVector.dy > 0 ? 1 : -1;
    }
  }

  const minPx2x2 = Math.min(centerParentX, centerParentX + stepX);
  const maxPx2x2 = Math.max(centerParentX, centerParentX + stepX);
  const minPy2x2 = Math.min(centerParentY, centerParentY + stepY);
  const maxPy2x2 = Math.max(centerParentY, centerParentY + stepY);

  // Helper to generate candidate tiles for an explicit rectangular parent bounding box
  function tryParentBounds(
    minPx: number,
    maxPx: number,
    minPy: number,
    maxPy: number
  ): CoherentTileCandidate[] | null {
    const parentSet = new Set<string>();
    const parentList: { px: number; py: number }[] = [];

    const addParent = (px: number, py: number) => {
      const key = `${px},${py}`;
      if (!parentSet.has(key)) {
        parentSet.add(key);
        parentList.push({ px, py });
      }
    };

    for (let py = minPy; py <= maxPy; py++) {
      for (let px = minPx; px <= maxPx; px++) {
        addParent(px, py);
      }
    }

    if (secondaryCenterGeo) {
      const secCenterTile = latLonToTile(secondaryCenterGeo.lat, secondaryCenterGeo.lon, zHigh);
      const secParentX = Math.floor(secCenterTile.x / 2);
      const secParentY = Math.floor(secCenterTile.y / 2);
      addParent(secParentX, secParentY);
    }

    // High-resolution tiles: all 4 children per parent (Stage V4.1, Stage W3)
    const highTiles: CoherentTileCandidate[] = [];
    let pMinX = Infinity;
    let pMaxX = -Infinity;
    let pMinY = Infinity;
    let pMaxY = -Infinity;

    for (const { px, py } of parentList) {
      if (px < pMinX) pMinX = px;
      if (px > pMaxX) pMaxX = px;
      if (py < pMinY) pMinY = py;
      if (py > pMaxY) pMaxY = py;

      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const cx = px * 2 + dx;
          const cy = py * 2 + dy;
          if (ImageryLODManager.tileIntersectsBounds(cx, cy, zHigh, bounds)) {
            highTiles.push({
              x: cx,
              y: cy,
              zoom: zHigh,
              dist: Math.hypot(cx - centerTile.x, cy - centerTile.y),
              isHighRes: true,
            });
          }
        }
      }
    }

    if (highTiles.length === 0) return [];

    // Outer coherent perimeter ring at zMid surrounding the parent footprint
    const midTiles: CoherentTileCandidate[] = [];
    for (let py = pMinY - 1; py <= pMaxY + 1; py++) {
      for (let px = pMinX - 1; px <= pMaxX + 1; px++) {
        if (parentSet.has(`${px},${py}`)) continue;
        if (ImageryLODManager.tileIntersectsBounds(px, py, zMid, bounds)) {
          midTiles.push({
            x: px,
            y: py,
            zoom: zMid,
            dist: Math.hypot((px - (pMinX + pMaxX) / 2) * 2, (py - (pMinY + pMaxY) / 2) * 2) + 2.0,
            isHighRes: false,
          });
        }
      }
    }

    if (highTiles.length + midTiles.length <= maxPatches) {
      return [...highTiles, ...midTiles];
    }
    return null;
  }

  // 1. Try desktop extended footprint along gaze if budget allows (e.g. maxPatches >= 66)
  if (maxPatches >= 66 && gazeVector && (Math.abs(gazeVector.dx) > 0.1 || Math.abs(gazeVector.dy) > 0.1)) {
    let dMinPx = minPx2x2;
    let dMaxPx = maxPx2x2;
    let dMinPy = minPy2x2;
    let dMaxPy = maxPy2x2;
    if (Math.abs(gazeVector.dx) >= Math.abs(gazeVector.dy)) {
      dMinPx = Math.min(minPx2x2, centerParentX + 2 * stepX);
      dMaxPx = Math.max(maxPx2x2, centerParentX + 2 * stepX);
      dMinPy = centerParentY - 1;
      dMaxPy = centerParentY + 1;
    } else {
      dMinPx = centerParentX - 1;
      dMaxPx = centerParentX + 1;
      dMinPy = Math.min(minPy2x2, centerParentY + 2 * stepY);
      dMaxPy = Math.max(maxPy2x2, centerParentY + 2 * stepY);
    }
    const configDesktop = tryParentBounds(dMinPx, dMaxPx, dMinPy, dMaxPy);
    if (configDesktop) return configDesktop;
  }

  // 2. Try 3x3 desktop footprint if budget allows (maxPatches >= 52)
  if (maxPatches >= 52) {
    const config3x3 = tryParentBounds(centerParentX - 1, centerParentX + 1, centerParentY - 1, centerParentY + 1);
    if (config3x3) return config3x3;
  }

  // 3. Try gaze-extended 3x2 / 2x3 parent configuration (24 children + 14 ring = 38 patches) if budget allows (maxPatches >= 38)
  if (maxPatches >= 38 && gazeVector && (Math.abs(gazeVector.dx) > 0.1 || Math.abs(gazeVector.dy) > 0.1)) {
    let gMinPx = minPx2x2;
    let gMaxPx = maxPx2x2;
    let gMinPy = minPy2x2;
    let gMaxPy = maxPy2x2;
    if (Math.abs(gazeVector.dx) >= Math.abs(gazeVector.dy)) {
      gMinPx = Math.min(minPx2x2, centerParentX + 2 * stepX);
      gMaxPx = Math.max(maxPx2x2, centerParentX + 2 * stepX);
    } else {
      gMinPy = Math.min(minPy2x2, centerParentY + 2 * stepY);
      gMaxPy = Math.max(maxPy2x2, centerParentY + 2 * stepY);
    }
    const configGaze = tryParentBounds(gMinPx, gMaxPx, gMinPy, gMaxPy);
    if (configGaze) return configGaze;
  }

  // 4. Try standard 2x2 parents (4 parents = 16 children at zHigh + 12 perimeter ring = 28-32 patches) if budget allows (maxPatches >= 28)
  if (maxPatches >= 28) {
    const config2x2 = tryParentBounds(minPx2x2, maxPx2x2, minPy2x2, maxPy2x2);
    if (config2x2) return config2x2;
  }

  // 5. Try 1 parent (4 children at zHigh + 8 surrounding zMid ring = 12 patches)
  const config1 = tryParentBounds(centerParentX, centerParentX, centerParentY, centerParentY);
  if (config1) return config1;

  // 3. If even 2x2 exceeds budget, lower entire region coherently to zMid (Section 38)
  const midCenterTile = latLonToTile(centerLat, centerLon, zMid);
  const midOnlyCandidates: CoherentTileCandidate[] = [];
  let r = 0;
  while (midOnlyCandidates.length < maxPatches && r <= 6) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = midCenterTile.x + dx;
        const ty = midCenterTile.y + dy;
        if (ImageryLODManager.tileIntersectsBounds(tx, ty, zMid, bounds)) {
          midOnlyCandidates.push({
            x: tx,
            y: ty,
            zoom: zMid,
            dist: Math.hypot(dx, dy),
            isHighRes: true,
          });
          if (midOnlyCandidates.length >= maxPatches) break;
        }
      }
      if (midOnlyCandidates.length >= maxPatches) break;
    }
    r++;
  }
  return midOnlyCandidates;
}

/**
 * Selects coherent refinement rings for 1:1 first-person view (Stage V6).
 * Eliminates partial-parent holes and checkerboard artifacts along the trail:
 * - Hiker route position / gaze is promoted in atomic 2x2 child blocks under parent tiles.
 * - Surrounding perimeter at zMid provides unbroken background coverage.
 * - Directional forward prefetch (~250m ahead) is promoted as an atomic parent block.
 * - Bounded strictly to maxPatches without slicing quadtrees.
 */
export function computeFirstPersonCoherentLODTiles(
  hikerLat: number,
  hikerLon: number,
  forwardLat: number,
  forwardLon: number,
  innerZoom: number,
  maxPatches: number,
  bounds: GeoBounds,
  behindLat?: number,
  behindLon?: number,
  corridorPoints?: { lat: number; lon: number }[]
): CoherentTileCandidate[] {
  const zHigh = innerZoom;
  const zMid = Math.max(13, zHigh - 1);

  if (zHigh <= 13) {
    const centerTile = latLonToTile(hikerLat, hikerLon, zHigh);
    const candidates: CoherentTileCandidate[] = [];
    let r = 0;
    while (candidates.length < maxPatches && r <= 6) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = centerTile.x + dx;
          const ty = centerTile.y + dy;
          if (ImageryLODManager.tileIntersectsBounds(tx, ty, zHigh, bounds)) {
            candidates.push({
              x: tx,
              y: ty,
              zoom: zHigh,
              dist: Math.hypot(dx, dy),
            });
            if (candidates.length >= maxPatches) break;
          }
        }
        if (candidates.length >= maxPatches) break;
      }
      r++;
    }
    return candidates;
  }

  const hikerTile = latLonToTile(hikerLat, hikerLon, zHigh);
  const hikerPx = Math.floor(hikerTile.x / 2);
  const hikerPy = Math.floor(hikerTile.y / 2);

  const fwdTile = latLonToTile(forwardLat, forwardLon, zHigh);
  const fwdPx = Math.floor(fwdTile.x / 2);
  const fwdPy = Math.floor(fwdTile.y / 2);

  const subX = hikerTile.x % 2 === 0 ? -1 : 1;
  const subY = hikerTile.y % 2 === 0 ? -1 : 1;
  const minPx = Math.min(hikerPx, hikerPx + subX);
  const maxPx = Math.max(hikerPx, hikerPx + subX);
  const minPy = Math.min(hikerPy, hikerPy + subY);
  const maxPy = Math.max(hikerPy, hikerPy + subY);

  function evaluateParentSet(parents: { px: number; py: number }[]): CoherentTileCandidate[] | null {
    const parentSet = new Set<string>();
    for (const p of parents) {
      parentSet.add(`${p.px},${p.py}`);
    }

    const highTiles: CoherentTileCandidate[] = [];
    let pMinX = Infinity;
    let pMaxX = -Infinity;
    let pMinY = Infinity;
    let pMaxY = -Infinity;

    for (const { px, py } of parents) {
      if (px < pMinX) pMinX = px;
      if (px > pMaxX) pMaxX = px;
      if (py < pMinY) pMinY = py;
      if (py > pMaxY) pMaxY = py;

      // Every parent promoted to zHigh receives all 4 children (Stage V6)
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const cx = px * 2 + dx;
          const cy = py * 2 + dy;
          if (ImageryLODManager.tileIntersectsBounds(cx, cy, zHigh, bounds)) {
            highTiles.push({
              x: cx,
              y: cy,
              zoom: zHigh,
              dist: Math.hypot(cx - hikerTile.x, cy - hikerTile.y),
              isHighRes: true,
            });
          }
        }
      }
    }

    if (highTiles.length === 0) return null;

    // Surrounding perimeter ring at zMid (8-way neighbors of the active parent footprint)
    const midSet = new Set<string>();
    const midTiles: CoherentTileCandidate[] = [];

    for (const { px, py } of parents) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const mx = px + dx;
          const my = py + dy;
          const mKey = `${mx},${my}`;
          if (parentSet.has(mKey) || midSet.has(mKey)) continue;
          midSet.add(mKey);
          if (ImageryLODManager.tileIntersectsBounds(mx, my, zMid, bounds)) {
            midTiles.push({
              x: mx,
              y: my,
              zoom: zMid,
              dist: Math.hypot((mx - hikerPx) * 2, (my - hikerPy) * 2) + 2.0,
              isHighRes: false,
            });
          }
        }
      }
    }

    if (highTiles.length + midTiles.length <= maxPatches) {
      return [...highTiles, ...midTiles];
    }
    return null;
  }

  // Build prioritized candidate parents list along route and gaze:
  const priorityParents: { px: number; py: number }[] = [];
  const visited = new Set<string>();

  const addPriority = (px: number, py: number) => {
    const k = `${px},${py}`;
    if (!visited.has(k)) {
      visited.add(k);
      priorityParents.push({ px, py });
    }
  };

  // 1. Immediate hiker parent (#1 priority)
  addPriority(hikerPx, hikerPy);

  // 2. Trail corridor parents connecting contiguously from hiker outward
  if (corridorPoints && corridorPoints.length > 0) {
    let closestHikerIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < corridorPoints.length; i++) {
      const d = Math.hypot(corridorPoints[i].lat - hikerLat, corridorPoints[i].lon - hikerLon);
      if (d < minDist) {
        minDist = d;
        closestHikerIdx = i;
      }
    }

    // Forward corridor points from hiker toward forward horizon
    for (let i = closestHikerIdx + 1; i < corridorPoints.length; i++) {
      const pt = corridorPoints[i];
      const t = latLonToTile(pt.lat, pt.lon, zHigh);
      addPriority(Math.floor(t.x / 2), Math.floor(t.y / 2));
    }

    // Behind corridor points from hiker backward
    for (let i = closestHikerIdx - 1; i >= 0; i--) {
      const pt = corridorPoints[i];
      const t = latLonToTile(pt.lat, pt.lon, zHigh);
      addPriority(Math.floor(t.x / 2), Math.floor(t.y / 2));
    }
  } else {
    // Intermediate parents along line from hiker to forward prefetch
    const steps = Math.max(Math.abs(fwdPx - hikerPx), Math.abs(fwdPy - hikerPy));
    for (let s = 1; s <= steps; s++) {
      const ipx = Math.round(hikerPx + (s / Math.max(1, steps)) * (fwdPx - hikerPx));
      const ipy = Math.round(hikerPy + (s / Math.max(1, steps)) * (fwdPy - hikerPy));
      addPriority(ipx, ipy);
    }
    addPriority(fwdPx, fwdPy);

    // Intermediate parents along line behind hiker if behind point given
    if (behindLat !== undefined && behindLon !== undefined) {
      const bTile = latLonToTile(behindLat, behindLon, zHigh);
      const bPx = Math.floor(bTile.x / 2);
      const bPy = Math.floor(bTile.y / 2);
      const stepsBehind = Math.max(Math.abs(bPx - hikerPx), Math.abs(bPy - hikerPy));
      for (let s = 1; s <= stepsBehind; s++) {
        const ipx = Math.round(hikerPx + (s / Math.max(1, stepsBehind)) * (bPx - hikerPx));
        const ipy = Math.round(hikerPy + (s / Math.max(1, stepsBehind)) * (bPy - hikerPy));
        addPriority(ipx, ipy);
      }
      addPriority(bPx, bPy);
    }
  }

  // 3. 2x2 cluster around hiker (ensures full 360° feet coverage)
  for (let py = minPy; py <= maxPy; py++) {
    for (let px = minPx; px <= maxPx; px++) {
      addPriority(px, py);
    }
  }

  // 4. Lateral wings: widen corridor around trail parents when budget permits (maxPatches >= 48)
  if (maxPatches >= 48) {
    const mainTrailParents = [...priorityParents];
    for (const p of mainTrailParents) {
      addPriority(p.px + 1, p.py);
      addPriority(p.px - 1, p.py);
      addPriority(p.px, p.py + 1);
      addPriority(p.px, p.py - 1);
    }
  }

  // 5. 2x2 cluster around forward prefetch
  const fsubX = fwdTile.x % 2 === 0 ? -1 : 1;
  const fsubY = fwdTile.y % 2 === 0 ? -1 : 1;
  for (let py = Math.min(fwdPy, fwdPy + fsubY); py <= Math.max(fwdPy, fwdPy + fsubY); py++) {
    for (let px = Math.min(fwdPx, fwdPx + fsubX); px <= Math.max(fwdPx, fwdPx + fsubX); px++) {
      addPriority(px, py);
    }
  }

  // Greedy parent promotion: add parents in priority order as long as 4-child block + mid ring fits
  let activeParents: { px: number; py: number }[] = [];
  let bestResult: CoherentTileCandidate[] | null = null;

  for (const cand of priorityParents) {
    const nextParents = [...activeParents, cand];
    const evalResult = evaluateParentSet(nextParents);
    if (evalResult) {
      activeParents = nextParents;
      bestResult = evalResult;
    }
  }

  if (bestResult) {
    return bestResult;
  }

  // 5. Demote to pure zMid if budget cannot accommodate zHigh
  const midCenterTile = latLonToTile(hikerLat, hikerLon, zMid);
  const midOnlyCandidates: CoherentTileCandidate[] = [];
  let r = 0;
  while (midOnlyCandidates.length < maxPatches && r <= 6) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = midCenterTile.x + dx;
        const ty = midCenterTile.y + dy;
        if (ImageryLODManager.tileIntersectsBounds(tx, ty, zMid, bounds)) {
          midOnlyCandidates.push({
            x: tx,
            y: ty,
            zoom: zMid,
            dist: Math.hypot(dx, dy),
            isHighRes: false,
          });
          if (midOnlyCandidates.length >= maxPatches) break;
        }
      }
      if (midOnlyCandidates.length >= maxPatches) break;
    }
    r++;
  }
  return midOnlyCandidates;
}

/**
 * ImageryLODManager
 *
 * Implements Stage R2, S1-S3, T5, and Stage U4: Coherent Adaptive High-Resolution Map Imagery.
 *
 * Stage U4 Enhancements:
 * - Separates requested, ready, and visible LOD explicitly (Section 37).
 * - Coherent coverage-first refinement rings without checkerboarding (Sections 38, 39, 62).
 * - Explicit parent/child replacement and deterministic hierarchy (Sections 40, 41, 63).
 * - Depth-write disabled during fade-in, opaque depth-write on completion (Section 42).
 * - Surface-conforming dynamic patch geometry subdivision (Sections 43, 44).
 * - XR view metrics derived from subcamera projection and WebXR framebuffer (Section 45).
 * - Target zoom promotion dwell time (500 ms) preventing head micro-jitter (Section 46).
 * - Granular coverage diagnostics (Section 47).
 *
 * INVARIANT: This class NEVER mutates dioramaRoot position, rotation, scale,
 * camera transform, HUD transform, or session state.
 */
export class ImageryLODManager {
  public readonly group: THREE.Group;
  private options: ImageryLODManagerOptions;
  private patches: Map<string, ImageryPatch> = new Map();

  private isDisposed: boolean = false;
  private currentGeneration: number = 0;

  private currentTextureStyle: TextureStyle;
  private verticalExaggeration: number;
  private maxPatches: number;
  private maxConcurrency: number;
  private enableInXR: boolean;
  private enableFadeIn: boolean;
  private debugPatchBounds: boolean;
  private lastIsXR: boolean = false;

  // Reconciliation state (Section 14, 30, 37)
  private desiredTileKeys: Set<string> = new Set();
  private pendingRequests: Map<string, PendingTileRequest> = new Map();
  private requestQueue: QueuedTile[] = [];
  private activeRequestCount: number = 0;
  private refinementGroups: Map<string, RefinementGroup> = new Map();

  // View state tracking & debouncing (Stage W QualityProfile driven)
  private qualityProfile: QualityProfile;
  private currentTargetZoom: number = 14;
  private calculatedDesiredZoom: number = 14;
  private providerMaxZoom: number = 19;
  private lastEvalTime: number = 0;
  private EVAL_INTERVAL_MS: number = 120;

  // Promotion & Demotion dwell timers (Stage W)
  private PROMOTION_DWELL_MS: number = 200;
  private DEMOTION_DWELL_MS: number = 3000;
  private promotionZoomBias: number = 0.8;
  private firstPersonEvalDistM: number = 15;
  private firstPersonPrefetchAheadM: number = 650;
  private firstPersonRetainBehindM: number = 300;
  private warmRetentionMs: number = 30000;
  private pendingPromoteZoom: number | null = null;
  private promoteCandidateSince: number = 0;
  private pendingDemoteZoom: number | null = null;
  private demoteCandidateSince: number = 0;

  private lastCamPos: THREE.Vector3 = new THREE.Vector3();
  private lastCamDir: THREE.Vector3 = new THREE.Vector3();
  private lastDioramaScale: number = 1.0;
  private lastDioramaWorldPos: THREE.Vector3 = new THREE.Vector3();

  // View mode and 1:1 trail following state (Section 11 & 12)
  private viewMode: ViewMode = 'diorama';
  private currentProgress: number = 0;
  private lastEvalProgress: number = -1;
  private routeGeometry?: RouteGeometry;

  // Telemetry & diagnostics
  private patchesCreatedTotal: number = 0;
  private patchesDisposedTotal: number = 0;

  // Active user interaction ray (e.g. pointer/laser in tabletop mode, Stage W3)
  private activeInteractionRay: THREE.Ray | null = null;
  private lastInspectedGeo: { lat: number; lon: number } | null = null;
  private lastTimeToSharpMs: number = 0;

  constructor(options: ImageryLODManagerOptions) {
    this.options = options;
    this.qualityProfile = options.qualityProfile || QualityProfileManager.getActiveProfile();
    this.currentTextureStyle = options.textureStyle || 'satellite';
    this.verticalExaggeration = options.verticalExaggeration ?? 1.0;
    this.enableInXR = options.enableInXR ?? true;
    this.enableFadeIn = options.enableFadeIn ?? true;
    this.debugPatchBounds = options.debugPatchBounds ?? false;
    this.viewMode = options.viewMode || 'diorama';
    this.routeGeometry = options.routeGeometry;

    this.maxConcurrency = options.maxConcurrency ?? this.qualityProfile.concurrency;
    this.maxPatches = options.maxPatches ?? (this.viewMode === 'first-person' ? this.qualityProfile.firstPersonPatches : this.qualityProfile.tabletopPatches);
    this.warmRetentionMs = this.qualityProfile.warmRetentionMs;
    this.EVAL_INTERVAL_MS = this.qualityProfile.evalIntervalMs;
    this.PROMOTION_DWELL_MS = this.qualityProfile.promotionDwellMs;
    this.DEMOTION_DWELL_MS = this.qualityProfile.demotionDwellMs;
    this.promotionZoomBias = this.qualityProfile.promotionZoomBias;
    this.firstPersonEvalDistM = this.qualityProfile.firstPersonEvalDistM;
    this.firstPersonPrefetchAheadM = this.qualityProfile.firstPersonPrefetchAheadM;
    this.firstPersonRetainBehindM = this.qualityProfile.firstPersonRetainBehindM;

    this.group = new THREE.Group();
    this.group.name = 'ImageryLODGroup';
  }

  public getDiagnostics(): ImageryLODDiagnostics {
    const visibleByZoom = new Map<number, number>();
    let visibleCount = 0;

    for (const patch of this.patches.values()) {
      if (patch.mesh.visible) {
        visibleCount++;
        visibleByZoom.set(patch.zoom, (visibleByZoom.get(patch.zoom) || 0) + 1);
      }
    }

    let readyHighRes = 0;
    let totalDesiredHighRes = 0;
    for (const key of this.desiredTileKeys) {
      const parsed = parseTileKey(key);
      if (parsed.zoom === this.currentTargetZoom) {
        totalDesiredHighRes++;
        const patch = this.patches.get(key);
        if (patch && patch.mesh.visible) {
          readyHighRes++;
        }
      }
    }

    const coveragePercent =
      totalDesiredHighRes > 0
        ? Math.round((readyHighRes / totalDesiredHighRes) * 100)
        : 100;

    let z19AheadDistanceMeters = 0;
    if (this.viewMode === 'first-person' && this.routeGeometry && this.currentTargetZoom >= 19) {
      const totalDist = this.routeGeometry.totalDistance;
      const hikerDist = this.currentProgress * totalDist;
      let checkDist = hikerDist + 25;
      while (checkDist <= totalDist) {
        const prog = checkDist / totalDist;
        const tele = this.routeGeometry.getTelemetryAtProgress(prog);
        const tile = latLonToTile(tele.currentPoint.lat, tele.currentPoint.lon, this.currentTargetZoom);
        const key = `${this.currentTextureStyle}:${this.currentTargetZoom}:${tile.x}:${tile.y}`;
        const patch = this.patches.get(key);
        if (patch && patch.mesh.visible) {
          z19AheadDistanceMeters = Math.round(checkDist - hikerDist);
          checkDist += 50;
        } else {
          break;
        }
      }
    }

    const residentWarmCount = Math.max(0, this.patches.size - visibleCount);
    const cacheHitRate = TileImageCache.getStats().hitRate;

    return {
      activePatchesCount: this.patches.size,
      targetZoom: this.currentTargetZoom,
      calculatedDesiredZoom: this.calculatedDesiredZoom,
      effectiveProviderClampedZoom: this.currentTargetZoom,
      providerMaxZoom: this.providerMaxZoom,
      inFlightRequests: this.activeRequestCount,
      requestQueueLength: this.requestQueue.length,
      pendingRequestsCount: this.pendingRequests.size,
      patchesCreatedTotal: this.patchesCreatedTotal,
      patchesDisposedTotal: this.patchesDisposedTotal,
      generation: this.currentGeneration,
      viewMode: this.viewMode,
      currentProgress: this.currentProgress,
      debugPatchBounds: this.debugPatchBounds,
      visibleByZoom,
      desiredZoom: this.currentTargetZoom,
      readyHighResCount: readyHighRes,
      totalDesiredHighResCount: totalDesiredHighRes,
      requestedCount: this.desiredTileKeys.size,
      readyCount: this.patches.size,
      visibleCount,
      coveragePercent,
      z19AheadDistanceMeters,
      residentWarmCount,
      evictionsTotal: this.patchesDisposedTotal,
      cacheHitRate,
      lastTimeToSharpMs: this.lastTimeToSharpMs,
    };
  }

  public getInspectedGeo(): { lat: number; lon: number } | null {
    return this.lastInspectedGeo;
  }

  public getLastTimeToSharpMs(): number {
    return this.lastTimeToSharpMs;
  }

  public setDebugPatchBounds(enabled: boolean): void {
    if (this.isDisposed || this.debugPatchBounds === enabled) return;
    this.debugPatchBounds = enabled;

    for (const patch of this.patches.values()) {
      if (enabled && !patch.outlineMesh) {
        const outline = this.buildPatchOutline(patch.mesh.geometry as THREE.BufferGeometry, patch.zoom);
        patch.outlineMesh = outline;
        patch.mesh.add(outline);
      } else if (!enabled && patch.outlineMesh) {
        patch.mesh.remove(patch.outlineMesh);
        patch.outlineMesh.geometry.dispose();
        (patch.outlineMesh.material as THREE.Material)?.dispose();
        patch.outlineMesh = undefined;
      }
    }
  }

  public setViewMode(mode: ViewMode): void {
    if (this.isDisposed || this.viewMode === mode) return;
    this.viewMode = mode;
    this.maxPatches = mode === 'first-person' ? this.qualityProfile.firstPersonPatches : this.qualityProfile.tabletopPatches;
    this.currentGeneration++;

    if (mode === 'first-person') {
      this.lastInspectedGeo = null;
    }

    for (const pending of this.pendingRequests.values()) {
      pending.abortController.abort();
    }
    this.pendingRequests.clear();
    this.requestQueue = [];
    this.desiredTileKeys.clear();
    this.activeRequestCount = 0;

    this.lastEvalTime = 0;
    this.lastEvalProgress = -1;

    // Retain compatible resident patches in GPU memory (Warm GPU-resident set).
    // Evict down to maxPatches if resident count exceeds the new mode's budget.
    while (this.patches.size > this.maxPatches) {
      this.evictFurthestPatch();
    }

    // Mark non-desired patches non-visible so they reside in the warm GPU-resident set
    this.updatePatchVisibility();
  }

  public setRouteProgress(progress: number): void {
    this.currentProgress = Math.max(0, Math.min(1, progress));
  }

  public setRouteGeometry(routeGeometry: RouteGeometry): void {
    this.routeGeometry = routeGeometry;
  }

  public setDeviceProfile(isQuest: boolean): void {
    const profile = QualityProfileManager.getDefaultProfile(isQuest);
    this.setQualityProfile(profile);
  }

  public setQualityProfile(profile: QualityProfile): void {
    this.qualityProfile = profile;
    this.maxConcurrency = profile.concurrency;
    this.maxPatches = this.viewMode === 'first-person' ? profile.firstPersonPatches : profile.tabletopPatches;
    this.warmRetentionMs = profile.warmRetentionMs;
    this.EVAL_INTERVAL_MS = profile.evalIntervalMs;
    this.PROMOTION_DWELL_MS = profile.promotionDwellMs;
    this.DEMOTION_DWELL_MS = profile.demotionDwellMs;
    this.promotionZoomBias = profile.promotionZoomBias;
    this.firstPersonEvalDistM = profile.firstPersonEvalDistM;
    this.firstPersonPrefetchAheadM = profile.firstPersonPrefetchAheadM;
    this.firstPersonRetainBehindM = profile.firstPersonRetainBehindM;
  }

  public getQualityProfile(): QualityProfile {
    return this.qualityProfile;
  }

  public setVerticalExaggeration(factor: number): void {
    if (this.isDisposed || Math.abs(this.verticalExaggeration - factor) < 0.01) return;
    this.verticalExaggeration = factor;

    // Update heights on all active patches
    for (const patch of this.patches.values()) {
      this.updatePatchGeometryHeights(patch.mesh.geometry as THREE.BufferGeometry, patch);
    }
  }

  public reprojectPatches(sampler?: (x: number, z: number) => number, bounds?: TerrainSurfaceBounds): void {
    if (this.isDisposed) return;
    if (sampler) {
      this.options.elevationSampler = sampler;
    }

    for (const patch of this.patches.values()) {
      const geo = patch.mesh.geometry as THREE.BufferGeometry;
      if (bounds) {
        if (!geo.boundingBox) {
          geo.computeBoundingBox();
        }
        const bbox = geo.boundingBox;
        if (bbox) {
          const intersects = !(
            bbox.max.x < bounds.minX ||
            bbox.min.x > bounds.maxX ||
            bbox.max.z < bounds.minZ ||
            bbox.min.z > bounds.maxZ
          );
          if (!intersects) {
            continue;
          }
        }
      }
      this.updatePatchGeometryHeights(geo, patch);
    }
  }

  public getOrCreateRefinementGroup(parentKey: string): RefinementGroup {
    let group = this.refinementGroups.get(parentKey);
    if (!group) {
      const parsed = parseTileKey(parentKey);
      const childZoom = parsed.zoom + 1;
      const c0 = getTileKey(parsed.style, childZoom, parsed.x * 2, parsed.y * 2);
      const c1 = getTileKey(parsed.style, childZoom, parsed.x * 2 + 1, parsed.y * 2);
      const c2 = getTileKey(parsed.style, childZoom, parsed.x * 2, parsed.y * 2 + 1);
      const c3 = getTileKey(parsed.style, childZoom, parsed.x * 2 + 1, parsed.y * 2 + 1);

      group = {
        parentKey,
        style: parsed.style,
        parentZoom: parsed.zoom,
        parentX: parsed.x,
        parentY: parsed.y,
        childZoom,
        fourChildKeys: [c0, c1, c2, c3],
        readyChildren: new Set<string>(),
        state: 'parent',
      };
      this.refinementGroups.set(parentKey, group);
    }

    // Keep readyChildren and state synchronized with current patches
    group.readyChildren.clear();
    for (const cKey of group.fourChildKeys) {
      if (this.patches.has(cKey)) {
        group.readyChildren.add(cKey);
      }
    }

    if (group.readyChildren.size === 0) {
      group.state = 'parent';
    } else if (group.readyChildren.size < 4) {
      if (group.requestStartTime === undefined) {
        group.requestStartTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      }
      group.state = 'loading';
    } else {
      const anyFading =
        this.enableFadeIn &&
        group.fourChildKeys.some((cKey) => this.patches.get(cKey)?.isFading);
      const newState = anyFading ? 'promoting' : 'children';
      if ((group.state === 'loading' || group.state === 'parent') && group.requestStartTime !== undefined) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.lastTimeToSharpMs = Math.round(now - group.requestStartTime);
        group.requestStartTime = undefined;
      }
      group.state = newState;
    }

    return group;
  }

  public getRefinementGroup(parentKey: string): RefinementGroup | undefined {
    return this.refinementGroups.get(parentKey);
  }

  public getAllRefinementGroups(): Map<string, RefinementGroup> {
    return new Map(this.refinementGroups);
  }

  public async setTextureStyle(style: TextureStyle): Promise<void> {
    if (this.isDisposed || this.currentTextureStyle === style) return;
    this.currentTextureStyle = style;
    this.currentGeneration++;

    // Abort pending consumer requests
    for (const pending of this.pendingRequests.values()) {
      pending.abortController.abort();
    }
    this.pendingRequests.clear();
    this.requestQueue = [];
    this.desiredTileKeys.clear();
    this.activeRequestCount = 0;

    // Clear all existing patch meshes so old style never floats over new style
    this.clearAllPatches();
  }

  public setActiveInteractionRay(ray: THREE.Ray | null): void {
    this.activeInteractionRay = ray ? ray.clone() : null;
  }

  public getActiveInteractionRay(): THREE.Ray | null {
    return this.activeInteractionRay ? this.activeInteractionRay.clone() : null;
  }

  /**
   * Main per-frame update method called from scene render loop.
   * Debounced, movement-thresholded, and dwell-filtered.
   */
  public update(
    camera: THREE.Camera,
    dioramaRoot: THREE.Group,
    isXR: boolean = false,
    routeProgress?: number,
    renderer?: THREE.WebGLRenderer
  ): void {
    if (this.isDisposed || !ENABLE_ADAPTIVE_IMAGERY_LOD) return;

    this.lastIsXR = isXR;

    if (routeProgress !== undefined) {
      this.currentProgress = Math.max(0, Math.min(1, routeProgress));
    }

    // In XR, enforce gate (Section 40)
    if (isXR) {
      if (!this.enableInXR) {
        if (this.patches.size > 0) {
          this.clearAllPatches();
        }
        return;
      }
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Smooth crossfade/fade-in animation tick for active patches (Stage S3 & U4 Section 42)
    let anyFadeCompleted = false;
    for (const patch of this.patches.values()) {
      if (patch.isFading) {
        const elapsed = now - patch.creationTime;
        const t = Math.min(1.0, elapsed / Math.max(patch.fadeDurationMs, 1));
        const mat = patch.mesh.material as THREE.MeshStandardMaterial;
        mat.opacity = t;
        if (t >= 1.0) {
          mat.opacity = 1.0;
          mat.transparent = false;
          mat.depthWrite = true;
          mat.needsUpdate = true;
          patch.isFading = false;
          anyFadeCompleted = true;
        }
      }
    }

    if (anyFadeCompleted) {
      this.updatePatchVisibility();
    }

    if (this.lastEvalTime !== 0 && now - this.lastEvalTime < this.EVAL_INTERVAL_MS) {
      return;
    }

    const metrics = getViewMetrics(camera, renderer);
    const camPos = metrics.worldPosition;
    const camDir = metrics.forward;
    const dioramaScale = dioramaRoot.scale.x;
    const isFirstRun = this.lastEvalTime === 0;

    const posDelta = camPos.distanceTo(this.lastCamPos);
    const dirAngle = camDir.angleTo(this.lastCamDir);
    const scaleRatio = Math.abs(dioramaScale - this.lastDioramaScale) / Math.max(this.lastDioramaScale, 0.001);

    if (this.viewMode === 'first-person') {
      const totalDist = this.routeGeometry?.totalDistance || 10000;
      const progressDistMoved =
        this.lastEvalProgress < 0
          ? Infinity
          : Math.abs(this.currentProgress - this.lastEvalProgress) * totalDist;

      if (!isFirstRun && progressDistMoved < this.firstPersonEvalDistM && dirAngle < 0.15) {
        return;
      }

      this.lastEvalProgress = this.currentProgress;
    } else {
      const hasPendingZoomChange = this.pendingPromoteZoom !== null || this.pendingDemoteZoom !== null;
      if (!isFirstRun && !hasPendingZoomChange && posDelta < 0.04 && dirAngle < 0.03 && scaleRatio < 0.04) {
        return;
      }
    }

    const dioramaWorldPos = new THREE.Vector3();
    dioramaRoot.getWorldPosition(dioramaWorldPos);
    const dioramaPosDelta = dioramaWorldPos.distanceTo(this.lastDioramaWorldPos);

    this.lastEvalTime = now;
    this.lastCamPos.copy(camPos);
    this.lastCamDir.copy(camDir);
    this.lastDioramaScale = dioramaScale;
    this.lastDioramaWorldPos.copy(dioramaWorldPos);

    if (this.viewMode === 'first-person') {
      this.evaluateFirstPersonLOD(camera, dioramaRoot, renderer);
    } else {
      this.evaluateLOD(camera, dioramaRoot, renderer, dioramaPosDelta, scaleRatio, isFirstRun);
    }
  }

  /**
   * Pure zoom calculation function based on Web Mercator ground texel density.
   * Supports hysteresis and provider clamping.
   */
  public static calculateTargetZoom(
    cameraDist: number,
    dioramaScale: number,
    centerLat: number,
    fovDeg: number = 60,
    viewportHeightPx: number = 1080,
    providerMaxZoom: number = 19,
    currentZoom?: number,
    promotionZoomBias: number = 0.8
  ): number {
    const fovRad = degToRad(fovDeg);
    // Displayed metric extent per viewport pixel
    const metersPerPixel = (2 * cameraDist * Math.tan(fovRad / 2)) / Math.max(viewportHeightPx, 480);
    const localMetersPerPixel = metersPerPixel / Math.max(dioramaScale, 0.000001);

    const latRad = degToRad(clampLatitude(centerLat));
    const earthCircumferenceMeters = 2 * Math.PI * 6378137 * Math.cos(latRad);
    const rawZoom = Math.log2((earthCircumferenceMeters / 256) / Math.max(localMetersPerPixel, 0.01));

    // Quality multiplier driven by promotionZoomBias (+0.7 to +1.0 in Stage W)
    const biasedZoom = rawZoom + promotionZoomBias;
    let targetZ = Math.round(biasedZoom);

    // Asymmetric zoom hysteresis (Stage W):
    // Eager promotion (> +0.4 drift above current zoom promotes quickly)
    // Conservative demotion (> -0.85 drift below current zoom required before demoting)
    if (currentZoom !== undefined) {
      if (biasedZoom > currentZoom + 0.4) {
        targetZ = Math.round(biasedZoom);
      } else if (biasedZoom < currentZoom - 0.85) {
        targetZ = Math.round(biasedZoom);
      } else {
        targetZ = currentZoom;
      }
    }

    // Minimum patch zoom: 13. Maximum: clamped strictly to provider maxZoom (Section 19)
    return Math.max(13, Math.min(providerMaxZoom, targetZ));
  }

  /**
   * Pure helper to test whether a tile intersects the terrain geographic bounds.
   */
  public static tileIntersectsBounds(x: number, y: number, zoom: number, bounds: GeoBounds): boolean {
    const tb = tileBounds(x, y, zoom);
    return !(
      tb.maxLon < bounds.minLon ||
      tb.minLon > bounds.maxLon ||
      tb.maxLat < bounds.minLat ||
      tb.minLat > bounds.maxLat
    );
  }

  /**
   * Fetches image source for a patch tile.
   * For 'hybrid', loads base satellite and reference overlay concurrently,
   * compositing them onto an offscreen canvas with graceful fallback to satellite (Req #6).
   */
  public static async loadPatchImage(
    zoom: number,
    x: number,
    y: number,
    style: TextureStyle,
    signal?: AbortSignal,
    priority: TilePriority = TilePriority.NORMAL
  ): Promise<HTMLImageElement | HTMLCanvasElement> {
    if (style === 'hybrid') {
      const satProvider = TextureProvider.getActiveSatelliteProvider();
      const labelProvider = TextureProvider.getReferenceOverlayProvider();

      const satPromise = TileImageCache.loadTile(satProvider, zoom, x, y, 4500, signal, priority);
      const labelPromise = TileImageCache.loadTile(labelProvider, zoom, x, y, 3500, signal, priority).catch(() => null);

      const [satImg, labelImg] = await Promise.all([satPromise, labelPromise]);

      if (typeof document !== 'undefined' && document.createElement) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 256;
          canvas.height = 256;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(satImg, 0, 0, 256, 256);
            if (labelImg) {
              ctx.drawImage(labelImg, 0, 0, 256, 256);
            }
            return canvas;
          }
        } catch {
          // If canvas operations fail, fall back to satImg
        }
      }

      return satImg;
    }

    const provider = TextureProvider.getProviderForStyle(style);
    return TileImageCache.loadTile(provider, zoom, x, y, 4500, signal, priority);
  }

  private evaluateLOD(
    camera: THREE.Camera,
    dioramaRoot: THREE.Group,
    renderer?: THREE.WebGLRenderer,
    dioramaPosDelta: number = 0,
    scaleRatio: number = 0,
    isFirstRun: boolean = false
  ): void {
    const provider = TextureProvider.getProviderForStyle(this.currentTextureStyle);
    this.providerMaxZoom = provider.maxZoom;
    const centerLat = this.options.terrainGeoBounds.centerLat;

    const metrics = getViewMetrics(camera, renderer);
    const dioramaWorldPos = new THREE.Vector3();
    dioramaRoot.getWorldPosition(dioramaWorldPos);
    const dioramaWorldQuat = new THREE.Quaternion();
    dioramaRoot.getWorldQuaternion(dioramaWorldQuat);
    const dioramaScale = dioramaRoot.scale.x;

    // 1. Raycast actual rendered terrain surface from active interaction ray or XR camera gaze (Stage V5.1, W3)
    const rayOrigin = this.activeInteractionRay ? this.activeInteractionRay.origin : metrics.worldPosition;
    const rayDir = this.activeInteractionRay ? this.activeInteractionRay.direction : metrics.forward;
    const raycaster = new THREE.Raycaster(rayOrigin, rayDir);
    let hitWorldPos: THREE.Vector3 | null = null;

    let terrainMesh = this.options.terrainMesh;
    if (!terrainMesh) {
      dioramaRoot.traverse((obj) => {
        if (
          !terrainMesh &&
          (obj as THREE.Mesh).isMesh &&
          !(obj as any).isLine &&
          obj.name !== 'WaypointHaloMesh' &&
          !obj.name.startsWith('ImageryPatch_')
        ) {
          const parentName = obj.parent?.name;
          if (parentName === 'TerrainGroup' || obj.name === 'BaseTerrainMesh' || obj.name === 'TerrainMesh') {
            terrainMesh = obj as THREE.Mesh;
          }
        }
      });
    }

    if (terrainMesh) {
      const hits = raycaster.intersectObject(terrainMesh, false);
      if (hits.length > 0) {
        hitWorldPos = hits[0].point;
      }
    }

    if (!hitWorldPos) {
      // Fallback: Plane transformed by the diorama's ACTUAL world transform (not fixed horizontal plane!) (Stage V5.1)
      const dioramaPlaneNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(dioramaWorldQuat).normalize();
      const dioramaPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(dioramaPlaneNormal, dioramaWorldPos);
      const planeHit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(dioramaPlane, planeHit)) {
        hitWorldPos = planeHit;
      }
    }

    // Determine target geographic center point from the terrain hit
    let targetGeo = { lat: centerLat, lon: this.options.terrainGeoBounds.centerLon };
    if (hitWorldPos) {
      const localHit = hitWorldPos.clone();
      dioramaRoot.worldToLocal(localHit);

      const halfW = (this.options.terrainGeoBounds.widthMeters * 1.5) / 2;
      const halfD = (this.options.terrainGeoBounds.depthMeters * 1.5) / 2;
      if (Math.abs(localHit.x) <= halfW && Math.abs(localHit.z) <= halfD) {
        targetGeo = localMetersToGeo(
          localHit.x,
          localHit.z,
          centerLat,
          this.options.terrainGeoBounds.centerLon
        );
      }
    }

    this.lastInspectedGeo = { lat: targetGeo.lat, lon: targetGeo.lon };

    // 2. Compute LOD resolution using viewed-region geometry (Stage V5.2)
    // Distance from active camera to actual viewed terrain hit (or diorama center if missed)
    const camDist = hitWorldPos
      ? Math.max(metrics.worldPosition.distanceTo(hitWorldPos), 0.2)
      : Math.max(metrics.worldPosition.distanceTo(dioramaWorldPos), 0.2);

    const rawTargetZoom = ImageryLODManager.calculateTargetZoom(
      camDist,
      dioramaScale,
      targetGeo.lat,
      metrics.verticalFov,
      metrics.viewportHeightPx,
      provider.maxZoom,
      this.currentTargetZoom,
      this.promotionZoomBias
    );

    this.calculatedDesiredZoom = rawTargetZoom;

    // Asymmetric Promotion and Demotion dwell timers (Stage W):
    // Eager promotion: 150-250ms dwell (or immediate if leaning in/scaling up)
    // Conservative demotion: 2-5s dwell to prevent collapsing on momentary head movement
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dioramaMovedSignificantly = isFirstRun || dioramaPosDelta > 0.10 || scaleRatio > 0.15;

    if (isFirstRun) {
      this.currentTargetZoom = rawTargetZoom;
      this.pendingPromoteZoom = null;
      this.pendingDemoteZoom = null;
    } else if (rawTargetZoom > this.currentTargetZoom) {
      this.pendingDemoteZoom = null;
      if (dioramaMovedSignificantly) {
        this.currentTargetZoom = rawTargetZoom;
        this.pendingPromoteZoom = null;
      } else {
        if (this.pendingPromoteZoom !== rawTargetZoom) {
          this.pendingPromoteZoom = rawTargetZoom;
          this.promoteCandidateSince = now;
        } else if (now - this.promoteCandidateSince >= this.PROMOTION_DWELL_MS) {
          this.currentTargetZoom = rawTargetZoom;
          this.pendingPromoteZoom = null;
        }
      }
    } else if (rawTargetZoom < this.currentTargetZoom) {
      this.pendingPromoteZoom = null;
      if (this.pendingDemoteZoom !== rawTargetZoom) {
        this.pendingDemoteZoom = rawTargetZoom;
        this.demoteCandidateSince = now;
      } else if (now - this.demoteCandidateSince >= this.DEMOTION_DWELL_MS) {
        this.currentTargetZoom = rawTargetZoom;
        this.pendingDemoteZoom = null;
      }
    } else {
      this.pendingPromoteZoom = null;
      this.pendingDemoteZoom = null;
    }

    const effectiveTargetZoom = this.currentTargetZoom;

    // Extract horizontal gaze / interaction orientation in diorama local space (Stage W3)
    const invQuat = dioramaWorldQuat.clone().invert();
    const localGazeDir = rayDir.clone().applyQuaternion(invQuat);
    const gazeHorizLen = Math.hypot(localGazeDir.x, localGazeDir.z);
    let gazeTileVector: { dx: number; dy: number } | undefined = undefined;
    if (gazeHorizLen > 0.05) {
      gazeTileVector = {
        dx: localGazeDir.x / gazeHorizLen,
        dy: localGazeDir.z / gazeHorizLen,
      };
    }

    // Coherent refinement rings (Sections 38, 39, 62, Stage W3)
    const candidates = computeCoherentLODTiles(
      targetGeo.lat,
      targetGeo.lon,
      effectiveTargetZoom,
      this.maxPatches,
      this.options.terrainGeoBounds,
      undefined,
      gazeTileVector
    );

    // Reconcile desired tiles with in-flight and visible patches (Section 14, 30, 40)
    this.reconcileDesiredTiles(candidates, provider, effectiveTargetZoom);
  }

  /**
   * 1:1 trail mode imagery LOD profile (Section 11 & 12).
   */
  private evaluateFirstPersonLOD(
    camera: THREE.Camera,
    dioramaRoot: THREE.Group,
    renderer?: THREE.WebGLRenderer
  ): void {
    const provider = TextureProvider.getProviderForStyle(this.currentTextureStyle);
    this.providerMaxZoom = provider.maxZoom;

    const innerZoom = Math.min(this.providerMaxZoom, 19);
    const midZoom = Math.max(13, innerZoom - 1);
    this.currentTargetZoom = innerZoom;
    this.calculatedDesiredZoom = innerZoom;

    let hikerLat = this.options.terrainGeoBounds.centerLat;
    let hikerLon = this.options.terrainGeoBounds.centerLon;
    let forwardLat = hikerLat;
    let forwardLon = hikerLon;
    let behindLat: number | undefined = undefined;
    let behindLon: number | undefined = undefined;
    let corridorPoints: { lat: number; lon: number }[] | undefined = undefined;

    if (this.routeGeometry) {
      const currentTelemetry = this.routeGeometry.getTelemetryAtProgress(this.currentProgress);
      hikerLat = currentTelemetry.currentPoint.lat;
      hikerLon = currentTelemetry.currentPoint.lon;

      // Extended directional prefetch ahead and retention behind (Stage W4)
      const currentDist = currentTelemetry.currentPoint.distanceFromStart;
      const forwardDist = Math.min(
        this.routeGeometry.totalDistance,
        currentDist + this.firstPersonPrefetchAheadM
      );
      const behindDist = Math.max(
        0,
        currentDist - this.firstPersonRetainBehindM
      );

      const forwardTelemetry = this.routeGeometry.getTelemetryAtDistance(forwardDist);
      forwardLat = forwardTelemetry.currentPoint.lat;
      forwardLon = forwardTelemetry.currentPoint.lon;

      const behindTelemetry = this.routeGeometry.getTelemetryAtDistance(behindDist);
      behindLat = behindTelemetry.currentPoint.lat;
      behindLon = behindTelemetry.currentPoint.lon;

      // Latitude-aware parent tile sizing along the trail (Stage W4)
      const parentTileWidthMeters = metersPerPixelAtZoom(hikerLat, innerZoom - 1) * 256;
      const sampleStepM = Math.max(25, parentTileWidthMeters * 0.4);

      corridorPoints = [];
      for (let d = behindDist; d <= forwardDist; d += sampleStepM) {
        const pt = this.routeGeometry.getTelemetryAtDistance(d).currentPoint;
        corridorPoints.push({ lat: pt.lat, lon: pt.lon });
      }
      corridorPoints.push({ lat: forwardLat, lon: forwardLon });
    } else {
      const metrics = getViewMetrics(camera, renderer);
      const ray = new THREE.Ray(metrics.worldPosition, metrics.forward);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -dioramaRoot.position.y);
      const hit = new THREE.Vector3();
      if (ray.intersectPlane(plane, hit)) {
        const localHit = hit.clone();
        dioramaRoot.worldToLocal(localHit);
        const geo = localMetersToGeo(
          localHit.x,
          localHit.z,
          this.options.terrainGeoBounds.centerLat,
          this.options.terrainGeoBounds.centerLon
        );
        hikerLat = geo.lat;
        hikerLon = geo.lon;
        const forwardMeters = localHit.clone().addScaledVector(
          metrics.forward.clone().setY(0).normalize(),
          this.firstPersonPrefetchAheadM
        );
        const fwdGeo = localMetersToGeo(
          forwardMeters.x,
          forwardMeters.z,
          this.options.terrainGeoBounds.centerLat,
          this.options.terrainGeoBounds.centerLon
        );
        forwardLat = fwdGeo.lat;
        forwardLon = fwdGeo.lon;
      }
    }

    // Coherent quadtree candidate generation for 1:1 first-person view (Stage V6, Stage W4)
    const candidates = computeFirstPersonCoherentLODTiles(
      hikerLat,
      hikerLon,
      forwardLat,
      forwardLon,
      innerZoom,
      this.maxPatches,
      this.options.terrainGeoBounds,
      behindLat,
      behindLon,
      corridorPoints
    );

    this.reconcileDesiredTiles(candidates, provider, innerZoom);
  }

  /**
   * Reconciles desired candidate tiles against active and pending tiles.
   */
  private reconcileDesiredTiles(
    candidates: { x: number; y: number; zoom?: number; dist: number }[],
    provider: ImageryProvider,
    defaultZoom: number
  ): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const newDesiredKeys = new Set<string>();
    const candidateMap = new Map<string, { x: number; y: number; zoom: number; dist: number }>();

    for (const c of candidates) {
      const z = c.zoom ?? defaultZoom;
      const key = getTileKey(this.currentTextureStyle, z, c.x, c.y);
      newDesiredKeys.add(key);
      candidateMap.set(key, { ...c, zoom: z });
    }

    this.desiredTileKeys = newDesiredKeys;

    // 1. Update lastUsed for already visible patches
    for (const [key, patch] of this.patches.entries()) {
      if (newDesiredKeys.has(key)) {
        patch.lastUsed = now;
        const c = candidateMap.get(key);
        if (c) patch.centerDist = c.dist;
      }
    }

    // 2. Selective request cancellation (Stage W):
    // Distinguish truly obsolete requests from near-future / warm working region requests.
    for (const [key, pending] of this.pendingRequests.entries()) {
      if (!newDesiredKeys.has(key)) {
        const parsed = parseTileKey(key);
        const parentKey = getParentTileKey(parsed.style, parsed.zoom, parsed.x, parsed.y);
        let hasLoadedSibling = false;
        if (parentKey) {
          const parentParsed = parseTileKey(parentKey);
          const siblingKeys = getChildTileKeys(parentParsed.style, parentParsed.zoom, parentParsed.x, parentParsed.y);
          hasLoadedSibling = siblingKeys.some((sk) => this.patches.has(sk));
        }

        const isNearWarmRegion = parsed.zoom >= defaultZoom - 1 && pending.dist < 3.5;
        if (hasLoadedSibling || isNearWarmRegion) {
          // Allow in-flight request to finish and enter warm resident cache
          continue;
        }

        // Truly obsolete request -> abort
        pending.abortController.abort();
        this.pendingRequests.delete(key);
      }
    }

    // 3. Rebuild prioritized request queue for desired tiles not yet visible or pending
    this.requestQueue = [];
    for (const [key, c] of candidateMap.entries()) {
      if (!this.patches.has(key) && !this.pendingRequests.has(key)) {
        this.requestQueue.push({
          key,
          zoom: c.zoom,
          x: c.x,
          y: c.y,
          dist: c.dist,
          style: this.currentTextureStyle,
        });
      }
    }

    // 4. Update parent/child visibility with strict 4/4 refinement
    this.updatePatchVisibility();

    // 5. Sort queue with group-aware priority (Stage X5)
    this.sortRequestQueue(defaultZoom);

    // 6. Drain queue up to concurrency limit
    this.drainQueue(provider);

    // 7. Prune expired or distant patches exceeding budget
    this.prunePatches(newDesiredKeys);
  }

  /**
   * Sorts requestQueue with group-aware priority (Stage X5):
   * Treat a four-child parent promotion as a scheduling unit.
   * - Tier 0: Missing 4th tile of a 3/4 child group (3 siblings already ready) -> unblock atomic promotion!
   * - Tier 1: Missing child for a 2/4 child group (2 siblings already ready) -> outrank starting a new parent
   * - Tier 2: 1 sibling already ready
   * - Tier 3: High-res tiles (zoom >= defaultZoom)
   * - Tier 4: Medium-res outer perimeter ring
   * Tie-breaker within tier: lowest distance from view center
   */
  private sortRequestQueue(defaultZoom: number = this.currentTargetZoom): void {
    const computeTileRank = (q: QueuedTile): number => {
      const parsed = parseTileKey(q.key);
      const parentKey = getParentTileKey(parsed.style, parsed.zoom, parsed.x, parsed.y);
      if (parentKey) {
        const group = this.getOrCreateRefinementGroup(parentKey);
        const readyCount = group ? group.readyChildren.size : 0;
        if (readyCount === 3) return 0; // Completing 3/4 child group -> highest priority!
        if (readyCount === 2) return 1; // 2/4 ready -> outrank starting a new distant parent
        if (readyCount === 1) return 2;
      }
      if (q.zoom >= defaultZoom) return 3;
      return 4;
    };

    const rankToPriority = (rank: number): TilePriority => {
      if (rank === 0) return TilePriority.CRITICAL;
      if (rank <= 3) return TilePriority.HIGH;
      return TilePriority.NORMAL;
    };

    const tileRanks = new Map<QueuedTile, number>();
    for (const q of this.requestQueue) {
      const rank = computeTileRank(q);
      q.priority = rankToPriority(rank);
      tileRanks.set(q, rank);
    }

    this.requestQueue.sort((a, b) => {
      const rA = tileRanks.get(a) ?? 4;
      const rB = tileRanks.get(b) ?? 4;
      if (rA !== rB) return rA - rB;
      return a.dist - b.dist;
    });
  }

  /**
   * Evaluates visibility for all ready patches according to explicit 4/4 RefinementGroup rules (Stage X5):
   * - 0/4 ready -> coarse representation only (all children hidden)
   * - 1/4 ready -> coarse representation only (all children hidden)
   * - 2/4 ready -> coarse representation only (all children hidden)
   * - 3/4 ready -> coarse representation only (all children hidden)
   * - 4/4 ready -> reveal all four children together atomically
   * The coarse representation may be an adaptive parent tile or underlying base imagery.
   * Partial child exposure is strictly forbidden across both tabletop and first-person view modes.
   */
  public updatePatchVisibility(): void {
    if (this.desiredTileKeys.size === 0) {
      for (const patch of this.patches.values()) {
        patch.mesh.visible = false;
      }
      return;
    }

    // 1. Identify which parent keys represent active RefinementGroups.
    // A parent tile P is a RefinementGroup IF AND ONLY IF:
    // (a) P is loaded as a patch in this.patches and any of its children are desired or loaded, OR
    // (b) P's children are being requested as a quadtree refinement (>= 2 sibling children desired,
    //     or all 4 children desired), OR
    // (c) P was already an active refinement group with ready children.
    const activeParentKeys = new Set<string>();

    for (const [pKey] of this.refinementGroups.entries()) {
      activeParentKeys.add(pKey);
    }

    // Check loaded patches: if patch has loaded or desired children, the patch itself is a parent
    for (const [key] of this.patches.entries()) {
      const parsed = parseTileKey(key);
      const childKeys = getChildTileKeys(parsed.style, parsed.zoom, parsed.x, parsed.y);
      if (childKeys.some((cKey) => this.desiredTileKeys.has(cKey) || this.patches.has(cKey))) {
        activeParentKeys.add(key);
      }
    }

    // Check desired tiles: count sibling children under each parent
    const desiredParentsCount = new Map<string, number>();
    for (const key of this.desiredTileKeys) {
      const parsed = parseTileKey(key);
      const pKey = getParentTileKey(parsed.style, parsed.zoom, parsed.x, parsed.y);
      if (pKey) {
        desiredParentsCount.set(pKey, (desiredParentsCount.get(pKey) ?? 0) + 1);
      }
    }
    for (const [pKey, count] of desiredParentsCount.entries()) {
      if (count >= 2 || this.patches.has(pKey)) {
        activeParentKeys.add(pKey);
      }
    }

    // Also count loaded patch siblings under each parent
    const patchParentsCount = new Map<string, number>();
    for (const [key] of this.patches.entries()) {
      const parsed = parseTileKey(key);
      const pKey = getParentTileKey(parsed.style, parsed.zoom, parsed.x, parsed.y);
      if (pKey) {
        patchParentsCount.set(pKey, (patchParentsCount.get(pKey) ?? 0) + 1);
      }
    }
    for (const [pKey, count] of patchParentsCount.entries()) {
      if (count >= 2) {
        activeParentKeys.add(pKey);
      }
    }

    // 2. Update readyChildren and state for all active refinement groups
    for (const parentKey of activeParentKeys) {
      this.getOrCreateRefinementGroup(parentKey);
    }

    // Clean up stale refinement groups that have 0 ready children and < 2 desired children
    for (const [pKey, group] of this.refinementGroups.entries()) {
      const desiredCount = group.fourChildKeys.filter((cKey) => this.desiredTileKeys.has(cKey)).length;
      if (group.readyChildren.size === 0 && desiredCount < 2 && !this.patches.has(pKey)) {
        this.refinementGroups.delete(pKey);
      }
    }

    // 3. Set visibility on each loaded patch enforcing strict 4/4 refinement
    for (const [key, patch] of this.patches.entries()) {
      const parsed = parseTileKey(key);
      const parentKey = getParentTileKey(parsed.style, parsed.zoom, parsed.x, parsed.y);

      // Check if patch belongs to a refinement group as a child
      let parentAllowsChildVisible = true;
      if (parentKey) {
        const parentGroup = this.refinementGroups.get(parentKey);
        if (parentGroup) {
          // Invariant: 0/4, 1/4, 2/4, 3/4 ready -> coarse representation only!
          // 4/4 ready -> reveal all four children together.
          if (parentGroup.state === 'parent' || parentGroup.state === 'loading') {
            parentAllowsChildVisible = false;
          }
        }
      }

      if (!parentAllowsChildVisible) {
        patch.mesh.visible = false;
        continue;
      }

      const ownChildGroup = this.refinementGroups.get(key);
      const isDesired = this.desiredTileKeys.has(key);
      const hasDesiredChildren =
        ownChildGroup !== undefined &&
        ownChildGroup.fourChildKeys.some((cKey) => this.desiredTileKeys.has(cKey));
      const isParentOfLoadingOrPromoting =
        hasDesiredChildren &&
        (ownChildGroup.state === 'parent' ||
          ownChildGroup.state === 'loading' ||
          ownChildGroup.state === 'promoting');

      // If neither desired nor providing coarse representation for loading/promoting children,
      // it belongs to the warm GPU-resident set (visible = false).
      if (!isDesired && !isParentOfLoadingOrPromoting) {
        patch.mesh.visible = false;
        continue;
      }

      // Check if THIS patch is a parent replaced by its own 4 children
      if (ownChildGroup && (ownChildGroup.state === 'promoting' || ownChildGroup.state === 'children')) {
        if (ownChildGroup.state === 'promoting') {
          // Crossfade: parent remains visible underneath while children fade in
          patch.mesh.visible = true;
        } else {
          // Fully promoted: hide parent
          patch.mesh.visible = false;
        }
      } else {
        // Not replaced by 4/4 children: patch remains visible
        patch.mesh.visible = true;
      }
    }
  }

  /**
   * Bounded scheduler processing tile requests up to concurrency limit (Section 30).
   */
  private drainQueue(provider: ImageryProvider): void {
    if (this.isDisposed) return;

    while (this.activeRequestCount < this.maxConcurrency && this.requestQueue.length > 0) {
      const next = this.requestQueue.shift();
      if (!next) break;

      // Verify request is still desired
      if (!this.desiredTileKeys.has(next.key) || this.patches.has(next.key)) {
        continue;
      }

      const abortController = new AbortController();
      const pending: PendingTileRequest = {
        ...next,
        abortController,
      };

      this.pendingRequests.set(next.key, pending);
      this.activeRequestCount++;

      const requestStyle = this.currentTextureStyle;
      ImageryLODManager.loadPatchImage(
        next.zoom,
        next.x,
        next.y,
        requestStyle,
        abortController.signal,
        next.priority ?? TilePriority.NORMAL
      )
        .then((imageSource) => {
          this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
          this.pendingRequests.delete(next.key);

          if (
            !this.isDisposed &&
            !abortController.signal.aborted &&
            (this.desiredTileKeys.has(next.key) || this.patches.size < this.maxPatches) &&
            this.currentTextureStyle === requestStyle
          ) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this.createAndMountPatch(next.key, next.zoom, next.x, next.y, imageSource, next.dist, now);
          }

          this.drainQueue(provider);
        })
        .catch(() => {
          this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
          this.pendingRequests.delete(next.key);
          this.drainQueue(provider);
        });
    }
  }

  private createAndMountPatch(
    key: string,
    zoom: number,
    x: number,
    y: number,
    img: HTMLImageElement | HTMLCanvasElement,
    dist: number,
    now: number
  ): void {
    if (this.patches.has(key)) return;

    // Create GPU Texture
    const texture = new THREE.CanvasTexture(img);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = TextureProvider.getMaxAnisotropy();
    texture.generateMipmaps = true;
    texture.needsUpdate = true;

    // Build conforming terrain geometry with true local Y datum
    const geo = this.buildPatchGeometry(zoom, x, y);

    const isXRActive = this.lastIsXR;
    const fadeDurationMs = isXRActive ? 150 : 250;
    const isFading = this.enableFadeIn;

    // Depth-write disabled during fade-in, opaque depth-write on completion (Section 42)
    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.9,
      metalness: 0.0,
      // Polygon offset prevents z-fighting with the base terrain mesh
      polygonOffset: true,
      polygonOffsetFactor: -1.0,
      polygonOffsetUnits: -1.0,
      transparent: isFading,
      opacity: isFading ? 0.0 : 1.0,
      depthTest: true,
      depthWrite: !isFading,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `ImageryPatch_${key}`;

    let outlineMesh: THREE.LineSegments | undefined;
    if (this.debugPatchBounds) {
      outlineMesh = this.buildPatchOutline(geo, zoom);
      mesh.add(outlineMesh);
    }

    this.group.add(mesh);

    const patch: ImageryPatch = {
      key,
      zoom,
      x,
      y,
      mesh,
      texture,
      lastUsed: now,
      centerDist: dist,
      creationTime: now,
      isFading,
      fadeDurationMs,
      outlineMesh,
      dispose: () => {
        if (patch.outlineMesh) {
          mesh.remove(patch.outlineMesh);
          patch.outlineMesh.geometry.dispose();
          (patch.outlineMesh.material as THREE.Material)?.dispose();
          patch.outlineMesh = undefined;
        }
        this.group.remove(mesh);
        geo.dispose();
        mat.dispose();
        texture.dispose();
      },
    };

    this.patches.set(key, patch);
    this.patchesCreatedTotal++;

    // Update parent/child visibility
    this.updatePatchVisibility();

    // Re-sort request queue so near-complete 3/4 groups unblock immediately (Stage X5)
    if (this.requestQueue.length > 1) {
      this.sortRequestQueue();
    }

    // Enforce patch budget
    if (this.patches.size > this.maxPatches) {
      this.evictFurthestPatch();
    }
  }

  private buildPatchGeometry(zoom: number, x: number, y: number): THREE.BufferGeometry {
    const tb = tileBounds(x, y, zoom);
    const nw = tb.nw;
    const se = tb.se;

    // Dynamic patch subdivision scaling (Section 44)
    const segments = getPatchSubdivisionSegments(zoom);
    const numVerts = (segments + 1) * (segments + 1);

    const positions = new Float32Array(numVerts * 3);
    const uvs = new Float32Array(numVerts * 2);
    const indices: number[] = [];

    const centerLat = this.options.terrainGeoBounds.centerLat;
    const centerLon = this.options.terrainGeoBounds.centerLon;
    const baseElevation = this.options.terrainBaseElevation;

    let vIdx = 0;
    for (let j = 0; j <= segments; j++) {
      const v = j / segments;
      const yVal = y + v;
      // Exact Web Mercator inverse projection for latitude
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * yVal) / 2 ** zoom)));
      const lat = radToDeg(latRad);

      for (let i = 0; i <= segments; i++) {
        const u = i / segments;
        const lon = nw.lon + u * (se.lon - nw.lon);

        const loc = geoToLocalMeters(lat, lon, 0, centerLat, centerLon, baseElevation);
        const groundLocalY = this.options.elevationSampler(loc.x, loc.z);
        const yPos = groundLocalY * this.verticalExaggeration + 0.04;

        positions[vIdx * 3] = loc.x;
        positions[vIdx * 3 + 1] = yPos;
        positions[vIdx * 3 + 2] = loc.z;

        uvs[vIdx * 2] = u;
        uvs[vIdx * 2 + 1] = 1 - v;

        vIdx++;
      }
    }

    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        const a = j * (segments + 1) + i;
        const b = a + 1;
        const c = a + (segments + 1);
        const d = c + 1;

        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    return geo;
  }

  private updatePatchGeometryHeights(geo: THREE.BufferGeometry, patch?: ImageryPatch): void {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const groundLocalY = this.options.elevationSampler(x, z);
      const y = groundLocalY * this.verticalExaggeration + 0.04;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    if (patch && patch.outlineMesh) {
      patch.mesh.remove(patch.outlineMesh);
      patch.outlineMesh.geometry.dispose();
      (patch.outlineMesh.material as THREE.Material)?.dispose();
      patch.outlineMesh = this.buildPatchOutline(geo, patch.zoom);
      patch.mesh.add(patch.outlineMesh);
    }
  }

  private buildPatchOutline(geo: THREE.BufferGeometry, zoom: number): THREE.LineSegments {
    const edges = new THREE.EdgesGeometry(geo, 40);
    let color = 0x818cf8; // default / base (indigo)
    if (zoom >= 19) {
      color = 0x22c55e; // z19 (vibrant emerald green)
    } else if (zoom === 18) {
      color = 0xfbbf24; // z18 perimeter ring (amber / warm yellow)
    } else if (zoom === 17) {
      color = 0x38bdf8; // z17 (sky cyan)
    }

    const lineMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.75,
    });
    const line = new THREE.LineSegments(edges, lineMat);
    line.name = 'DebugPatchBoundary';
    return line;
  }

  private hasPendingChildren(parentKey: string): boolean {
    const group = this.refinementGroups.get(parentKey);
    if (group && (group.state === 'loading' || group.state === 'promoting')) {
      return true;
    }
    const parsed = parseTileKey(parentKey);
    const childKeys = getChildTileKeys(parsed.style, parsed.zoom, parsed.x, parsed.y);
    const desiredChildKeys = childKeys.filter((k) => this.desiredTileKeys.has(k));
    if (desiredChildKeys.length === 0) return false;
    const allReady = desiredChildKeys.every((k) => this.patches.has(k));
    return !allReady;
  }

  /**
   * Calculates a multi-factor importance score for a patch (Stage W5).
   * Higher score = more important (retain in warm set).
   * Lower score = least important (evict first under memory pressure).
   */
  public calculatePatchImportanceScore(
    patch: ImageryPatch,
    activeKeys: Set<string>,
    now: number
  ): number {
    let score = 0;

    // 1. Active / Desired Status
    const isActive = activeKeys.has(patch.key);
    if (isActive) {
      score += 10000;
    }
    if (this.hasPendingChildren(patch.key)) {
      score += 5000;
    }

    // 2. Recency (time since last used)
    const ageSeconds = Math.max(0, (now - patch.lastUsed) / 1000);
    const retentionSeconds = this.warmRetentionMs / 1000;
    const recencyRatio = Math.max(0, 1 - ageSeconds / Math.max(1, retentionSeconds));
    score += recencyRatio * 2000;

    // 3. Spatial Proximity / Route Corridor
    if (this.viewMode === 'first-person') {
      if (this.routeGeometry) {
        const b = tileBounds(patch.x, patch.y, patch.zoom);
        const patchLat = (b.minLat + b.maxLat) / 2;
        const patchLon = (b.minLon + b.maxLon) / 2;
        const hikerTele = this.routeGeometry.getTelemetryAtProgress(this.currentProgress);
        const hikerPt = hikerTele.currentPoint;
        const latDiff = (patchLat - hikerPt.lat) * 111320;
        const lonDiff = (patchLon - hikerPt.lon) * 111320 * Math.cos((hikerPt.lat * Math.PI) / 180);
        const distToHiker = Math.hypot(latDiff, lonDiff);

        // Corridor envelope bonus (retained behind and prefetched ahead)
        const corridorMax = Math.max(this.firstPersonRetainBehindM, this.firstPersonPrefetchAheadM);
        if (distToHiker <= corridorMax) {
          score += 3000;
        }
        score += Math.max(0, 2000 - distToHiker * 2);
      }
    } else {
      // Tabletop mode: proximity to current viewed terrain hit / diorama center
      score += Math.max(0, 3000 - patch.centerDist * 300);
    }

    return score;
  }

  private prunePatches(activeKeys: Set<string>): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // 1. Retain warm tiles until budget is actually exceeded (Stage W5).
    // Stale cold tiles (> warmRetentionMs * 2) with low score (< 500) can be gently pruned
    const coldThresholdMs = this.warmRetentionMs * 2;
    for (const [key, patch] of this.patches.entries()) {
      if (this.hasPendingChildren(key) || activeKeys.has(key)) continue;

      const score = this.calculatePatchImportanceScore(patch, activeKeys, now);
      if (now - patch.lastUsed > coldThresholdMs && score < 500) {
        patch.dispose();
        this.patches.delete(key);
        this.patchesDisposedTotal++;
      }
    }

    // 2. Memory-pressure driven eviction: when patch count exceeds maxPatches,
    // evict the lowest scoring tiles first (Stage W5)
    while (this.patches.size > this.maxPatches) {
      let lowestScore = Infinity;
      let victimKey: string | null = null;

      for (const [key, patch] of this.patches.entries()) {
        if (this.hasPendingChildren(key)) continue;

        const score = this.calculatePatchImportanceScore(patch, activeKeys, now);
        if (score < lowestScore) {
          lowestScore = score;
          victimKey = key;
        }
      }

      if (victimKey) {
        const patch = this.patches.get(victimKey);
        patch?.dispose();
        this.patches.delete(victimKey);
        this.patchesDisposedTotal++;
      } else {
        break;
      }
    }

    this.updatePatchVisibility();
  }

  private evictFurthestPatch(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let lowestScore = Infinity;
    let victimKey: string | null = null;

    for (const [key, patch] of this.patches.entries()) {
      if (this.hasPendingChildren(key)) continue;

      const score = this.calculatePatchImportanceScore(patch, this.desiredTileKeys, now);
      if (score < lowestScore) {
        lowestScore = score;
        victimKey = key;
      }
    }

    if (victimKey) {
      const patch = this.patches.get(victimKey);
      if (patch) {
        patch.dispose();
        this.patches.delete(victimKey);
        this.patchesDisposedTotal++;
        this.updatePatchVisibility();
      }
    }
  }

  private clearAllPatches(): void {
    this.refinementGroups.clear();
    for (const patch of this.patches.values()) {
      patch.dispose();
      this.patchesDisposedTotal++;
    }
    this.patches.clear();
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0]);
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const pending of this.pendingRequests.values()) {
      pending.abortController.abort();
    }
    this.pendingRequests.clear();
    this.requestQueue = [];
    this.desiredTileKeys.clear();
    this.activeRequestCount = 0;
    this.refinementGroups.clear();

    this.clearAllPatches();
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    disposeObject3D(this.group);
  }
}
