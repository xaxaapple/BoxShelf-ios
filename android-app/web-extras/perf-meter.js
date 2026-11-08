// Android build only (copy-web.js puts it right after android-early.js; bottom.html loads it first too).
// A cheap work meter for the heat / efficiency checks: how often the page wakes up to draw, how long that takes on the
// main thread, how many WebGL draw calls it sends, and how much of it happens while nobody is touching anything.
// Only counters are bumped per call (no arrays, no timers of its own); BS_METER.snap() reads them out.
//   rafPerSec   animation-frame callbacks a second          frames      vsyncs where any callback ran
//   rafMsPerSec main-thread ms a second spent in them       draws       WebGL drawArrays / drawElements calls
//   idleFrames  frames that ran with no input for IDLE_MS (and the shelf not sliding): the number that should be 0
(function () {
  if (window.BS_METER) return;
  const IDLE_MS = 4000, now = () => performance.now();
  const c = { cb: 0, ms: 0, frames: 0, idleFrames: 0, draws: 0 }; let lastInput = now(), frameT = -1, t0 = now(), base = Object.assign({}, c);
  const busy = () => { try { return !!(window.BS_BUSY && window.BS_BUSY()); } catch { return false; } };
  // The idle state also pauses decoration: STILL_MS without input puts body.bs-still on (the halo and theme particles
  // stop, themefx.js stops its canvas), the next input takes it off. One timer at most, armed by input, none while idle.
  const STILL_MS = 5000; let stillT = 0;
  function still() { stillT = 0; const left = STILL_MS - (now() - lastInput); if (left > 50) { stillT = setTimeout(still, left); return; } if (document.body) document.body.classList.add('bs-still'); }
  const mark = () => { lastInput = now(); if (!stillT) { if (document.body) document.body.classList.remove('bs-still'); stillT = setTimeout(still, STILL_MS); } };
  stillT = setTimeout(still, STILL_MS);
  for (const e of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) addEventListener(e, mark, { capture: true, passive: true });
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (fn) {
    return raf(function (t) {
      if (t !== frameT) { frameT = t; c.frames++; if (now() - lastInput > IDLE_MS && !busy()) c.idleFrames++; }
      c.cb++; const s = now(); try { fn(t); } finally { c.ms += now() - s; }
    });
  };
  const wrap = P => { if (!P) return; for (const k of ['drawArrays', 'drawElements']) { const o = P[k]; if (o) P[k] = function () { c.draws++; return o.apply(this, arguments); }; } };
  wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype); wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  window.BS_METER = {
    input: mark,                                    // the pad reader calls this when a button or stick changes
    raf,                                            // the uncounted one (the Thor test meter's own loop isn't the app's work)
    counts: () => Object.assign({}, c),             // raw totals (the meter works out its own once-a-second rates)
    idle: () => now() - lastInput > IDLE_MS,
    idleFor: () => now() - lastInput,
    reset() { base = Object.assign({}, c); t0 = now(); },
    // counts since the last reset (or the page start), per second; anim = running CSS / Web animations right now
    snap(withAnims) {
      const s = Math.max(.001, (now() - t0) / 1000), d = k => c[k] - base[k];
      const o = { secs: +s.toFixed(1), rafPerSec: +(d('cb') / s).toFixed(1), framesPerSec: +(d('frames') / s).toFixed(1), rafMsPerSec: +(d('ms') / s).toFixed(1),
        drawsPerSec: +(d('draws') / s).toFixed(1), idleFrames: d('idleFrames'), idle: now() - lastInput > IDLE_MS };
      if (withAnims && document.getAnimations) { try { o.anims = document.getAnimations().filter(a => a.playState === 'running').length; } catch {} }
      return o;
    }
  };
})();
