/** Observe actual element-buffer traffic without saving geometry or GPU handles. */
export function installTerrainIndexAudit() {
  const contexts = new WeakMap(), buffers = new WeakMap(), sources = new WeakMap();
  window.__terrainIndexAudit = { identify: source => sources.get(source) ?? null };
  const nativeBind = WebGL2RenderingContext.prototype.bindBuffer;
  WebGL2RenderingContext.prototype.bindBuffer = function (target, buffer) {
    if (target === this.ELEMENT_ARRAY_BUFFER) contexts.set(this, buffer);
    return nativeBind.apply(this, arguments);
  };
  const nativeData = WebGL2RenderingContext.prototype.bufferData;
  WebGL2RenderingContext.prototype.bufferData = function (target, source) {
    if (target === this.ELEMENT_ARRAY_BUFFER && ArrayBuffer.isView(source)) {
      const row = { allocationBytes: source.byteLength, allocationCalls: 1, updateBytes: 0, updateCalls: 0, maxUpdateBytes: 0,
        revisions: 0, equivalentFullPrefixBytes: 0, lastVersion: null };
      const buffer = contexts.get(this); if (buffer) buffers.set(buffer, row);
      sources.set(source, row);
    }
    return nativeData.apply(this, arguments);
  };
  const nativeSubData = WebGL2RenderingContext.prototype.bufferSubData;
  WebGL2RenderingContext.prototype.bufferSubData = function (target, _offset, source, sourceOffset = 0, length) {
    if (target === this.ELEMENT_ARRAY_BUFFER && ArrayBuffer.isView(source)) {
      const row = buffers.get(contexts.get(this));
      if (row) {
        const geometry = window.__trekViewerApp?.activeTrek?.terrainResult?.terrainMesh?.geometry;
        if (geometry?.index?.array === source && row.lastVersion !== geometry.index.version) {
          row.lastVersion = geometry.index.version; row.revisions++;
          row.equivalentFullPrefixBytes += Math.min(geometry.drawRange.count, geometry.index.count) * source.BYTES_PER_ELEMENT;
        }
        const bytes = ((length === undefined || length === 0) ? source.length - sourceOffset : length) * source.BYTES_PER_ELEMENT;
        row.updateBytes += bytes; row.updateCalls++; row.maxUpdateBytes = Math.max(row.maxUpdateBytes, bytes);
      }
    }
    return nativeSubData.apply(this, arguments);
  };
}
