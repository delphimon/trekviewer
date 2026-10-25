import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function resolveChromium() {
  const candidates = [
    process.env.TREK_PLAYWRIGHT_MODULE,
    'playwright',
    'playwright-core',
  ].filter(Boolean);
  for (const mod of candidates) {
    try {
      return require(mod).chromium;
    } catch {
      // try next
    }
  }
  throw new Error('Playwright module not found. Install playwright or set TREK_PLAYWRIGHT_MODULE.');
}

export function resolveExecutablePath() {
  const candidates = [
    process.env.TREK_EDGE_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function resolveLaunchOptions(extra = {}) {
  const executablePath = resolveExecutablePath();
  return {
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    ...extra,
  };
}
