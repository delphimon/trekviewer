import type { ViewMode } from '../gpx/TrackTypes.ts';

export type PlaybackMode = 'tour' | 'recorded';
export const TOUR_DURATION_SECONDS = 90;

/** Shared playback policy for the DOM controls and spatial HUD. */
export function playbackPresentation(mode: PlaybackMode, viewMode: ViewMode, playing: boolean) {
  const walking = viewMode === 'first-person';
  return {
    label: mode === 'tour' ? '90s tour' : 'Track timing',
    playLabel: playing ? '⏸ Pause' : walking ? '▶ Walk' : mode === 'tour' ? '▶ Tour' : '▶ Play track',
    speeds: mode === 'tour' ? [0.5, 1, 2, 3] : [1, 5, 20, 60],
  };
}
