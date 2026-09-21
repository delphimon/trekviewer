import * as fs from 'fs';
import * as path from 'path';
import { GPXParser } from '../src/gpx/GPXParser.ts';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

console.log('--- Testing GPX Parser with Real Routes ---');

// 1. Mount Rainier via Emmons
const rainierPath = path.resolve('routes/MountRanierViaEmmons.gpx.gpx');
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
const enchantPath = path.resolve('routes/EnchantmentsAndDragontail.gpx');
const enchantXML = fs.readFileSync(enchantPath, 'utf8');
const enchantTrack = GPXParser.parse(enchantXML);

console.log('\nEnchantments & Dragontail parsed:');
console.log(`- Name: ${enchantTrack.name}`);
console.log(`- Points: ${enchantTrack.points.length}`);
console.log(`- Distance: ${(enchantTrack.totalDistance / 1000).toFixed(2)} km`);
console.log(`- Elevation Gain: +${Math.round(enchantTrack.elevationGain)} m`);
console.log(`- High Point: ${Math.round(enchantTrack.maxElevation)} m`);

assert(enchantTrack.points.length > 1000, 'Enchantments has points');
assert(enchantTrack.maxElevation > 2600, 'Dragontail Peak summit > 2,600m');

// 3. Elevation Profile Resampling
const samples = GPXParser.sampleElevationProfile(rainierTrack.points, 100);
console.log(`\nSampled elevation profile: ${samples.length} equidistant samples`);
assert(samples.length === 100, 'Exactly 100 profile samples generated');
assert(samples[0].distance === 0, 'First sample at 0 distance');
assert(Math.abs(samples[99].distance - rainierTrack.totalDistance) < 1, 'Final sample at total distance');

console.log('✓ All GPX parsing and metric verification tests passed!\n');
