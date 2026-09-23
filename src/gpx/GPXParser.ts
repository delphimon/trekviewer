import type { GPXPoint, GPXWaypoint, GeoBounds, TrackStats, TrackSegment } from './TrackTypes.ts';
import { haversineDistance } from './Coordinates.ts';
import { calculateElevationStats } from './ElevationStats.ts';
import { GPXValidator, type RawTrackPoint } from './GPXValidator.ts';

export interface RawParsedGPX {
  trackName: string;
  rawSegments: RawTrackPoint[][];
  waypoints: GPXWaypoint[];
  warnings: string[];
}

export class GPXParser {
  /**
   * Parses raw GPX XML string into TrackStats preserving <trkseg> boundaries,
   * validating coordinates, normalizing missing elevations, and deriving landmarks.
   */
  public static parse(
    xmlContent: string,
    fallbackName?: string,
    demElevationSampler?: (lat: number, lon: number) => number | undefined
  ): TrackStats {
    const raw = this.parseRaw(xmlContent, fallbackName);
    return this.finalizeWithDEM(raw, demElevationSampler);
  }

  /**
   * Phase 1: Validates XML structure, checks 25MB file limit, extracts coordinates,
   * timestamps, and waypoints without requiring DEM.
   */
  public static parseRaw(xmlContent: string, fallbackName?: string): RawParsedGPX {
    if (xmlContent.length > 25 * 1024 * 1024) {
      throw new Error('GPX file exceeds 25 MB limit.');
    }

    let trackName = fallbackName || 'Unnamed Trek';
    const rawSegments: RawTrackPoint[][] = [];
    const waypoints: GPXWaypoint[] = [];

    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlContent, 'application/xml');

      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        throw new Error(`XML parse error: ${parseError.textContent}`);
      }

      // Track Name
      const nameEl = doc.querySelector('trk > name') || doc.querySelector('name');
      trackName =
        nameEl?.textContent?.trim() ||
        fallbackName ||
        'Unnamed Trek';

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

        if (!isNaN(lat) && !isNaN(lon)) {
          waypoints.push({ lat, lon, ele, name, desc, sym });
        }
      }

      // Track Segments (<trk> -> <trkseg> -> <trkpt>)
      const trkElements = Array.from(doc.querySelectorAll('trk'));
      for (const trk of trkElements) {
        const segElements = Array.from(trk.querySelectorAll('trkseg'));
        if (segElements.length > 0) {
          for (const seg of segElements) {
            const segPts = this.parsePointElements(Array.from(seg.querySelectorAll('trkpt')));
            if (segPts.length > 0) rawSegments.push(segPts);
          }
        } else {
          const trkPts = this.parsePointElements(Array.from(trk.querySelectorAll('trkpt')));
          if (trkPts.length > 0) rawSegments.push(trkPts);
        }
      }

      // Route points (<rte> -> <rtept>) fallback
      if (rawSegments.length === 0) {
        const rteElements = Array.from(doc.querySelectorAll('rte'));
        for (const rte of rteElements) {
          const rtePts = this.parsePointElements(Array.from(rte.querySelectorAll('rtept')));
          if (rtePts.length > 0) rawSegments.push(rtePts);
        }
      }
    } else {
      // Node.js fallback parser
      const nameMatch = xmlContent.match(/<trk>\s*<name>([^<]+)<\/name>/i) ||
                        xmlContent.match(/<name>([^<]+)<\/name>/i);
      if (nameMatch) trackName = nameMatch[1].trim();

      // Find waypoints
      const wptRegex = /<wpt\s+[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*>([\s\S]*?)<\/wpt>/gi;
      let wMatch: RegExpExecArray | null;
      while ((wMatch = wptRegex.exec(xmlContent)) !== null) {
        const lat = parseFloat(wMatch[1]);
        const lon = parseFloat(wMatch[2]);
        const inner = wMatch[3];
        const eleMatch = inner.match(/<ele>([^<]+)<\/ele>/i);
        const nameMatch2 = inner.match(/<name>([^<]+)<\/name>/i);
        const descMatch = inner.match(/<desc>([^<]+)<\/desc>/i);
        const symMatch = inner.match(/<sym>([^<]+)<\/sym>/i);

        if (!isNaN(lat) && !isNaN(lon)) {
          waypoints.push({
            lat,
            lon,
            ele: eleMatch ? parseFloat(eleMatch[1]) : undefined,
            name: nameMatch2 ? nameMatch2[1].trim() : 'Waypoint',
            desc: descMatch ? descMatch[1].trim() : undefined,
            sym: symMatch ? symMatch[1].trim() : undefined,
          });
        }
      }

      // Find <trkseg> blocks
      const segRegex = /<trkseg>([\s\S]*?)<\/trkseg>/gi;
      let sMatch: RegExpExecArray | null;
      while ((sMatch = segRegex.exec(xmlContent)) !== null) {
        const pts = this.parsePointRegex(sMatch[1]);
        if (pts.length > 0) rawSegments.push(pts);
      }

      // If no <trkseg>, try raw <trkpt> or <rtept>
      if (rawSegments.length === 0) {
        const pts = this.parsePointRegex(xmlContent);
        if (pts.length > 0) rawSegments.push(pts);
      }
    }

    if (rawSegments.length === 0) {
      throw new Error('No GPS track points found in GPX file.');
    }

    // Validate and sanitize each segment
    const validatedSegments: RawTrackPoint[][] = [];
    const allWarnings: string[] = [];

    for (const rawSeg of rawSegments) {
      const vResult = GPXValidator.validate(rawSeg);
      if (vResult.warnings.length > 0) {
        allWarnings.push(...vResult.warnings);
      }
      if (vResult.isValid && vResult.sanitizedPoints.length >= 2) {
        validatedSegments.push(vResult.sanitizedPoints);
      }
    }

    if (validatedSegments.length === 0) {
      throw new Error('Valid GPS points could not be extracted after filtering.');
    }

    return {
      trackName,
      rawSegments: validatedSegments,
      waypoints,
      warnings: Array.from(new Set(allWarnings)),
    };
  }

  /**
   * Computes geographic bounds from raw parsed segments without requiring normalized elevations.
   */
  public static calculateRawBounds(raw: RawParsedGPX): GeoBounds {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minEle = Infinity;
    let maxEle = -Infinity;

    for (const seg of raw.rawSegments) {
      for (const p of seg) {
        minLat = Math.min(minLat, p.lat);
        maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon);
        maxLon = Math.max(maxLon, p.lon);
        if (p.ele !== undefined) {
          minEle = Math.min(minEle, p.ele);
          maxEle = Math.max(maxEle, p.ele);
        }
      }
    }

    if (!isFinite(minEle)) minEle = 0;
    if (!isFinite(maxEle)) maxEle = 1000;

    const centerLat = (minLat + maxLat) / 2;
    const centerLon = (minLon + maxLon) / 2;
    const widthMeters = haversineDistance(centerLat, minLon, centerLat, maxLon);
    const depthMeters = haversineDistance(minLat, centerLon, maxLat, centerLon);
    const elevationSpan = Math.max(maxEle - minEle, 10);

    return {
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
  }

  /**
   * Phase 2: Finalizes track by normalizing missing elevations using DEM elevation sampler,
   * building segments, calculating distance & elevation metrics, and deriving semantic landmarks.
   */
  public static finalizeWithDEM(
    raw: RawParsedGPX,
    demElevationSampler?: (lat: number, lon: number) => number | undefined
  ): TrackStats {
    const trackName = raw.trackName;
    const waypoints = raw.waypoints;
    const allWarnings = [...raw.warnings];

    // Clone raw segments so raw data can be re-finalized if needed
    const validatedSegments: RawTrackPoint[][] = raw.rawSegments.map((seg) =>
      seg.map((p) => ({ ...p }))
    );

    // 1. Missing Elevation Normalization with provenance tracking
    this.normalizeElevations(validatedSegments, demElevationSampler);

    // 2. Build TrackPoints and Segments preserving boundaries
    const segments: TrackSegment[] = [];
    const points: GPXPoint[] = [];
    let cumulativeDistance = 0;
    let cumulativeElapsedSeconds = 0;
    let cumulativePlaybackSeconds = 0;
    let totalMovingTimeSeconds = 0;
    let maxSpeed = 0;

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minEle = Infinity;
    let maxEle = -Infinity;

    let globalPointIdx = 0;

    for (let segIdx = 0; segIdx < validatedSegments.length; segIdx++) {
      const rawSeg = validatedSegments[segIdx];
      const segPoints: GPXPoint[] = [];
      const segStartGlobalIdx = globalPointIdx;
      let segDistance = 0;

      for (let i = 0; i < rawSeg.length; i++) {
        const cur = rawSeg[i];
        const ele = cur.ele!;

        minLat = Math.min(minLat, cur.lat);
        maxLat = Math.max(maxLat, cur.lat);
        minLon = Math.min(minLon, cur.lon);
        maxLon = Math.max(maxLon, cur.lon);
        minEle = Math.min(minEle, ele);
        maxEle = Math.max(maxEle, ele);

        let distDelta = 0;
        let timeDelta = 0;
        let speed: number | undefined = undefined;
        let grade: number | undefined = undefined;

        if (i > 0) {
          const prev = rawSeg[i - 1];
          distDelta = haversineDistance(prev.lat, prev.lon, cur.lat, cur.lon);
          segDistance += distDelta;
          cumulativeDistance += distDelta;

          const eleDelta = ele - prev.ele!;
          const slope = distDelta > 0.5 ? eleDelta / distDelta : 0;
          if (distDelta > 0.5) {
            grade = slope * 100;
          }

          if (cur.time && prev.time) {
            timeDelta = Math.max(0, (cur.time.getTime() - prev.time.getTime()) / 1000);
          } else {
            // Tobler's Hiking Function (m/s)
            const toblerKmh = 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
            const toblerMs = Math.max(0.2, (toblerKmh * 1000) / 3600);
            timeDelta = distDelta / toblerMs;
          }

          cumulativeElapsedSeconds += timeDelta;

          if (timeDelta > 0 && timeDelta < 86400) {
            speed = distDelta / timeDelta;
            const isMoving = speed >= 0.08 || (distDelta > 2.5 && speed >= 0.03);
            if (isMoving && speed < 45) {
              totalMovingTimeSeconds += timeDelta;
              maxSpeed = Math.max(maxSpeed, speed * 3.6);
            }
          }

          // Playback pause compression (max 2.5s stationary pause)
          let playbackDelta = timeDelta;
          if (distDelta < 5 && timeDelta > 10) {
            playbackDelta = Math.min(timeDelta, 2.5);
          } else if (speed !== undefined && speed < 0.2 && timeDelta > 6) {
            playbackDelta = Math.min(timeDelta, 2.5);
          }
          cumulativePlaybackSeconds += playbackDelta;
        } else if (segIdx > 0) {
          // Boundary between separate track segments:
          // A short 1.5-second pause in playback, but ZERO artificial distance, speed, or grade!
          cumulativePlaybackSeconds += 1.5;
        }

        const pt: GPXPoint = {
          lat: cur.lat,
          lon: cur.lon,
          ele,
          rawEle: cur.rawEle,
          elevationProvenance: cur.elevationProvenance,
          time: cur.time,
          distanceFromStart: cumulativeDistance,
          elapsedSeconds: cumulativeElapsedSeconds,
          playbackSeconds: cumulativePlaybackSeconds,
          speed,
          grade,
          hr: cur.hr,
          cad: cur.cad,
          index: globalPointIdx++,
          segmentIndex: segIdx,
        };

        segPoints.push(pt);
        points.push(pt);
      }

      // Calculate elevation statistics per segment using pure distance-window algorithm
      const segEleStats = calculateElevationStats(segPoints, { windowMeters: 30, hysteresisMeters: 5 });

      segments.push({
        points: segPoints,
        distance: segDistance,
        elevationGain: segEleStats.elevationGain,
        elevationLoss: segEleStats.elevationLoss,
        startIndex: segStartGlobalIdx,
        endIndex: globalPointIdx - 1,
      });
    }

    // Overall elevation gain/loss across all segments
    const totalElevationGain = segments.reduce((sum, s) => sum + s.elevationGain, 0);
    const totalElevationLoss = segments.reduce((sum, s) => sum + s.elevationLoss, 0);

    const centerLat = (minLat + maxLat) / 2;
    const centerLon = (minLon + maxLon) / 2;
    const widthMeters = haversineDistance(centerLat, minLon, centerLat, maxLon);
    const depthMeters = haversineDistance(minLat, centerLon, maxLat, centerLon);
    const elevationSpan = Math.max(maxEle - minEle, 10);

    const startTime = points[0]?.time;
    const endTime = points[points.length - 1]?.time;

    let avgSpeed = 0;
    if (totalMovingTimeSeconds > 0) {
      avgSpeed = (cumulativeDistance / 1000) / (totalMovingTimeSeconds / 3600);
    } else if (startTime && endTime) {
      const totalHours = (endTime.getTime() - startTime.getTime()) / (1000 * 3600);
      if (totalHours > 0) {
        avgSpeed = (cumulativeDistance / 1000) / totalHours;
        totalMovingTimeSeconds = totalHours * 3600;
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

    // 3. Derive semantic landmarks from GPS data
    const landmarks = this.deriveLandmarks(points, bounds, waypoints);

    return {
      name: trackName,
      totalDistance: cumulativeDistance,
      elevationGain: totalElevationGain,
      elevationLoss: totalElevationLoss,
      minElevation: minEle,
      maxElevation: maxEle,
      startTime,
      endTime,
      movingTime: totalMovingTimeSeconds,
      totalPlaybackSeconds: cumulativePlaybackSeconds,
      avgSpeed,
      maxSpeed,
      bounds,
      points,
      segments,
      waypoints,
      landmarks,
      warnings: Array.from(new Set(allWarnings)),
    };
  }

  private static parsePointElements(elements: Element[]): RawTrackPoint[] {
    const raw: RawTrackPoint[] = [];
    for (const pt of elements) {
      const lat = parseFloat(pt.getAttribute('lat') || '0');
      const lon = parseFloat(pt.getAttribute('lon') || '0');
      const eleStr = pt.querySelector('ele')?.textContent;
      const ele = eleStr ? parseFloat(eleStr) : undefined;
      const timeStr = pt.querySelector('time')?.textContent;
      const time = timeStr ? new Date(timeStr) : undefined;

      const hrStr = pt.querySelector('hr, gpxtpx\\:hr')?.textContent;
      const hr = hrStr ? parseInt(hrStr, 10) : undefined;

      const cadStr = pt.querySelector('cad, gpxtpx\\:cad')?.textContent;
      const cad = cadStr ? parseInt(cadStr, 10) : undefined;

      if (!isNaN(lat) && !isNaN(lon)) {
        raw.push({ lat, lon, ele, rawEle: ele, time, hr, cad });
      }
    }
    return raw;
  }

  private static parsePointRegex(xmlChunk: string): RawTrackPoint[] {
    const raw: RawTrackPoint[] = [];
    const trkptRegex = /<(?:trkpt|rtept)\s+[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:trkpt|rtept)>/gi;
    let match: RegExpExecArray | null;

    while ((match = trkptRegex.exec(xmlChunk)) !== null) {
      const lat = parseFloat(match[1]);
      const lon = parseFloat(match[2]);
      const inner = match[3];

      const eleMatch = inner.match(/<ele>([^<]+)<\/ele>/i);
      const ele = eleMatch ? parseFloat(eleMatch[1]) : undefined;

      const timeMatch = inner.match(/<time>([^<]+)<\/time>/i);
      const time = timeMatch ? new Date(timeMatch[1]) : undefined;

      const hrMatch = inner.match(/<[^:]*:?hr>(\d+)<\/[^:]*:?hr>/i);
      const hr = hrMatch ? parseInt(hrMatch[1], 10) : undefined;

      const cadMatch = inner.match(/<[^:]*:?cad>(\d+)<\/[^:]*:?cad>/i);
      const cad = cadMatch ? parseInt(cadMatch[1], 10) : undefined;

      if (!isNaN(lat) && !isNaN(lon)) {
        raw.push({ lat, lon, ele, rawEle: ele, time, hr, cad });
      }
    }
    return raw;
  }

  /**
   * Normalizes missing elevations across segments using defined hierarchy:
   * 1. Valid GPX elevation
   * 2. DEM elevation at coordinate (if available)
   * 3. Linear interpolation between adjacent valid track elevations
   * 4. Bounded fallback to track median/valid
   */
  private static normalizeElevations(
    segments: RawTrackPoint[][],
    demSampler?: (lat: number, lon: number) => number | undefined
  ): void {
    for (const seg of segments) {
      // Step A: Sample DEM for points with missing ele if sampler is provided
      if (demSampler) {
        for (const pt of seg) {
          if (pt.ele === undefined) {
            const demEle = demSampler(pt.lat, pt.lon);
            if (demEle !== undefined && !isNaN(demEle) && isFinite(demEle)) {
              pt.ele = demEle;
              pt.elevationProvenance = 'dem';
            }
          }
        }
      }

      // Step B: Linear interpolation between valid neighbors
      let lastValidIdx = -1;
      let firstValidIdx = -1;
      for (let i = 0; i < seg.length; i++) {
        if (seg[i].ele !== undefined) {
          if (!seg[i].elevationProvenance) {
            seg[i].elevationProvenance = 'gpx';
          }
          if (firstValidIdx === -1) {
            firstValidIdx = i;
          }
          if (lastValidIdx !== -1 && i - lastValidIdx > 1) {
            const startEle = seg[lastValidIdx].ele!;
            const endEle = seg[i].ele!;
            const span = i - lastValidIdx;
            for (let j = lastValidIdx + 1; j < i; j++) {
              const alpha = (j - lastValidIdx) / span;
              seg[j].ele = startEle + alpha * (endEle - startEle);
              seg[j].elevationProvenance = 'interpolated';
            }
          }
          lastValidIdx = i;
        }
      }

      // Handle leading points missing elevation
      if (firstValidIdx !== -1) {
        const firstValidEle = seg[firstValidIdx].ele!;
        for (let i = 0; i < firstValidIdx; i++) {
          seg[i].ele = firstValidEle;
          seg[i].elevationProvenance = 'interpolated';
        }
        // Handle trailing points missing elevation
        const lastValidEle = seg[lastValidIdx].ele!;
        for (let i = lastValidIdx + 1; i < seg.length; i++) {
          seg[i].ele = lastValidEle;
          seg[i].elevationProvenance = 'interpolated';
        }
      } else {
        // Entire segment had NO elevation at all: default to 1000m fallback
        for (const pt of seg) {
          pt.ele = 1000.0;
          pt.elevationProvenance = 'fallback';
        }
      }
    }
  }

  /**
   * Derives semantic landmarks from GPS data (Start, Finish, High Point, Low Point, Long Stop, Day N Start).
   * Merges with existing explicit waypoints if within 25 meters.
   */
  private static deriveLandmarks(
    points: GPXPoint[],
    bounds: GeoBounds,
    explicitWaypoints: GPXWaypoint[] = []
  ): GPXWaypoint[] {
    if (points.length < 2) return [];
    const landmarks: GPXWaypoint[] = [];

    const isNearExplicit = (lat: number, lon: number, thresholdMeters = 25): GPXWaypoint | undefined => {
      return explicitWaypoints.find((w) => haversineDistance(w.lat, w.lon, lat, lon) <= thresholdMeters);
    };

    // 1. Trailhead / Start
    const start = points[0];
    const nearStart = isNearExplicit(start.lat, start.lon);
    if (!nearStart) {
      landmarks.push({
        lat: start.lat,
        lon: start.lon,
        ele: start.ele,
        name: 'Start',
        desc: `Beginning of route at ${Math.round(start.ele)} m (${Math.round(start.ele * 3.28084)} ft)`,
        sym: 'Trailhead',
        type: 'start',
        isDerivedLandmark: true,
      });
    } else if (!nearStart.type) {
      nearStart.type = 'start';
    }

    // 2. High Point
    let maxPt = points[0];
    let minPt = points[0];
    for (const pt of points) {
      if (pt.ele > maxPt.ele) maxPt = pt;
      if (pt.ele < minPt.ele) minPt = pt;
    }

    if (maxPt !== start && maxPt !== points[points.length - 1]) {
      const nearSummit = isNearExplicit(maxPt.lat, maxPt.lon);
      if (!nearSummit) {
        landmarks.push({
          lat: maxPt.lat,
          lon: maxPt.lon,
          ele: maxPt.ele,
          name: 'High Point',
          desc: `Maximum route elevation: ${Math.round(maxPt.ele)} m (${Math.round(maxPt.ele * 3.28084)} ft)`,
          sym: 'Summit',
          type: 'summit',
          isDerivedLandmark: true,
        });
      } else {
        if (!nearSummit.type) nearSummit.type = 'summit';
      }
    }

    // 3. Lowest Point
    if (minPt !== start && minPt !== points[points.length - 1] && minPt !== maxPt) {
      const nearLow = isNearExplicit(minPt.lat, minPt.lon);
      if (!nearLow) {
        landmarks.push({
          lat: minPt.lat,
          lon: minPt.lon,
          ele: minPt.ele,
          name: 'Low Point',
          desc: `Minimum route elevation: ${Math.round(minPt.ele)} m (${Math.round(minPt.ele * 3.28084)} ft)`,
          sym: 'Valley',
          type: 'low_point',
          isDerivedLandmark: true,
        });
      }
    }

    // 4. Significant Stops (> 20 min dwell) & Day Boundaries
    let prevDateStr = start.time?.toDateString();
    let dayCount = 1;

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];

      // Day boundary check
      if (cur.time && prevDateStr) {
        const curDateStr = cur.time.toDateString();
        if (curDateStr !== prevDateStr) {
          dayCount++;
          prevDateStr = curDateStr;
          landmarks.push({
            lat: cur.lat,
            lon: cur.lon,
            ele: cur.ele,
            name: `Day ${dayCount} Start`,
            desc: `Route continuation on ${cur.time.toLocaleDateString()}`,
            sym: 'DayBoundary',
            type: 'day_boundary',
            isDerivedLandmark: true,
          });
        }
      }

      // Significant stop (> 20 min elapsed with < 30m distance)
      if (cur.time && prev.time) {
        const dtSec = (cur.time.getTime() - prev.time.getTime()) / 1000;
        const dDist = cur.distanceFromStart - prev.distanceFromStart;
        if (dtSec >= 1200 && dDist < 30) {
          landmarks.push({
            lat: cur.lat,
            lon: cur.lon,
            ele: cur.ele,
            name: 'Long Stop',
            desc: `Extended rest stop (${Math.round(dtSec / 60)} min) at ${Math.round(cur.ele)} m`,
            sym: 'RestStop',
            type: 'stop',
            isDerivedLandmark: true,
          });
        }
      }
    }

    // 5. Finish
    const finish = points[points.length - 1];
    const nearFinish = isNearExplicit(finish.lat, finish.lon);
    if (!nearFinish) {
      landmarks.push({
        lat: finish.lat,
        lon: finish.lon,
        ele: finish.ele,
        name: 'Finish',
        desc: `End of route (${(finish.distanceFromStart / 1000).toFixed(1)} km)`,
        sym: 'Flag',
        type: 'finish',
        isDerivedLandmark: true,
      });
    } else if (!nearFinish.type) {
      nearFinish.type = 'finish';
    }

    return landmarks;
  }

  /**
   * Resamples track points along uniform distance intervals.
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
