import { describe, expect, it, vi } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';

const points = '<trkpt lon="-122" lat="47"><ele>100</ele></trkpt><trkpt lon="-122.001" lat="47.001"><ele>200</ele></trkpt>';
const track = `<trk><name>Ridge &amp; Lake &#x26F0;</name><trkseg>${points}</trkseg></trk>`;
const wrap = (body: string) => `<gpx>${body}</gpx>`;

describe('shared GPX XML reader', () => {
  it.each(['', 'http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1'])('reads GPX namespace %s with arbitrary attribute order', namespace => {
    const raw = GPXParser.parseRaw(`<gpx xmlns="${namespace}">${track}</gpx>`);
    expect(raw.trackName).toBe('Ridge & Lake ⛰');
    expect(raw.rawSegments[0].map(point => [point.lat, point.lon, point.ele])).toEqual([[47, -122, 100], [47.001, -122.001, 200]]);
  });

  it('accepts prefixed GPX, CDATA, self-closing waypoints and arbitrary extension prefixes', () => {
    const xml = `<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1" xmlns:fitness="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
      <g:wpt lon="-122" lat="47"/><g:wpt lat="47.001" lon="-122.001"><g:name><![CDATA[Camp <Upper> & East]]></g:name><g:desc>Water &amp; shelter</g:desc><g:sym>Campground</g:sym></g:wpt>
      <g:trk><g:name><![CDATA[Valley & Ridge]]></g:name><g:trkseg>
      <g:trkpt lon="-122" lat="47"><g:ele>100</g:ele><g:time>2026-10-19T00:00:00Z</g:time><g:extensions><fitness:TrackPointExtension><fitness:hr>144</fitness:hr><fitness:cad>82</fitness:cad></fitness:TrackPointExtension></g:extensions></g:trkpt>
      <g:trkpt lon="-122.001" lat="47.001"/></g:trkseg></g:trk></g:gpx>`;
    const raw = GPXParser.parseRaw(xml);
    expect(raw.trackName).toBe('Valley & Ridge');
    expect(raw.rawSegments[0]).toHaveLength(2);
    expect(raw.rawSegments[0][0]).toMatchObject({ ele: 100, rawEle: 100, hr: 144, cad: 82, time: new Date('2026-10-19T00:00:00Z') });
    expect(raw.waypoints.map(point => point.name)).toEqual(['Waypoint', 'Camp <Upper> & East']);
    expect(raw.waypoints[1]).toMatchObject({ desc: 'Water & shelter', sym: 'Campground' });
  });

  it('preserves separate tracks and segments and uses routes only when no track points exist', () => {
    const rte = '<rte><rtept lat="46" lon="-121"/><rtept lat="46.001" lon="-121.001"/></rte>';
    const raw = GPXParser.parseRaw(wrap(`${rte}<trk><trkseg>${points}</trkseg><trkseg>${points}</trkseg></trk><trk>${points}</trk>`));
    expect(raw.rawSegments).toHaveLength(3);
    expect(raw.rawSegments.every(segment => segment[0].lat === 47 && segment.length === 2)).toBe(true);
    const routes = GPXParser.parseRaw(wrap(`<trk><trkseg/></trk>${rte}${rte}`));
    expect(routes.rawSegments).toHaveLength(2);
    expect(routes.rawSegments[0][0].lat).toBe(46);
  });

  it('ignores extension elements that shadow core data', () => {
    const raw = GPXParser.parseRaw(`<gpx xmlns:x="urn:vendor"><extensions><name>Wrong name</name><x:trk><x:trkseg>${points}</x:trkseg></x:trk></extensions>
      <trk><name>Correct</name><trkseg><trkpt lat="47" lon="-122"><extensions><x:ele>8000</x:ele></extensions><ele>100</ele></trkpt>${points}</trkseg></trk></gpx>`);
    expect(raw.trackName).toBe('Correct');
    expect(raw.rawSegments[0]).toHaveLength(3);
    expect(raw.rawSegments[0][0].ele).toBe(100);
  });

  it('filters missing, empty and partially numeric coordinates rather than inventing locations', () => {
    const bad = '<trkpt lon="-122"/><trkpt lat="" lon="-122"/><trkpt lat="47north" lon="-122"/>';
    const raw = GPXParser.parseRaw(wrap(`<wpt lon="-122"/><wpt lat="" lon="-122"/><trk><trkseg>${bad}${points}</trkseg></trk>`));
    expect(raw.rawSegments[0]).toHaveLength(2);
    expect(raw.rawSegments[0][0].lat).toBe(47);
    expect(raw.waypoints).toHaveLength(0);
    expect(raw.warnings.join(' ')).toMatch(/3/);
  });

  it.each([
    '<gpx><trk></gpx>', '<gpx/><gpx/>', '<wrong/>', '',
    '<gpx><trk><name>&unknown;</name></trk></gpx>',
    '<!DOCTYPE gpx [<!ENTITY place "Ridge">]><gpx/>',
    '<gpx><u:trk/></gpx>',
  ])('rejects malformed or unsupported XML: %s', xml => {
    expect(() => GPXParser.parseRaw(xml)).toThrow(/XML parse error/);
  });

  it('bounds prefixed point and waypoint counts, XML size and nesting', () => {
    const prefix = '<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1">';
    expect(() => GPXParser.parseRaw(`${prefix}<g:trk><g:trkseg>${'<g:trkpt lat="47" lon="-122"/>'.repeat(100_001)}</g:trkseg></g:trk></g:gpx>`)).toThrow(/100,000/);
    expect(() => GPXParser.parseRaw(`${prefix}${'<g:wpt lat="47" lon="-122"/>'.repeat(1_001)}</g:gpx>`)).toThrow(/1,000/);
    expect(() => GPXParser.parseRaw(' '.repeat(25 * 1024 * 1024 + 1))).toThrow(/25 MB/);
    expect(() => GPXParser.parseRaw(wrap('<extensions>'.repeat(128) + '</extensions>'.repeat(128)))).toThrow(/128 levels/);
  });

  it('uses the same reader even when a browser DOMParser exists', () => {
    const dom = vi.fn(() => { throw new Error('DOM path must not run'); });
    vi.stubGlobal('DOMParser', dom);
    try {
      expect(GPXParser.parseRaw(wrap(track)).trackName).toBe('Ridge & Lake ⛰');
      expect(dom).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
