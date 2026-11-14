import type { ViewMode } from '../gpx/TrackTypes.ts';

export type PlaybackMode = 'tour' | 'recorded';
export const TOUR_DURATION_SECONDS = 90;

/** Walking pace that the trail view's speed multiplies (m/s). */
export const WALKING_PACE_MPS = 1.4;
/** Desktop "Fly the trail" speeds, as multiples of walking pace. XR life-size stays at 1x. */
export const DESKTOP_TRAIL_SPEEDS = [1, 10, 30, 100];

/** Shared playback policy for the DOM controls and spatial HUD. */
export function playbackPresentation(mode: PlaybackMode, viewMode: ViewMode, playing: boolean, desktop = false) {
  const walking = viewMode === 'first-person';
  return {
    label: walking && desktop ? 'Walking pace' : mode === 'tour' ? '90s tour' : 'Track timing',
    playLabel: playing ? 'Pause' : walking ? (desktop ? 'Fly' : 'Walk') : mode === 'tour' ? 'Play tour' : 'Play track',
    speeds: walking && desktop ? DESKTOP_TRAIL_SPEEDS : mode === 'tour' ? [0.5, 1, 2, 3] : [1, 5, 20, 60],
  };
}
