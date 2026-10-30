const MiB = 1024 * 1024;

import * as bindings from "./bindings/webvprobe/index.js";
window.go = window.go || {};
window.go.webvprobe = bindings;

const out = document.getElementById("out");
const lines = [];

function log(html) {
    lines.push(html);
    out.innerHTML = lines.join("<br>");
    console.log("[webvprobe]", html.replace(/<[^>]+>/g, " "));
}

function res(ok, label, detail) {
    const cls = ok === true ? "ok" : ok === false ? "bad" : "warn";
    const mark = ok === true ? "PASS" : ok === false ? "FAIL" : "INFO";
    log(`<span class="${cls}">[${mark}] ${label}</span> — ${detail}`);
}

const encoder = new TextEncoder();

// Deterministic pattern matching Go: byte(i % 251)
function expectedByte(i) { return i % 251; }

function verifySlice(u8, offset) {
    for (let k = 0; k < u8.length; k++) {
        if (u8[k] !== expectedByte(offset + k)) return `mismatch at ${offset + k}: got ${u8[k]} want ${expectedByte(offset + k)}`;
    }
    return null;
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

// ---------- bonus quick checks (no gesture needed) ----------
function bonusChecks() {
    res(null, "UA", navigator.userAgent);
    res(typeof webkit !== "undefined" && !!webkit.messageHandlers,
        "window.webkit.messageHandlers", typeof webkit !== "undefined" ? Object.keys(webkit.messageHandlers || {}).join(",") || "present(empty)" : "webkit undefined");
    res(typeof OffscreenCanvas !== "undefined", "OffscreenCanvas", typeof OffscreenCanvas);
    // performance.now() resolution
    let min = Infinity, prev = performance.now();
    for (let i = 0; i < 20000; i++) {
        const t = performance.now();
        const d = t - prev;
        if (d > 0 && d < min) min = d;
        prev = t;
    }
    res(true, "performance.now() min delta", `${min.toFixed(6)} ms (resolution <= ${min.toExponential(2)} ms)`);
    res(typeof AudioContext !== "undefined", "AudioContext constructor present", typeof AudioContext);
    res(typeof webkitAudioContext !== "undefined", "webkitAudioContext present", typeof webkitAudioContext);
}

// ---------- structured clone between workers ----------
async function workerCloneTest() {
    return new Promise((resolve) => {
        const workerSrc = `
            self.onmessage = (e) => {
                const buf = e.data; // structured clone (not transferred)
                const u8 = new Uint8Array(buf);
                const okFirst = u8[0] === ${expectedByte(0)};
                const okLast = u8[u8.length - 1] === ${expectedByte(32 * 1024 * 1024 - 1)};
                // post back with transfer (so round-trip doesn't re-clone on the way home)
                self.postMessage({ len: buf.byteLength, okFirst, okLast }, [buf]);
            };
        `;
        const blob = new Blob([workerSrc], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        const w = new Worker(url);
        const buf = new ArrayBuffer(32 * MiB);
        const u8 = new Uint8Array(buf);
        for (let i = 0; i < u8.length; i++) u8[i] = expectedByte(i);
        const t0 = performance.now();
        w.onmessage = (e) => {
            const t1 = performance.now();
            w.terminate();
            URL.revokeObjectURL(url);
            const ms = t1 - t0;
            res(e.data.okFirst && e.data.okLast && e.data.len === 32 * MiB,
                "Worker structured clone 32 MiB (main→worker postMessage, no transfer)",
                `${ms.toFixed(1)} ms, ${(32 / (ms / 1000)).toFixed(0)} MB/s, verified=${e.data.okFirst && e.data.okLast}`);
            resolve();
        };
        w.postMessage(buf); // structured clone, no transfer list
    });
}

// ---------- transfer tests (bound call + asset server) ----------
async function transferTests() {
    // sanity: greeting call works
    try {
        const g = await window.go.webvprobe.GreetingService.Hello();
        res(g === "hi", "binding sanity Hello()", JSON.stringify(g));
    } catch (e) {
        res(false, "binding sanity Hello()", String(e));
        return;
    }

    // (a) bound method returning 32 MiB []byte (arrives as base64 string)
    try {
        const t0 = performance.now();
        const b64 = await window.go.webvprobe.ProbeService.GetData();
        const t1 = performance.now();
        const ms = t1 - t0;
        const approxBytes = b64.length; // base64 chars ≈ wire+decode payload size
        res(true, "Bound call ProbeService.GetData() [32 MiB []byte]",
            `${ms.toFixed(1)} ms, base64 len=${approxBytes} (~${(approxBytes / MiB).toFixed(1)} MB string), ${(32 / (ms / 1000)).toFixed(0)} MB/s (of raw bytes)`);
        // verify first/last after decode
        const t2 = performance.now();
        const u8 = base64ToBytes(b64);
        const t3 = performance.now();
        res(u8.length === 32 * MiB && u8[0] === expectedByte(0) && u8[u8.length - 1] === expectedByte(32 * MiB - 1),
            "Bound call payload verify (first/last byte + length)",
            `decode=${(t3 - t2).toFixed(1)} ms, len=${u8.length}, first=${u8[0]} (want ${expectedByte(0)}), last=${u8[u8.length - 1]} (want ${expectedByte(32 * MiB - 1)})`);
        const err = verifySlice(u8.subarray(0, 4096), 0) || verifySlice(u8.subarray(u8.length - 4096), u8.length - 4096);
        res(err === null, "Bound call 8 KiB sample verify", err || "first/last 4 KiB match pattern");
    } catch (e) {
        res(false, "Bound call ProbeService.GetData()", String(e && e.message || e));
    }

    // (b) asset server full 32 MiB fetch
    try {
        const t0 = performance.now();
        const resp = await fetch("/blob");
        const total = +(resp.headers.get("content-length") || 0);
        const buf = await resp.arrayBuffer();
        const t1 = performance.now();
        const ms = t1 - t0;
        const u8 = new Uint8Array(buf);
        res(resp.ok && u8.length === 32 * MiB && u8[0] === expectedByte(0) && u8[u8.length - 1] === expectedByte(32 * MiB - 1),
            "Asset-server fetch /blob (32 MiB, no Range)",
            `${ms.toFixed(1)} ms, ${(32 / (ms / 1000)).toFixed(0)} MB/s, status=${resp.status}, content-length=${total}, first=${u8[0]}, last=${u8[u8.length - 1]}`);
    } catch (e) {
        res(false, "Asset-server fetch /blob", String(e && e.message || e));
    }

    // (c) Range request: 1 MiB slice at offset 16 MiB
    try {
        const off = 16 * MiB, len = 1 * MiB;
        const t0 = performance.now();
        const resp = await fetch("/blob", { headers: { Range: `bytes=${off}-${off + len - 1}` } });
        const buf = await resp.arrayBuffer();
        const t1 = performance.now();
        const ms = t1 - t0;
        const u8 = new Uint8Array(buf);
        const err = resp.status === 206 ? verifySlice(u8, off) : `status=${resp.status} (expected 206)`;
        res(err === null,
            "Range fetch 1 MiB @ offset 16 MiB",
            `${ms.toFixed(1)} ms, ${(1 / (ms / 1000)).toFixed(0)} MB/s, status=${resp.status}, content-range=${resp.headers.get("content-range")}, verify=${err || "ok"}`);
    } catch (e) {
        res(false, "Range fetch", String(e && e.message || e));
    }
}

// ---------- audio tests ----------
async function audioTests(useGesture) {
    let ctx;
    try {
        ctx = new AudioContext();
        res(true, "new AudioContext()", `state=${ctx.state}, sampleRate=${ctx.sampleRate}`);
    } catch (e) {
        res(false, "new AudioContext()", String(e && e.message || e));
        return;
    }

    // resume attempt
    try {
        const p = ctx.resume();
        await Promise.race([p, new Promise(r => setTimeout(r, 1000))]);
        await new Promise(r => setTimeout(r, 100));
        res(ctx.state === "running", `resume() ${useGesture ? "WITH" : "WITHOUT"} user gesture`,
            `state after=${ctx.state}`);
    } catch (e) {
        res(false, `resume() ${useGesture ? "WITH" : "WITHOUT"} user gesture`, String(e && e.message || e));
    }

    if (ctx.state !== "running") {
        res(false, "oscillator render", "skipped: context not running");
        return;
    }

    // currentTime advance rate
    const c0 = ctx.currentTime;
    const w0 = performance.now();
    await new Promise(r => setTimeout(r, 500));
    const c1 = ctx.currentTime;
    const w1 = performance.now();
    const rate = (c1 - c0) / ((w1 - w0) / 1000);
    res(Math.abs(rate - 1) < 0.05, "audioCtx.currentTime advance rate",
        `${rate.toFixed(4)}× wall clock (Δctx=${(c1 - c0).toFixed(4)}s over wall ${(w1 - w0).toFixed(1)}ms)`);

    // oscillator → gain → analyser; confirm samples flow
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    osc.connect(gain).connect(analyser);
    const tStart = ctx.currentTime;
    osc.start(tStart);
    await new Promise(r => setTimeout(r, 200));
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    res(rms > 0.01, "oscillator→gain→analyser render (200 ms)",
        `RMS=${rms.toFixed(5)} (${rms > 0.01 ? "samples flowed" : "silent"})`);
    osc.stop();
    await new Promise(r => setTimeout(r, 50));

    // AudioBufferSourceNode.start(when) scheduling precision
    // Schedule 5 clicks (2 ms 1 kHz bursts) at 250 ms intervals; detect actual
    // onset via analyser peak scan. Block granularity on WebKitGTK ≈ 128 samples.
    const clickBuf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.002), ctx.sampleRate);
    const cd = clickBuf.getChannelData(0);
    for (let i = 0; i < cd.length; i++) cd[i] = Math.sin(2 * Math.PI * 1000 * i / ctx.sampleRate) * 0.9;

    const schedAnalyser = ctx.createAnalyser();
    schedAnalyser.fftSize = 2048;
    schedAnalyser.connect(ctx.destination); // analyser needs a sink? not required, but keep graph alive
    const schedGain = ctx.createGain();
    schedGain.gain.value = 1;
    schedGain.connect(schedAnalyser);

    const base = ctx.currentTime + 0.2;
    const offsets = [0, 0.25, 0.5, 0.75, 1.0];
    const scheduled = offsets.map(o => base + o);
    const sources = scheduled.map((when, idx) => {
        const src = ctx.createBufferSource();
        src.buffer = clickBuf;
        src.connect(schedGain);
        src.start(when);
        return src;
    });

    // poll analyser and record peak times
    const detections = [];
    const pollData = new Float32Array(schedAnalyser.fftSize);
    let nextIdx = 0;
    const wallStart = performance.now();
    const ctxAtStart = ctx.currentTime;
    while (nextIdx < scheduled.length && performance.now() - wallStart < 3000) {
        schedAnalyser.getFloatTimeDomainData(pollData);
        let peak = 0, peakI = 0;
        for (let i = 0; i < pollData.length; i++) {
            const a = Math.abs(pollData[i]);
            if (a > peak) { peak = a; peakI = i; }
        }
        if (peak > 0.3 && nextIdx < scheduled.length) {
            // approx time of this block's end is ctx.currentTime; peak is peakI samples before end
            const tDetect = ctx.currentTime - (pollData.length - peakI) / ctx.sampleRate;
            detections.push({ scheduled: scheduled[nextIdx], detected: tDetect });
            nextIdx++;
            // small delay so the click decays
            await new Promise(r => setTimeout(r, 60));
        } else {
            await new Promise(r => setTimeout(r, 10));
        }
    }
    sources.forEach(s => { try { s.stop(); } catch (_) {} });
    schedGain.disconnect();

    if (detections.length === 0) {
        res(false, "AudioBufferSourceNode.start(when) scheduling", "no click detected in 3 s");
    } else {
        const errs = detections.map(d => (d.detected - d.scheduled) * 1000);
        const maxAbs = Math.max(...errs.map(Math.abs));
        res(maxAbs < 20, `AudioBufferSourceNode.start(when) precision (${detections.length}/${scheduled.length} detected)`,
            `errors: ${errs.map(e => e.toFixed(1)).join(", ")} ms (max |err|=${maxAbs.toFixed(1)} ms; poll granularity ~±${(schedAnalyser.fftSize / ctx.sampleRate * 1000 / 2).toFixed(0)} ms)`);
    }

    ctx.close();
}

// ---------- export-capability checks (M5 MediaRecorder matrix, M2 frontend zstd) ----------
async function exportTests(useGesture) {
    // Compression Streams: which formats construct? (zstd expected missing — spec only
    // covers gzip/deflate/deflate-raw; sidecars are zstd → frontend must NOT rely on this)
    res(typeof DecompressionStream !== "undefined", "DecompressionStream present", typeof DecompressionStream);
    for (const fmt of ["gzip", "deflate", "deflate-raw", "zstd"]) {
        try {
            new DecompressionStream(fmt);
            res(true, `DecompressionStream('${fmt}')`, "constructs OK");
        } catch (e) {
            res(false, `DecompressionStream('${fmt}')`, String((e && e.message) || e));
        }
    }

    // MediaRecorder support matrix (Linux/WebKitGTK leg of M5's per-OS matrix)
    if (typeof MediaRecorder === "undefined") {
        res(false, "MediaRecorder", "missing");
        return;
    }
    res(true, "MediaRecorder present", typeof MediaRecorder);
    const mimes = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus",
        "video/webm;codecs=vp9", "video/webm;codecs=h264", "video/mp4;codecs=avc1"];
    for (const m of mimes) {
        res(null, `MediaRecorder.isTypeSupported('${m}')`, String(MediaRecorder.isTypeSupported(m)));
    }

    // Real encode roundtrip: oscillator → MediaStreamDestination → MediaRecorder → blob
    if (!useGesture) {
        res(null, "MediaRecorder record roundtrip", "skipped (needs gesture run for AudioContext)");
        return;
    }
    let ctx;
    try {
        ctx = new AudioContext();
        await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1000))]);
        if (ctx.state !== "running") {
            res(false, "MediaRecorder record roundtrip", `AudioContext ${ctx.state} — encoder not exercised`);
            return;
        }
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        osc.frequency.value = 440;
        const g = ctx.createGain();
        g.gain.value = 0.5;
        osc.connect(g).connect(dest);
        osc.start();
        const preferred = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"]
            .find(m => MediaRecorder.isTypeSupported(m));
        const rec = new MediaRecorder(dest.stream, preferred ? { mimeType: preferred } : undefined);
        const chunks = [];
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise(r => { rec.onstop = r; });
        rec.start();
        await new Promise(r => setTimeout(r, 600));
        rec.stop();
        await stopped;
        try { osc.stop(); } catch (_) {}
        const blob = new Blob(chunks, { type: rec.mimeType || preferred || "audio/webm" });
        res(blob.size > 0, `MediaRecorder encode roundtrip (${rec.mimeType || preferred || "default"})`,
            `600 ms tone → blob ${blob.size} bytes → encoder ${blob.size > 0 ? "WORKS" : "produced nothing"}`);
        ctx.close();
    } catch (e) {
        res(false, "MediaRecorder record roundtrip", String((e && e.message) || e));
        if (ctx) { try { ctx.close(); } catch (_) {} }
    }
}

async function runAll(withGesture) {
    log(`— — — run (${withGesture ? "user gesture" : "no gesture"}) — — —`);
    await audioTests(withGesture);
    await exportTests(withGesture);
    await workerCloneTest();
    await transferTests();
    log("— done —");
}

let autoDone = false;
let gestureRequested = false;
function maybeGestureRun() {
    if (autoDone) { runAll(true); }
    else { gestureRequested = true; log("— user gesture received (queued until auto-run finishes) —"); }
}
document.getElementById("run").addEventListener("click", maybeGestureRun);
document.addEventListener("click", (e) => {
    log(`— click at page (${e.clientX},${e.clientY}) target=${e.target.tagName} —`);
    maybeGestureRun();
});

// auto-run non-gesture checks on load
bonusChecks();
runAll(false).then(() => {
    autoDone = true;
    if (gestureRequested) runAll(true);
});
