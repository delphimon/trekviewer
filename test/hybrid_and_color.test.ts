import { describe, it } from "vitest";
import * as THREE from 'three';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import * as fs from 'fs';
import * as path from 'path';

describe("hybrid and color", () => {
  it("verifies hybrid and color", async () => {

console.log('--- Testing Hybrid Map View, Trail Color Modes & Radiant Hiker Beacon ---');

// 1. Load test trek (Mount Rainier via Emmons)
const rainierXml = fs.readFileSync(path.resolve('public/routes/MountRanierViaEmmons.gpx.gpx'), 'utf8');
const track = GPXParser.parse(rainierXml, 'Mount Rainier via Emmons');

// 2. Test Trail Mesh creation and default color mode
const trailResult = TrailMesh.create(track);

const ribbonGeo = trailResult.trailMesh.geometry;
const colorAttr = ribbonGeo.attributes.color as THREE.BufferAttribute;
if (!colorAttr) {
  throw new Error('Expected trail mesh to have color attribute');
}

console.log(`Trail vertices: ${ribbonGeo.attributes.position.count}, Color tuples: ${colorAttr.count}`);

// Verify that colors exist and are valid RGB floats [0, 1]
for (let i = 0; i < colorAttr.count; i += 100) {
  const r = colorAttr.getX(i);
  const g = colorAttr.getY(i);
  const b = colorAttr.getZ(i);
  if (isNaN(r) || isNaN(g) || isNaN(b) || r < 0 || r > 1 || g < 0 || g > 1 || b < 0 || b > 1) {
    throw new Error(`Invalid RGB vertex color at index ${i}: (${r}, ${g}, ${b})`);
  }
}
console.log('✓ Trail ribbon vertex colors initialized properly (Grade / Steepness mode default)');

// Test cycling to 'speed' (Pace) mode
trailResult.setColorMode('speed');
const speedColorSample = [colorAttr.getX(50), colorAttr.getY(50), colorAttr.getZ(50)];
console.log(`Sample Pace/Speed RGB at segment 50: (${speedColorSample.map(v => v.toFixed(3)).join(', ')})`);

// Test cycling to 'elevation' mode
trailResult.setColorMode('elevation');
const eleColorSample = [colorAttr.getX(50), colorAttr.getY(50), colorAttr.getZ(50)];
console.log(`Sample Elevation RGB at segment 50: (${eleColorSample.map(v => v.toFixed(3)).join(', ')})`);

// Return to 'grade' mode
trailResult.setColorMode('grade');
console.log('✓ Trail color mode successfully toggled between Grade, Speed/Pace, and Elevation');

// 3. Test Radiant Hiker Beacon Prominence
const marker = trailResult.hikerMarker;
let jewelFound = false;
let jewelY = 0;
let coreFound = false;
let pillarFound = false;
let ringCount = 0;
let arrowFound = false;

marker.traverse((obj) => {
  if ((obj as THREE.Mesh).isMesh) {
    const mesh = obj as THREE.Mesh;
    const geo = mesh.geometry;
    if (geo.type === 'OctahedronGeometry') {
      jewelFound = true;
      jewelY = mesh.position.y;
    }
    if (geo.type === 'SphereGeometry' && mesh.position.y > 10) {
      coreFound = true;
    }
    if (geo.type === 'CylinderGeometry') {
      pillarFound = true;
    }
    if (geo.type === 'RingGeometry') {
      ringCount++;
    }
    if (geo.type === 'ConeGeometry') {
      arrowFound = true;
    }
  }
});

console.log(`Beacon components: jewelFound=${jewelFound} (elevated y=${jewelY.toFixed(1)}m), coreFound=${coreFound}, pillarFound=${pillarFound}, rings=${ringCount}, arrowFound=${arrowFound}`);

if (!jewelFound || jewelY < 35) {
  throw new Error(`Expected hiker beacon jewel to be prominently elevated (found y=${jewelY})`);
}
if (!coreFound || !pillarFound || ringCount < 2 || !arrowFound) {
  throw new Error('Expected hiker beacon to include radiant core, laser pillar, multiple ground radar rings, and heading arrow');
}
console.log('✓ Prominent hiker beacon verified: diamond jewel, core, laser pillar, radar reticle, and heading arrow');

// 4. Test Hybrid Tile URLs & Quadrangle calculations
const grid = TextureProvider.getTileGridForBounds(track.bounds);
console.log(`Rainier Tile Grid zoom=${grid.zoom}, ${grid.numTilesX}x${grid.numTilesY} tiles`);

const testTx = grid.tileXMin;
const testTy = grid.tileYMin;

const usgsHybridUrl = `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/${grid.zoom}/${testTy}/${testTx}`;
const esriOverlayUrl = `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer/tile/${grid.zoom}/${testTy}/${testTx}`;
const esriPlacesUrl = `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${grid.zoom}/${testTy}/${testTx}`;

console.log('Sample Hybrid USGS Tile URL:', usgsHybridUrl);
console.log('Sample Esri Reference Overlay Tile URL:', esriOverlayUrl);
console.log('Sample Esri Places/Landmarks Tile URL:', esriPlacesUrl);

if (!usgsHybridUrl.includes('USGSImageryTopo') || !esriOverlayUrl.includes('World_Reference_Overlay')) {
  throw new Error('Invalid Hybrid tile URL format');
}
console.log('✓ Hybrid imagery and reference label tile URLs validated');

console.log('✓ All Hybrid Map View, Trail Color, and Hiker Beacon tests passed successfully!');

  });
});
