export type QualityProfileName = 'quest-balanced' | 'quest-high' | 'desktop-high';
export type QualityMode = 'high' | 'balanced';

export interface QualityProfile {
  name: QualityProfileName;
  displayName: string;
  tabletopPatches: number;
  firstPersonPatches: number;
  concurrency: number;
  tileCacheEntries: number;
  tileCacheBytes: number;
  warmRetentionMs: number;
  evalIntervalMs: number;
  promotionDwellMs: number;
  demotionDwellMs: number;
  promotionZoomBias: number;
  firstPersonEvalDistM: number;
  firstPersonPrefetchAheadM: number;
  firstPersonRetainBehindM: number;
  localTerrainRadiusM: number;
  localDemZoom: number;
  localDemMaxTiles: number;
  localDemSegments: number;
}

export const QUALITY_PROFILES: Record<QualityProfileName, QualityProfile> = {
  'quest-high': {
    name: 'quest-high',
    displayName: 'Quest 3 High Quality (Stage X Default)',
    tabletopPatches: 48,
    firstPersonPatches: 64,
    concurrency: 6,
    tileCacheEntries: 240,
    tileCacheBytes: 64 * 1024 * 1024, // 64 MB
    warmRetentionMs: 30000,           // 30 seconds
    evalIntervalMs: 120,              // 100-150 ms
    promotionDwellMs: 200,            // 150-250 ms (fast promotion)
    demotionDwellMs: 3000,            // 2-5 sec (slow demotion)
    promotionZoomBias: 0.8,           // +0.7 to +1.0 zoom bias
    firstPersonEvalDistM: 15,         // 10-20 m route threshold
    firstPersonPrefetchAheadM: 650,   // 500-750 m forward prefetch corridor
    firstPersonRetainBehindM: 300,    // 200-400 m warm retention corridor behind
    localTerrainRadiusM: 1250,        // 1000-1500 m local high-res DEM radius
    localDemZoom: 15,                 // Terrarium zoom 15 local elevation
    localDemMaxTiles: 16,             // ~16 z15 tiles on Quest-high
    localDemSegments: 128,            // 128x128 grid resolution (~10-15m spacing)
  },
  'quest-balanced': {
    name: 'quest-balanced',
    displayName: 'Quest 3 Balanced (Power Saving)',
    tabletopPatches: 28,
    firstPersonPatches: 36,
    concurrency: 4,
    tileCacheEntries: 160,
    tileCacheBytes: 40 * 1024 * 1024, // 40 MB
    warmRetentionMs: 15000,
    evalIntervalMs: 200,
    promotionDwellMs: 350,
    demotionDwellMs: 2000,
    promotionZoomBias: 0.5,
    firstPersonEvalDistM: 30,
    firstPersonPrefetchAheadM: 350,
    firstPersonRetainBehindM: 150,
    localTerrainRadiusM: 750,
    localDemZoom: 15,
    localDemMaxTiles: 8,
    localDemSegments: 96,
  },
  'desktop-high': {
    name: 'desktop-high',
    displayName: 'Desktop High Quality',
    tabletopPatches: 80,
    firstPersonPatches: 96,
    concurrency: 6,
    tileCacheEntries: 360,
    tileCacheBytes: 96 * 1024 * 1024, // 96 MB
    warmRetentionMs: 45000,
    evalIntervalMs: 100,
    promotionDwellMs: 150,
    demotionDwellMs: 4000,
    promotionZoomBias: 0.85,
    firstPersonEvalDistM: 15,
    firstPersonPrefetchAheadM: 750,
    firstPersonRetainBehindM: 400,
    localTerrainRadiusM: 1500,
    localDemZoom: 15,
    localDemMaxTiles: 25,
    localDemSegments: 160,
  },
};

export class QualityProfileManager {
  private static activeProfile: QualityProfile = QUALITY_PROFILES['desktop-high'];

  /**
   * Resolves appropriate default profile:
   * Defaults to 'quest-high' for Meta Quest / WebXR unless explicitly overridden.
   */
  public static getDefaultProfile(isQuest: boolean): QualityProfile {
    return isQuest ? QUALITY_PROFILES['quest-high'] : QUALITY_PROFILES['desktop-high'];
  }

  public static getActiveProfile(): QualityProfile {
    return this.activeProfile;
  }

  public static setActiveProfile(profileOrName: QualityProfile | QualityProfileName): QualityProfile {
    if (typeof profileOrName === 'string') {
      const p = QUALITY_PROFILES[profileOrName];
      if (!p) {
        throw new Error(`Unknown quality profile: ${profileOrName}`);
      }
      this.activeProfile = p;
    } else {
      this.activeProfile = profileOrName;
    }
    return this.activeProfile;
  }

  public static getProfile(name: QualityProfileName): QualityProfile {
    return QUALITY_PROFILES[name];
  }

  public static resolveProfileName(mode: QualityMode, isQuest: boolean): QualityProfileName {
    if (isQuest) {
      return mode === 'high' ? 'quest-high' : 'quest-balanced';
    } else {
      return mode === 'high' ? 'desktop-high' : 'quest-balanced';
    }
  }

  public static getQualityMode(profileName: QualityProfileName): QualityMode {
    return profileName === 'quest-balanced' ? 'balanced' : 'high';
  }
}
