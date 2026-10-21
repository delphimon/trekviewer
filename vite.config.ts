import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { execSync } from 'child_process';
import { entryIntegrity } from './scripts/entry-integrity.ts';
import { offlineShell } from './scripts/offline-shell.ts';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const routeManifest = JSON.parse(fs.readFileSync(new URL('./public/routes/manifest.json', import.meta.url), 'utf8')) as { id: string; file: string }[];
const offlineRouteHashes = Object.fromEntries(routeManifest.filter(route => ['rainier-emmons', 'enchantments-dragontail'].includes(route.id))
  .map(route => [route.id, createHash('sha256').update(fs.readFileSync(new URL('./public' + route.file, import.meta.url), 'utf8').replace(/\r\n?/g, '\n')).digest('hex')]));

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
    __OFFLINE_ROUTE_HASHES__: JSON.stringify(offlineRouteHashes),
  },
  plugins: [
    basicSsl(),
    entryIntegrity(),
    offlineShell(buildId),
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
