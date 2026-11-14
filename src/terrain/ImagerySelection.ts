/** Pure imagery tile selection (keys, quadtree relations, coherent LOD rings). Moved
 * unchanged from ImageryLODManager.ts. */
import type { GeoBounds, TextureStyle } from '../gpx/TrackTypes.ts';
import { latLonToTile, tileBounds } from '../gpx/Coordinates.ts';

/** Whether a tile intersects the terrain's geographic bounds. */
export function tileIntersectsBounds(x: number, y: number, zoom: number, bounds: GeoBounds): boolean {
  const tb = tileBounds(x, y, zoom);
  return !(tb.maxLon < bounds.minLon || tb.minLon > bounds.maxLon || tb.maxLat < bounds.minLat || tb.minLat > bounds.maxLat);
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
          if (tileIntersectsBounds(tx, ty, targetZoom, bounds)) {
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
          if (tileIntersectsBounds(cx, cy, zHigh, bounds)) {
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
        if (tileIntersectsBounds(px, py, zMid, bounds)) {
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
        if (tileIntersectsBounds(tx, ty, zMid, bounds)) {
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
  corridorPoints?: { lat: number; lon: number }[],
  visiblePoints?: { lat: number; lon: number }[]
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
          if (tileIntersectsBounds(tx, ty, zHigh, bounds)) {
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
          if (tileIntersectsBounds(cx, cy, zHigh, bounds)) {
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
          if (tileIntersectsBounds(mx, my, zMid, bounds)) {
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

  // 2. Keep the ground immediately around the hiker sharp in every direction.
  // Route prefetch must not consume the budget before these nearby parents.
  for (let py = minPy; py <= maxPy; py++) {
    for (let px = minPx; px <= maxPx; px++) {
      addPriority(px, py);
    }
  }

  // 3. Refine terrain currently in the headset view before off-screen trail
  // prefetch. A hiker can face a wall or pass far to the side of the route.
  for (const point of visiblePoints ?? []) {
    const tile = latLonToTile(point.lat, point.lon, zHigh);
    addPriority(Math.floor(tile.x / 2), Math.floor(tile.y / 2));
  }

  // 4. Trail corridor parents connecting contiguously from hiker outward
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

  // 5. Lateral wings: widen corridor around trail parents when budget permits (maxPatches >= 48)
  if (maxPatches >= 48) {
    const mainTrailParents = [...priorityParents];
    for (const p of mainTrailParents) {
      addPriority(p.px + 1, p.py);
      addPriority(p.px - 1, p.py);
      addPriority(p.px, p.py + 1);
      addPriority(p.px, p.py - 1);
    }
  }

  // 6. 2x2 cluster around forward prefetch
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
        if (tileIntersectsBounds(tx, ty, zMid, bounds)) {
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
 * A stable, concentric first-person footprint for Quest High. Four levels give
 * the hiker z19 detail while keeping z16–z17 imagery resident in every look
 * direction. The selected keys depend on route position, never head rotation.
 */
export function computeFirstPersonStableLODTiles(
  hikerLat: number,
  hikerLon: number,
  innerZoom: number,
  maxPatches: number,
  bounds: GeoBounds
): CoherentTileCandidate[] {
  if (maxPatches < 61 || innerZoom < 16) {
    return computeFirstPersonCoherentLODTiles(
      hikerLat, hikerLon, hikerLat, hikerLon, innerZoom, maxPatches, bounds
    );
  }
  const zOuter = innerZoom - 3;
  const zNear = innerZoom - 2;
  const zParent = innerZoom - 1;
  const centerOuter = latLonToTile(hikerLat, hikerLon, zOuter);
  const centerNear = latLonToTile(hikerLat, hikerLon, zNear);
  const result: CoherentTileCandidate[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number, zoom: number, dist: number) => {
    const key = `${zoom}:${x}:${y}`;
    if (seen.has(key) || !tileIntersectsBounds(x, y, zoom, bounds)) return;
    seen.add(key);
    result.push({ x, y, zoom, dist, isHighRes: zoom === innerZoom });
  };

  // Broad outer tiles stay resident while the hiker turns in place.
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      add(centerOuter.x + dx, centerOuter.y + dy, zOuter, Math.hypot(dx, dy) + 6);
    }
  }
  // A full 4x4 intermediate block supplies 360-degree near-field detail.
  // Align to z16 parent boundaries so the parent never disappears after only
  // part of its area has loaded.
  const nearStartX = Math.floor((centerNear.x - 1) / 2) * 2;
  const nearStartY = Math.floor((centerNear.y - 1) / 2) * 2;
  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 4; dx++) {
      add(nearStartX + dx, nearStartY + dy, zNear,
        Math.hypot(nearStartX + dx - centerNear.x, nearStartY + dy - centerNear.y) + 3);
    }
  }
  // Promote all four z18 children of the hiker's z17 tile, then every z19
  // child of those parents. Every level replaces its parent atomically.
  for (let pyOffset = 0; pyOffset < 2; pyOffset++) {
    for (let pxOffset = 0; pxOffset < 2; pxOffset++) {
      const px = centerNear.x * 2 + pxOffset;
      const py = centerNear.y * 2 + pyOffset;
      add(px, py, zParent, 1);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          add(px * 2 + dx, py * 2 + dy, innerZoom, 0);
        }
      }
    }
  }
  return result;
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
