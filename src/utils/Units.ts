/** Display units for distances, elevations and speeds. Values are always stored in metres. */
export type UnitSystem = 'imperial' | 'metric';

export const UNITS_STORAGE_KEY = 'trekviewer.units';
const FEET_PER_METRE = 3.28084;
const MILES_PER_METRE = 0.000621371;

/** US English defaults to imperial; every other locale to metric. */
export function defaultUnits(language: string | undefined = typeof navigator !== 'undefined' ? navigator.language : undefined): UnitSystem {
  return language?.toLowerCase() === 'en-us' ? 'imperial' : 'metric';
}

let current: UnitSystem | null = null;
const listeners = new Set<(units: UnitSystem) => void>();

export function getUnits(): UnitSystem {
  if (current) return current;
  let stored: string | null = null;
  try { stored = typeof localStorage !== 'undefined' ? localStorage.getItem(UNITS_STORAGE_KEY) : null; } catch { /* optional */ }
  current = stored === 'imperial' || stored === 'metric' ? stored : defaultUnits();
  return current;
}

export function setUnits(units: UnitSystem): void {
  if (units === getUnits()) return;
  current = units;
  try { localStorage.setItem(UNITS_STORAGE_KEY, units); } catch { /* optional */ }
  for (const listener of listeners) listener(units);
}

/** Subscribe to unit changes; returns the unsubscribe function. */
export function onUnitsChange(listener: (units: UnitSystem) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const group = (value: number) => Math.round(value).toLocaleString('en-US');

/** "17.1 mi" / "27.5 km". */
export function formatDistance(metres: number, units: UnitSystem = getUnits(), digits = 1): string {
  return units === 'imperial' ? `${(metres * MILES_PER_METRE).toFixed(digits)} mi` : `${(metres / 1000).toFixed(digits)} km`;
}

/** Distance as a number in the display unit (miles or kilometres), for axes. */
export function distanceInUnits(metres: number, units: UnitSystem = getUnits()): number {
  return units === 'imperial' ? metres * MILES_PER_METRE : metres / 1000;
}
export const distanceUnitLabel = (units: UnitSystem = getUnits()) => units === 'imperial' ? 'mi' : 'km';

/** "14,407 ft" / "4,391 m"; `signed` adds a leading + for gains. */
export function formatElevation(metres: number, units: UnitSystem = getUnits(), signed = false): string {
  const value = units === 'imperial' ? metres * FEET_PER_METRE : metres;
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${group(value)} ${units === 'imperial' ? 'ft' : 'm'}`;
}

/** "2.8 mph" / "4.5 km/h" from metres per second. */
export function formatSpeed(metresPerSecond: number, units: UnitSystem = getUnits()): string {
  return units === 'imperial' ? `${(metresPerSecond * 2.23694).toFixed(1)} mph` : `${(metresPerSecond * 3.6).toFixed(1)} km/h`;
}

/** The other system, for secondary readouts ("4,391 m" under "14,407 ft"). */
export const otherUnits = (units: UnitSystem = getUnits()): UnitSystem => units === 'imperial' ? 'metric' : 'imperial';
