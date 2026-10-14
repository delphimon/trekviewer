export interface ComfortPreferences {
  movement: 'walk' | 'step';
  turning: 'snap' | 'smooth';
  vignette: boolean;
  panelScale: number;
}

export const DEFAULT_COMFORT: ComfortPreferences = {
  movement: 'walk', turning: 'snap', vignette: true, panelScale: 1,
};

export function readComfortPreferences(): ComfortPreferences {
  try {
    const value = JSON.parse(localStorage.getItem('trekviewer.comfort') || '{}');
    return {
      movement: value.movement === 'step' ? 'step' : 'walk',
      turning: value.turning === 'smooth' ? 'smooth' : 'snap',
      vignette: value.vignette !== false,
      panelScale: value.panelScale === 1.25 ? 1.25 : 1,
    };
  } catch { return { ...DEFAULT_COMFORT }; }
}

export function saveComfortPreferences(value: ComfortPreferences): void {
  try { localStorage.setItem('trekviewer.comfort', JSON.stringify(value)); } catch { /* private browsing */ }
}
