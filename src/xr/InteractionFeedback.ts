/**
 * Short synthesized audio cues for XR interactions. Meta's hands guidance treats
 * audio confirmation as required for poke/pinch/grab because hands have no haptics.
 * The AudioContext is created lazily on the first cue (after a user gesture such as
 * entering XR), and every failure is silent: feedback must never break input.
 */
export type FeedbackCue = 'press' | 'select' | 'grab' | 'release' | 'arm';

interface Tone { frequency: number; durationS: number; gain: number; endFrequency?: number }

const CUES: Record<FeedbackCue, Tone[]> = {
  press: [{ frequency: 1250, durationS: 0.035, gain: 0.07 }],
  select: [{ frequency: 880, durationS: 0.05, gain: 0.07 }, { frequency: 1320, durationS: 0.06, gain: 0.06 }],
  grab: [{ frequency: 420, endFrequency: 620, durationS: 0.06, gain: 0.06 }],
  release: [{ frequency: 620, endFrequency: 420, durationS: 0.05, gain: 0.04 }],
  arm: [{ frequency: 660, durationS: 0.08, gain: 0.06 }],
};

export class InteractionFeedback {
  private context: AudioContext | null = null;
  private enabled = true;
  private lastCueAt = 0;

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public play(cue: FeedbackCue): void {
    if (!this.enabled) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastCueAt < 40) return; // Avoid buzzing when several sources fire together.
    this.lastCueAt = now;
    try {
      const ctx = this.ensureContext();
      if (!ctx) return;
      let start = ctx.currentTime;
      for (const tone of CUES[cue]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(tone.frequency, start);
        if (tone.endFrequency) osc.frequency.linearRampToValueAtTime(tone.endFrequency, start + tone.durationS);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(tone.gain, start + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.durationS);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + tone.durationS + 0.01);
        start += tone.durationS;
      }
    } catch {
      /* Audio is optional feedback. */
    }
  }

  public dispose(): void {
    void this.context?.close().catch(() => {});
    this.context = null;
  }

  private ensureContext(): AudioContext | null {
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
      return this.context;
    }
    const Ctor = (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.context = new Ctor();
    return this.context;
  }
}
