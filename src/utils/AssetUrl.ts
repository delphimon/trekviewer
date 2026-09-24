/**
 * Resolves application-owned static asset paths with support for root hosting,
 * subpath hosting (e.g. GitHub Pages /trekviewer/), and relative base paths.
 */
export function resolveAssetUrl(path: string, customBase?: string): string {
  if (!path) return '';

  // Return absolute or scheme-specific URLs untouched
  if (/^(?:[a-z]+:|\/\/|blob:|data:)/i.test(path)) {
    return path;
  }

  const base = customBase ?? (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : './');

  // Normalize base: ensure it ends with '/' if it doesn't already, except empty or './'
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  // Normalize path: strip leading '/'
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;

  return `${normalizedBase}${normalizedPath}`;
}
