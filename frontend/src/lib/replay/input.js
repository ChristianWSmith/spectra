// M2 replay input: keyboard transport hotkeys + canvas pan/zoom.
//
// Key map: Space play/pause · , / . speed down/up · ← / → frame step ·
// Shift+← / → ±64 frames (~1 s) · [ / ] previous/next round · L toggle
// loop · F toggle follow · 1-9, 0 select (+follow) player slot · X skip
// freeze · S snapshot PNG.

import { downloadCanvasPNG } from '../download.js';

// snapshot saves the canvas as replay-<matchId>-<tick>.png through the
// native save dialog (lib/save.js → download.js) — cancel is a silent
// no-op; the S-key / button path has no error surface, so failures log to
// the console.
export function snapshot(canvas, matchId, tick) {
  downloadCanvasPNG(canvas, `replay-${matchId}-${tick}.png`).catch((e) =>
    console.error('snapshot save failed:', e),
  );
}

// REPEATABLE — the keys whose auto-repeat is welcome: frame stepping and
// the speed ladder. Everything else held down would strobe its action (a
// held Space/L/F/S must toggle ONCE, not on every key repeat).
const REPEATABLE = new Set(['ArrowLeft', 'ArrowRight', ',', '.']);

// isTextEntry — the focused element swallows EVERY key: a real text
// field (the loop from/to times, filter boxes), a select, a textarea or
// a contenteditable. INPUT[type=range] (the scrubber and the five volume
// faders) is deliberately NOT text entry — its native arrow handling
// owns only the ARROWS (see onKey) while Space/letters/digits keep
// working, so clicking the timeline can never leave Space dead.
function isTextEntry(e) {
  const t = e.target;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true;
  if (tag === 'INPUT') return (t.type || 'text').toLowerCase() !== 'range';
  return false;
}

// isRange — a focused slider: the arrows are its native step/scrub.
function isRange(e) {
  const t = e.target;
  return !!t && t.tagName === 'INPUT' && String(t.type || '').toLowerCase() === 'range';
}

// isControlTarget — the event landed on (or inside) a focusable control
// Space would activate natively: the native activation wins, so the key
// can never double-fire through this handler.
function isControlTarget(t) {
  if (!t) return false;
  if (typeof t.closest === 'function') return t.closest('button, a, [role=button]') != null;
  return t.tagName === 'BUTTON' || t.tagName === 'A' || t.getAttribute?.('role') === 'button';
}

// attachReplayInput wires keys + pointer pan/wheel zoom; returns {detach}.
// onRound(dir) / onSkipFreeze() hand the two VIEW-owned actions back to
// the caller (round navigation and the skip-freeze toggle persist the
// `skip_freeze` pref view-side) — this module stays the key OWNER, never
// the owner of those decisions.
export function attachReplayInput({
  canvas,
  engine,
  renderer,
  matchId,
  slotCount,
  onRound,
  onSkipFreeze,
}) {
  let lastSlot = 0;

  // The F-resume target mirrors the VIEW's lastFollowed: any engine
  // change reporting a follow records it, so F after a Free/Smart detour
  // resumes the player the camera was actually on — not a stale slot.
  const offChange = engine.onChange((st) => {
    if (st.followSlot != null) lastSlot = st.followSlot;
  });

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // browser/app shortcuts
    // A focused component that already handled the key wins (a
    // LandmarkRow role=button preventDefaults its own Space).
    if (e.defaultPrevented) return;
    if (isTextEntry(e)) return; // typing swallows every key
    if (e.repeat && !REPEATABLE.has(e.key)) return; // no strobing toggles
    if (e.key === ' ' && isControlTarget(e.target)) return; // native activation
    if (isRange(e) && e.key.startsWith('Arrow')) return; // native scrub/fader step
    switch (e.key) {
      case ' ':
        e.preventDefault();
        engine.toggle();
        break;
      case ',':
        engine.stepSpeed(-1);
        break;
      case '.':
        engine.stepSpeed(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        engine.step(e.shiftKey ? -64 : -1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        engine.step(e.shiftKey ? 64 : 1);
        break;
      case '[':
        onRound?.(-1);
        break;
      case ']':
        onRound?.(1);
        break;
      case 'l':
      case 'L':
        engine.toggleLoop();
        break;
      case 'f':
      case 'F':
        engine.setFollow(engine.state.followSlot == null ? lastSlot : null);
        break;
      case 'x':
      case 'X':
        onSkipFreeze?.();
        break;
      case 's':
      case 'S':
        snapshot(canvas, matchId, engine.state.tick);
        break;
      default: {
        // Player slots: 1-9 are slots 0-8, 0 is slot 10 (only in a
        // match that HAS ten slots — a 9-player match has no slot 9).
        let slot = -1;
        if (e.key >= '1' && e.key <= '9') slot = Number(e.key) - 1;
        else if (e.key === '0' && slotCount > 9) slot = 9;
        if (slot >= 0 && slot < slotCount) {
          lastSlot = slot;
          engine.setFollow(slot);
        }
      }
    }
  }

  // Pointer pan (drag) — grabbing the map clears follow so the camera is
  // free again. (The WHEEL is different: zooming keeps follow and scales
  // around the followed player — renderer zoomAt.)
  let panning = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e) {
    if (e.button !== 0) return;
    panning = true;
    lastX = e.clientX;
    lastY = e.clientY;
    if (engine.state.followSlot != null) engine.setFollow(null);
    canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!panning) return;
    renderer.panBy(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    renderer.draw();
  }

  function onPointerUp(e) {
    if (!panning) return;
    panning = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoomAt(
      e.deltaY < 0 ? 1.15 : 1 / 1.15,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    renderer.draw();
  }

  window.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return {
    detach() {
      offChange();
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
