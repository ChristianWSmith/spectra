// Event-handler error attribution for component frames — the half of
// 04 §4's known gap that needs no cooperation from the component:
// <svelte:boundary> never sees an error thrown by an event handler (the
// runtime rethrows it out of its delegated listener, and the webview
// reports it on window). Each frame marks itself as the dispatch's owner
// from a CAPTURE listener on its own element (capture runs before any
// handler inside it, delegated or direct); one window 'error' listener
// hands an error reported while a frame owns the dispatch to that frame
// and cancels the default report. Ownership ends when the event finishes
// bubbling to window, or on the next task for events that do not bubble
// or whose propagation a handler stopped.
//
// Errors from async work a component started (timers, promises) carry no
// dispatch and are routed by the read API's guard() instead.

// Every event type a component is likely to handle. A type missing here
// is not attributed (its error still reaches the console as before).
export const ATTRIBUTED_EVENTS = Object.freeze([
  'click', 'dblclick', 'auxclick', 'contextmenu',
  'input', 'change', 'beforeinput', 'submit', 'reset', 'invalid', 'select', 'toggle',
  'keydown', 'keyup', 'keypress',
  'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout',
  'pointerenter', 'pointerleave', 'pointercancel', 'gotpointercapture', 'lostpointercapture',
  'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
  'touchstart', 'touchend', 'touchmove', 'touchcancel',
  'focus', 'blur', 'focusin', 'focusout',
  'wheel', 'scroll',
  'dragstart', 'drag', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop',
  'copy', 'cut', 'paste',
  'load', 'error', 'animationend', 'transitionend',
]);

let owner = null; // the report fn of the frame owning the current dispatch
let installed = false;

function onWindowError(ev) {
  if (!owner) return;
  const report = owner;
  report(ev.error instanceof Error ? ev.error : new Error(ev.message || String(ev.error)));
  ev.preventDefault();
}

function release() {
  owner = null;
}

function install() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', onWindowError);
  // Bubble phase on window = after every handler of a bubbling event.
  // Not for 'error'/'load': window receives those itself (the reported
  // error IS an 'error' event on window), so they release on the timer.
  for (const t of ATTRIBUTED_EVENTS) {
    if (t !== 'error' && t !== 'load') window.addEventListener(t, release);
  }
}

// attachFrame makes `el`'s subtree report handler errors through
// `report`. Returns the detach function (an $effect cleanup).
export function attachFrame(el, report) {
  install();
  const claim = () => {
    owner = report;
    setTimeout(() => {
      if (owner === report) owner = null;
    }, 0);
  };
  for (const t of ATTRIBUTED_EVENTS) el.addEventListener(t, claim, true);
  return () => {
    for (const t of ATTRIBUTED_EVENTS) el.removeEventListener(t, claim, true);
    if (owner === report) owner = null;
  };
}
