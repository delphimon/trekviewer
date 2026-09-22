import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

describe('GPX Parser with Real Routes', () => {
  it('parses real mountain GPX files and resamples elevation profile', () => {
    // 1. Mount Rainier via Emmons
    const rainierPath = path.resolve('public/routes/MountRainierViaEmmons.gpx');
    const rainierXML = fs.readFileSync(rainierPath, 'utf8');
    const rainierTrack = GPXParser.parse(rainierXML);

console.log('Mount Rainier parsed:');
console.log(`- Name: ${rainierTrack.name}`);
console.log(`- Points: ${rainierTrack.points.length}`);
console.log(`- Distance: ${(rainierTrack.totalDistance / 1000).toFixed(2)} km (${(rainierTrack.totalDistance * 0.000621371).toFixed(2)} mi)`);
console.log(`- Elevation Gain: +${Math.round(rainierTrack.elevationGain)} m (+${Math.round(rainierTrack.elevationGain * 3.28084)} ft)`);
console.log(`- High Point: ${Math.round(rainierTrack.maxElevation)} m (${Math.round(rainierTrack.maxElevation * 3.28084)} ft)`);
console.log(`- Low Point: ${Math.round(rainierTrack.minElevation)} m (${Math.round(rainierTrack.minElevation * 3.28084)} ft)`);

assert(rainierTrack.points.length > 4000, 'Rainier has dense surveyed GPS points');
assert(rainierTrack.maxElevation > 4300, 'Mount Rainier summit is > 4,300m');
assert(rainierTrack.elevationGain > 2800, 'Rainier Emmons climb gain > 2,800m');
assert(rainierTrack.totalDistance > 15000, 'Total roundtrip distance > 15 km');

    // 2. Enchantments & Dragontail Peak
    const enchantPath = path.resolve('public/routes/EnchantmentsAndDragontail.gpx');
    const enchantXML = fs.readFileSync(enchantPath, 'utf8');
    const enchantTrack = GPXParser.parse(enchantXML);

    assert(enchantTrack.points.length > 1000, 'Enchantments has points');
    assert(enchantTrack.maxElevation > 2600, 'Dragontail Peak summit > 2,600m');

    // 3. Elevation Profile Resampling
    const samples = GPXParser.sampleElevationProfile(rainierTrack.points, 100);
    assert(samples.length === 100, 'Exactly 100 profile samples generated');
    assert(samples[0].distance === 0, 'First sample at 0 distance');
    assert(Math.abs(samples[99].distance - rainierTrack.totalDistance) < 1, 'Final sample at total distance');
  });
});
