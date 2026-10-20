import sax, { type QualifiedTag } from 'sax';
import type { RawTrackPoint } from './GPXValidator.ts';
import type { GPXWaypoint } from './TrackTypes.ts';

const GPX_NAMESPACES = new Set(['', 'http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1']);
type Kind = 'gpx' | 'metadata' | 'trk' | 'trkseg' | 'rte' | 'point' | 'wpt' | 'extensions' | 'field' | 'other';
interface Frame {
  kind: Kind;
  point?: RawTrackPoint;
  waypoint?: GPXWaypoint;
  points?: RawTrackPoint[];
  segments?: RawTrackPoint[][];
  field?: string;
  text?: string;
  owner?: Frame;
}

/** One XML reader for browser imports and Node tests; no DOM or complete XML tree. */
export function readGPXXML(xml: string, fallbackName?: string) {
  if (xml.length > 25 * 1024 * 1024) throw new Error('GPX file exceeds 25 MB limit.');
  const options = { xmlns: true, strictEntities: true };
  const reader = sax.parser(true, options);
  const stack: Frame[] = [];
  const tracks: RawTrackPoint[][] = [], routes: RawTrackPoint[][] = [], waypoints: GPXWaypoint[] = [];
  let rootSeen = false, namespace = '', trackName = '', firstName = '';
  let pointCount = 0, waypointCount = 0;
  const fail = (message: string): never => { throw new Error(`XML parse error: ${message}`); };
  reader.onerror = error => fail(error.message);
  reader.ondoctype = () => fail('DOCTYPE declarations are not supported in GPX imports.');
  reader.onsgmldeclaration = () => fail('Unsupported XML declaration.');
  reader.onopentag = node => {
    const tag = node as QualifiedTag;
    if (stack.length >= 128) fail('GPX nesting exceeds 128 levels.');
    if (!stack.length) {
      if (rootSeen || tag.local !== 'gpx' || !GPX_NAMESPACES.has(tag.uri)) fail('Expected one GPX root element.');
      rootSeen = true;
      namespace = tag.uri;
      stack.push({ kind: 'gpx' });
      return;
    }
    const parent = stack[stack.length - 1];
    const core = tag.uri === namespace;
    const name = tag.local;
    const frame: Frame = { kind: 'other' };
    // Count actual GPX elements, including prefixed and self-closing points.
    if (core && (name === 'trkpt' || name === 'rtept') && ++pointCount > 100_000) {
      throw new Error('GPX exceeds 100,000 track points. Simplify the track before importing.');
    }
    if (core && name === 'wpt' && ++waypointCount > 1_000) {
      throw new Error('GPX exceeds 1,000 waypoints. Reduce the waypoint count before importing.');
    }
    const coordinate = (key: string) => {
      const attribute = tag.attributes[key];
      // Missing/empty coordinates must never become a point at (0, 0).
      return attribute && attribute.uri === '' && attribute.value.trim() ? Number(attribute.value) : NaN;
    };
    if (core && parent.kind === 'gpx' && name === 'metadata') {
      frame.kind = 'metadata';
    } else if (core && parent.kind === 'gpx' && (name === 'trk' || name === 'rte')) {
      frame.kind = name;
      frame.points = [];
      frame.segments = [];
    } else if (core && name === 'trkseg' && parent.kind === 'trk') {
      frame.kind = 'trkseg';
      frame.points = [];
    } else if (core && ((name === 'trkpt' && (parent.kind === 'trkseg' || parent.kind === 'trk')) ||
      (name === 'rtept' && parent.kind === 'rte'))) {
      frame.kind = 'point';
      frame.point = { lat: coordinate('lat'), lon: coordinate('lon') };
    } else if (core && name === 'wpt' && parent.kind === 'gpx') {
      frame.kind = 'wpt';
      frame.waypoint = { lat: coordinate('lat'), lon: coordinate('lon'), name: 'Waypoint' };
    } else if (core && name === 'extensions' && parent.kind === 'point') {
      frame.kind = 'extensions';
      frame.owner = parent;
    } else if (core && ((name === 'name' && ['gpx', 'metadata', 'trk', 'rte', 'wpt'].includes(parent.kind)) ||
      (['ele', 'time', 'hr', 'cad'].includes(name) && parent.kind === 'point') ||
      (['ele', 'desc', 'sym'].includes(name) && parent.kind === 'wpt'))) {
      frame.kind = 'field'; frame.field = name; frame.text = ''; frame.owner = parent;
    } else if (name === 'hr' || name === 'cad') {
      const extension = stack.slice().reverse().find(entry => entry.kind === 'extensions');
      if (extension) {
        frame.kind = 'field'; frame.field = name; frame.text = ''; frame.owner = extension.owner;
      }
    }
    stack.push(frame);
  };
  const text = (value: string) => {
    const frame = stack[stack.length - 1];
    if (frame?.kind === 'field') frame.text += value;
  };
  reader.ontext = text;
  reader.oncdata = text;
  reader.onclosetag = () => {
    const frame = stack.pop()!;
    const parent = stack[stack.length - 1];
    if (frame.kind === 'point') parent.points!.push(frame.point!);
    else if (frame.kind === 'wpt') {
      const waypoint = frame.waypoint!;
      if (Number.isFinite(waypoint.lat) && Number.isFinite(waypoint.lon) && Math.abs(waypoint.lat) <= 85 && Math.abs(waypoint.lon) <= 180) {
        waypoints.push(waypoint);
      }
    } else if (frame.kind === 'trkseg') parent.segments!.push(frame.points!);
    else if (frame.kind === 'trk') {
      // Even empty segment elements suppress the nonstandard direct-point fallback.
      for (const points of frame.segments!.length ? frame.segments! : [frame.points!]) {
        if (points.length) tracks.push(points);
      }
    } else if (frame.kind === 'rte' && frame.points!.length) routes.push(frame.points!);
    else if (frame.kind === 'field') {
      const value = frame.text!.trim(), owner = frame.owner!, field = frame.field!;
      if (!value) return;
      if (owner.point) {
        const point = owner.point;
        if (field === 'time') point.time ??= new Date(value);
        else if (field === 'ele') { point.ele ??= Number(value); point.rawEle = point.ele; }
        else if (field === 'hr' || field === 'cad') point[field] ??= Number(value);
      } else if (owner.waypoint) {
        if (field === 'ele') owner.waypoint.ele = Number(value);
        else if (field === 'name' || field === 'desc' || field === 'sym') owner.waypoint[field] = value;
      }
      if (field === 'name') {
        firstName ||= value;
        if (owner.kind === 'trk') trackName ||= value;
      }
    }
  };
  // Chunk writes also keep the parser's token buffer checks bounded.
  for (let offset = 0; offset < xml.length; offset += 16_384) reader.write(xml.slice(offset, offset + 16_384));
  reader.close();
  if (!rootSeen) fail('Expected a GPX root element.');
  return { trackName: trackName || firstName || fallbackName || 'Unnamed Trek', rawSegments: tracks.length ? tracks : routes, waypoints };
}
