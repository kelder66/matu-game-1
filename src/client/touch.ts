import { touch } from './input';

/**
 * On-screen controls for phones and tablets: a thumbstick on the left for pitch and
 * bank, a fire button on the right, and two small throttle buttons.
 *
 * Pointer Events rather than Touch Events, so one code path covers finger, pen and
 * (for testing) mouse. Every control tracks its own pointerId, which is what makes
 * two thumbs work at once -- steering while firing is the normal case, not an edge
 * case.
 */

const STICK_RADIUS = 56; // px of travel from centre to full deflection
const DEADZONE = 0.12; // fraction of the radius ignored, so a resting thumb is neutral

/**
 * Best-effort pointer capture. Capture is a nicety -- it keeps a thumb that slides
 * off a button still owning it -- but it throws if the pointer is not currently
 * active, and an exception here would abort the handler and leave the control dead.
 * Never let it gate the actual response.
 */
function capture(el: HTMLElement, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* not capturable; the control still works, it just loses slide-off tracking */
  }
}

export function isTouchDevice(): boolean {
  // ?touch forces the on-screen controls on a desktop, which is the only practical
  // way to check the layout without picking up a phone.
  if (location.search.includes('touch')) return true;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

export function initTouchControls() {
  const root = document.getElementById('touch');
  if (!root) return;
  root.classList.remove('hidden');

  setupStick(
    root.querySelector('#stick') as HTMLElement,
    root.querySelector('#stickKnob') as HTMLElement,
  );
  setupHold(root.querySelector('#btnFire') as HTMLElement, (on) => (touch.fire = on));
  setupHold(root.querySelector('#btnUp') as HTMLElement, (on) => (touch.throttle = on ? 1 : 0));
  setupHold(root.querySelector('#btnDown') as HTMLElement, (on) => (touch.throttle = on ? -1 : 0));

  // A touch that ends while the page is hidden never reports a pointerup.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAllTouchControls();
  });
  window.addEventListener('blur', releaseAllTouchControls);

  // iOS ignores user-scalable=no, so pinch-zoom has to be refused explicitly. Without
  // this, a thumb that misses the fire button and lands on the canvas can double-tap
  // or pinch the whole page into a corner mid-flight.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault());
  }
  document.addEventListener('dblclick', (e) => e.preventDefault());
}

function setupStick(base: HTMLElement, knob: HTMLElement) {
  let id: number | null = null;
  let originX = 0;
  let originY = 0;

  const reset = () => {
    id = null;
    touch.roll = 0;
    touch.pitch = 0;
    knob.style.transform = 'translate(-50%, -50%)';
  };

  base.addEventListener('pointerdown', (e) => {
    if (id !== null) return;
    id = e.pointerId;
    capture(base, e.pointerId);
    const r = base.getBoundingClientRect();
    originX = r.left + r.width / 2;
    originY = r.top + r.height / 2;
    move(e);
    e.preventDefault();
  });

  // Move and release are tracked on WINDOW, not on the pad.
  //
  // Listening on the element alone is how the stick got stuck: the finger leaves the
  // 148 px circle, the browser retargets or drops the events, no pointerup ever
  // reaches the pad, `id` stays set, and every later pointerdown returns early --
  // a dead stick frozen at its last deflection, while the fire button (its own
  // pointer) kept working. `pointerleave` used to be in the release list too, which
  // reset the stick mid-turn whenever a thumb strayed outside the circle.
  window.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    move(e);
    e.preventDefault();
  });

  const end = (e: PointerEvent) => {
    if (e.pointerId === id) reset();
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  stickResets.push(reset);

  function move(e: PointerEvent) {
    let dx = (e.clientX - originX) / STICK_RADIUS;
    let dy = (e.clientY - originY) / STICK_RADIUS;

    // Clamp to the circle so diagonals aren't stronger than the cardinals.
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }

    const mag = Math.hypot(dx, dy);
    if (mag < DEADZONE) {
      touch.roll = 0;
      touch.pitch = 0;
    } else {
      // Rescale past the deadzone so the very first movement isn't a jump to 0.12.
      const scale = (mag - DEADZONE) / (1 - DEADZONE) / mag;
      touch.roll = dx * scale;
      touch.pitch = -dy * scale; // screen y grows downward; pulling back raises the nose
    }

    knob.style.transform =
      `translate(-50%, -50%) translate(${dx * STICK_RADIUS}px, ${dy * STICK_RADIUS}px)`;
  }

  reset();
}

function setupHold(el: HTMLElement, set: (on: boolean) => void) {
  let id: number | null = null;

  const release = () => {
    id = null;
    el.classList.remove('down');
    set(false);
  };

  el.addEventListener('pointerdown', (e) => {
    if (id !== null) return;
    id = e.pointerId;
    capture(el, e.pointerId);
    el.classList.add('down');
    set(true);
    e.preventDefault();
  });

  // Released on WINDOW for the same reason as the stick: a lift outside the button
  // must still count. A throttle button stuck down is not merely unresponsive -- it
  // pins the aircraft at minimum or maximum speed, which reads as "the plane is
  // slow" rather than as a stuck control.
  const end = (e: PointerEvent) => {
    if (e.pointerId === id) release();
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  holdResets.push(release);
}

/** Every control's release, so a lost pointer can be cleared wholesale. */
const holdResets: (() => void)[] = [];
const stickResets: (() => void)[] = [];

/**
 * Last-resort recovery. Switching apps mid-drag, an incoming call, or a gesture the
 * OS steals can all end a touch without any event we ever see; a control left held
 * would fly the plane into the ground on its own.
 */
export function releaseAllTouchControls() {
  for (const r of holdResets) r();
  for (const r of stickResets) r();
}

/**
 * Keep the screen awake. Without this a phone dims and locks mid-flight, which on
 * iOS also suspends the render loop and drops the WebSocket.
 */
export async function keepAwake() {
  type WakeLockNav = Navigator & { wakeLock?: { request(t: 'screen'): Promise<unknown> } };
  const nav = navigator as WakeLockNav;
  if (!nav.wakeLock) return;
  const acquire = () => nav.wakeLock?.request('screen').catch(() => undefined);
  await acquire();
  // The lock is dropped whenever the tab is backgrounded, so re-take it on return.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) acquire();
  });
}
