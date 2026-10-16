import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';

const coords = pathToFileURL(path.resolve('src/gpx/Coordinates.ts')).href;
const { latLonToTile, tileBounds } = await import(coords);
async function load(source) {
  const js = stripTypeScriptTypes(source).replace("'../gpx/Coordinates.ts'", JSON.stringify(coords));
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).computeBroadDetailTiles;
}
const before = await load(execFileSync('git', ['show', 'f3a3c7f:src/terrain/BroadDetailSelection.ts'], { encoding: 'utf8', windowsHide: true }));
const after = await load(fs.readFileSync('src/terrain/BroadDetailSelection.ts', 'utf8'));
const center = { lat: 46.85, lon: -121.75 };
const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.85, maxLon: -121.65, centerLat: center.lat, centerLon: center.lon,
  widthMeters: 15000, depthMeters: 11000, minEle: 0, maxEle: 4000, elevationSpan: 4000 };
const edge = before(center, 19, 480, bounds).find(t => t.zoom === 19 && t.dist > 0);
const b = tileBounds(edge.x, edge.y, 19);
const current = { lat: (b.nw.lat + b.se.lat) / 2, lon: (b.nw.lon + b.se.lon) / 2 };
const history = Array.from({ length: 12 }, (_, i) => ({ lat: center.lat + Math.sin(i * Math.PI / 6) * .025, lon: center.lon + Math.cos(i * Math.PI / 6) * .04 }));
const group = tile => `${tile.zoom}:${Math.floor(tile.x / 4)}:${Math.floor(tile.y / 4)}`;
const targetGroup = group({ ...latLonToTile(current.lat, current.lon, 19), zoom: 19 });
const cases = [
  { name: 'Already selected view edge with distant retained history', points: [center, current, ...history] },
  { name: 'Broad core without view targets', points: [] },
  { name: 'Many current and retained view targets', points: [center, ...history, current] },
];
const results = cases.map(({ name, points }) => {
  const oldTiles = before(center, 19, 480, bounds, points), newTiles = after(center, 19, 480, bounds, points);
  const keys = tiles => tiles.map(t => `${t.zoom}:${t.x}:${t.y}`).sort();
  assert.deepEqual(keys(oldTiles), keys(newTiles), `${name}: geographic coverage changed`);
  // Empty-resident initial fine requests: all groups have the same sibling
  // completion rank. Collapse ordered crops to distinct 1024px source exports.
  const order = tiles => [...new Set(tiles.filter(t => t.zoom === 19).sort((a, b) => a.dist - b.dist).map(group))];
  return { name, selectedTiles: newTiles.length, fineTiles: newTiles.filter(t => t.zoom === 19).length, identicalTileKeys: true,
    targetSourcePositionBefore: order(oldTiles).indexOf(targetGroup), targetSourcePositionAfter: order(newTiles).indexOf(targetGroup),
    firstFourSourcesBefore: order(oldTiles).slice(0, 4), firstFourSourcesAfter: order(newTiles).slice(0, 4) };
});
assert(results[0].targetSourcePositionAfter < results[0].targetSourcePositionBefore);
assert.equal(results[0].targetSourcePositionAfter, 1, 'Hiker source remains first, current view edge follows');
const result = { baseline: 'f3a3c7f', condition: 'Pure selection and initial source-order comparison. No elapsed-time, browser rendering or native MR claim. Positions are zero-based.', cases: results };
const out = path.resolve('.review-cache/view-priority'); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'order.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
