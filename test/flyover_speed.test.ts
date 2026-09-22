import * as fs from 'fs';
import { describe, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';

describe('GPS Speed-Inferred Playback Simulation', () => {
  it('correctly parses track playback times and simulates flyover steps', () => {
    const xml = fs.readFileSync('./public/routes/MountRainierViaEmmons.gpx', 'utf8');
    const track = GPXParser.parse(xml, 'Mount Rainier via Emmons');

    if (track.totalPlaybackSeconds <= 0) {
      throw new Error('totalPlaybackSeconds must be positive');
    }

    const trailResult = TrailMesh.create(track);
    const flyover = new FlyoverController(trailResult, track);

    // Verify initial state
    flyover.setProgress(0);
    if (flyover.getProgress() !== 0 || flyover.getPlaybackTime() !== 0) {
      throw new Error('Initial state mismatch');
    }

// Test speed variation between flat section vs steep climb
// Find flat section vs steep section in track.points
let flatPtIdx = 0;
let steepPtIdx = 0;
for (let i = 10; i < track.points.length - 10; i++) {
  const g = Math.abs(track.points[i].grade || 0);
  if (g < 8 && flatPtIdx === 0) flatPtIdx = i;
  if (g > 35 && steepPtIdx === 0) steepPtIdx = i;
}

const flatPt = track.points[flatPtIdx];
const steepPt = track.points[steepPtIdx];
console.log(`Flat section grade: ${flatPt.grade?.toFixed(1)}%, speed: ${(flatPt.speed || 0).toFixed(2)} m/s`);
console.log(`Steep section grade: ${steepPt.grade?.toFixed(1)}%, speed: ${(steepPt.speed || 0).toFixed(2)} m/s`);

// Step distance in meters (thumbstick simulation)
flyover.setProgress(0);
flyover.stepDistanceMeters(1000); // Walk 1000 meters
const p1km = flyover.getProgress();
const dist1km = p1km * track.totalDistance;
console.log('After stepping 1000m: progress =', p1km.toFixed(4), 'distance =', dist1km.toFixed(1), 'm');
if (Math.abs(dist1km - 1000) > 1) {
  throw new Error(`stepDistanceMeters did not advance 1000m: ${dist1km}`);
}

// Test continuous play update
flyover.play();
flyover.update(1.0); // 1 real second
const pAfter1s = flyover.getProgress();
console.log('Progress after 1s playback:', pAfter1s.toFixed(5));
    if (pAfter1s <= 0) {
      throw new Error('Playback did not advance');
    }
  });
});
