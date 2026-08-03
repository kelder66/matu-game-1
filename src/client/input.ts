export interface Input {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  faster: boolean;
  slower: boolean;
  fire: boolean;
}

export const input: Input = {
  up: false,
  down: false,
  left: false,
  right: false,
  faster: false,
  slower: false,
  fire: false,
};

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

function set(e: KeyboardEvent, value: boolean) {
  // Never swallow typing in the name field (this exact bug was fixed once already).
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;

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
