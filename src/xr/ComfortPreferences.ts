export interface ComfortPreferences {
  movement: 'walk' | 'step';
  turning: 'snap' | 'smooth';
  vignette: boolean;
  panelScale: number;
}

/** Step (25 m teleport-like steps) is the comfortable default; a saved choice always wins. */
export const DEFAULT_COMFORT: ComfortPreferences = {
  movement: 'step', turning: 'snap', vignette: true, panelScale: 1,
};

/** Each 25 m step fades through black: out over the first half, in over the second. */
export const STEP_FADE_MS = 150;
export function stepFadeOpacity(elapsedMs: number): number {
  const half = STEP_FADE_MS / 2;
  if (!(elapsedMs >= 0) || elapsedMs >= STEP_FADE_MS) return 0;
  return elapsedMs < half ? elapsedMs / half : 1 - (elapsedMs - half) / half;
}

export function readComfortPreferences(): ComfortPreferences {
  try {
    const value = JSON.parse(localStorage.getItem('trekviewer.comfort') || '{}');
    return {
      movement: value.movement === 'walk' || value.movement === 'step' ? value.movement : DEFAULT_COMFORT.movement,
      turning: value.turning === 'smooth' ? 'smooth' : 'snap',
      vignette: value.vignette !== false,
      panelScale: value.panelScale === 1.25 ? 1.25 : 1,
    };
  } catch { return { ...DEFAULT_COMFORT }; }
}

export function saveComfortPreferences(value: ComfortPreferences): void {
  try { localStorage.setItem('trekviewer.comfort', JSON.stringify(value)); } catch { /* private browsing */ }
}
