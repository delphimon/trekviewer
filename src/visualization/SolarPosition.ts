/** Sun direction for a place and time (N5), NOAA low-precision formulas (about 0.5° accuracy). */
export interface SolarAngles { azimuthDeg: number; elevationDeg: number }

const RAD = Math.PI / 180;

/** Azimuth (degrees clockwise from true north) and elevation above the horizon. */
export function solarPosition(date: Date, latDeg: number, lonDeg: number): SolarAngles {
  const dayMs = 86400000;
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - start) / dayMs);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const g = 2 * Math.PI / 365 * (dayOfYear + (utcHours - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const trueSolarMinutes = utcHours * 60 + eqTime + 4 * lonDeg;
  const hourAngle = (trueSolarMinutes / 4 - 180) * RAD;
  const lat = latDeg * RAD;
  const cosZenith = Math.min(1, Math.max(-1, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)));
  const zenith = Math.acos(cosZenith);
  const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / RAD + 180;
  return { azimuthDeg: (azimuth + 360) % 360, elevationDeg: 90 - zenith / RAD };
}

/** The UTC instant for a local mean solar time (minutes after midnight) on a date at a longitude. */
export function solarTimeToDate(day: Date, minutes: number, lonDeg: number): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + (minutes - 4 * lonDeg) * 60000);
}

/** Unit vector toward the sun in model space (+X east, +Y up, -Z north). */
export function sunDirection(angles: SolarAngles, out: { x: number; y: number; z: number }): typeof out {
  const elevation = Math.max(2, angles.elevationDeg) * RAD, azimuth = angles.azimuthDeg * RAD;
  out.x = Math.cos(elevation) * Math.sin(azimuth);
  out.y = Math.sin(elevation);
  out.z = -Math.cos(elevation) * Math.cos(azimuth);
  return out;
}

/** Light intensity scale: full above ~25°, fading to a dim floor at and below the horizon. */
export const sunIntensityScale = (elevationDeg: number) => Math.min(1, Math.max(0.15, Math.sin(Math.max(0, elevationDeg) * RAD) * 2.4));
