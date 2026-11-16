/** True only when running as the installed Quest app (manifest `display: standalone`).
 * Quest Browser exposes PWA-only APIs such as `getDigitalGoodsService` in ordinary tabs too,
 * so the display mode is the reliable signal. */
export function isInstalledApp(win: Pick<Window, 'matchMedia'>): boolean {
  try {
    return win.matchMedia?.('(display-mode: standalone)').matches === true
      || win.matchMedia?.('(display-mode: fullscreen)').matches === true;
  } catch {
    return false;
  }
}
