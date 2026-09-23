import * as fs from 'fs';
import { describe, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';

describe('GPS Speed-Inferred Playback Simulation', () => {
  it('correctly parses track playback times and simulates flyover steps', () => {
    const xml = fs.readFileSync('./public/routes/MountRanierViaEmmons.gpx.gpx', 'utf8');
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

    // Step distance in meters (thumbstick simulation)
    flyover.setProgress(0);
    flyover.stepDistanceMeters(1000); // Walk 1000 meters
    const p1km = flyover.getProgress();
    const dist1km = p1km * track.totalDistance;
    if (Math.abs(dist1km - 1000) > 1) {
      throw new Error(`stepDistanceMeters did not advance 1000m: ${dist1km}`);
    }

    // Test continuous play update
    flyover.play();
    flyover.update(1.0); // 1 real second
    const pAfter1s = flyover.getProgress();
    if (pAfter1s <= 0) {
      throw new Error('Playback did not advance');
    }
  });
});
