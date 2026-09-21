import * as fs from 'fs';
import { haversineDistance } from '../src/gpx/Coordinates.ts';

const xml = fs.readFileSync('routes/EnchantsmentsAndDragontail.gpx', 'utf8');

const trkptRegex = /<trkpt\s+[^>]*lat=["\x27]([^"\x27]+)["\x27][^>]*lon=["\x27]([^"\x27]+)["\x27][^>]*>([\s\S]*?)<\/trkpt>/gi;
let match;
let rawPoints: Array<{ lat: number; lon: number; ele: number; time?: Date }> = [];
while ((match = trkptRegex.exec(xml)) !== null) {
  const ele = parseFloat(match[3].match(/<ele>([^<]+)<\/ele>/)![1]);
  const timeM = match[3].match(/<time>([^<]+)<\/time>/);
  const time = timeM ? new Date(timeM[1]) : undefined;
  rawPoints.push({ lat: parseFloat(match[1]), lon: parseFloat(match[2]), ele, time });
}

// 9-point moving window
const smoothedEles = new Float64Array(rawPoints.length);
const ELE_WINDOW = 4;
for (let i = 0; i < rawPoints.length; i++) {
  let sum = 0;
  let count = 0;
  for (let w = Math.max(0, i - ELE_WINDOW); w <= Math.min(rawPoints.length - 1, i + ELE_WINDOW); w++) {
    sum += rawPoints[w].ele;
    count++;
  }
  smoothedEles[i] = sum / count;
}

let elevationGain = 0;
let elevationLoss = 0;
let lastClimbEle = smoothedEles[0];
const ELEVATION_CLIMB_THRESHOLD = 5.0; // 5 meters

for (const minSpeed of [0.05, 0.07, 0.09, 0.12]) {
  let movingTimeSeconds = 0;
  let totalElapsedSeconds = 0;

  for (let i = 1; i < rawPoints.length; i++) {
    const prev = rawPoints[i - 1];
    const cur = rawPoints[i];
    const distDelta = haversineDistance(prev.lat, prev.lon, cur.lat, cur.lon);

    let timeDelta = 0;
    if (cur.time && prev.time) {
      timeDelta = Math.max(0, (cur.time.getTime() - prev.time.getTime()) / 1000);
    }
    totalElapsedSeconds += timeDelta;

    if (timeDelta > 0 && timeDelta < 86400) {
      const speed = distDelta / timeDelta;
      // Moving if speed exceeds minSpeed OR if user traveled significant distance in this step (> 3m)
      const isMoving = speed >= minSpeed || (distDelta > 3.0 && speed >= 0.03);
      if (isMoving && speed < 45) {
        movingTimeSeconds += timeDelta;
      }
    }
  }

  console.log(`minSpeed=${minSpeed} -> Moving Time: ${(movingTimeSeconds/3600).toFixed(2)}h (${Math.floor(movingTimeSeconds/3600)}h ${Math.round((movingTimeSeconds%3600)/60)}m) out of ${(totalElapsedSeconds/3600).toFixed(2)}h total`);
}

for (let i = 1; i < rawPoints.length; i++) {
  const dFromLastClimb = smoothedEles[i] - lastClimbEle;
  if (Math.abs(dFromLastClimb) >= ELEVATION_CLIMB_THRESHOLD) {
    if (dFromLastClimb > 0) elevationGain += dFromLastClimb;
    else elevationLoss += Math.abs(dFromLastClimb);
    lastClimbEle = smoothedEles[i];
  }
}
console.log('Gain:', (elevationGain * 3.28084).toFixed(0), 'ft, Loss:', (elevationLoss * 3.28084).toFixed(0), 'ft');
