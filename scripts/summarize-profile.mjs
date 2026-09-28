#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

function counterIncreases(windows, key) {
  let total = 0;
  for (let i = 1; i < windows.length; i++) {
    const before = windows[i - 1][key];
    const after = windows[i][key];
    if (Number.isFinite(before) && Number.isFinite(after)) total += Math.max(0, after - before);
  }
  return total;
}

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('Usage: node scripts/summarize-profile.mjs <profile.json> [profile.json ...]');
  process.exitCode = 2;
} else {
  for (const path of paths) {
    try {
      const report = JSON.parse(await readFile(path, 'utf8'));
      if (report.schemaVersion !== 1 || !Array.isArray(report.windows) || !report.summary) {
        throw new Error('Unrecognized TrekViewer profile schema');
      }
      const windows = report.windows;
      const active = windows.filter(w => w.callbackSamples > 0);
      const worst = [...active].sort((a, b) => (b.intervalMaxMs ?? 0) - (a.intervalMaxMs ?? 0)).slice(0, 5);
      const phaseNames = Object.keys(windows[0]?.phaseMeanMs ?? {});
      const phaseCosts = phaseNames.map(name => ({
        name,
        meanMs: windows.reduce((sum, w) => sum + (w.phaseMeanMs[name] ?? 0) * (w.frames ?? w.callbackSamples + 1), 0)
          / Math.max(1, windows.reduce((sum, w) => sum + (w.frames ?? w.callbackSamples + 1), 0)),
        maxMs: Math.max(0, ...windows.map(w => w.phaseMaxMs[name] ?? 0)),
      })).sort((a, b) => b.meanMs - a.meanMs);
      const contexts = new Map();
      for (const w of windows) {
        const key = `${w.viewMode} / ${w.qualityProfile} / ${w.textureStyle} / ${w.imageryProvider ?? 'unknown provider'}`;
        contexts.set(key, (contexts.get(key) ?? 0) + w.durationSeconds);
      }
      console.log(`\n${path}`);
      console.log(`Build: ${report.buildId}  |  ${report.startedAt} to ${report.endedAt}`);
      console.log(`Duration: ${report.summary.durationSeconds.toFixed(1)} s  |  windows: ${windows.length}  |  dropped: ${report.windowsDropped}`);
      console.log(`Callback samples: ${report.summary.callbackSamples}  |  minimum window callback rate: ${report.summary.minWindowCallbackHz?.toFixed(1) ?? 'unknown'} Hz`);
      console.log(`Largest callback interval: ${report.summary.maxCallbackIntervalMs.toFixed(1)} ms  |  largest CPU submit: ${report.summary.maxCpuSubmitMs.toFixed(1)} ms`);
      console.log(`Estimated missed callbacks: ${report.summary.estimatedMissedCallbacks ?? 'unknown (XR target rate unavailable)'}  |  long tasks: ${report.summary.longTaskCount}`);
      console.log(`Peak draw calls: ${report.summary.maxDrawCalls}  |  peak WebGL textures: ${report.summary.maxTextures}`);
      console.log('Time by view / quality / imagery style / provider:');
      for (const [key, seconds] of contexts) console.log(`  ${key}: ${seconds.toFixed(1)} s`);
      if (active.some(w => Number.isFinite(w.imageryTargetZoom))) {
        const zooms = [...new Set(active.map(w => w.imageryTargetZoom).filter(Number.isFinite))].sort((a, b) => a - b);
        const focusSources = new Map();
        for (const w of active) focusSources.set(w.imageryFocusSource ?? 'unknown', (focusSources.get(w.imageryFocusSource ?? 'unknown') ?? 0) + w.durationSeconds);
        console.log(`Imagery zooms: ${zooms.join(', ')}  |  incomplete selected coverage: ${active.filter(w => w.imageryCoveragePercent < 100).length}/${active.length} windows`);
        console.log(`Focus source: ${[...focusSources].map(([source, seconds]) => `${source} ${seconds.toFixed(1)}s`).join(', ')}`);
        console.log(`Patch creations/disposals during sampled windows: ${counterIncreases(active, 'imageryCreatedTotal')}/${counterIncreases(active, 'imageryDisposedTotal')}  |  tile failures: ${counterIncreases(active, 'tileCacheFailures')}  |  tabletop terrain focus changes: ${counterIncreases(active, 'localTerrainFocusChangesTotal')}`);
      }
      if (active.some(w => Number.isFinite(w.baseTerrainCellXM) && w.baseTerrainCellXM > 0)) {
        const latest = active.at(-1);
        console.log(`Terrain: base ${latest.baseTerrainCellXM}m × ${latest.baseTerrainCellZM}m cells, DEM z${latest.baseDemZoom}; visible local DEM z${latest.visibleLocalDemZoom}`);
        if (latest.regionalBaseDemZoom) console.log(`Regional base elevation: DEM z${latest.regionalBaseDemZoom}, ${latest.regionalBaseTiles ?? 0} packaged USGS tiles`);
        if (Number.isFinite(latest.visibleLocalCellXM) && latest.visibleLocalCellXM > 0) {
          console.log(`Visible local mesh: ${latest.visibleLocalCellXM.toFixed(1)}m × ${latest.visibleLocalCellZM.toFixed(1)}m cells; regional DEM ${latest.regionalDemEnabled ? 'enabled' : 'disabled'}; ${latest.visibleLocalRegionalTiles ?? 0} USGS / ${latest.visibleLocalAwsTiles ?? 0} AWS tiles`);
        }
        const localRays = active.reduce((sum, w) => sum + (w.firstPersonLocalSurfaceRays ?? 0), 0);
        const baseRays = active.reduce((sum, w) => sum + (w.firstPersonBaseSurfaceRays ?? 0), 0);
        if (localRays + baseRays) console.log(`Sampled first-person terrain rays: ${localRays} local / ${baseRays} base`);
      }
      console.log('CPU phases (mean per callback / worst single callback):');
      for (const p of phaseCosts.filter(p => !p.name.startsWith('imagery') || p.name === 'imagery')) {
        console.log(`  ${p.name.padEnd(18)} ${p.meanMs.toFixed(2).padStart(6)} / ${p.maxMs.toFixed(2).padStart(6)} ms`);
      }
      const imageryParts = phaseCosts.filter(p => p.name.startsWith('imagery') && p.name !== 'imagery');
      if (imageryParts.length) {
        console.log('Imagery subphases (included in imagery above):');
        for (const p of imageryParts) console.log(`  ${p.name.padEnd(18)} ${p.meanMs.toFixed(2).padStart(6)} / ${p.maxMs.toFixed(2).padStart(6)} ms`);
      }
      console.log('Worst windows by longest callback interval:');
      for (const w of worst) console.log(`  t=${w.elapsedSeconds.toFixed(1).padStart(6)}s  max=${(w.intervalMaxMs ?? 0).toFixed(1).padStart(5)}ms  p95=${(w.intervalP95Ms ?? 0).toFixed(1).padStart(5)}ms  callback=${w.callbackHz?.toFixed(1) ?? '?'}Hz  CPU p95=${w.cpuSubmitP95Ms?.toFixed(1) ?? '?'}ms  calls=${w.drawCalls}  ${w.viewMode}/${w.qualityProfile}/${w.textureStyle}`);
      console.log('Browser callback and CPU submission measurements only; pair with headset GPU/FPS/thermal metrics.');
    } catch (error) {
      console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
