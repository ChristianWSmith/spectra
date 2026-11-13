// frameprobe — the ADDITIVE frame-time measurement probe for the replay
// renderer (instrumentation only: it never touches the canvas, the engine
// state or the emitted ops, so a session with the probe disabled draws
// byte-identically to one without it).
//
// WHAT IT MEASURES — one session = one page load (`reset()` starts a new
// one without touching the on/off wiring):
//   draw     — the synchronous JS duration of ONE renderer draw() call:
//              the performance.now() delta around the draw body, i.e.
//              canvas COMMAND-EMIT time. Skia raster/compositing happens
//              after draw() returns and is therefore NOT in draw-ms.
//   frame    — rAF-to-rAF gaps from the engine's playback loop
//              (engine.js loop()): real display frame times — draw +
//              raster + Svelte DOM patch + compositor for that frame.
//              Gaps beyond FRAME_GAP_MAX_MS (250 ms — the same
//              tab-switch threshold loop()'s dt clamps) are resume gaps,
//              not frames: they are counted in `gaps`, never recorded.
//   longtask — PerformanceObserver('longtask') durations, feature-
//              detected: unsupported (WebKit support is uncertain) → no
//              observer is installed and the summary says `unsupported`
//              rather than a fake zero. Never throws either way.
//
// READING THE RENDER-PARALLELISM GATE: `frame` p95 vs the 16.7 ms budget,
// and `frame − draw` as the draw-vs-rest split (rest = raster + DOM patch
// + everything else the browser does between two rAF callbacks).
//
// HOW TO COLLECT NUMBERS (60-second GUI session):
//   1. ACTIVATE THE READOUT: start the app on a route whose query
//      carries `?probe=1` (e.g. #/replay/<id>?probe=1) — the gate is
//      probeEnabled() below (the ROUTER's already-parsed query, never a
//      second parser). The readout is the fixed top-right HUD strip
//      (App.svelte .probe-hud) showing `line()` refreshed once a
//      second — NO devtools needed, which matters because production
//      builds disable the WebKit inspector.
//      • PRODUCTION-BUILD ACTIVATION (no inspector exists to type a
//        hash into) — seed the window's initial hash from the env:
//          SPECTRA_START_HASH='#/?probe=1' ./spectra
//            arm at boot, then navigate normally — or deep-link straight
//            to a match: SPECTRA_START_HASH='#/replay/12?probe=1'
//            ./spectra. ANY #/... hash works — the session will pick
//            either shape (main.go initialURL: the seed must start with
//            "#"; empty/malformed/control bytes fall back to the stock
//            "/", so an unset or bad seed can never change startup).
//          The param rides the HASH query (location.hash → firstRoute),
//          and the LATCH below keeps it across every later navigation.
//          MEASUREMENT-VALIDITY BONUS: the session then runs the
//          PRODUCTION binary — the numbers come from the same minified
//          release JS users run, with no dev-build caveat.
//      • It LATCHES: once a route carries the param the strip stays up
//        for the session (nav.js rebuilds queries on navigation, so a
//        derived-only gate would drop it mid-measurement). Runtime
//        toggle from anywhere: __spectraFrameProbe.showHud = false / true.
//   2. play a replay for ~60 s          — frame samples only arrive while
//      the engine is PLAYING; draw samples also arrive while paused or
//      scrubbing (every draw() funnels through the one probe call site)
//   3. inspector path (devtools builds only): `__spectraFrameProbe.reset()`
//      for a fresh session, then `__spectraFrameProbe.dump()` — logs and
//      returns one line:
//        frame n=3600 p50=16.7 p95=17.0 p99=18.1 max=33.4 | draw n=3600
//        p50=2.1 p95=3.4 p99=5.0 max=12.3 | longtasks n=2 total=140.0ms
//        | gaps=0 | span=60123ms
//      (`summary()` = the same numbers as an object, `line()` = the
//      string without logging; a series with no samples prints n/a.)
//
// PERCENTILE BOOKKEEPING — exact over a capped window (no reservoir, no
// buckets): count/min/mean/max are incremental EXACT totals over the
// whole session; p50/p95/p99 are nearest-rank EXACT percentiles over a
// fixed ring of the most recent `cap` samples (default 4096 ≈ 68 s at
// 60 Hz — a 60 s session fits entirely, so every percentile is exact for
// the whole session; only LONGER sessions become "recent-window"
// percentiles, marked `windowed`: no sampling error, the oldest samples
// simply stop counting). Sorting happens only when you read
// (summary()/line()); recording is O(1) with no per-sample allocation.
//
// COST / ON-OFF STORY: collection is ALWAYS ON by default — per frame
// that is two performance.now() reads and O(1) ring writes (negligible).
// `__spectraFrameProbe.enabled = false` stops it: the draw call site
// then skips even its extra timestamp read, the record methods return
// before touching the clock, and the longtask observer (installed once
// at module load when the browser supports it) no-ops.

// The percentile window: 4096 samples ≈ 68 s of 60 Hz frames — a
// 60-second measurement session is fully inside it.
export const FRAME_PROBE_CAP = 4096;
// Resume-gap bound: a rAF gap beyond this is a tab-switch/background
// resume, not a frame (mirrors the dt clamp in engine.js loop()).
export const FRAME_GAP_MAX_MS = 250;

// probeEnabled — THE ?probe=1 gate for the on-screen readout: true only
// for the literal value "1" on an ALREADY-PARSED route query (router.js
// parseHash's generic query — this module never parses a URL itself,
// so there is exactly one query parser in the app). App.svelte latches
// its HUD on this at boot and on any later navigation carrying the
// param; without it the strip never renders.
export function probeEnabled(query) {
  return query != null && query.probe === '1';
}

const f1 = (v) => (v == null ? 'n/a' : v.toFixed(1));

// nearest-rank percentile over an ASCENDING array: index ceil(p·n/100) − 1
// (clamped) — exact, no interpolation, no buckets.
function nearestRank(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// createSeries — one measurement series (draw-ms or frame-ms): a fixed
// Float64Array ring of the last `cap` samples plus whole-session
// incremental totals. All state is closure-local (pure, injectable).
function createSeries(cap) {
  const size = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : FRAME_PROBE_CAP;
  const ring = new Float64Array(size);
  let count = 0;
  let filled = 0;
  let head = 0; // next write slot; once wrapped it is also the OLDEST sample
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  return {
    record(v) {
      count++;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      ring[head] = v;
      head = (head + 1) % size;
      if (filled < size) filled++;
    },
    clear() {
      count = 0;
      filled = 0;
      head = 0;
      sum = 0;
      min = Infinity;
      max = -Infinity;
    },
    summary() {
      if (count === 0) {
        // No samples → nulls, never a fabricated zero (count says why).
        return {
          count: 0,
          min: null,
          mean: null,
          p50: null,
          p95: null,
          p99: null,
          max: null,
          windowed: false,
        };
      }
      const start = filled === size ? head : 0; // oldest retained sample
      const win = new Array(filled);
      for (let i = 0; i < filled; i++) win[i] = ring[(start + i) % size];
      win.sort((a, b) => a - b);
      return {
        count,
        min,
        mean: sum / count,
        p50: nearestRank(win, 50),
        p95: nearestRank(win, 95),
        p99: nearestRank(win, 99),
        max,
        windowed: count > size,
      };
    },
  };
}

// createFrameProbe — a stats accumulator over an injectable monotonic
// clock (the tests drive `now`; production uses performance.now()).
export function createFrameProbe({
  cap = FRAME_PROBE_CAP,
  gapMaxMs = FRAME_GAP_MAX_MS,
  now = () => performance.now(),
} = {}) {
  const draws = createSeries(cap);
  const frames = createSeries(cap);
  let gaps = 0; // rejected frame samples (resume gaps / invalid values)
  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  let firstAt = null; // clock stamp of the first recorded sample
  let lastAt = null; // …and of the latest — span = last − first

  const touch = (t) => {
    if (firstAt == null) firstAt = t;
    lastAt = t;
  };

  const probe = {
    // ALWAYS ON by default (see the header); console: `__spectraFrameProbe.enabled = false`
    enabled: true,
    // The on-screen HUD's runtime toggle (App.svelte's 1 s tick reads
    // it): false hides the ?probe=1 strip without touching collection.
    showHud: true,
    // Set by installLongTaskTally when the browser supports
    // PerformanceObserver('longtask'); null = the tally measures nothing.
    longTaskObserver: null,

    // draw-ms: one call per renderer draw(). NaN/negative (impossible
    // with a monotonic clock) is dropped rather than poisoning the sums.
    recordDraw(ms) {
      if (!probe.enabled || !(ms >= 0)) return;
      touch(now());
      draws.record(ms);
    },

    // frame-ms: one call per engine playback rAF. Anything outside
    // [0, gapMaxMs] is not a frame — counted as a gap, not recorded.
    recordFrame(ms) {
      if (!probe.enabled) return;
      if (!(ms >= 0) || ms > gapMaxMs) {
        gaps++;
        return;
      }
      touch(now());
      frames.record(ms);
    },

    recordLongTask(ms) {
      if (!probe.enabled || !(ms >= 0)) return;
      touch(now());
      longTaskCount++;
      longTaskTotalMs += ms;
    },

    // reset() restarts the SAMPLES only: `enabled` and the longtask
    // observer are the probe's wiring and survive a session reset.
    reset() {
      draws.clear();
      frames.clear();
      gaps = 0;
      longTaskCount = 0;
      longTaskTotalMs = 0;
      firstAt = null;
      lastAt = null;
    },

    summarize() {
      return {
        enabled: probe.enabled,
        sessionMs: firstAt == null ? 0 : lastAt - firstAt,
        draws: draws.summary(),
        frames: frames.summary(),
        gaps,
        longtasks: {
          supported: probe.longTaskObserver != null,
          count: longTaskCount,
          totalMs: longTaskTotalMs,
        },
      };
    },

    line() {
      const s = probe.summarize();
      const seg = (name, x) =>
        `${name} n=${x.count} p50=${f1(x.p50)} p95=${f1(x.p95)} p99=${f1(x.p99)} max=${f1(x.max)}` +
        (x.windowed ? ' [windowed]' : '');
      const lt = s.longtasks.supported
        ? `longtasks n=${s.longtasks.count} total=${f1(s.longtasks.totalMs)}ms`
        : 'longtasks unsupported';
      return (
        `${seg('frame', s.frames)} | ${seg('draw', s.draws)} | ${lt}` +
        ` | gaps=${s.gaps} | span=${Math.round(s.sessionMs)}ms`
      );
    },

    // The human-facing dump: log the one-liner and hand it back.
    dump() {
      const out = probe.line();
      console.log(out);
      return out;
    },
  };
  return probe;
}

// installLongTaskTally — feature-detected, never throws: the observer is
// created only when the engine reports 'longtask' support (node does
// not, so tests see a plain no-op); an engine that reports support but
// refuses the observe() still lands in the catch and the tally stays
// `unsupported`. The callback no-ops while the probe is disabled.
function installLongTaskTally(probe) {
  try {
    if (typeof PerformanceObserver === 'undefined') return;
    const supported = PerformanceObserver.supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes('longtask')) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.recordLongTask(entry.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
    probe.longTaskObserver = observer;
  } catch {
    // Unsupported engine (WebKit among them): the tally reports
    // `unsupported` instead of a misleading 0. Never throw.
  }
}

// THE session singleton — one page load = one probe. Importing this
// module (engine.js, renderer.js and App.svelte's HUD gate all do)
// installs the longtask tally and publishes the ONE console-accessible
// exposure:
//   __spectraFrameProbe.reset() / .dump() / .line() / .summary() /
//   .enabled = false   (stop collecting) /
//   .showHud = false   (hide the ?probe=1 strip; see probeEnabled)
export const frameProbe = createFrameProbe();
installLongTaskTally(frameProbe);
globalThis.__spectraFrameProbe = frameProbe;
