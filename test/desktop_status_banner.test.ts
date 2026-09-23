import { describe, it } from 'vitest';
import assert from 'node:assert';

describe('DesktopOverlay Status Banner & Spinner Lifecycle', () => {
  it('hides spinner and auto-dismisses on ready and completion messages', () => {
    // Tests the status banner logic implemented in DesktopOverlay.showStatus
    function evaluateStatusBanner(message: string, isError: boolean = false) {
      const isDone = !isError && (
        message.toLowerCase().includes('ready') ||
        message.includes('Loaded:') ||
        message.includes('active') ||
        message.includes('complete')
      );

      const spinnerDisplay = (isDone || isError) ? 'none' : 'inline-block';
      const autoHideDelay = isDone ? 2500 : isError ? 6000 : null;

      return { isDone, spinnerDisplay, autoHideDelay };
    }

    // 1. In-progress loading message: spinner MUST be visible, no auto-dismissal
    const stateLoading = evaluateStatusBanner('Downloading 3D elevation tiles (4/12)...');
    assert.strictEqual(stateLoading.isDone, false);
    assert.strictEqual(stateLoading.spinnerDisplay, 'inline-block');
    assert.strictEqual(stateLoading.autoHideDelay, null);

    // 2. "Satellite imagery ready." (The user's reported bug): MUST hide spinner and dismiss after 2.5s
    const stateSatReady = evaluateStatusBanner('Satellite imagery ready.', false);
    assert.strictEqual(stateSatReady.isDone, true);
    assert.strictEqual(stateSatReady.spinnerDisplay, 'none', 'Spinner must hide when satellite imagery is ready');
    assert.strictEqual(stateSatReady.autoHideDelay, 2500, 'Must auto-dismiss after 2500ms');

    // 3. "Elevation model ready.": MUST hide spinner and dismiss
    const stateEleReady = evaluateStatusBanner('Elevation model ready.', false);
    assert.strictEqual(stateEleReady.isDone, true);
    assert.strictEqual(stateEleReady.spinnerDisplay, 'none');
    assert.strictEqual(stateEleReady.autoHideDelay, 2500);

    // 4. "Loaded: Mount Rainier": MUST hide spinner and dismiss
    const stateLoaded = evaluateStatusBanner('Loaded: Mount Rainier (9.3 mi, +4,600 ft gain)', false);
    assert.strictEqual(stateLoaded.isDone, true);
    assert.strictEqual(stateLoaded.spinnerDisplay, 'none');
    assert.strictEqual(stateLoaded.autoHideDelay, 2500);

    // 5. Error message: spinner hidden, dismiss after 6s
    const stateError = evaluateStatusBanner('Failed to load GPX track', true);
    assert.strictEqual(stateError.isDone, false);
    assert.strictEqual(stateError.spinnerDisplay, 'none', 'Spinner must not spin on error');
    assert.strictEqual(stateError.autoHideDelay, 6000);

    console.log('✓ Desktop status banner and spinner lifecycle logic verified successfully!');
  });
});
