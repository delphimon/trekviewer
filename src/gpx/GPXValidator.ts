import { haversineDistance } from './Coordinates.ts';

export interface RawTrackPoint {
  lat: number;
  lon: number;
  ele?: number;
  rawEle?: number;
  time?: Date;
  hr?: number;
  cad?: number;
}

export interface ValidationResult {
  isValid: boolean;
  fatalError?: string;
  warnings: string[];
  sanitizedPoints: RawTrackPoint[];
}

export class GPXValidator {
  public static validate(rawPoints: RawTrackPoint[]): ValidationResult {
    const warnings: string[] = [];

    // 1. Zero-length or 1-point tracks (Fatal)
    if (rawPoints.length === 0) {
      return {
        isValid: false,
        fatalError: 'No GPS track points found in GPX file.',
        warnings: [],
        sanitizedPoints: [],
      };
    }

    if (rawPoints.length === 1) {
      return {
        isValid: false,
        fatalError: 'Track contains only 1 GPS point. At least 2 points are required to render a route.',
        warnings: [],
        sanitizedPoints: [],
      };
    }

    // 2. Extremely large tracks warning (> 20,000 points)
    if (rawPoints.length > 20000) {
      warnings.push(`Extremely dense survey (${rawPoints.length.toLocaleString()} points). Decimating for Quest rendering efficiency.`);
    }

    // 3. Coordinate validation and sanitization
    const sanitized: RawTrackPoint[] = [];
    let missingEleCount = 0;
    let outOfBoundsCount = 0;
    let nonFiniteEleCount = 0;
    let jumpCount = 0;
    let nonMonotonicTimeCount = 0;

    let prevPoint: RawTrackPoint | null = null;

    for (let i = 0; i < rawPoints.length; i++) {
      const pt = rawPoints[i];

      // Check Latitude & Longitude validity
      if (
        typeof pt.lat !== 'number' ||
        typeof pt.lon !== 'number' ||
        isNaN(pt.lat) ||
        isNaN(pt.lon) ||
        !isFinite(pt.lat) ||
        !isFinite(pt.lon)
      ) {
        outOfBoundsCount++;
        continue;
      }

      if (pt.lat < -90 || pt.lat > 90 || pt.lon < -180 || pt.lon > 180) {
        outOfBoundsCount++;
        continue;
      }

      // Check Elevation validity
      let ele = pt.ele;
      if (ele === undefined || ele === null || isNaN(ele)) {
        missingEleCount++;
        ele = undefined;
      } else if (!isFinite(ele) || ele < -500 || ele > 9000) {
        nonFiniteEleCount++;
        ele = undefined;
      }

      // Check Pathological coordinate jumps (> 50km between consecutive points)
      if (prevPoint) {
        const d = haversineDistance(prevPoint.lat, prevPoint.lon, pt.lat, pt.lon);
        if (d > 50000) {
          jumpCount++;
          // Exclude single isolated pathological telemetry glitch
          if (i + 1 < rawPoints.length) {
            const nextPt = rawPoints[i + 1];
            const dNext = haversineDistance(prevPoint.lat, prevPoint.lon, nextPt.lat, nextPt.lon);
            if (dNext < 25000) {
              // The current point was an outlier glitch
              continue;
            }
          }
        }

        // Check timestamp monotonicity
        if (prevPoint.time && pt.time && pt.time.getTime() < prevPoint.time.getTime()) {
          nonMonotonicTimeCount++;
        }
      }

      const validPoint: RawTrackPoint = {
        lat: pt.lat,
        lon: pt.lon,
        ele,
        rawEle: pt.rawEle !== undefined ? pt.rawEle : (ele !== undefined ? ele : undefined),
        time: pt.time,
        hr: pt.hr,
        cad: pt.cad,
      };

      sanitized.push(validPoint);
      prevPoint = validPoint;
    }

    if (sanitized.length < 2) {
      return {
        isValid: false,
        fatalError: 'Track contains insufficient valid coordinates after filtering.',
        warnings,
        sanitizedPoints: [],
      };
    }

    // Compile recoverable warnings
    if (missingEleCount > 0) {
      warnings.push(`${missingEleCount} GPS point(s) missing elevation data (reconstructed from DEM/interpolation).`);
    }
    if (outOfBoundsCount > 0) {
      warnings.push(`Ignored ${outOfBoundsCount} point(s) with out-of-range or NaN coordinates.`);
    }
    if (nonFiniteEleCount > 0) {
      warnings.push(`Corrected ${nonFiniteEleCount} non-finite/extreme elevation outlier(s).`);
    }
    if (jumpCount > 0) {
      warnings.push(`Detected ${jumpCount} suspicious GPS coordinate jump(s) (>50 km).`);
    }
    if (nonMonotonicTimeCount > 0) {
      warnings.push(`Fixed ${nonMonotonicTimeCount} non-monotonic GPS timestamps.`);
    }

    return {
      isValid: true,
      warnings,
      sanitizedPoints: sanitized,
    };
  }
}
