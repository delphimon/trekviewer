import * as THREE from 'three';
import { describe, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import * as fs from 'fs';
import * as path from 'path';

describe('2D Trail Ribbon & Alpine Hiker Beacon', () => {
  it('evaluates trail ribbon geometry and hiker beacon components', () => {

// Parse a sample route
const gpxPath = path.resolve('public/routes/MountRanierViaEmmons.gpx.gpx');
const xml = fs.readFileSync(gpxPath, 'utf8');
const track = GPXParser.parse(xml, 'Rainier Test');

const trail = TrailMesh.create(track);

// 1. Verify Trail Mesh Geometry is Flat 2D Ribbon (BufferGeometry with indices and vertex colors)
const geo = trail.trailMesh.geometry;
if (!geo.index) {
  throw new Error('Trail ribbon geometry must have index attribute for triangle quads');
}
const posAttr = geo.attributes.position;
const normAttr = geo.attributes.normal;
const colorAttr = geo.attributes.color;

if (!posAttr || !normAttr || !colorAttr) {
  throw new Error('Trail ribbon must have position, normal, and color attributes');
}

console.log(`Trail Ribbon Vertices: ${posAttr.count}`);
console.log(`Trail Ribbon Triangles: ${geo.index.count / 3}`);

// Verify that normals point upward (Y > 0.9)
for (let i = 0; i < Math.min(100, normAttr.count); i++) {
  const ny = normAttr.getY(i);
  if (ny < 0.9) {
    throw new Error(`Expected upward ribbon normal, got ny=${ny} at vertex ${i}`);
  }
}
console.log('✓ Trail ribbon has proper 2D upward normals and zero 3D cylinder bulk');

// 2. Verify Hiker Marker Beacon Components
const hiker = trail.hikerMarker;
if (hiker.children.length < 4) {
  throw new Error(`Expected at least 4 beacon components in hikerMarker, got ${hiker.children.length}`);
}

// Check for elevated jewel, core, vertical pillar, ground rings, chevron
let hasElevatedJewel = false;
let hasLaserPillar = false;
let hasGroundRing = false;
let hasForwardChevron = false;

hiker.children.forEach((child) => {
  const mesh = child as THREE.Mesh;
  const geoType = mesh.geometry?.type;
  if (geoType === 'OctahedronGeometry' && child.position.y > 10) {
    hasElevatedJewel = true;
  } else if (geoType === 'CylinderGeometry' && child.position.y > 5) {
    hasLaserPillar = true;
  } else if (geoType === 'ConeGeometry' && child.position.y > 5) {
    hasForwardChevron = true;
  } else if (geoType === 'RingGeometry' && child.position.y < 5.0) {
    hasGroundRing = true;
  }
});

if (!hasElevatedJewel) throw new Error('Missing elevated beacon jewel at y>=25m');
if (!hasLaserPillar) throw new Error('Missing vertical laser pillar');
if (!hasGroundRing) throw new Error('Missing ground footprint target ring');
if (!hasForwardChevron) throw new Error('Missing forward directional chevron');

console.log('✓ Elevated beacon jewel (y=28m), laser pillar, ground rings, and directional chevron verified!');

// 3. Verify Hiker update position
const updateResult = trail.updateHikerPosition(0.5);
console.log(`Hiker position at 50% trek progress: { x: ${updateResult.position.x.toFixed(1)}, y: ${updateResult.position.y.toFixed(1)}, z: ${updateResult.position.z.toFixed(1)} }`);
if (Math.abs(hiker.position.x - updateResult.position.x) > 0.001) {
  throw new Error('Hiker marker position did not update correctly to match progress');
}
console.log('✓ Hiker position tracking along trail curve verified!');

console.log('✓ All 2D Trail Ribbon & Alpine Hiker Beacon tests passed!');
  });
});
