"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const V = "phasle:v3"; // bump when tiers change shape, so old saves don't replay onto new puzzles

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode: progress just won't persist */
      }
    },
  };

  // ---------- theme colours for canvas ----------

  const colors = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const name of ["ink", "muted", "faint", "line", "trace", "good", "surface", "mono"]) {
      colors[name] = cs.getPropertyValue(`--${name}`).trim();
    }
  }
  readColors();

  // ---------- guess matching ----------

  const norm = (s) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  // Right or wrong, nothing in between: the reconstruction is the only clue.
  function isCorrect(text, secret) {
    const g = norm(text);
    const has = (phrase) => ` ${g} `.includes(` ${norm(phrase)} `);
    return norm(secret.answer) === g || secret.accept.some((a) => norm(a) === g) || secret.contains.some(has);
  }

  const unwrap = (b64) =>
    JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));

  // ---------- days ----------

  function localDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function dayIndex(epoch) {
    const override = new URLSearchParams(location.search).get("day");
    if (override && /^\d+$/.test(override)) return Math.max(0, Number(override) - 1);
    const [y, m, d] = epoch.split("-").map(Number);
    return Math.max(0, Math.round((localDay(new Date()) - new Date(y, m - 1, d)) / 864e5));
  }

  function dayLabel(epoch, idx) {
    const [y, m, d] = epoch.split("-").map(Number);
    return new Date(y, m - 1, d + idx).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  // ---------- Fourier series of a closed curve ----------

  // In-place radix-2 FFT; length must be a power of two. inverse skips the 1/N.
  function fft(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inverse ? 2 : -2) * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k;
          const b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = t;
        }
      }
    }
  }

  // Terms sorted biggest circle first. err[n-1] is the % error left after keeping n terms:
  // RMS distance from the true pen at the same t, over the RMS distance of the true pen from
  // the centre (so drawing nothing is 100%). By Parseval that is sqrt(dropped energy / total).
  function fourier(points) {
    const N = points.length;
    const re = Float64Array.from(points, (p) => p[0]);
    const im = Float64Array.from(points, (p) => p[1]);
    fft(re, im);
    const terms = [];
    for (let i = 1; i < N; i++) {
      const cr = re[i] / N;
      const ci = im[i] / N;
      terms.push({ k: i < N / 2 ? i : i - N, re: cr, im: ci, r: Math.hypot(cr, ci), phase: Math.atan2(ci, cr) });
    }
    terms.sort((a, b) => b.r - a.r);
    const total = terms.reduce((s, t) => s + t.r * t.r, 0);
    let kept = 0;
    const err = terms.map((t) => {
      kept += t.r * t.r;
      return 100 * Math.sqrt(Math.max(0, 1 - kept / total));
    });
    return { N, c0: [re[0] / N, im[0] / N], terms, err };
  }

  // The curve drawn by the n biggest terms, sampled at the original N points.
  function curveFor(f, n) {
    const re = new Float64Array(f.N);
    const im = new Float64Array(f.N);
    [re[0], im[0]] = f.c0;
    for (let j = 0; j < n; j++) {
      const t = f.terms[j];
      const idx = (t.k + f.N) % f.N;
      re[idx] = t.re;
      im[idx] = t.im;
    }
    fft(re, im, true);
    const pts = new Float64Array(2 * f.N);
    for (let s = 0; s < f.N; s++) {
      pts[2 * s] = re[s];
      pts[2 * s + 1] = im[s];
    }
    return pts;
  }

  // One trip of the pen: quick for a lone circle, slower once there are borders to follow.
  const lapMs = (n) => Math.min(12000, 3500 + 1200 * Math.log2(Math.max(1, n)));

  // ---------- shape view: epicycles tracing the curve ----------

  class ShapeView {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.raf = 0;
      new ResizeObserver(() => this.resize()).observe(canvas);
    }

    setData(points, f) {
      this.f = f;
      let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const [x, y] of points) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      this.bounds = { x0, x1, y0, y1 };
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.cv.clientWidth;
      const h = this.cv.clientHeight;
      if (!w || !h) return;
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w;
      this.h = h;
      if (this.bounds) {
        const b = this.bounds;
        const pad = 0.08;
        this.scale = Math.min((w * (1 - 2 * pad)) / (b.x1 - b.x0), (h * (1 - 2 * pad)) / (b.y1 - b.y0));
        this.ox = w / 2 - ((b.x0 + b.x1) / 2) * this.scale;
        this.oy = h / 2 - ((b.y0 + b.y1) / 2) * this.scale;
      }
      if (this.curve) this.frame(performance.now());
    }

    show(n, { ghost = 0, final = false } = {}) {
      this.n = n;
      this.curve = curveFor(this.f, n);
      this.ghost = ghost ? curveFor(this.f, ghost) : null;
      this.final = final;
      this.lap = lapMs(n);
      this.restart();
    }

    restart() {
      this.t0 = performance.now();
      this.resume();
    }

    resume() {
      cancelAnimationFrame(this.raf);
      const tick = (now) => {
        this.frame(now);
        if (!reduceMotion && !document.hidden) this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }

    stop() {
      cancelAnimationFrame(this.raf);
    }

    path(pts, count) {
      const { ctx } = this;
      ctx.beginPath();
      for (let s = 0; s < count; s++) {
        const X = this.ox + pts[2 * s] * this.scale;
        const Y = this.oy + pts[2 * s + 1] * this.scale;
        if (s === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      }
    }

    frame(now) {
      const { ctx, w, h } = this;
      if (!w || !this.curve) return;
      const p = reduceMotion ? 1 : (now - this.t0) / this.lap;
      const samples = this.curve.length / 2;
      ctx.clearRect(0, 0, w, h);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      if (this.ghost) {
        this.path(this.ghost, samples);
        ctx.closePath();
        ctx.strokeStyle = colors.faint;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      const done = p >= 1;
      this.path(this.curve, done ? samples : Math.max(1, Math.floor(p * samples)));
      if (done) ctx.closePath();
      ctx.strokeStyle = this.final ? colors.good : colors.trace;
      ctx.lineWidth = this.n > 60 ? 1.5 : 2.2;
      ctx.stroke();

      // Epicycles: the pen keeps riding the curve after the first lap.
      const t = 2 * Math.PI * (reduceMotion ? 0 : p);
      let x = this.f.c0[0];
      let y = this.f.c0[1];
      ctx.lineWidth = 1;
      for (let j = 0; j < this.n; j++) {
        const term = this.f.terms[j];
        const ang = term.k * t + term.phase;
        const nx = x + term.r * Math.cos(ang);
        const ny = y + term.r * Math.sin(ang);
        const R = term.r * this.scale;
        if (j < 80 && R > 0.6) {
          const X = this.ox + x * this.scale;
          const Y = this.oy + y * this.scale;
          ctx.beginPath();
          ctx.arc(X, Y, R, 0, 2 * Math.PI);
          ctx.strokeStyle = colors.muted;
          ctx.globalAlpha = 0.22;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(X, Y);
          ctx.lineTo(this.ox + nx * this.scale, this.oy + ny * this.scale);
          ctx.globalAlpha = 0.7;
          ctx.strokeStyle = colors.ink;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        x = nx;
        y = ny;
      }
      ctx.beginPath();
      ctx.arc(this.ox + x * this.scale, this.oy + y * this.scale, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = this.final ? colors.good : colors.trace;
      ctx.fill();
    }
  }

  // ---------- song view: waveform and spectrum of the kept terms ----------

  class SongView {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      new ResizeObserver(() => this.resize()).observe(canvas);
    }

    setData(puzzle, viz) {
      const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      this.duration = puzzle.duration;
      this.viz = viz;
      this.env = viz.env.map((b) => new Int8Array(bytes(b).buffer));
      this.spec = viz.spec.map(bytes);
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.cv.clientWidth;
      const h = this.cv.clientHeight;
      if (!w || !h) return;
      this.dpr = dpr;
      this.w = w;
      this.h = h;
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
      if (this.i != null) this.draw(null);
    }

    // i indexes the tiers; one past the last tier is the original recording.
    show(i) {
      this.i = i;
      this.draw(null);
    }

    draw(time) {
      const { ctx, w, h } = this;
      if (!w || !this.viz || this.i == null) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.font = `10.5px ${colors.mono || "monospace"}`;
      ctx.textBaseline = "top";

      const specH = 46;
      const top = 26;
      const waveH = h - top - specH - 60;
      const mid = top + waveH / 2;
      const amp = waveH / 2 / 127;
      const { cols, bins, fmin, fmax } = this.viz;
      const env = this.env[this.i];
      const playX = time == null ? w : (time / this.duration) * w;
      const bw = w / cols + 0.4;

      ctx.fillStyle = colors.faint;
      ctx.fillText("waveform", 12, 9);
      ctx.fillStyle = colors.trace;
      for (const bright of [true, false]) {
        ctx.globalAlpha = bright ? 1 : 0.28;
        for (let c = 0; c < cols; c++) {
          const x = (c / cols) * w;
          if (x < playX !== bright) continue;
          const lo = env[2 * c];
          const hi = env[2 * c + 1];
          ctx.fillRect(x, mid - hi * amp, bw, Math.max(1, (hi - lo) * amp));
        }
      }
      ctx.globalAlpha = 1;
      if (time != null) {
        ctx.fillStyle = colors.ink;
        ctx.fillRect(playX, top - 4, 1.5, waveH + 8);
      }

      // Spectrum: grey is the whole song, colour is what this tier keeps.
      const base = h - 30;
      ctx.fillStyle = colors.faint;
      ctx.fillText("spectrum of kept terms", 12, base - specH - 16);
      const full = this.spec[this.spec.length - 1];
      const kept = this.spec[this.i];
      const sw = w / bins;
      for (let b = 0; b < bins; b++) {
        const x = b * sw;
        ctx.fillStyle = colors.line;
        ctx.fillRect(x, base - (full[b] / 255) * specH, sw + 0.3, (full[b] / 255) * specH);
        if (kept[b]) {
          ctx.fillStyle = colors.trace;
          ctx.fillRect(x, base - (kept[b] / 255) * specH, sw + 0.3, (kept[b] / 255) * specH);
        }
      }
      ctx.fillStyle = colors.line;
      ctx.fillRect(0, base, w, 1);
      ctx.fillStyle = colors.faint;
      for (const [f, label] of [[100, "100 Hz"], [1000, "1 kHz"], [10000, "10 kHz"]]) {
        const x = (Math.log(f / fmin) / Math.log(fmax / fmin)) * w;
        ctx.fillRect(x, base, 1, 4);
        ctx.fillText(label, Math.min(x - 14, w - 46), base + 7);
      }
    }
  }

  // ---------- audio ----------

  class Player {
    constructor() {
      this.ctx = null;
      this.raw = new Map();
      this.decoded = new Map();
      this.src = null;
    }

    prefetch(url) {
      if (!this.raw.has(url)) this.raw.set(url, fetch(url).then((r) => r.arrayBuffer()));
      return this.raw.get(url);
    }

    async buffer(url) {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (!this.decoded.has(url)) {
        this.decoded.set(url, this.prefetch(url).then((ab) => this.ctx.decodeAudioData(ab.slice(0))));
      }
      return this.decoded.get(url);
    }

    async play(url, onEnd) {
      this.stop();
      const buf = await this.buffer(url);
      if (this.ctx.state === "suspended") await this.ctx.resume();
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.onended = () => {
        if (this.src === src) {
          this.src = null;
          onEnd?.();
        }
      };
      src.start();
      this.src = src;
      this.startedAt = this.ctx.currentTime;
      this.duration = buf.duration;
    }

    stop() {
      if (this.src) {
        const s = this.src;
        this.src = null;
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      }
    }

    get playing() {
      return !!this.src;
    }

    get time() {
      return this.src ? Math.min(this.duration, this.ctx.currentTime - this.startedAt) : 0;
    }
  }

  // ---------- formatting ----------

  const pct = (e) => `${e.toFixed(1)}%`;
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const full = (n) => n.toLocaleString("en-US");
  const compact = (n) => (n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`);

  function shapeEquation(f, n) {
    const parts = f.terms.slice(0, Math.min(n, 2)).map((t) => {
      const kt = t.k === 1 ? "t" : t.k === -1 ? "−t" : `${t.k < 0 ? "−" : ""}${Math.abs(t.k)}t`;
      const ph = `${t.phase < 0 ? "−" : "+"}${Math.abs(t.phase).toFixed(2)}`;
      return `${t.r.toFixed(2)}e<sup>i(${kt}${ph})</sup>`;
    });
    const more = n > 2 ? ` + … (${full(n)} terms)` : "";
    return `z(t) = ${parts.join(" + ")}${more}`;
  }

  const songEquation = (k) =>
    `x(t) = Σ<sub>j=1</sub><sup>${full(k)}</sup> A<sub>j</sub> cos(2πf<sub>j</sub>t + φ<sub>j</sub>)`;

  // ---------- game ----------

  const els = {
    stage: $("stage"),
    songPanel: $("song-panel"),
    label: $("puzzle-label"),
    date: $("puzzle-date"),
    rTier: $("r-tier"),
    rTerms: $("r-terms"),
    rErr: $("r-err"),
    errCover: $("errbar-cover"),
    equation: $("equation"),
    tiers: $("tiers"),
    form: $("guess-form"),
    input: $("guess-input"),
    skip: $("skip-btn"),
    skipNote: $("skip-note"),
    suggestions: $("suggestions"),
    history: $("history"),
    result: $("result"),
    kicker: $("result-kicker"),
    answer: $("result-answer"),
    detail: $("result-detail"),
    share: $("share-btn"),
    original: $("original-btn"),
    credit: $("credit"),
    countdown: $("countdown"),
    play: $("play-btn"),
    playerTitle: $("player-title"),
    playerTime: $("player-time"),
    scrub: $("scrub-fill"),
    toast: $("toast"),
  };

  const shapeView = new ShapeView($("shape-canvas"));
  const songView = new SongView($("song-canvas"));
  const player = new Player();

  let data;
  let day;
  let mode = "shape";
  const games = {};

  const MARK = { good: "✓", bad: "✕", skip: "–" };
  const EMOJI = { good: "🟩", bad: "🟥", skip: "⬛" };
  const UNIT = { shape: ["circle", "circles"], song: ["sine wave", "sine waves"] };
  const unit = (m, n) => UNIT[m][n === 1 ? 0 : 1];

  function toast(msg, ms = 1800) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove("show"), ms);
  }

  const puzzleFor = (m) => data[m][day % data[m].length];
  const saveKey = (m) => `${V}:${m}:${day + 1}:${puzzleFor(m).id}`;

  async function loadGame(m) {
    if (games[m]) return games[m];
    const puzzle = puzzleFor(m);
    const g = {
      mode: m,
      puzzle,
      key: saveKey(m),
      secret: unwrap(puzzle.secret),
      state: store.get(saveKey(m), { guesses: [], done: false, won: false, counted: false }),
      tiers: puzzle.tiers,
      view: null,
    };
    if (m === "shape") {
      g.points = (await (await fetch(puzzle.file)).json()).points;
      g.f = fourier(g.points);
      g.errors = g.tiers.map((n) => g.f.err[n - 1]);
    } else {
      g.viz = await (await fetch(`${puzzle.dir}/viz.json`)).json();
      g.errors = puzzle.errors;
    }
    games[m] = g;
    return g;
  }

  const currentTier = (g) => (g.state.done ? (g.state.won ? g.state.guesses.length - 1 : g.tiers.length - 1) : g.state.guesses.length);
  const revealedUpTo = (g) => (g.state.done ? g.tiers.length - 1 : g.state.guesses.length);

  function save(g) {
    store.set(g.key, g.state);
  }

  const emptyStats = (m) => ({ played: 0, won: 0, streak: 0, maxStreak: 0, last: null, dist: Array(data.targets[m].length).fill(0) });

  function countResult(g) {
    if (g.state.counted) return;
    const key = `${V}:stats:${g.mode}`;
    const s = store.get(key, emptyStats(g.mode));
    s.played += 1;
    if (g.state.won) {
      s.won += 1;
      s.dist[g.state.guesses.length - 1] += 1;
      s.streak = s.last === day - 1 ? s.streak + 1 : 1;
    } else {
      s.streak = 0;
    }
    s.maxStreak = Math.max(s.maxStreak, s.streak);
    s.last = day;
    store.set(key, s);
    g.state.counted = true;
    save(g);
  }

  const songUrl = (g, view) => `${g.puzzle.dir}/${view === "orig" ? "full" : `t${view + 1}`}.mp3`;

  // What the stage shows: a tier index, or "orig" for the full picture / original song.
  function setView(g, view, { autoplay = false } = {}) {
    g.view = view;
    const isOrig = view === "orig";
    if (g.mode === "shape") {
      const n = isOrig ? g.f.terms.length : g.tiers[view];
      shapeView.show(n, { ghost: !isOrig && view > 0 ? g.tiers[view - 1] : 0, final: isOrig });
      readout(isOrig ? "Full picture" : `Tier ${view + 1}/${g.tiers.length}`, `${full(n)} ${unit("shape", n)}`, isOrig ? 0 : g.errors[view]);
      els.equation.innerHTML = shapeEquation(g.f, n);
    } else {
      player.stop();
      const k = isOrig ? g.puzzle.terms_total : g.tiers[view];
      songView.show(isOrig ? g.tiers.length : view);
      readout(isOrig ? "Original" : `Tier ${view + 1}/${g.tiers.length}`, `${full(k)} ${unit("song", k)}`, isOrig ? 0 : g.errors[view]);
      els.equation.innerHTML = isOrig ? `x(t) = the real recording (${full(k)} terms)` : songEquation(k);
      els.playerTitle.textContent = isOrig ? `${g.secret.answer} · original` : `Tier ${view + 1} · ${full(k)} sine waves`;
      els.playerTime.textContent = `0:00 / ${mmss(g.puzzle.duration)}`;
      els.scrub.style.width = "0";
      els.play.classList.remove("playing");
      player.prefetch(songUrl(g, view));
      if (autoplay) togglePlay();
    }
    renderTiers(g);
  }

  function readout(tier, terms, err) {
    els.rTier.textContent = tier;
    els.rTerms.textContent = terms;
    els.rErr.textContent = `${pct(err)} error`;
    els.errCover.style.width = `${100 - Math.min(100, err)}%`;
  }

  function renderTiers(g) {
    const cur = currentTier(g);
    const upto = revealedUpTo(g);
    els.tiers.style.setProperty("--n", g.tiers.length);
    els.tiers.replaceChildren(
      ...g.tiers.map((n, i) => {
        const li = document.createElement("li");
        const guess = g.state.guesses[i];
        if (guess) li.classList.add(guess.type);
        if (!g.state.done && i === cur) li.classList.add("current");
        if (g.view === i) li.classList.add("viewing");
        const b = document.createElement("button");
        b.type = "button";
        b.disabled = i > upto;
        b.innerHTML = `<span class="t-n">${compact(n)}</span><span class="t-e">${i <= upto ? pct(g.errors[i]) : `~${data.targets[g.mode][i]}%`}</span>`;
        b.setAttribute("aria-label", `Tier ${i + 1}: ${full(n)} terms${i <= upto ? `, ${pct(g.errors[i])} error` : ", locked"}`);
        b.addEventListener("click", () => setView(g, i));
        li.append(b);
        return li;
      }),
    );
  }

  function render(g) {
    const { state } = g;
    const modeName = g.mode === "shape" ? "Shape" : "Song";
    els.label.textContent = `${modeName} #${day + 1}`;
    els.date.textContent = dayLabel(data.epoch, day);
    els.stage.classList.toggle("song", g.mode === "song");
    els.songPanel.hidden = g.mode !== "song";
    $("replay-btn").hidden = g.mode !== "shape";

    els.suggestions.replaceChildren(
      ...data.suggest[g.mode].map((s) => Object.assign(document.createElement("option"), { value: s })),
    );
    els.input.placeholder = g.mode === "shape" ? "What is the drawing?" : "Name the song";

    els.history.replaceChildren(
      ...state.guesses.map((guess, i) => {
        const li = document.createElement("li");
        li.className = guess.type;
        li.innerHTML = `<span class="h-mark">${MARK[guess.type]}</span><span class="h-text"></span>`;
        li.querySelector(".h-text").textContent = guess.type === "skip" ? `Skipped tier ${i + 1}` : guess.text;
        return li;
      }),
    );

    els.form.hidden = state.done;
    if (!state.done) {
      const cur = currentTier(g);
      const more = cur < g.tiers.length - 1 ? g.tiers[cur + 1] - g.tiers[cur] : 0;
      els.skipNote.textContent = more ? `(+${compact(more)} ${g.mode === "shape" ? unit("shape", more) : "sines"})` : "(give up)";
    }

    els.result.hidden = !state.done;
    if (state.done) {
      const n = state.guesses.length;
      const at = state.won ? n - 1 : g.tiers.length - 1;
      const where = `${full(g.tiers[at])} ${unit(g.mode, g.tiers[at])}, ${pct(g.errors[at])} error`;
      els.result.classList.toggle("won", state.won);
      els.kicker.textContent = state.won ? `Got it in ${n}/${g.tiers.length}` : "Out of tiers";
      els.answer.textContent = g.secret.answer;
      const said = state.won ? `Named at ${where}` : `Last tier: ${where}`;
      els.detail.textContent = g.mode === "song" ? `${g.secret.artist} · ${said[0].toLowerCase()}${said.slice(1)}` : said;
      els.original.textContent = g.mode === "shape" ? "Full picture" : "Play original";
      els.credit.textContent = g.secret.credit || "";
    }

    for (const tab of document.querySelectorAll(".modes button")) {
      const m = tab.dataset.mode;
      tab.setAttribute("aria-selected", String(m === g.mode));
      const done = games[m]?.state.done ?? store.get(saveKey(m), {}).done;
      let mark = tab.querySelector(".done-mark");
      if (done && !mark) {
        mark = document.createElement("span");
        mark.className = "done-mark";
        mark.setAttribute("aria-label", "done today");
        tab.append(mark);
      } else if (!done && mark) mark.remove();
    }
  }

  function advance(g, entry) {
    const { state } = g;
    state.guesses.push(entry);
    if (entry.type === "good") {
      state.done = true;
      state.won = true;
    } else if (state.guesses.length >= g.tiers.length) {
      state.done = true;
    }
    save(g);
    if (state.done) {
      countResult(g);
      render(g);
      setView(g, "orig", { autoplay: g.mode === "song" });
      setTimeout(() => els.result.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" }), 120);
    } else {
      render(g);
      setView(g, state.guesses.length);
    }
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const g = games[mode];
    if (!g || g.state.done) return;
    const text = els.input.value.trim();
    if (!norm(text)) return;
    if (g.state.guesses.some((x) => x.text && norm(x.text) === norm(text))) {
      els.form.classList.remove("shake");
      void els.form.offsetWidth;
      els.form.classList.add("shake");
      toast("Already guessed");
      return;
    }
    els.input.value = "";
    const right = isCorrect(text, g.secret);
    if (!right) toast(g.state.guesses.length + 1 < g.tiers.length ? "Not it. More terms coming…" : "Not it");
    advance(g, { type: right ? "good" : "bad", text });
  });

  els.skip.addEventListener("click", () => {
    const g = games[mode];
    if (!g || g.state.done) return;
    advance(g, { type: "skip" });
  });

  $("replay-btn").addEventListener("click", () => shapeView.restart());

  els.original.addEventListener("click", () => {
    const g = games[mode];
    setView(g, "orig", { autoplay: g.mode === "song" });
  });

  // ---------- song playback ----------

  let playRaf = 0;
  function playTick() {
    const g = games.song;
    const t = player.time;
    songView.draw(t);
    els.scrub.style.width = `${(100 * t) / g.puzzle.duration}%`;
    els.playerTime.textContent = `${mmss(t)} / ${mmss(g.puzzle.duration)}`;
    if (player.playing) playRaf = requestAnimationFrame(playTick);
  }

  function resetPlayerUI() {
    const g = games.song;
    els.play.classList.remove("playing");
    cancelAnimationFrame(playRaf);
    songView.draw(null);
    els.scrub.style.width = "0";
    els.playerTime.textContent = `0:00 / ${mmss(g.puzzle.duration)}`;
  }

  async function togglePlay() {
    const g = games.song;
    if (!g) return;
    if (player.playing) {
      player.stop();
      resetPlayerUI();
      return;
    }
    els.play.disabled = true;
    try {
      await player.play(songUrl(g, g.view), resetPlayerUI);
      els.play.classList.add("playing");
      cancelAnimationFrame(playRaf);
      playRaf = requestAnimationFrame(playTick);
    } catch (err) {
      console.error(err);
      toast("Couldn't load the audio");
    } finally {
      els.play.disabled = false;
    }
  }
  els.play.addEventListener("click", togglePlay);

  // ---------- share ----------

  function shareText(g) {
    const { state } = g;
    const n = state.guesses.length;
    const icon = g.mode === "shape" ? "🌀" : "🎵";
    const squares = Array.from({ length: g.tiers.length }, (_, i) => (state.guesses[i] ? EMOJI[state.guesses[i].type] : "⬜")).join("");
    const at = n - 1;
    const tail = state.won ? `${full(g.tiers[at])} ${unit(g.mode, g.tiers[at])} · ${pct(g.errors[at])} error` : "stumped";
    return `Phasle #${day + 1} ${icon} ${g.mode === "shape" ? "Shape" : "Song"} ${state.won ? n : "X"}/${g.tiers.length}\n${squares}\n${tail}`;
  }

  els.share.addEventListener("click", async () => {
    const text = shareText(games[mode]);
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard");
    } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      toast(ok ? "Copied to clipboard" : text, ok ? 1800 : 5000);
    }
  });

  // ---------- countdown ----------

  function tickCountdown() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((next - now) / 1000));
    els.countdown.textContent = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map((v) => String(v).padStart(2, "0")).join(":");
    if (s === 0 && !new URLSearchParams(location.search).has("day")) setTimeout(() => location.reload(), 1500);
  }
  setInterval(tickCountdown, 1000);
  tickCountdown();

  // ---------- dialogs ----------

  const helpDialog = $("help-dialog");
  const statsDialog = $("stats-dialog");
  $("help-btn").addEventListener("click", () => helpDialog.showModal());
  for (const dlg of [helpDialog, statsDialog]) {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
  }

  $("stats-btn").addEventListener("click", () => {
    const s = store.get(`${V}:stats:${mode}`, emptyStats(mode));
    $("stats-title").textContent = `${mode === "shape" ? "Shape" : "Song"} statistics`;
    const cells = [
      [s.played, "Played"],
      [s.played ? Math.round((100 * s.won) / s.played) : 0, "Win %"],
      [s.streak, "Streak"],
      [s.maxStreak, "Max streak"],
    ];
    $("stat-row").innerHTML = cells.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("");
    const max = Math.max(1, ...s.dist);
    const g = games[mode];
    const today = g?.state.won ? g.state.guesses.length - 1 : -1;
    $("dist").innerHTML = s.dist
      .map((v, i) => `<div class="dist-row"><span>${i + 1}</span><div class="dist-bar${i === today ? " hl" : ""}" style="width:${Math.max(8, (100 * v) / max)}%">${v}</div></div>`)
      .join("");
    statsDialog.showModal();
  });

  // ---------- modes ----------

  async function switchMode(m) {
    mode = m;
    store.set("phasle:mode", m);
    if (location.hash !== `#${m}`) history.replaceState(null, "", `${location.search}#${m}`);
    player.stop();
    shapeView.stop();
    const g = await loadGame(m);
    if (mode !== m) return;
    render(g);
    if (m === "song") songView.setData(g.puzzle, g.viz);
    else shapeView.setData(g.points, g.f);
    setView(g, g.view ?? (g.state.done ? "orig" : currentTier(g)));
  }

  for (const tab of document.querySelectorAll(".modes button")) {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode));
  }

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    readColors();
    const g = games[mode];
    if (g) setView(g, g.view);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && mode === "shape" && games.shape) shapeView.resume();
  });

  // ---------- boot ----------

  (async () => {
    data = await (await fetch("data/puzzles.json")).json();
    day = dayIndex(data.epoch);
    const fromHash = location.hash.slice(1);
    const start = ["shape", "song"].includes(fromHash) ? fromHash : store.get("phasle:mode", "shape");
    await switchMode(start);
    if (!store.get("phasle:seen-help", false)) {
      store.set("phasle:seen-help", true);
      helpDialog.showModal();
    }
  })().catch((err) => {
    console.error(err);
    toast("Couldn't load today's puzzle", 6000);
  });
})();
