import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import { DesktopOverlay } from '../src/ui/DesktopOverlay.ts';

describe('DesktopOverlay Status Banner & Spinner Lifecycle', () => {
  let origDocument: any;
  let origWindow: any;
  let lastTimeoutDelay: number | null = null;

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    origWindow = (globalThis as any).window;
    lastTimeoutDelay = null;

    (globalThis as any).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      clearTimeout: vi.fn(),
      setTimeout: vi.fn((_cb: () => void, delay: number) => {
        lastTimeoutDelay = delay;
        return 1;
      }),
    };

    const elements = new Map<string, any>();
    const spinnerEl = { style: { display: 'inline-block' } };
    const mockCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      strokeText: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      measureText: () => ({ width: 50 }),
      roundRect: vi.fn(),
      drawImage: vi.fn(),
      setLineDash: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
    };

    (globalThis as any).document = {
      createTextNode: (text: string) => ({ textContent: text }),
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return { width: 280, height: 60, getContext: () => mockCtx };
        }
        return {
          style: {},
          classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
          appendChild: vi.fn(),
          addEventListener: vi.fn(),
          setAttribute: vi.fn(),
          getAttribute: () => null,
        };
      },
      getElementById: (id: string) => {
        if (!elements.has(id)) {
          const el: any = {
            id,
            disabled: false,
            style: {},
            classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
            addEventListener: vi.fn(),
            appendChild: vi.fn(),
            querySelector: (sel: string) => (sel === '.status-spinner' ? spinnerEl : { style: {}, disabled: false, textContent: '', classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() } }),
            querySelectorAll: () => [],
            textContent: '',
            value: '0',
            files: [],
          };
          if (id === 'canvasChart') {
            el.width = 280;
            el.height = 60;
            el.getContext = () => mockCtx;
          }
          elements.set(id, el);
        }
        return elements.get(id);
      },
      querySelectorAll: () => [],
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    (globalThis as any).window = origWindow;
    vi.restoreAllMocks();
  });

  it('hides spinner and auto-dismisses on ready and completion messages via DesktopOverlay.showStatus', () => {
    const container = { innerHTML: '', addEventListener: vi.fn() } as unknown as HTMLElement;
    const overlay = new DesktopOverlay(container, {
      onSelectRoute: () => {},
      onUploadGPX: () => {},
      onEnterXR: () => {},
      onToggleViewMode: () => {},
      onTogglePlay: () => {},
      onSetSpeed: () => {},
      onScrub: () => {},
      onSetTextureStyle: () => {},
      onSetTrailColorMode: () => {},
    });

    const statusBanner = (globalThis as any).document.getElementById('statusBanner');
    const spinner = statusBanner.querySelector('.status-spinner');

    // 1. In-progress loading message: spinner MUST be visible, no auto-dismissal
    lastTimeoutDelay = null;
    overlay.showStatus('Downloading 3D elevation tiles (4/12)...');
    assert.strictEqual(spinner.style.display, 'inline-block');
    assert.strictEqual(lastTimeoutDelay, null);

    // 2. "Satellite imagery ready.": MUST hide spinner and dismiss after 2.5s
    lastTimeoutDelay = null;
    overlay.showStatus('Satellite imagery ready.', false);
    assert.strictEqual(spinner.style.display, 'none', 'Spinner must hide when satellite imagery is ready');
    assert.strictEqual(lastTimeoutDelay, 2500, 'Must auto-dismiss after 2500ms');

    // 3. "Elevation model ready.": MUST hide spinner and dismiss
    lastTimeoutDelay = null;
    overlay.showStatus('Elevation model ready.', false);
    assert.strictEqual(spinner.style.display, 'none');
    assert.strictEqual(lastTimeoutDelay, 2500);

    // 4. "Loaded: Mount Rainier": MUST hide spinner and dismiss
    lastTimeoutDelay = null;
    overlay.showStatus('Loaded: Mount Rainier (9.3 mi, +4,600 ft gain)', false);
    assert.strictEqual(spinner.style.display, 'none');
    assert.strictEqual(lastTimeoutDelay, 2500);

    // 5. Error message: spinner hidden, dismiss after 6s
    lastTimeoutDelay = null;
    overlay.showStatus('Failed to load GPX track', true);
    assert.strictEqual(spinner.style.display, 'none', 'Spinner must not spin on error');
    assert.strictEqual(lastTimeoutDelay, 6000);

    overlay.dispose();
  });
});
