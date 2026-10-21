/** Opt-in public-source diagnostic. Records model tile IDs, never request URLs. */
export function installTerrainPlanAudit(streamer = window.__trekViewerApp.activeTrek.localTerrainStreamer) {
  const audit = { plans: [], acquisitions: [] };
  window.__terrainPlanAudit = audit;
  const seen = new WeakSet();
  const observe = () => {
    for (const [id, entry] of streamer.acquisitions) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      const row = { id, startedAtMs: performance.now(), settledAtMs: null, abortedAtMs: null };
      audit.acquisitions.push(row);
      entry.controller.signal.addEventListener('abort', () => {
        row.abortedAtMs = performance.now(); row.wantedAtAbort = streamer.wanted.has(id);
        row.settledAtAbort = entry.settled;
      }, { once: true });
      void entry.result.then(result => {
        row.settledAtMs = performance.now(); row.hasGrid = !!result.grid;
      });
    }
  };
  const original = streamer.update;
  let previousKey;
  streamer.update = function (...args) {
    const result = original.apply(this, args);
    observe();
    if (this.planKey !== previousKey) {
      previousKey = this.planKey;
      audit.plans.push({ timeMs: performance.now(), wanted: [...this.wanted.keys()],
        loaded: [...this.chunks.keys()], focus: { ...this.localFocus },
        anchors: this.detailFocus.map(p => ({ x: p.x, z: p.z })),
        focusId: this.focusTileId, aheadId: this.prefetchTileId,
        revision: this.options.terrainResult.surfaceRevision });
    }
    return result;
  };
  observe();
}
