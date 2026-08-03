import { createInput, type Input } from '../shared/flight';

export type { Input };

export const input: Input = createInput();

const MAP: Record<string, keyof Input> = {
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
  input[action] = value;
}

export function initInput() {
  window.addEventListener('keydown', (e) => set(e, true));
  window.addEventListener('keyup', (e) => set(e, false));
  // A key held while the tab loses focus would otherwise stick forever.
  window.addEventListener('blur', () => {
    for (const k of Object.keys(input) as (keyof Input)[]) input[k] = false;
  });
}
