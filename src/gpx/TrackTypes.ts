export interface GPXPoint {
  lat: number;
  lon: number;
  ele: number; // meters (normalized)
  rawEle?: number; // original elevation if present
  elevationProvenance?: 'gpx' | 'dem' | 'interpolated' | 'fallback';
  time?: Date;
  distanceFromStart: number; // cumulative distance in meters across the whole trek
  elapsedSeconds: number; // raw seconds from start
  playbackSeconds: number; // playback seconds with compressed pauses
  speed?: number; // m/s
  grade?: number; // percentage (e.g. 15 for 15% slope)
  hr?: number; // heart rate bpm
  cad?: number; // cadence rpm
  index: number;
  segmentIndex?: number;
}

export interface TrackSegment {
  points: GPXPoint[];
  distance: number;
  elevationGain: number;
  elevationLoss: number;
  startIndex: number;
  endIndex: number;
}

export interface GPXWaypoint {
  lat: number;
  lon: number;
  ele?: number;
  name: string;
  desc?: string;
  sym?: string;
  type?: string;
  isDerivedLandmark?: boolean;
}

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  minEle: number;
  maxEle: number;
  centerLat: number;
  centerLon: number;
  widthMeters: number;
  depthMeters: number;
  elevationSpan: number;
}

export interface ElevationProvenanceStats {
  gpxCount: number;
  demCount: number;
  interpolatedCount: number;
  fallbackCount: number;
  gpxPercent: number;
  demPercent: number;
  interpolatedPercent: number;
  fallbackPercent: number;
}

export interface TrackStats {
  name: string;
  totalDistance: number; // meters
  elevationGain: number; // meters
  elevationLoss: number; // meters
  minElevation: number; // meters
  maxElevation: number; // meters
  startTime?: Date;
  endTime?: Date;
  movingTime: number; // seconds
  totalPlaybackSeconds: number; // seconds for playback with compressed pauses
  avgSpeed: number; // km/h
  maxSpeed: number; // km/h
  bounds: GeoBounds;
  points: GPXPoint[];
  segments: TrackSegment[];
  waypoints: GPXWaypoint[];
  landmarks: GPXWaypoint[];
  warnings: string[];
  elevationProvenanceStats?: ElevationProvenanceStats;
  timingType?: 'recorded' | 'estimated';
}

export type ViewMode = 'diorama' | 'first-person';
export type TextureStyle = 'satellite' | 'topo' | 'hybrid';
export type TrailColorMode = 'elevation' | 'grade' | 'speed' | 'solid';

export interface RouteManifestItem {
  id: string;
  name: string;
  file: string;
  region: string;
  difficulty: string;
  description: string;
}
