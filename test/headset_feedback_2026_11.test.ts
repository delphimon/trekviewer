import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { trailWidthFraction, TRAIL_ANGULAR_HALF_WIDTH } from '../src/visualization/TrailChevronMaterial.ts';
import { HUDTerrainClearance, requiredHUDLift } from '../src/xr/HUDTerrainClearance.ts';
import { TiledTerrainStreamer } from '../src/terrain/TiledTerrainStreamer.ts';

const track = GPXParser.parse(`<gpx><trk><name>Width test</name><trkseg>
<trkpt lat="47" lon="-121"><ele>100</ele></trkpt>
<trkpt lat="47.02" lon="-120.98"><ele>300</ele></trkpt></trkseg></trk></gpx>`, 'Width test');

describe('trail width follows view distance (headset feedback)', () => {
  const tabletop = { builtHalfWidth: 20, angularHalfWidth: TRAIL_ANGULAR_HALF_WIDTH, minHalfWidth: 1 };
  const lifeSize = { builtHalfWidth: 0.35, angularHalfWidth: TRAIL_ANGULAR_HALF_WIDTH, minHalfWidth: 0.05 };

  it('keeps the built width for an overview but narrows a zoomed-in tabletop', () => {
    // 1:20000 tabletop seen from 0.6 m: built width is already thin.
    expect(trailWidthFraction(tabletop, 0.6, 1 / 20000)).toBe(1);
    // Zoomed to 1:500: 20 m half-width would be a 8 cm band; now about 0.66 m.
    expect(trailWidthFraction(tabletop, 0.6, 1 / 500) * 20).toBeCloseTo(1, 0);
  });

  it('draws the 1:1 trail as a thin line near the viewer and full width far away', () => {
    expect(trailWidthFraction(lifeSize, 1.7, 1) * 0.35).toBeCloseTo(0.05, 3);
    expect(trailWidthFraction(lifeSize, 500, 1)).toBe(1);
  });

  it('keeps each vertex\'s opposite-edge copy in step with terrain and exaggeration changes', () => {
    const trail = TrailMesh.create(track, () => 10);
    const check = () => {
      const geo = trail.trailMesh.geometry;
      const pos = geo.getAttribute('position'), partner = geo.getAttribute('trailPartner');
      for (const i of [0, 1, 6, 7, pos.count - 1]) {
        expect(partner.getY(i)).toBeCloseTo(pos.getY(i ^ 1), 5);
        expect(partner.getX(i)).toBeCloseTo(pos.getX(i ^ 1), 5);
      }
    };
    check();
    trail.setVerticalExaggeration(2); check();
    trail.reprojectToSurface!(() => 42); check();
    trail.setViewMode('first-person'); check();
    trail.reprojectToSurface!(() => 7); check();
    trail.dispose();
  });
});

describe('spatial panel stays out of the terrain (headset feedback)', () => {
  const eye = new THREE.Vector3(0, 1.6, 0);

  it('needs no lift over flat ground well below the panel', () => {
    const bottoms = [new THREE.Vector3(-0.4, 1.1, -1.1), new THREE.Vector3(0.4, 1.1, -1.1)];
    expect(requiredHUDLift(eye, bottoms, () => 0)).toBe(0);
  });

  it('lifts the panel above a ridge in front of it and comes back down when it passes', () => {
    const group = new THREE.Group();
    group.position.set(0, 1.4, -1.1);
    const clearance = new HUDTerrainClearance();
    clearance.reset(group);
    let ground = 1.3; // terrain rising through the panel's lower half
    const surface = () => ground;
    clearance.update(group, 0.4, 0.3, eye, surface, 0, eye.y + 0.05, true);
    expect(group.position.y - 0.3).toBeGreaterThanOrEqual(1.3);
    expect(clearance.buried).toBe(false);
    ground = 0;
    for (let t = 1; t < 400; t++) clearance.update(group, 0.4, 0.3, eye, surface, t * 250, eye.y + 0.05);
    expect(group.position.y).toBeCloseTo(1.4, 3);
  });

  it('caps the lift near eye level and reports the panel as buried instead', () => {
    const group = new THREE.Group();
    group.position.set(0, 1.4, -1.1);
    const clearance = new HUDTerrainClearance();
    clearance.update(group, 0.4, 0.3, eye, () => 3, 0, eye.y + 0.05, true);
    expect(group.position.y).toBeCloseTo(1.65, 5);
    expect(clearance.buried).toBe(true);
  });

  it('treats a manual move as the new resting height', () => {
    const group = new THREE.Group();
    group.position.set(0, 1.4, -1.1);
    const clearance = new HUDTerrainClearance();
    clearance.reset(group);
    group.position.y = 1.0; // dragged lower by the user
    clearance.update(group, 0.4, 0.3, eye, () => null, 0, 2, true);
    expect(group.position.y).toBe(1.0);
  });
});

describe('terrain seam blending is spread across frames (loading hitches)', () => {
  it('re-blends at most one chunk per call until no edges change', () => {
    const streamer: any = Object.create(TiledTerrainStreamer.prototype);
    const make = () => {
      let changed = true;
      return { mesh: { visible: true }, getSurfaceBounds: () => ({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }),
        setOuterEdges: vi.fn(() => { const was = changed; changed = false; return was; }) };
    };
    const a = make(), b = make();
    streamer.chunks = new Map([['0:0', a], ['1:0', b]]);
    streamer.seamsDirty = true;
    const notify = vi.fn();
    streamer.applyPendingSeam({ notifySurfaceChange: notify });
    expect(notify).toHaveBeenCalledTimes(1);
    streamer.applyPendingSeam({ notifySurfaceChange: notify });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(streamer.seamsDirty).toBe(true);
    streamer.applyPendingSeam({ notifySurfaceChange: notify });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(streamer.seamsDirty).toBe(false);
  });
});
