// THE AudioContext resume retry — the one home for both replay engines
// (replay/audio.js voice, replay/sfx.js sound effects). The retry
// mechanics were verbatim duplicates in each engine; they exist exactly
// once here:
//   • gesture retry: document-level pointerdown/keydown CAPTURE
//     listeners re-attempt resume() on EVERY interaction while the
//     context is suspended — persistent until clear(), no pending flag,
//     no UI and no error while merely suspended (the autoplay policy is
//     not a failure; the sounds simply start on the first interaction,
//     or by themselves where the platform allows it);
//   • tryResume's RESUME_MS race: a resume() the autoplay policy blocks
//     may stay pending forever, so the race concludes "still suspended"
//     (NOT an error); a resume() that REJECTS propagates — the
//     rejecting resume IS the device failure, and the caller reports it
//     once with the GStreamer hint (replay/audio.js GST_AUDIO_HINT);
//   • the bounded gesture-free BACKOFF: while armed and suspended a
//     short capped timer ladder re-attempts resume() with NO user
//     action, so a first-AudioContext device-init race (GStreamer
//     pipeline warm-up) recovers by itself. It stops on clear()
//     (running / failure / destroy — including a reported device
//     failure, which refuses to re-arm) and at the attempt cap; no
//     playing gate, because cues never fire while paused and a context
//     granted while paused is a warm context for the next play. The
//     gesture listeners stay the guaranteed path — the backoff only
//     ever ADDS attempts.
// The engines own their OUTCOMES (onRunning / onClosed / onFailure) and
// their guard predicates (active / rearm); everything mechanical lives
// here — extending the retry means extending THIS module, never a third
// engine-local copy (AGENTS.md "One canonical way").

// A browser without a user gesture may keep ctx.resume()'s promise
// pending forever; race it against this timeout before concluding the
// context is still suspended (merely suspended is NOT a failure — see
// the engines' silent-retry contract).
export const RESUME_MS = 750;

// The gesture-free backoff ladder (see createResumeRetry): short at
// first — a device-init race usually recovers on an early retry — then
// widening; the CAP bounds the whole armed period (a fresh clear()
// resets it). After the cap the gesture listeners remain the only
// retry path — they always do.
const BACKOFF_LADDER_MS = [250, 500, 1000, 2000, 4000];
const BACKOFF_MAX_ATTEMPTS = 10;

// primeAudioContext constructs an AudioContext EARLY — the Replay calls
// this at load() entry, inside the opening click's user activation
// window, so the FIRST resume attempt is not born outside that window
// (the engines' contexts are otherwise constructed only after the cold
// bundle/sidecar load, by which point the window may have expired). One
// silent resume() is issued here: where the platform allows it the
// context is already running when the engine adopts it; a blocked or
// rejected first attempt is the ENGINE's to report and retry (it arms
// the full retry on construction). Never throws — a constructor failure
// resolves to null and the engine builds its own context.
export function primeAudioContext() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const c = new Ctx();
    try {
      Promise.resolve(c.resume()).catch(() => {});
    } catch {
      /* the engine's construction attempt reports it */
    }
    return c;
  } catch {
    return null;
  }
}

// tryResume calls ctx.resume() SYNCHRONOUSLY (a retry listener must
// invoke it inside the user gesture) and resolves to whether the
// context ended up running. resume()'s own promise may stay pending
// forever when autoplay is blocked, so it is raced against RESUME_MS —
// the loser is already subscribed by Promise.race (no hang, no
// unhandled rejection). A resume() that REJECTS propagates. A lost race
// resolves to the running check — "still suspended", which is NOT an
// error.
function tryResume(ctx) {
  if (!ctx) return Promise.resolve(false);
  if (ctx.state === 'running') return Promise.resolve(true);
  let p;
  try {
    p = Promise.resolve(ctx.resume());
  } catch (e) {
    return Promise.reject(e);
  }
  const timeout = new Promise((r) => setTimeout(() => r(undefined), RESUME_MS));
  return Promise.race([p, timeout]).then(() => !!ctx && ctx.state === 'running');
}

// createResumeRetry builds ONE engine's retry controller:
//   getCtx   — () => AudioContext | null (the engine's live context)
//   active   — () => boolean — the engine still wants audio; guards
//              every attempt and every arm (destroy / enable withdrawn)
//   rearm    — () => boolean — may a merely-suspended result arm the
//              retry again? (sfx: never after a reported failure; the
//              voice engine has no such state)
//   onRunning(alreadyRunning) — the context is running: `true` when it
//              was already running when the attempt began, `false` when
//              THIS resume brought it up (the voice engine re-anchors
//              unconditionally on the entry branch but not on a stale
//              retry landing after the engine is already up clean)
//   onClosed — the context closed mid-flight (destroy ran)
//   onFailure(state) — resume() REJECTED: the device is broken; the
//              engine reports it exactly once (its own fail path)
// Returns { attempt, arm, clear }: attempt is ONE silent resume attempt
// (fire-and-forget — races RESUME_MS, never throws), arm parks the
// gesture listeners plus the next backoff attempt, clear tears
// everything down (running / failure / destroy). No pending flag, no UI,
// no error while merely suspended.
export function createResumeRetry({ getCtx, active, rearm = () => true, onRunning, onClosed, onFailure }) {
  let off = null; // tears down the parked gesture listeners
  let timer = null; // one pending backoff attempt
  let attempts = 0; // backoff attempts scheduled since the last clear

  function clear() {
    if (off) {
      off();
      off = null;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    attempts = 0;
  }

  // installGesture parks document-level pointerdown/keydown capture
  // listeners that retry the resume on EVERY interaction while the
  // context is suspended — persistent, not one-time: they stay until
  // clear() runs (context running, engine failed or destroyed).
  function installGesture() {
    if (off || typeof document === 'undefined' || !document.addEventListener) return;
    const handler = () => attempt();
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
    off = () => {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }

  // scheduleBackoff arms ONE gesture-free attempt on the capped ladder
  // — idempotent (a pending timer or an exhausted cap arms nothing) and
  // silent: merely suspended is not a failure, so this never reports
  // anything.
  function scheduleBackoff() {
    if (timer || attempts >= BACKOFF_MAX_ATTEMPTS) return;
    const ctx = getCtx();
    if (!active() || !ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    const delay = BACKOFF_LADDER_MS[Math.min(attempts, BACKOFF_LADDER_MS.length - 1)];
    attempts++;
    timer = setTimeout(() => {
      timer = null;
      attempt();
    }, delay);
  }

  function arm() {
    installGesture();
    scheduleBackoff();
  }

  // attempt — ONE silent resume attempt: running → the retry listeners
  // come down; still suspended → keep them and stay SILENT; a REJECTED
  // resume() → the device is broken, the engine reports it once (the
  // only error either engine ever surfaces for audio).
  function attempt() {
    const ctx = getCtx();
    if (!active() || !ctx) return;
    if (ctx.state === 'running') {
      clear();
      if (onRunning) onRunning(true);
      return;
    }
    tryResume(ctx).then(
      (ok) => {
        const c = getCtx();
        if (!active() || !c) return;
        if (ok) {
          clear();
          if (onRunning) onRunning(false);
          return;
        }
        if (c.state === 'closed') {
          clear(); // destroy closed it mid-flight
          if (onClosed) onClosed();
          return;
        }
        // Merely suspended — silent; the retry stays armed unless the
        // engine refuses to re-arm (a reported device failure must
        // never re-arm the listeners after the fact).
        if (rearm()) arm();
      },
      () => {
        if (!active() || !getCtx()) return;
        clear(); // a rejection is terminal: never re-arm
        if (onFailure) onFailure(getCtx().state);
      },
    );
  }

  return { attempt, arm, clear };
}
