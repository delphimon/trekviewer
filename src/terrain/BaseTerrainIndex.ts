import { BaseTerrainCoverage } from './BaseTerrainCoverage.ts';
import type { TerrainGridLayout } from './TerrainGrid.ts';
import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';

type TerrainIndices = Uint16Array | Uint32Array;
const HIDDEN = 0xffffffff;
const CELLS_PER_BLOCK = 64;

/** Compact opaque terrain by swapping removed cells with the last visible cell.
 * Retains exactly the original triangles/winding without shifting the entire
 * index prefix for every promotion. Vertex attributes and geometry stay fixed. */
export class BaseTerrainIndex {
  private readonly coverage: BaseTerrainCoverage;
  private readonly cellSlots: Uint32Array;
  private readonly slotCells: Uint32Array;
  private readonly dirtyBlocks: Uint8Array;
  private readonly previousHidden: Uint8Array;
  private readonly previousWords: Uint32Array;
  private readonly hiddenWords: Uint32Array;
  private visibleCells: number;
  /** Index-element ranges, coalesced into bounded 64-cell upload blocks. */
  public readonly dirtyRanges: { start: number; count: number }[] = [];

  constructor(grid: TerrainGridLayout, private readonly original: TerrainIndices) {
    const cells = grid.segmentsX * grid.segmentsZ;
    this.coverage = new BaseTerrainCoverage(grid, original);
    this.cellSlots = new Uint32Array(cells);
    this.slotCells = new Uint32Array(cells);
    this.dirtyBlocks = new Uint8Array(Math.ceil(cells / CELLS_PER_BLOCK));
    this.previousHidden = new Uint8Array(cells);
    this.previousWords = new Uint32Array(this.previousHidden.buffer, 0, Math.floor(cells / 4));
    this.hiddenWords = new Uint32Array(this.coverage.hiddenCells.buffer, 0, Math.floor(cells / 4));
    this.visibleCells = cells;
    for (let cell = 0; cell < cells; cell++) this.cellSlots[cell] = this.slotCells[cell] = cell;
  }

  public get hiddenCells(): Uint8Array { return this.coverage.hiddenCells; }

  public update(holes: readonly TerrainSurfaceBounds[], target: TerrainIndices, pending: readonly { start: number; count: number }[] = []): number {
    const hidden = this.coverage.updateMask(holes);
    this.dirtyBlocks.fill(0); this.dirtyRanges.length = 0;
    // A culled mesh can accumulate many revisions before rendering. Union its
    // pending writes into fixed-size state instead of growing a range list.
    for (const range of pending) this.dirtyBlocks.fill(1, Math.floor(range.start / (CELLS_PER_BLOCK * 6)),
      Math.ceil((range.start + range.count) / (CELLS_PER_BLOCK * 6)));
    // Compare four visibility bytes at once, visiting slot maps only for cells
    // whose coverage changed. The last partial word uses individual bytes.
    for (let word = 0; word <= this.hiddenWords.length; word++) {
      if (word < this.hiddenWords.length && this.hiddenWords[word] === this.previousWords[word]) continue;
      const end = Math.min(hidden.length, word * 4 + 4);
      for (let cell = word * 4; cell < end; cell++) {
        if (hidden[cell] === this.previousHidden[cell]) continue;
        const slot = this.cellSlots[cell];
        if (hidden[cell] && slot !== HIDDEN) {
          const last = --this.visibleCells;
          if (slot !== last) {
            const moved = this.slotCells[last];
            target.copyWithin(slot * 6, last * 6, last * 6 + 6);
            this.slotCells[slot] = moved; this.cellSlots[moved] = slot;
            this.dirtyBlocks[Math.floor(slot / CELLS_PER_BLOCK)] = 1;
          }
          this.cellSlots[cell] = HIDDEN;
        } else if (!hidden[cell] && slot === HIDDEN) {
          const appended = this.visibleCells++;
          for (let i = 0; i < 6; i++) target[appended * 6 + i] = this.original[cell * 6 + i];
          this.slotCells[appended] = cell; this.cellSlots[cell] = appended;
          this.dirtyBlocks[Math.floor(appended / CELLS_PER_BLOCK)] = 1;
        }
        this.previousHidden[cell] = hidden[cell];
      }
    }
    const count = this.visibleCells * 6;
    for (let block = 0; block < this.dirtyBlocks.length;) {
      if (!this.dirtyBlocks[block]) { block++; continue; }
      const start = block * CELLS_PER_BLOCK * 6;
      while (++block < this.dirtyBlocks.length && this.dirtyBlocks[block]) { /* Coalesce adjacent blocks. */ }
      // Retain pending writes even beyond a newly shortened draw range. An
      // empty range list means "upload everything" to Three if a version is
      // still pending, including when coverage becomes completely hidden.
      const end = Math.min(target.length, block * CELLS_PER_BLOCK * 6);
      if (end > start) this.dirtyRanges.push({ start, count: end - start });
    }
    return count;
  }
}
