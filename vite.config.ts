import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { execSync } from 'child_process';

let gitSha = 'fe42d68e70ab9eb8e761c89d3d43299a322cbb17';
let gitBranch = 'stage-a/build-infra';
try {
  gitSha = execSync('git rev-parse HEAD').toString().trim();
  gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
} catch {}

const buildTimestamp = new Date().toISOString();

export default defineConfig({
  base: './',
  define: {
    __APP_BUILD_INFO__: JSON.stringify({
      sha: gitSha,
      shortSha: gitSha.substring(0, 7),
      branch: gitBranch,
      builtAt: buildTimestamp,
      label: 'STAGE H (contact-anchored & bimanual hand manipulation)',
    }),
  },
  plugins: [
    basicSsl(),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: {},
    cors: true,
  },
  build: {
    target: 'esnext',
  },
});
