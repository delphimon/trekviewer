export interface AppBuildInfo {
  id: string;
  sha: string;
  shortSha: string;
  branch: string;
  dirty: boolean;
  builtAt: string;
  label: string;
}

export interface BuildDisplayInfo extends AppBuildInfo {
  version: string;
  builtDateShort: string;
  shortBadge: string;
  fullBadge: string;
}

declare const __APP_BUILD_INFO__: AppBuildInfo | undefined;

export const APP_VERSION = '1.0.0';

export function getBuildInfo(): AppBuildInfo {
  if (typeof __APP_BUILD_INFO__ !== 'undefined' && __APP_BUILD_INFO__) {
    return __APP_BUILD_INFO__;
  }
  return {
    id: `v${APP_VERSION}-dev`,
    sha: 'development',
    shortSha: 'dev',
    branch: 'main',
    dirty: false,
    builtAt: new Date().toISOString(),
    label: `TrekViewer ${APP_VERSION} (dev)`,
  };
}

export function getBuildDisplayInfo(): BuildDisplayInfo {
  const info = getBuildInfo();
  let builtDateShort = '';
  try {
    const d = new Date(info.builtAt);
    if (!Number.isNaN(d.getTime())) {
      builtDateShort = d.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
    }
  } catch {
    builtDateShort = info.builtAt;
  }

  const dirtySuffix = info.dirty ? '*' : '';
  const shortBadge = `v${APP_VERSION} • ${info.shortSha}${dirtySuffix}`;
  const fullBadge = `v${APP_VERSION} • build ${info.shortSha}${info.dirty ? ' (modified)' : ''}${builtDateShort ? ` • ${builtDateShort}` : ''}`;

  return {
    ...info,
    version: APP_VERSION,
    builtDateShort,
    shortBadge,
    fullBadge,
  };
}
