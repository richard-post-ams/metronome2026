/* =========================================================
   Master Metronome, mobile-first.
   State: bpm, subdivision, timeSig top/bottom, accent, transport,
          speed trainer, gap click.
   No polyrhythm, no timing analyzer, no mic.
   ========================================================= */

(function () {
  "use strict";

  /* ---------- State ---------- */
  const state = {
    bpm: 120,
    subdivision: "quarter", // 'quarter' | 'eighth' | 'sixteenth' | 'triplet'
    isPlaying: false,

    timeSigTop: 4,
    timeSigBottom: 4,
    accentEnabled: true,

    // Speed Trainer
    speedTrainerEnabled: false,
    speedStep: 2,
    speedEveryBars: 4,
    speedMax: 180,

    // Gap Click
    gapClickEnabled: false,
    gapPlayBars: 4,
    gapMuteBars: 2,
  };

  const BPM_MIN = 30;
  const BPM_MAX = 260;
  const TS_TOP_MIN = 1;
  const TS_TOP_MAX = 15;
  const TS_BOTTOM_VALUES = [1, 2, 4, 8, 16]; // standard note values
  const TAP_RESET_MS = 2000;
  const SCHEDULE_AHEAD_SEC = 0.1;
  const LOOKAHEAD_MS = 25;

  /* ---------- Audio ---------- */
  let audioCtx = null;
  let masterGain = null;
  let woodblockAccent = null; // AudioBuffer, louder velocity layer
  let woodblockNormal = null; // AudioBuffer, normal velocity layer
  let nextNoteTime = 0;
  let barBeatIndex = 0;   // 0..timeSigTop-1
  let subStepIndex = 0;   // 0..stepsPerBeat-1
  let currentBar = 1;     // 1-based bar counter
  let timerID = null;

  function initAudio() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(audioCtx.destination);

    // Pre-render two ultra-short woodblock samples.
    // Two velocity layers: accent (harder hit) and normal (softer hit).
    // No effects chain: buffers are played raw into masterGain.
    woodblockAccent = renderWoodblockBuffer(audioCtx, {
      pitch: 2200,      // Hz, higher for a harder stick strike
      durationSec: 0.045,
      amp: 1.0,
    });
    woodblockNormal = renderWoodblockBuffer(audioCtx, {
      pitch: 1500,      // Hz, lower body tone
      durationSec: 0.035,
      amp: 0.72,
    });
  }

  // Procedural woodblock: short noise transient + pitched body with
  // inharmonic partials, fast exponential decay. No filters, no reverb.
  function renderWoodblockBuffer(ctx, opts) {
    const sr = ctx.sampleRate;
    const length = Math.max(1, Math.floor(sr * opts.durationSec));
    const buffer = ctx.createBuffer(1, length, sr);
    const data = buffer.getChannelData(0);

    const twoPi = Math.PI * 2;
    const pitch = opts.pitch;
    const tau = opts.durationSec * 0.22; // decay time constant
    const transientSec = 0.0025;          // ~2.5 ms click onset

    let peak = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sr;
      const env = Math.exp(-t / tau);

      // Pitched wood body: fundamental + two inharmonic partials.
      const body =
        Math.sin(twoPi * pitch * t) * 1.0 +
        Math.sin(twoPi * pitch * 2.76 * t) * 0.28 +
        Math.sin(twoPi * pitch * 5.40 * t) * 0.12;

      // Brief noise burst shapes the initial strike.
      const nEnv = t < transientSec ? 1 - t / transientSec : 0;
      const noise = (Math.random() * 2 - 1) * nEnv;

      const sample = env * (body * 0.55 + noise * 0.9);
      data[i] = sample;
      const a = Math.abs(sample);
      if (a > peak) peak = a;
    }

    // Normalize so buffer tops out just under clip, then apply velocity amp.
    const norm = peak > 0 ? 0.95 / peak : 1;
    for (let i = 0; i < length; i++) data[i] *= norm * opts.amp;

    return buffer;
  }

  // Two velocity layers: accent on beat 1 of each bar, normal everywhere else.
  function scheduleClick(time, isAccent) {
    if (!audioCtx || !masterGain) return;
    const buf = isAccent ? woodblockAccent : woodblockNormal;
    if (!buf) return;

    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(masterGain); // direct, no effects
    src.start(time);
  }

  /* ---------- Scheduler ---------- */

  function stepsPerBeat() {
    switch (state.subdivision) {
      case "eighth": return 2;
      case "sixteenth": return 4;
      case "triplet": return 3;
      case "quarter":
      default: return 1;
    }
  }

  // True when the current bar is in the muted portion of a gap-click cycle.
  function isBarMuted(barNum) {
    if (!state.gapClickEnabled) return false;
    const total = state.gapPlayBars + state.gapMuteBars;
    if (total <= 0) return false;
    const idx = (barNum - 1) % total;
    return idx >= state.gapPlayBars;
  }

  function scheduleNotes() {
    if (!audioCtx) return;

    while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD_SEC) {
      // Recompute every iteration so BPM / subdivision changes apply quickly.
      const beatInterval = 60 / state.bpm;
      const steps = stepsPerBeat();
      const stepInterval = beatInterval / steps;

      const isBeatStart = subStepIndex === 0;
      const isDownbeat = isBeatStart && barBeatIndex === 0;
      const muted = isBarMuted(currentBar);

      // Audio: accent on beat 1 of each bar only, single click tone for
      // everything else (other beats AND subdivisions use the same tone).
      if (!muted) {
        const isAccent = isDownbeat && state.accentEnabled;
        scheduleClick(nextNoteTime, isAccent);
      }

      // Visual pulses always fire so the user can follow bars even when muted.
      const delayMs = Math.max(0, (nextNoteTime - audioCtx.currentTime) * 1000);
      scheduleVisualPulse(delayMs, isBeatStart, isDownbeat, muted);

      // Advance step.
      nextNoteTime += stepInterval;
      subStepIndex++;
      if (subStepIndex >= steps) {
        subStepIndex = 0;
        barBeatIndex++;
        if (barBeatIndex >= Math.max(1, state.timeSigTop)) {
          barBeatIndex = 0;
          currentBar++;
          handleBarAdvanced();
        }
      }
    }
  }

  function scheduler() {
    if (!state.isPlaying) return;
    scheduleNotes();
    timerID = setTimeout(scheduler, LOOKAHEAD_MS);
  }

  // Called when a new bar starts (currentBar just incremented).
  function handleBarAdvanced() {
    // Speed Trainer: bump BPM every N completed bars.
    if (state.speedTrainerEnabled) {
      const completedBars = currentBar - 1;
      if (completedBars > 0 && completedBars % state.speedEveryBars === 0) {
        const next = Math.min(state.speedMax, state.bpm + state.speedStep);
        if (next !== state.bpm) {
          setBpm(next);
          setSpeedStatus("Ramping: " + next + " BPM");
        } else {
          setSpeedStatus("Maxed at " + state.bpm + " BPM");
        }
      } else {
        const rem = state.speedEveryBars - (completedBars % state.speedEveryBars);
        setSpeedStatus("Next jump in " + rem + " bar" + (rem === 1 ? "" : "s"));
      }
    }

    // Gap Click: update status readout.
    if (state.gapClickEnabled) {
      const total = state.gapPlayBars + state.gapMuteBars;
      if (total > 0) {
        const idx = (currentBar - 1) % total;
        if (idx < state.gapPlayBars) {
          setGapStatus("Clicking (bar " + (idx + 1) + "/" + state.gapPlayBars + ")");
        } else {
          setGapStatus("Muted (bar " + (idx - state.gapPlayBars + 1) + "/" + state.gapMuteBars + ")");
        }
      }
    }
  }

  /* ---------- Visual pulse ---------- */
  const beatIndicatorEl = document.getElementById("beatIndicator");
  const subIndicatorEl = document.getElementById("subdivisionIndicator");
  const borderFlashEl = document.querySelector(".border-flash");

  function scheduleVisualPulse(delayMs, isBeatStart, isDownbeat, muted) {
    setTimeout(() => {
      if (isBeatStart) {
        beatIndicatorEl.classList.add("active");
        setTimeout(() => beatIndicatorEl.classList.remove("active"), 110);
        if (isDownbeat && !muted) {
          borderFlashEl.classList.add("active");
          setTimeout(() => borderFlashEl.classList.remove("active"), 120);
        }
      } else {
        subIndicatorEl.classList.add("active");
        setTimeout(() => subIndicatorEl.classList.remove("active"), 80);
      }
    }, delayMs);
  }

  /* ---------- Transport ---------- */
  const startStopBtn = document.getElementById("startStopBtn");
  const transportStatusEl = document.getElementById("transportStatus");
  const startLabelEl = startStopBtn.querySelector(".btn-label");

  function setTransportStatus(text) {
    transportStatusEl.textContent = text;
  }

  function start() {
    if (state.isPlaying) return;
    initAudio();
    if (audioCtx.state === "suspended") audioCtx.resume();

    barBeatIndex = 0;
    subStepIndex = 0;
    currentBar = 1;
    nextNoteTime = audioCtx.currentTime + 0.08;

    state.isPlaying = true;
    startStopBtn.setAttribute("aria-pressed", "true");
    startLabelEl.textContent = "Stop";
    setTransportStatus("Running " + state.bpm + " BPM");

    // Reset mode statuses so they reflect live state.
    if (state.speedTrainerEnabled) setSpeedStatus("Ramping from " + state.bpm + " BPM");
    if (state.gapClickEnabled) setGapStatus("Clicking (bar 1/" + state.gapPlayBars + ")");

    scheduler();
  }

  function stop() {
    state.isPlaying = false;
    if (timerID) { clearTimeout(timerID); timerID = null; }
    startStopBtn.setAttribute("aria-pressed", "false");
    startLabelEl.textContent = "Start";
    setTransportStatus("Stopped");
    if (state.speedTrainerEnabled) setSpeedStatus("Idle");
    if (!state.gapClickEnabled) setGapStatus("Playing always");
  }

  function toggleTransport() {
    if (state.isPlaying) stop();
    else start();
  }

  /* ---------- BPM UI ---------- */
  const bpmValueBtn = document.getElementById("bpmValueBtn");
  const bpmMinusBtn = document.getElementById("bpmMinus");
  const bpmPlusBtn = document.getElementById("bpmPlus");

  function setBpm(next) {
    const clamped = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(next)));
    state.bpm = clamped;
    refreshBpmDisplay();
    if (state.isPlaying) setTransportStatus("Running " + clamped + " BPM");
  }

  function enterBpmEdit() {
    if (bpmValueBtn.classList.contains("editing")) return;
    bpmValueBtn.classList.add("editing");

    const current = state.bpm;
    bpmValueBtn.innerHTML = "";

    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "numeric";
    input.pattern = "[0-9]*";
    input.min = String(BPM_MIN);
    input.max = String(BPM_MAX);
    input.value = String(current);

    bpmValueBtn.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const parsed = parseInt(input.value, 10);
      const next = isNaN(parsed) ? current : parsed;
      exitBpmEdit(next);
    };

    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); exitBpmEdit(current); }
    });
  }

  function exitBpmEdit(nextBpm) {
    bpmValueBtn.classList.remove("editing");
    bpmValueBtn.innerHTML = '<span id="bpmValue">' + String(state.bpm) + "</span>";
    setBpm(nextBpm);
  }

  function refreshBpmDisplay() {
    const el = document.getElementById("bpmValue");
    if (el) el.textContent = String(state.bpm);
  }

  /* ---------- Subdivision ---------- */
  const subButtons = Array.prototype.slice.call(document.querySelectorAll(".sub-btn"));

  function setSubdivision(next) {
    if (!["quarter", "eighth", "sixteenth", "triplet"].includes(next)) return;
    state.subdivision = next;

    subButtons.forEach((btn) => {
      const isActive = btn.dataset.sub === next;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-checked", isActive ? "true" : "false");
    });

    // If playing, re-anchor to the next clean beat so accent stays on beat 1.
    if (state.isPlaying && audioCtx) {
      const now = audioCtx.currentTime;
      const beatInterval = 60 / state.bpm;
      subStepIndex = 0;
      nextNoteTime = Math.max(now + 0.02, Math.min(nextNoteTime, now + beatInterval));
    }
  }

  /* ---------- Tap tempo ---------- */
  const tapBtn = document.getElementById("tapTempoBtn");
  const tapTimes = [];
  let lastTapAt = 0;

  function handleTap() {
    const now = performance.now();
    if (now - lastTapAt > TAP_RESET_MS) tapTimes.length = 0;
    tapTimes.push(now);
    lastTapAt = now;
    while (tapTimes.length > 6) tapTimes.shift();

    if (tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      setBpm(60000 / avg);
    }

    tapBtn.classList.add("active");
    setTimeout(() => tapBtn.classList.remove("active"), 120);
  }

  /* ---------- Time signature ---------- */
  const tsTopEl = document.getElementById("timeSigTop");
  const tsBotEl = document.getElementById("timeSigBottom");

  function setTimeSigTop(next) {
    const clamped = Math.max(TS_TOP_MIN, Math.min(TS_TOP_MAX, next));
    state.timeSigTop = clamped;
    tsTopEl.textContent = String(clamped);
    barBeatIndex = 0; // realign accent to new bar length
  }

  function setTimeSigBottom(next) {
    // Snap to nearest allowed note value.
    let value = TS_BOTTOM_VALUES[0];
    let minDelta = Math.abs(next - value);
    for (const v of TS_BOTTOM_VALUES) {
      const d = Math.abs(next - v);
      if (d < minDelta) { minDelta = d; value = v; }
    }
    state.timeSigBottom = value;
    tsBotEl.textContent = String(value);
  }

  function stepTimeSigBottom(direction) {
    const idx = TS_BOTTOM_VALUES.indexOf(state.timeSigBottom);
    const nextIdx = Math.max(0, Math.min(TS_BOTTOM_VALUES.length - 1, idx + direction));
    setTimeSigBottom(TS_BOTTOM_VALUES[nextIdx]);
  }

  /* ---------- Accent ---------- */
  const accentBtn = document.getElementById("accentBtn");

  function setAccent(enabled) {
    state.accentEnabled = enabled;
    accentBtn.textContent = enabled ? "On" : "Off";
    accentBtn.classList.toggle("active", enabled);
    accentBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  /* ---------- Speed Trainer ---------- */
  const speedStepEl = document.getElementById("speedStep");
  const speedEveryEl = document.getElementById("speedEveryBars");
  const speedMaxEl = document.getElementById("speedMax");
  const speedToggleBtn = document.getElementById("speedTrainerToggle");
  const speedSummaryEl = document.getElementById("speedTrainerSummary");
  const speedStatusEl = document.getElementById("speedTrainerStatus");

  function setSpeedStep(v)      { state.speedStep = clampInt(v, 1, 50); speedStepEl.textContent = String(state.speedStep); }
  function setSpeedEveryBars(v) { state.speedEveryBars = clampInt(v, 1, 64); speedEveryEl.textContent = String(state.speedEveryBars); }
  function setSpeedMax(v)       { state.speedMax = clampInt(v, BPM_MIN, BPM_MAX); speedMaxEl.textContent = String(state.speedMax); }

  function setSpeedTrainerEnabled(on) {
    state.speedTrainerEnabled = on;
    speedToggleBtn.textContent = on ? "On" : "Off";
    speedToggleBtn.classList.toggle("active", on);
    speedToggleBtn.setAttribute("aria-pressed", on ? "true" : "false");
    speedSummaryEl.textContent = on ? "On" : "Off";
    speedSummaryEl.classList.toggle("on", on);
    setSpeedStatus(on ? (state.isPlaying ? "Ramping from " + state.bpm + " BPM" : "Armed") : "Idle");
  }

  function setSpeedStatus(text) { speedStatusEl.textContent = text; }

  /* ---------- Gap Click ---------- */
  const gapPlayEl = document.getElementById("gapPlayBars");
  const gapMuteEl = document.getElementById("gapMuteBars");
  const gapToggleBtn = document.getElementById("gapClickToggle");
  const gapSummaryEl = document.getElementById("gapClickSummary");
  const gapStatusEl = document.getElementById("gapClickStatus");

  function setGapPlayBars(v) { state.gapPlayBars = clampInt(v, 1, 64); gapPlayEl.textContent = String(state.gapPlayBars); }
  function setGapMuteBars(v) { state.gapMuteBars = clampInt(v, 0, 64); gapMuteEl.textContent = String(state.gapMuteBars); }

  function setGapClickEnabled(on) {
    state.gapClickEnabled = on;
    gapToggleBtn.textContent = on ? "On" : "Off";
    gapToggleBtn.classList.toggle("active", on);
    gapToggleBtn.setAttribute("aria-pressed", on ? "true" : "false");
    gapSummaryEl.textContent = on ? "On" : "Off";
    gapSummaryEl.classList.toggle("on", on);
    setGapStatus(on ? "Clicking (bar 1/" + state.gapPlayBars + ")" : "Playing always");
  }

  function setGapStatus(text) { gapStatusEl.textContent = text; }

  /* ---------- Theme (dark default, light optional) ---------- */
  const themeToggleBtn = document.getElementById("themeToggleBtn");
  const THEME_KEY = "mm-theme";

  function readStoredTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === "light" ? "light" : "dark";
    } catch (_) {
      return "dark";
    }
  }

  function applyTheme(theme) {
    const t = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    if (themeToggleBtn) {
      themeToggleBtn.setAttribute("aria-pressed", t === "light" ? "true" : "false");
      themeToggleBtn.setAttribute(
        "aria-label",
        t === "light" ? "Switch to dark mode" : "Switch to light mode"
      );
    }
    // Match iOS status bar / PWA chrome to current theme.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "light" ? "#f4f6fb" : "#05070b");
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "light" ? "dark" : "light";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* ignore */ }
  }

  /* ---------- Helpers ---------- */
  function clampInt(n, min, max) {
    const parsed = typeof n === "number" ? n : parseInt(n, 10);
    if (isNaN(parsed)) return min;
    return Math.max(min, Math.min(max, Math.round(parsed)));
  }

  function attachHoldRepeat(btn, fn) {
    let holdTimeout = null;
    let intervalId = null;
    const start = () => {
      holdTimeout = setTimeout(() => { intervalId = setInterval(fn, 70); }, 400);
    };
    const clear = () => {
      if (holdTimeout) { clearTimeout(holdTimeout); holdTimeout = null; }
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    };
    btn.addEventListener("mousedown", start);
    btn.addEventListener("touchstart", start, { passive: true });
    btn.addEventListener("mouseup", clear);
    btn.addEventListener("mouseleave", clear);
    btn.addEventListener("touchend", clear);
    btn.addEventListener("touchcancel", clear);
  }

  /* ---------- Bindings ---------- */
  function bind() {
    // Theme toggle
    if (themeToggleBtn) themeToggleBtn.addEventListener("click", toggleTheme);

    // Transport
    startStopBtn.addEventListener("click", toggleTransport);

    // BPM stepper
    bpmMinusBtn.addEventListener("click", () => setBpm(state.bpm - 1));
    bpmPlusBtn.addEventListener("click", () => setBpm(state.bpm + 1));
    attachHoldRepeat(bpmMinusBtn, () => setBpm(state.bpm - 1));
    attachHoldRepeat(bpmPlusBtn, () => setBpm(state.bpm + 1));
    bpmValueBtn.addEventListener("click", enterBpmEdit);

    // Subdivision
    subButtons.forEach((btn) => {
      btn.addEventListener("click", () => setSubdivision(btn.dataset.sub));
    });

    // Time signature
    document.getElementById("tsTopMinus").addEventListener("click", () => setTimeSigTop(state.timeSigTop - 1));
    document.getElementById("tsTopPlus").addEventListener("click", () => setTimeSigTop(state.timeSigTop + 1));
    document.getElementById("tsBotMinus").addEventListener("click", () => stepTimeSigBottom(-1));
    document.getElementById("tsBotPlus").addEventListener("click", () => stepTimeSigBottom(1));

    // Accent + tap tempo
    accentBtn.addEventListener("click", () => setAccent(!state.accentEnabled));
    tapBtn.addEventListener("click", handleTap);

    // Speed Trainer
    document.getElementById("speedStepMinus").addEventListener("click", () => setSpeedStep(state.speedStep - 1));
    document.getElementById("speedStepPlus").addEventListener("click", () => setSpeedStep(state.speedStep + 1));
    document.getElementById("speedEveryMinus").addEventListener("click", () => setSpeedEveryBars(state.speedEveryBars - 1));
    document.getElementById("speedEveryPlus").addEventListener("click", () => setSpeedEveryBars(state.speedEveryBars + 1));
    document.getElementById("speedMaxMinus").addEventListener("click", () => setSpeedMax(state.speedMax - 1));
    document.getElementById("speedMaxPlus").addEventListener("click", () => setSpeedMax(state.speedMax + 1));
    attachHoldRepeat(document.getElementById("speedMaxMinus"), () => setSpeedMax(state.speedMax - 1));
    attachHoldRepeat(document.getElementById("speedMaxPlus"), () => setSpeedMax(state.speedMax + 1));
    speedToggleBtn.addEventListener("click", () => setSpeedTrainerEnabled(!state.speedTrainerEnabled));

    // Gap Click
    document.getElementById("gapPlayMinus").addEventListener("click", () => setGapPlayBars(state.gapPlayBars - 1));
    document.getElementById("gapPlayPlus").addEventListener("click", () => setGapPlayBars(state.gapPlayBars + 1));
    document.getElementById("gapMuteMinus").addEventListener("click", () => setGapMuteBars(state.gapMuteBars - 1));
    document.getElementById("gapMutePlus").addEventListener("click", () => setGapMuteBars(state.gapMuteBars + 1));
    gapToggleBtn.addEventListener("click", () => setGapClickEnabled(!state.gapClickEnabled));

    // Keyboard: spacebar toggles transport on desktop.
    document.addEventListener("keydown", (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.code === "Space") { e.preventDefault(); toggleTransport(); }
    });

    // Prevent iOS double-tap zoom.
    document.addEventListener("gesturestart", (e) => e.preventDefault());

    // PWA service worker.
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js").catch(() => {});
      });
    }
  }

  /* ---------- Init ---------- */
  function init() {
    // Apply persisted theme before any rendering so there is no flash.
    applyTheme(readStoredTheme());

    refreshBpmDisplay();
    tsTopEl.textContent = String(state.timeSigTop);
    tsBotEl.textContent = String(state.timeSigBottom);
    setAccent(state.accentEnabled);
    setSubdivision(state.subdivision);

    speedStepEl.textContent = String(state.speedStep);
    speedEveryEl.textContent = String(state.speedEveryBars);
    speedMaxEl.textContent = String(state.speedMax);
    setSpeedTrainerEnabled(state.speedTrainerEnabled);

    gapPlayEl.textContent = String(state.gapPlayBars);
    gapMuteEl.textContent = String(state.gapMuteBars);
    setGapClickEnabled(state.gapClickEnabled);

    bind();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
