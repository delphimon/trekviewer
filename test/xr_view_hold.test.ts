import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { XRManager } from '../src/core/XRManager.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const controllers: THREE.Group[] = [];
  const sceneManager: any = {
    renderer: { xr: { isPresenting: true, getCamera: () => new THREE.PerspectiveCamera(),
      getController: () => { const c = new THREE.Group(); controllers.push(c); return c; },
      getControllerGrip: () => new THREE.Group(), getHand: () => new THREE.Group(), getSession: () => ({}) } },
    camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), dioramaRoot: new THREE.Group(),
  };
  const xr = new XRManager(sceneManager);
  const progress: (number | null)[] = [];
  const onToggleViewMode = vi.fn();
  xr.setCallbacks({ onViewModeHoldProgress: p => progress.push(p), onToggleViewMode });
  const sources = controllers.map((controller, i) => {
    const buttons = Array.from({ length: 6 }, () => ({ pressed: false, touched: false, value: 0 }));
    const source = { handedness: i === 0 ? 'left' : 'right', gamepad: { buttons, axes: [0, 0, 0, 0] } };
    controller.dispatchEvent({ type: 'connected', data: source } as any);
    return source;
  });
  return { xr, controllers, sources, progress, onToggleViewMode };
}

it('clears the hold dim when the controller disconnects mid-hold', () => {
  let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { xr, controllers, sources, progress, onToggleViewMode } = setup();
  xr.update(); // arms the controller with nothing pressed
  sources[1].gamepad.buttons[4].pressed = true;
  xr.update(); now += 200; xr.update();
  expect(progress.at(-1)).toBeGreaterThan(0);
  controllers[1].dispatchEvent({ type: 'disconnected', data: sources[1] } as any);
  expect(progress.at(-1)).toBeNull();
  expect(onToggleViewMode).not.toHaveBeenCalled();
});

it('clears the hold dim on an interaction reset and ignores a second face button during a hold', () => {
  let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { xr, sources, progress } = setup();
  xr.update();
  sources[1].gamepad.buttons[4].pressed = true;
  xr.update(); now += 100;
  sources[0].gamepad.buttons[4].pressed = true; // X on the other controller
  xr.update(); now += 100;
  sources[0].gamepad.buttons[4].pressed = false; // releasing the ignored button must not clear the dim
  xr.update();
  expect(progress.at(-1)).toBeGreaterThan(0);
  xr.resetInteractionState();
  expect(progress.at(-1)).toBeNull();
});

it('pauses and ignores the sticks while the session is blurred by the system UI', () => {
  const controllers: THREE.Group[] = [];
  const session: { visibilityState: string } = { visibilityState: 'visible' };
  const sceneManager: any = {
    renderer: { xr: { isPresenting: true, getCamera: () => new THREE.PerspectiveCamera(),
      getController: () => { const c = new THREE.Group(); controllers.push(c); return c; },
      getControllerGrip: () => new THREE.Group(), getHand: () => new THREE.Group(), getSession: () => session } },
    camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), dioramaRoot: new THREE.Group(),
  };
  const xr = new XRManager(sceneManager);
  xr.setViewMode('first-person');
  const onSessionBlur = vi.fn(), onScrubDistance = vi.fn();
  xr.setCallbacks({ onSessionBlur, onScrubDistance });
  const buttons = Array.from({ length: 6 }, () => ({ pressed: false, touched: false, value: 0 }));
  const axes = [0, 0, 0, 0];
  controllers[0].dispatchEvent({ type: 'connected', data: { handedness: 'left', gamepad: { buttons, axes } } } as any);
  xr.update();
  session.visibilityState = 'visible-blurred';
  axes[3] = -1;
  for (let i = 0; i < 10; i++) xr.update();
  expect(onSessionBlur).toHaveBeenCalledTimes(1);
  expect(onScrubDistance).not.toHaveBeenCalled();
});

it('plays the release cue when a controller grip lets go of the model', async () => {
  const { InteractionFeedback } = await import('../src/xr/InteractionFeedback.ts');
  const play = vi.spyOn(InteractionFeedback.prototype, 'play').mockImplementation(() => {});
  const { xr, sources } = setup();
  xr.setViewMode('diorama');
  xr.update();
  sources[1].gamepad.buttons[1].pressed = true; xr.update(); // grip
  sources[1].gamepad.buttons[1].pressed = false; xr.update(); // release
  expect(play).toHaveBeenCalledWith('release');
});
