import type { GPXPoint, GPXWaypoint, GeoBounds, TrackStats } from './TrackTypes.ts';
import { haversineDistance } from './Coordinates.ts';

export class GPXParser {
  /**
   * Parses raw GPX XML string into TrackStats object with calculated metrics.
   */
  public static parse(xmlContent: string, fallbackName?: string): TrackStats {
    let trackName = fallbackName || 'Unnamed Trek';
    const rawPoints: Array<{
      lat: number;
      lon: number;
      ele: number;
      time?: Date;
      hr?: number;
      cad?: number;
    }> = [];
    const waypoints: GPXWaypoint[] = [];

    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlContent, 'application/xml');

      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        throw new Error(`Invalid GPX XML: ${parseError.textContent}`);
      }

      // Extract route / trek name
      trackName =
        doc.querySelector('trk > name')?.textContent?.trim() ||
        doc.querySelector('metadata > name')?.textContent?.trim() ||
        doc.querySelector('gpx > name')?.textContent?.trim() ||
        fallbackName ||
        'Unnamed Trek';

      // Track points
      const trkptElements = Array.from(doc.querySelectorAll('trkpt'));
      if (trkptElements.length === 0) {
        const rteptElements = Array.from(doc.querySelectorAll('rtept'));
        if (rteptElements.length > 0) trkptElements.push(...rteptElements);
        else throw new Error('No GPS track points found in GPX file.');
      }

      // Parse Waypoints
      const wptElements = Array.from(doc.querySelectorAll('wpt'));
      for (const wpt of wptElements) {
        const lat = parseFloat(wpt.getAttribute('lat') || '0');
        const lon = parseFloat(wpt.getAttribute('lon') || '0');
        const eleStr = wpt.querySelector('ele')?.textContent;
        const ele = eleStr ? parseFloat(eleStr) : undefined;
        const name = wpt.querySelector('name')?.textContent?.trim() || 'Waypoint';
        const desc = wpt.querySelector('desc')?.textContent?.trim();
        const sym = wpt.querySelector('sym')?.textContent?.trim();
        const type = wpt.querySelector('type')?.textContent?.trim();

        if (!isNaN(lat) && !isNaN(lon)) {
          waypoints.push({ lat, lon, ele, name, desc, sym, type });
        }
      }

      for (const pt of trkptElements) {
        const lat = parseFloat(pt.getAttribute('lat') || '0');
        const lon = parseFloat(pt.getAttribute('lon') || '0');
        const eleStr = pt.querySelector('ele')?.textContent;
        const ele = eleStr ? parseFloat(eleStr) : 0;
        const timeStr = pt.querySelector('time')?.textContent;
        const time = timeStr ? new Date(timeStr) : undefined;

        const hrStr = pt.querySelector('hr, gpxtpx\\:hr')?.textContent;
        const hr = hrStr ? parseInt(hrStr, 10) : undefined;

        const cadStr = pt.querySelector('cad, gpxtpx\\:cad')?.textContent;
        const cad = cadStr ? parseInt(cadStr, 10) : undefined;

        if (isNaN(lat) || isNaN(lon)) continue;
        rawPoints.push({ lat, lon, ele, time, hr, cad });
      }
    } else {
      // Node.js fallback parser
      const nameMatch = xmlContent.match(/<trk>\s*<name>([^<]+)<\/name>/i) ||
                         xmlContent.match(/<name>([^<]+)<\/name>/i);
      if (nameMatch) trackName = nameMatch[1].trim();

      const trkptRegex = /<trkpt\s+[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*>([\s\S]*?)<\/trkpt>/gi;
      let match: RegExpExecArray | null;
      while ((match = trkptRegex.exec(xmlContent)) !== null) {
        const lat = parseFloat(match[1]);
        const lon = parseFloat(match[2]);
        const inner = match[3];

        const eleMatch = inner.match(/<ele>([^<]+)<\/ele>/i);
        const ele = eleMatch ? parseFloat(eleMatch[1]) : 0;

        const timeMatch = inner.match(/<time>([^<]+)<\/time>/i);
        const time = timeMatch ? new Date(timeMatch[1]) : undefined;

        const hrMatch = inner.match(/<[^:]*:?hr>(\d+)<\/[^:]*:?hr>/i);
        const hr = hrMatch ? parseInt(hrMatch[1], 10) : undefined;

        const cadMatch = inner.match(/<[^:]*:?cad>(\d+)<\/[^:]*:?cad>/i);
        const cad = cadMatch ? parseInt(cadMatch[1], 10) : undefined;

        if (!isNaN(lat) && !isNaN(lon)) {
          rawPoints.push({ lat, lon, ele, time, hr, cad });
        }
      }
    }

    if (rawPoints.length === 0) {
      throw new Error('Valid GPS points could not be extracted.');
    }

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minEle = Infinity;
    let maxEle = -Infinity;

    for (const p of rawPoints) {
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
      minEle = Math.min(minEle, p.ele);
      maxEle = Math.max(maxEle, p.ele);
    }

    // Process cumulative distances, speeds, and elevation gain/loss
    const points: GPXPoint[] = [];
    let cumulativeDistance = 0;
    let elevationGain = 0;
    let elevationLoss = 0;
    let movingTimeSeconds = 0;
    let maxSpeed = 0;
    let cumulativeElapsedSeconds = 0;
    let cumulativePlaybackSeconds = 0;

    // 9-point moving window filter to remove barometric / GPS elevation jitter
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

    // 5.0m (~16.4 ft) climb hysteresis threshold matching standard topo altimeter algorithms
    let lastClimbEle = smoothedEles[0];
    const ELEVATION_CLIMB_THRESHOLD = 5.0; // meters

    for (let i = 0; i < rawPoints.length; i++) {
      const cur = rawPoints[i];
      let speed: number | undefined = undefined;
      let grade: number | undefined = undefined;

      if (i > 0) {
        const prev = rawPoints[i - 1];
        const distDelta = haversineDistance(prev.lat, prev.lon, cur.lat, cur.lon);
        cumulativeDistance += distDelta;

        const eleDelta = smoothedEles[i] - smoothedEles[i - 1];
        const slope = distDelta > 0.5 ? eleDelta / distDelta : 0;
        if (distDelta > 0.5) {
          grade = slope * 100;
        }

        // Elevation gain/loss filtering using smoothed elevation profile
        const dFromLastClimb = smoothedEles[i] - lastClimbEle;
        if (Math.abs(dFromLastClimb) >= ELEVATION_CLIMB_THRESHOLD) {
          if (dFromLastClimb > 0) {
            elevationGain += dFromLastClimb;
          } else {
            elevationLoss += Math.abs(dFromLastClimb);
          }
          lastClimbEle = smoothedEles[i];
        }

        let timeDelta = 0;
        if (cur.time && prev.time) {
          timeDelta = Math.max(0, (cur.time.getTime() - prev.time.getTime()) / 1000);
        } else {
          // Tobler's Hiking Function for fallback (m/s)
          const toblerKmh = 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
          const toblerMs = Math.max(0.2, (toblerKmh * 1000) / 3600);
          timeDelta = distDelta / toblerMs;
        }

        cumulativeElapsedSeconds += timeDelta;

        if (timeDelta > 0 && timeDelta < 86400) {
          speed = distDelta / timeDelta;
          // Calibrated moving detection: accounts for steep technical alpine scrambling (> 0.08 m/s or > 2.5m displacement)
          const isMoving = speed >= 0.08 || (distDelta > 2.5 && speed >= 0.03);
          if (isMoving && speed < 45) {
            movingTimeSeconds += timeDelta;
            maxSpeed = Math.max(maxSpeed, speed * 3.6);
          }
        }

        // Playback compression: compress stationary dwell time to a max of 2.5 seconds
        let playbackDelta = timeDelta;
        if (distDelta < 5 && timeDelta > 10) {
          playbackDelta = Math.min(timeDelta, 2.5);
        } else if (speed !== undefined && speed < 0.2 && timeDelta > 6) {
          playbackDelta = Math.min(timeDelta, 2.5);
        }
        cumulativePlaybackSeconds += playbackDelta;
      }

      points.push({
        lat: cur.lat,
        lon: cur.lon,
        ele: cur.ele,
        time: cur.time,
        distanceFromStart: cumulativeDistance,
        elapsedSeconds: cumulativeElapsedSeconds,
        playbackSeconds: cumulativePlaybackSeconds,
        speed,
        grade,
        hr: cur.hr,
        cad: cur.cad,
        index: i,
      });
    }

    const centerLat = (minLat + maxLat) / 2;
    const centerLon = (minLon + maxLon) / 2;
    const widthMeters = haversineDistance(centerLat, minLon, centerLat, maxLon);
    const depthMeters = haversineDistance(minLat, centerLon, maxLat, centerLon);
    const elevationSpan = Math.max(maxEle - minEle, 10);

    const startTime = points[0]?.time;
    const endTime = points[points.length - 1]?.time;

    // Calculate average speed
    let avgSpeed = 0;
    if (movingTimeSeconds > 0) {
      avgSpeed = (cumulativeDistance / 1000) / (movingTimeSeconds / 3600);
    } else if (startTime && endTime) {
      const totalHours = (endTime.getTime() - startTime.getTime()) / (1000 * 3600);
      if (totalHours > 0) {
        avgSpeed = (cumulativeDistance / 1000) / totalHours;
        movingTimeSeconds = totalHours * 3600;
      }
    }

    const bounds: GeoBounds = {
      minLat,
      maxLat,
      minLon,
      maxLon,
      minEle,
      maxEle,
      centerLat,
      centerLon,
      widthMeters,
      depthMeters,
      elevationSpan,
    };

    return {
      name: trackName,
      totalDistance: cumulativeDistance,
      elevationGain,
      elevationLoss,
      minElevation: minEle,
      maxElevation: maxEle,
      startTime,
      endTime,
      movingTime: movingTimeSeconds,
      totalPlaybackSeconds: cumulativePlaybackSeconds,
      avgSpeed,
      maxSpeed,
      bounds,
      points,
      waypoints,
    };
  }

  /**
   * Resamples track points along uniform distance intervals (e.g. for charts and elevation profile scrubbers).
   */
  public static sampleElevationProfile(
    points: GPXPoint[],
    sampleCount: number = 200
  ): Array<{ distance: number; elevation: number; grade: number; pointIndex: number }> {
    if (points.length === 0) return [];
    if (points.length <= sampleCount) {
      return points.map((p) => ({
        distance: p.distanceFromStart,
        elevation: p.ele,
        grade: p.grade || 0,
        pointIndex: p.index,
      }));
    }

    const totalDist = points[points.length - 1].distanceFromStart;
    const interval = totalDist / (sampleCount - 1);
    const samples: Array<{
      distance: number;
      elevation: number;
      grade: number;
      pointIndex: number;
    }> = [];

    let currentPointIdx = 0;

    for (let i = 0; i < sampleCount; i++) {
      const targetDist = i * interval;
      while (
        currentPointIdx < points.length - 1 &&
        points[currentPointIdx + 1].distanceFromStart < targetDist
      ) {
        currentPointIdx++;
      }

      const p1 = points[currentPointIdx];
      const p2 = points[Math.min(currentPointIdx + 1, points.length - 1)];

      let elevation = p1.ele;
      let grade = p1.grade || 0;

      if (p1 !== p2 && p2.distanceFromStart > p1.distanceFromStart) {
        const factor =
          (targetDist - p1.distanceFromStart) /
          (p2.distanceFromStart - p1.distanceFromStart);
        elevation = p1.ele + (p2.ele - p1.ele) * factor;
        grade = (p1.grade || 0) + ((p2.grade || 0) - (p1.grade || 0)) * factor;
      }

      samples.push({
        distance: targetDist,
        elevation,
        grade,
        pointIndex: currentPointIdx,
      });
    }

    return samples;
  }
}
