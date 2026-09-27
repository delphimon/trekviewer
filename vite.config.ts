import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { execSync } from 'child_process';

let gitSha = 'unknown';
let gitBranch = 'unknown';
let gitDirty = true;
try {
  gitSha = execSync('git rev-parse HEAD').toString().trim();
  gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  gitDirty = execSync('git status --porcelain --untracked-files=normal').toString().trim().length > 0;
} catch {}

const buildTimestamp = new Date().toISOString();
const buildId = `${gitSha.substring(0, 7)}${gitDirty ? '-modified' : ''}-${buildTimestamp}`;
const buildLabel = process.env.APP_BUILD_LABEL || `TrekViewer 1.0.0 • ${gitSha.substring(0, 7)}${gitDirty ? " (modified)" : ""}`;

const buildInfo = {id:buildId, sha:gitSha, shortSha:gitSha.substring(0,7), branch:gitBranch,
  dirty:gitDirty, builtAt:buildTimestamp, label:buildLabel};

export default defineConfig({
  base: './',
  define: {
    __APP_BUILD_INFO__: JSON.stringify(buildInfo),
  },
  plugins: [
    basicSsl(),
    {
      name: 'build-provenance',
      generateBundle() {
        this.emitFile({type:'asset',fileName:'build-info.json',source:JSON.stringify(buildInfo,null,2)+'\n'});
      },
    },
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
