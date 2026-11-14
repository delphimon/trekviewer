import { defineConfig } from '@playwright/test';

/** One browser smoke test against the built app (npm run build first). */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  timeout: 120_000,
  use: { baseURL: 'http://127.0.0.1:4180', ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) },
  webServer: {
    command: 'python3 -m http.server 4180 --bind 127.0.0.1 --directory dist',
    url: 'http://127.0.0.1:4180',
    reuseExistingServer: !process.env.CI,
  },
});
