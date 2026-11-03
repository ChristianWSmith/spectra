// M2 replay input: keyboard transport hotkeys + canvas pan/zoom.
//
// Key map: Space play/pause · , / . speed down/up · ← / → frame step ·
// Shift+← / → ±64 frames · L toggle loop · F toggle follow · 1-9 select
// (+follow) player slot · S snapshot PNG.

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

// attachReplayInput wires keys + pointer pan/wheel zoom; returns {detach}.
export function attachReplayInput({ canvas, engine, renderer, matchId, slotCount }) {
  let lastSlot = 0;

  function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName;
    return (
      tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable
    );
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e)) return;
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
      case 'l':
      case 'L':
        engine.toggleLoop();
        break;
      case 'f':
      case 'F':
        engine.setFollow(engine.state.followSlot == null ? lastSlot : null);
        break;
      case 's':
      case 'S':
        snapshot(canvas, matchId, engine.state.tick);
        break;
      default: {
        if (e.key >= '1' && e.key <= '9') {
          const slot = Number(e.key) - 1;
          if (slot < slotCount) {
            lastSlot = slot;
            engine.setFollow(slot);
          }
        }
      }
    }
  }

  // Pointer pan (drag) — grabbing the map clears follow so the camera is
  // free again.
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
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
