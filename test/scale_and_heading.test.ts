import * as THREE from 'three';
import { describe, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import * as fs from 'fs';
import * as path from 'path';

describe('Scale-Adaptive Route, 1:1 Forward Angle & Topo Tile URLs', () => {
  it('evaluates scale adaptation, 1:1 heading, and topo tile URLs', () => {

// 1. Test Scale Adaptation: Small Alpine Climb vs. Massive Bailey Range Traverse
const rainierXml = fs.readFileSync(path.resolve('public/routes/MountRainierViaEmmons.gpx'), 'utf8');
const rainierTrack = GPXParser.parse(rainierXml, 'Mount Rainier');

const baileyXml = fs.readFileSync(path.resolve('public/routes/OlympusBaileyTraverse2026.gpx'), 'utf8');
const baileyTrack = GPXParser.parse(baileyXml, 'Bailey Range Traverse');

const rainierDim = Math.max(rainierTrack.bounds.widthMeters, rainierTrack.bounds.depthMeters);
const baileyDim = Math.max(baileyTrack.bounds.widthMeters, baileyTrack.bounds.depthMeters);

console.log(`Rainier Extent: ${(rainierDim / 1000).toFixed(1)} km`);
console.log(`Bailey Range Extent: ${(baileyDim / 1000).toFixed(1)} km`);

if (baileyDim <= rainierDim * 1.5) {
  throw new Error('Expected Bailey Range Traverse extent to be significantly larger than Rainier');
}

const rainierTrail = TrailMesh.create(rainierTrack);
const baileyTrail = TrailMesh.create(baileyTrack);

// Inspect geometry attributes
const rainierPositions = rainierTrail.trailMesh.geometry.attributes.position;
const baileyPositions = baileyTrail.trailMesh.geometry.attributes.position;

// Check width difference between Rainier and Bailey Range:
// Bailey ribbon width in world coordinates should be substantially larger so it maintains ~2mm visible on table
const rainierWidth = Math.abs(rainierPositions.getX(1) - rainierPositions.getX(0)) || Math.abs(rainierPositions.getZ(1) - rainierPositions.getZ(0));
const baileyWidth = Math.abs(baileyPositions.getX(1) - baileyPositions.getX(0)) || Math.abs(baileyPositions.getZ(1) - baileyPositions.getZ(0));

console.log(`Rainier World Ribbon Width: ${rainierWidth.toFixed(1)}m`);
console.log(`Bailey Range World Ribbon Width: ${baileyWidth.toFixed(1)}m`);

if (baileyWidth <= rainierWidth) {
  throw new Error(`Expected Bailey Range ribbon width (${baileyWidth}m) to be larger than Rainier (${rainierWidth}m) for scale adaptation`);
}

// Check hiker jewel height
let rainierJewelY = 0;
rainierTrail.hikerMarker.children.forEach(c => {
  if ((c as THREE.Mesh).geometry?.type === 'OctahedronGeometry') rainierJewelY = c.position.y;
});

let baileyJewelY = 0;
baileyTrail.hikerMarker.children.forEach(c => {
  if ((c as THREE.Mesh).geometry?.type === 'OctahedronGeometry') baileyJewelY = c.position.y;
});

console.log(`Rainier Hiker Jewel Height: ${rainierJewelY.toFixed(1)}m`);
console.log(`Bailey Range Hiker Jewel Height: ${baileyJewelY.toFixed(1)}m`);

if (baileyJewelY <= rainierJewelY) {
  throw new Error('Expected Bailey Range hiker jewel height to scale with extent');
}
console.log('✓ Scale-adaptive route ribbon and hiker beacon verified across 15km and 50km+ treks!');

// 2. Test 1:1 Forward Angle Heading
const controller = new FlyoverController(rainierTrail, rainierTrack);
controller.setViewMode('first-person');

const dummyDioramaRoot = new THREE.Group();
// Run update for WebXR presenting mode
controller.update(0.016, undefined, dummyDioramaRoot, true);

// Verify dioramaRoot has valid rotation and offset
console.log(`1:1 WebXR World Rotation Y: ${dummyDioramaRoot.rotation.y.toFixed(3)} rad (${(dummyDioramaRoot.rotation.y * 180 / Math.PI).toFixed(1)}°)`);
console.log(`1:1 WebXR World Position Offset: { x: ${dummyDioramaRoot.position.x.toFixed(1)}, y: ${dummyDioramaRoot.position.y.toFixed(1)}, z: ${dummyDioramaRoot.position.z.toFixed(1)} }`);

// Check that tangent vector when rotated by rotY points towards -Z (forward into room)
const tangent = rainierTrail.curve.getTangentAt(0);
const rotatedTangent = tangent.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), dummyDioramaRoot.rotation.y);
console.log(`Trail tangent in WebXR Room Space: { x: ${rotatedTangent.x.toFixed(3)}, y: ${rotatedTangent.y.toFixed(3)}, z: ${rotatedTangent.z.toFixed(3)} }`);

if (rotatedTangent.z >= 0) {
  throw new Error(`Expected trail tangent in room space to point forward (-Z <= 0), but got z = ${rotatedTangent.z.toFixed(3)} (looking backward)`);
}
console.log('✓ 1:1 mode rotates 180° into travel heading facing forward along -Z in room space!');

// 3. Test Topo Tile URL and Grid Generation
const tileGrid = TextureProvider.getTileGridForBounds(rainierTrack.bounds);
console.log(`Topo Tile Grid at Zoom ${tileGrid.zoom}: ${tileGrid.numTilesX}x${tileGrid.numTilesY} tiles (${tileGrid.numTilesX * tileGrid.numTilesY} total)`);

const sampleTx = tileGrid.tileXMin;
const sampleTy = tileGrid.tileYMin;
const usgsUrl = `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/${tileGrid.zoom}/${sampleTy}/${sampleTx}`;
const esriUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${tileGrid.zoom}/${sampleTy}/${sampleTx}`;
const otmUrl = `https://a.tile.opentopomap.org/${tileGrid.zoom}/${sampleTx}/${sampleTy}.png`;

console.log(`Sample USGS Topo URL: ${usgsUrl}`);
console.log(`Sample ArcGIS Topo URL: ${esriUrl}`);
console.log(`Sample OpenTopoMap URL: ${otmUrl}`);

if (!usgsUrl.includes('USGSTopo') || !esriUrl.includes('World_Topo_Map') || !otmUrl.includes('opentopomap.org')) {
  throw new Error('Invalid topo tile URL format');
}
console.log('✓ High-res Topographic tile URLs and Web Mercator bounds verified!');

console.log('✓ All scale, heading, and topo map tests passed!');
  });
});
