import { createInput, type Input } from '../shared/flight';

export type { Input };

/**
 * The combined control output the flight model reads. Two sources write into it --
 * the keyboard and the on-screen touch controls -- and `syncInput()` merges them
 * once per frame, so neither can clobber the other.
 */
export const input: Input = createInput();

const held = {
  up: false,
  down: false,
  left: false,
  right: false,
  faster: false,
  slower: false,
  fire: false,
};

type Held = keyof typeof held;

const MAP: Record<string, Held> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ShiftLeft: 'faster',
  ShiftRight: 'faster',
  ControlLeft: 'slower',
  ControlRight: 'slower',
  Space: 'fire',
};

/** Written by the touch layer; all zero on a desktop. */
export const touch = { roll: 0, pitch: 0, throttle: 0, fire: false };

const clamp1 = (x: number) => (x < -1 ? -1 : x > 1 ? 1 : x);

/** Merge keyboard and touch into `input`. Call once at the top of each frame. */
export function syncInput() {
  input.roll = clamp1((held.right ? 1 : 0) - (held.left ? 1 : 0) + touch.roll);
  input.pitch = clamp1((held.up ? 1 : 0) - (held.down ? 1 : 0) + touch.pitch);
  input.throttle = clamp1((held.faster ? 1 : 0) - (held.slower ? 1 : 0) + touch.throttle);
  input.fire = held.fire || touch.fire;
}

/** One-shot keys (fire once per press), for things that toggle rather than hold. */
const presses = new Map<string, () => void>();

export function onPress(code: string, fn: () => void) {
  presses.set(code, fn);
}

function set(e: KeyboardEvent, value: boolean) {
  // Never swallow typing in the name field (this exact bug was fixed once already).
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;

  // One-shot handlers run before the held-key map, and ignore auto-repeat.
  if (value && !e.repeat) {
    const once = presses.get(e.code);
    if (once) {
      e.preventDefault();
      once();
      return;
    }
  }

  const action = MAP[e.code];
  if (!action) return;
  e.preventDefault(); // stop arrows/space scrolling the page
  held[action] = value;
}

export function initInput() {
  window.addEventListener('keydown', (e) => set(e, true));
  window.addEventListener('keyup', (e) => set(e, false));
  // A key held while the tab loses focus would otherwise stick forever.
  window.addEventListener('blur', () => {
    for (const k of Object.keys(held) as Held[]) held[k] = false;
    touch.roll = touch.pitch = touch.throttle = 0;
    touch.fire = false;
  });
}
