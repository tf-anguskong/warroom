/**
 * Notification sounds, synthesised with Web Audio (no audio files to ship or load).
 *   join     someone joined your voice room      soft rising chime
 *   leave    someone left your voice room        soft falling chime
 *   summon   you're called (back) to a room      three-note call
 *   mention  someone @mentioned you              bright double ping
 * On/off is a per-browser preference (localStorage); browsers only allow sound after the first click
 * or key press on the page, so the audio context is unlocked then.
 */

export type SoundKind = 'join' | 'leave' | 'summon' | 'mention';

const KEY = 'warroom.sounds';
let ctx: AudioContext | null = null;
const listeners = new Set<(on: boolean) => void>();

export function soundsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundsOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* private window: keep it for this page only */
  }
  listeners.forEach((fn) => fn(on));
  if (on) play('mention');
}

export function onSoundsChanged(fn: (on: boolean) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

// Unlock audio on the first interaction (autoplay rules).
if (typeof window !== 'undefined') {
  const unlock = () => {
    audio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

/** One tone: frequency (Hz), start offset and length (s), shape, peak volume. */
function tone(a: AudioContext, freq: number, at: number, len: number, type: OscillatorType, peak: number) {
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, a.currentTime + at);
  const t0 = a.currentTime + at;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + len + 0.02);
}

const SOUNDS: Record<SoundKind, (a: AudioContext) => void> = {
  join: (a) => {
    tone(a, 587.33, 0, 0.16, 'sine', 0.12); // D5
    tone(a, 880, 0.09, 0.22, 'sine', 0.12); // A5
  },
  leave: (a) => {
    tone(a, 880, 0, 0.16, 'sine', 0.1);
    tone(a, 587.33, 0.09, 0.24, 'sine', 0.1);
  },
  summon: (a) => {
    tone(a, 523.25, 0, 0.18, 'triangle', 0.2); // C5
    tone(a, 659.25, 0.14, 0.18, 'triangle', 0.2); // E5
    tone(a, 783.99, 0.28, 0.36, 'triangle', 0.22); // G5
  },
  mention: (a) => {
    tone(a, 1318.5, 0, 0.12, 'triangle', 0.16); // E6
    tone(a, 1760, 0.11, 0.2, 'triangle', 0.14); // A6
  },
};

// Don't machine-gun: the same sound at most once every 400 ms (e.g. several people joining at once).
const last: Partial<Record<SoundKind, number>> = {};

export function play(kind: SoundKind) {
  if (!soundsOn()) return;
  const now = Date.now();
  if (now - (last[kind] ?? 0) < 400) return;
  last[kind] = now;
  const a = audio();
  if (!a || a.state !== 'running') return;
  try {
    SOUNDS[kind](a);
  } catch {
    /* audio device gone: ignore */
  }
}
