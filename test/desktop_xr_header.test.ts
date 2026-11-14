import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest';
import { DesktopOverlay } from '../src/ui/DesktopOverlay.ts';

describe('DesktopOverlay header without headset support', () => {
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

  const overlay = () => new DesktopOverlay({ innerHTML: '', addEventListener: vi.fn() } as unknown as HTMLElement, {
    onSelectRoute: () => {}, onUploadGPX: () => {}, onEnterXR: () => {}, onToggleViewMode: () => {}, onTogglePlay: () => {},
    onSetSpeed: () => {}, onScrub: () => {}, onSetTextureStyle: () => {}, onSetTrailColorMode: () => {},
  });

  it('hides both XR buttons and the status line and offers one Quest link when XR is unavailable', () => {
    const o = overlay(), doc = (globalThis as any).document;
    o.setXRSupport(false, false, 'VR/MR is unavailable here. Open this page in a headset browser.');
    expect(doc.getElementById('btnEnterVR').hidden).toBe(true);
    expect(doc.getElementById('btnEnterAR').hidden).toBe(true);
    expect(doc.getElementById('xrSupportStatus').hidden).toBe(true);
    expect(doc.getElementById('btnQuestHelp').hidden).toBe(false);
    o.setXRSupport(true, false, 'Passthrough is unavailable.');
    expect(doc.getElementById('btnEnterVR').hidden).toBe(false);
    expect(doc.getElementById('btnQuestHelp').hidden).toBe(true);
    expect(doc.getElementById('xrSupportStatus').hidden).toBe(false);
    o.dispose();
  });
});
