import { describe, expect, it } from 'vitest';
import { solarPosition, solarTimeToDate, sunDirection, sunIntensityScale } from '../src/visualization/SolarPosition.ts';

describe('solarPosition', () => {
  it('puts the summer solstice noon sun high and due south at Mount Rainier', () => {
    // Solar noon near 46.85°N, 121.76°W on 21 June: elevation ≈ 90 - 46.85 + 23.44 ≈ 66.6°.
    const noon = solarTimeToDate(new Date('2024-06-21T00:00:00Z'), 12 * 60, -121.76);
    const sun = solarPosition(noon, 46.85, -121.76);
    expect(sun.elevationDeg).toBeCloseTo(66.6, 0);
    expect(Math.abs(sun.azimuthDeg - 180)).toBeLessThan(2);
  });
  it('rises in the east in the morning and is below the horizon at midnight', () => {
    const day = new Date('2024-03-20T00:00:00Z');
    const morning = solarPosition(solarTimeToDate(day, 7 * 60, -121.76), 46.85, -121.76);
    expect(morning.azimuthDeg).toBeGreaterThan(80); expect(morning.azimuthDeg).toBeLessThan(110);
    expect(morning.elevationDeg).toBeGreaterThan(0); expect(morning.elevationDeg).toBeLessThan(15);
    expect(solarPosition(solarTimeToDate(day, 0, -121.76), 46.85, -121.76).elevationDeg).toBeLessThan(-30);
  });
});

describe('sunDirection', () => {
  it('maps azimuth to model axes (+X east, -Z north) and keeps the sun just above the horizon', () => {
    const south = sunDirection({ azimuthDeg: 180, elevationDeg: 45 }, { x: 0, y: 0, z: 0 });
    expect(south.z).toBeCloseTo(Math.SQRT1_2); expect(south.y).toBeCloseTo(Math.SQRT1_2); expect(south.x).toBeCloseTo(0);
    const east = sunDirection({ azimuthDeg: 90, elevationDeg: -10 }, { x: 0, y: 0, z: 0 });
    expect(east.x).toBeGreaterThan(0.99); expect(east.y).toBeGreaterThan(0);
  });
  it('dims the light toward and below the horizon', () => {
    expect(sunIntensityScale(60)).toBe(1);
    expect(sunIntensityScale(-5)).toBe(0.15);
    expect(sunIntensityScale(5)).toBeLessThan(1);
  });
});
