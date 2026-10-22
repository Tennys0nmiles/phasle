"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const TIERS = 6;
  const FULL_TERMS = 256; // circles used for the "full picture" reveal
  const REV_MS = 5200; // one trip of the pen around the curve
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  let colors = {};
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

  function judge(text, secret) {
    const g = norm(text);
    if (!g) return null;
    const has = (phrase) => ` ${g} `.includes(` ${norm(phrase)} `);
    if (norm(secret.answer) === g || secret.accept.some((a) => norm(a) === g) || secret.contains.some(has)) {
      return { type: "good" };
    }
    for (const c of secret.close) {
      if (c.any.some(has)) return { type: "warn", note: c.hint };
    }
    return { type: "bad" };
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

  // Complex DFT of the sampled curve, terms sorted biggest circle first.
  // err[n-1] is the % error left after keeping n terms (Parseval: the energy of what's dropped).
  function fourier(points) {
    const N = points.length;
    const cosT = new Float64Array(N);
    const sinT = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      cosT[i] = Math.cos((2 * Math.PI * i) / N);
      sinT[i] = Math.sin((2 * Math.PI * i) / N);
    }
    let c0 = [0, 0];
    const terms = [];
    for (let k = -N / 2; k < N / 2; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        const idx = (((-k * n) % N) + N) % N;
        const [x, y] = points[n];
        re += x * cosT[idx] - y * sinT[idx];
        im += x * sinT[idx] + y * cosT[idx];
      }
      re /= N;
      im /= N;
      if (k === 0) c0 = [re, im];
      else terms.push({ k, re, im, r: Math.hypot(re, im), phase: Math.atan2(im, re) });
    }
    terms.sort((a, b) => b.r - a.r);
    const total = terms.reduce((s, t) => s + t.r * t.r, 0);
    let kept = 0;
    const err = terms.map((t) => {
      kept += t.r * t.r;
      return 100 * Math.sqrt(Math.max(0, 1 - kept / total));
    });
    return { c0, terms, err };
  }

  function sampleCurve(f, n, samples) {
    const pts = new Float64Array(samples * 2);
    for (let s = 0; s < samples; s++) {
      const t = (2 * Math.PI * s) / samples;
      let x = f.c0[0];
      let y = f.c0[1];
      for (let j = 0; j < n; j++) {
        const { k, re, im } = f.terms[j];
        const c = Math.cos(k * t);
        const si = Math.sin(k * t);
        x += re * c - im * si;
        y += re * si + im * c;
      }
      pts[2 * s] = x;
      pts[2 * s + 1] = y;
    }
    return pts;
  }

  // ---------- shape view: epicycles tracing the curve ----------

  class ShapeView {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.raf = 0;
      new ResizeObserver(() => this.resize()).observe(canvas);
    }

    setData(points, f) {
      this.points = points;
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
        const pad = 0.1;
        this.scale = Math.min((w * (1 - 2 * pad)) / (b.x1 - b.x0), (h * (1 - 2 * pad)) / (b.y1 - b.y0));
        this.ox = w / 2 - ((b.x0 + b.x1) / 2) * this.scale;
        this.oy = h / 2 - ((b.y0 + b.y1) / 2) * this.scale;
      }
      if (this.curve) this.frame(performance.now());
    }

    show(n, { ghost = 0, original = false } = {}) {
      this.n = n;
      this.curve = sampleCurve(this.f, n, 900);
      this.ghost = ghost ? sampleCurve(this.f, ghost, 600) : null;
      this.original = original;
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

    path(pts, upto) {
      const { ctx } = this;
      ctx.beginPath();
      const count = upto ?? pts.length / 2;
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
      const p = reduceMotion ? 1 : (now - this.t0) / REV_MS;
      const progress = Math.min(1, p);
      ctx.clearRect(0, 0, w, h);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      if (this.original) {
        ctx.beginPath();
        this.points.forEach(([x, y], i) => {
          const X = this.ox + x * this.scale;
          const Y = this.oy + y * this.scale;
          if (i === 0) ctx.moveTo(X, Y);
          else ctx.lineTo(X, Y);
        });
        ctx.closePath();
        ctx.strokeStyle = colors.good;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (this.ghost) {
        this.path(this.ghost);
        ctx.closePath();
        ctx.setLineDash([4, 5]);
        ctx.strokeStyle = colors.faint;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const samples = this.curve.length / 2;
      const upto = Math.max(1, Math.floor(progress * samples));
      this.path(this.curve, upto + (progress >= 1 ? 1 : 0));
      if (progress >= 1) ctx.closePath();
      ctx.strokeStyle = colors.trace;
      ctx.lineWidth = 2.6;
      ctx.stroke();

      // Epicycles: the pen keeps riding the curve after the first lap.
      const t = 2 * Math.PI * (reduceMotion ? 0 : p);
      let x = this.f.c0[0];
      let y = this.f.c0[1];
      const show = Math.min(this.n, 80);
      for (let j = 0; j < this.n; j++) {
        const term = this.f.terms[j];
        const ang = term.k * t + term.phase;
        const nx = x + term.r * Math.cos(ang);
        const ny = y + term.r * Math.sin(ang);
        if (j < show) {
          const X = this.ox + x * this.scale;
          const Y = this.oy + y * this.scale;
          const R = term.r * this.scale;
          if (R > 0.6) {
            ctx.beginPath();
            ctx.arc(X, Y, R, 0, 2 * Math.PI);
            ctx.strokeStyle = colors.muted;
            ctx.globalAlpha = j === 0 ? 0.28 : 0.22;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(X, Y);
            ctx.lineTo(this.ox + nx * this.scale, this.oy + ny * this.scale);
            ctx.globalAlpha = 0.7;
            ctx.strokeStyle = colors.ink;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
        x = nx;
        y = ny;
      }
      ctx.beginPath();
      ctx.arc(this.ox + x * this.scale, this.oy + y * this.scale, 4, 0, 2 * Math.PI);
      ctx.fillStyle = colors.trace;
      ctx.fill();
    }
  }

  // ---------- song view: kept sine waves over time ----------

  class SongView {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.layer = document.createElement("canvas");
      new ResizeObserver(() => this.resize()).observe(canvas);
    }

    setData(meta, peaks) {
      this.meta = meta;
      this.peaks = peaks;
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
      this.cv.width = this.layer.width = Math.round(w * dpr);
      this.cv.height = this.layer.height = Math.round(h * dpr);
      if (this.k) this.setTerms(this.k);
    }

    yOf(fpos) {
      return this.h - 22 - fpos * (this.h - 40);
    }

    setTerms(k) {
      this.k = k;
      if (!this.meta || !this.w) return;
      const { frames, kmax, hop, t0 } = this.meta.viz;
      const dur = this.meta.duration;
      const g = this.layer.getContext("2d");
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, this.w, this.h);
      g.fillStyle = colors.trace;
      const bw = Math.max(1.4, (this.w / frames) * 1.3);
      const bh = k <= 4 ? 3.4 : k <= 16 ? 2.4 : 1.6;
      for (let j = 0; j < frames; j++) {
        const x = ((t0 + j * hop) / dur) * this.w;
        for (let r = 0; r < Math.min(k, kmax); r++) {
          const o = (j * kmax + r) * 2;
          const level = this.peaks[o + 1] / 255;
          if (!level) continue;
          g.globalAlpha = (k <= 8 ? 0.35 : 0.15) + (k <= 8 ? 0.65 : 0.85) * level ** 1.4;
          g.fillRect(x - bw / 2, this.yOf(this.peaks[o] / 255) - bh / 2, bw, bh);
        }
      }
      g.globalAlpha = 1;
      this.draw(null);
    }

    draw(time) {
      const { ctx, w, h } = this;
      if (!w || !this.meta) return;
      const dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const { fmin, fmax } = this.meta.viz;
      ctx.font = `11px ${colors.mono || "monospace"}`;
      ctx.textBaseline = "bottom";
      for (const [f, label] of [[100, "100 Hz"], [1000, "1 kHz"], [10000, "10 kHz"]]) {
        const y = this.yOf(Math.log(f / fmin) / Math.log(fmax / fmin));
        ctx.fillStyle = colors.line;
        ctx.fillRect(0, Math.round(y), w, 1);
        ctx.fillStyle = colors.faint;
        ctx.fillText(label, 8, y - 2);
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (time == null) {
        ctx.drawImage(this.layer, 0, 0);
      } else {
        const px = Math.round((time / this.meta.duration) * w * dpr);
        ctx.globalAlpha = 0.28;
        ctx.drawImage(this.layer, 0, 0);
        ctx.globalAlpha = 1;
        if (px > 0) ctx.drawImage(this.layer, 0, 0, px, this.layer.height, 0, 0, px, this.layer.height);
        ctx.fillStyle = colors.ink;
        ctx.fillRect(px, 0, Math.max(1, dpr * 1.5), this.layer.height);
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
      this.url = url;
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

  function shapeEquation(f, n) {
    const parts = f.terms.slice(0, Math.min(n, 2)).map((t) => {
      const kt = t.k === 1 ? "t" : t.k === -1 ? "−t" : `${t.k < 0 ? "−" : ""}${Math.abs(t.k)}t`;
      const ph = `${t.phase < 0 ? "−" : "+"}${Math.abs(t.phase).toFixed(2)}`;
      return `${t.r.toFixed(2)}e<sup>i(${kt}${ph})</sup>`;
    });
    const more = n > 2 ? ` + … (${n} terms)` : "";
    return `z(t) = ${parts.join(" + ")}${more}`;
  }

  function songEquation(k) {
    return `x(t) = Σ<sub>j=1</sub><sup>${k}</sup> A<sub>j</sub>(t) cos(2πf<sub>j</sub>(t)·t + φ<sub>j</sub>(t))`;
  }

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
    hint: $("hint"),
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

  const MARK = { good: "✓", warn: "~", bad: "✕", skip: "–" };
  const EMOJI = { good: "🟩", warn: "🟨", bad: "🟥", skip: "⬛" };

  function toast(msg, ms = 1800) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove("show"), ms);
  }

  async function loadGame(m) {
    if (games[m]) return games[m];
    const list = data[m];
    const puzzle = list[day % list.length];
    const key = `phasle:${m}:${day + 1}:${puzzle.id}`;
    const g = {
      mode: m,
      puzzle,
      key,
      secret: unwrap(puzzle.secret),
      state: store.get(key, { guesses: [], done: false, won: false, counted: false }),
      view: null,
    };
    if (m === "shape") {
      const pts = (await (await fetch(puzzle.file)).json()).points;
      g.points = pts;
      g.f = fourier(pts);
      g.tiers = puzzle.tiers;
      g.errors = puzzle.tiers.map((n) => g.f.err[n - 1]);
    } else {
      const buf = await (await fetch(`${puzzle.dir}/peaks.bin`)).arrayBuffer();
      g.peaks = new Uint8Array(buf);
      g.tiers = puzzle.tiers;
      g.errors = puzzle.errors;
    }
    games[m] = g;
    return g;
  }

  const currentTier = (g) => (g.state.done ? (g.state.won ? g.state.guesses.length - 1 : TIERS - 1) : g.state.guesses.length);
  const revealedUpTo = (g) => (g.state.done ? TIERS - 1 : g.state.guesses.length);

  function save(g) {
    store.set(g.key, g.state);
  }

  function countResult(g) {
    if (g.state.counted) return;
    const key = `phasle:stats:${g.mode}`;
    const s = store.get(key, { played: 0, won: 0, streak: 0, maxStreak: 0, last: null, dist: [0, 0, 0, 0, 0, 0] });
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

  // What the stage shows: a tier index 0..5, or "orig" for the full picture / original song.
  function setView(g, view, { autoplay = false } = {}) {
    g.view = view;
    const isOrig = view === "orig";
    if (g.mode === "shape") {
      const n = isOrig ? Math.min(FULL_TERMS, g.f.terms.length) : g.tiers[view];
      const ghost = !isOrig && view > 0 ? g.tiers[view - 1] : 0;
      shapeView.show(n, { ghost, original: isOrig });
      const err = isOrig ? g.f.err[n - 1] : g.errors[view];
      readout(isOrig ? "Full picture" : `Tier ${view + 1}/${TIERS}`, `${n} circles`, err);
      els.equation.innerHTML = shapeEquation(g.f, n);
    } else {
      player.stop();
      const k = isOrig ? g.puzzle.viz.kmax : g.tiers[view];
      songView.setTerms(k);
      readout(isOrig ? "Original" : `Tier ${view + 1}/${TIERS}`, isOrig ? "every sine wave" : `${k} sines at a time`, isOrig ? 0 : g.errors[view]);
      els.equation.innerHTML = isOrig ? "x(t) = the real recording" : songEquation(k);
      els.playerTitle.textContent = isOrig ? `${g.secret.answer} · original` : `Tier ${view + 1} · ${k} sine waves`;
      els.playerTime.textContent = `0:00 / ${mmss(g.puzzle.duration)}`;
      els.scrub.style.width = "0";
      els.play.classList.remove("playing");
      const url = songUrl(g, view);
      player.prefetch(url);
      if (autoplay) togglePlay();
    }
    renderTiers(g);
  }

  const songUrl = (g, view) => `${g.puzzle.dir}/${view === "orig" ? "full" : `t${view + 1}`}.mp3`;

  function readout(tier, terms, err) {
    els.rTier.textContent = tier;
    els.rTerms.textContent = terms;
    els.rErr.textContent = `${pct(err)} error`;
    els.errCover.style.width = `${100 - Math.min(100, err)}%`;
  }

  function renderTiers(g) {
    const cur = currentTier(g);
    const upto = revealedUpTo(g);
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
        b.innerHTML = `<span class="t-n">${n}</span><span class="t-e">${i <= upto ? pct(g.errors[i]) : "?"}</span>`;
        b.setAttribute("aria-label", `Tier ${i + 1}: ${n} terms${i <= upto ? `, ${pct(g.errors[i])} error` : ", locked"}`);
        b.addEventListener("click", () => setView(g, i));
        li.append(b);
        return li;
      }),
    );
  }

  function render(g) {
    const { state, puzzle } = g;
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

    // history
    els.history.replaceChildren(
      ...state.guesses.map((guess, i) => {
        const li = document.createElement("li");
        li.className = guess.type;
        const text = guess.type === "skip" ? `Skipped tier ${i + 1}` : guess.text;
        li.innerHTML = `<span class="h-mark">${MARK[guess.type]}</span><span class="h-text"></span>${guess.note ? `<span class="h-note"></span>` : ""}`;
        li.querySelector(".h-text").textContent = text;
        if (guess.note) li.querySelector(".h-note").textContent = guess.note;
        return li;
      }),
    );

    const cur = currentTier(g);
    const hintOn = puzzle.hint && (state.done || cur + 1 >= puzzle.hint.tier);
    els.hint.hidden = !hintOn;
    if (hintOn) els.hint.innerHTML = `<b>Hint</b> · ${puzzle.hint.text}`;

    els.form.hidden = state.done;
    if (!state.done) {
      const more = cur < TIERS - 1 ? g.tiers[cur + 1] - g.tiers[cur] : 0;
      const unit = g.mode === "shape" ? (more === 1 ? "circle" : "circles") : more === 1 ? "sine" : "sines";
      els.skipNote.textContent = more ? `(+${more} ${unit})` : "(give up)";
    }

    els.result.hidden = !state.done;
    if (state.done) {
      const n = state.guesses.length;
      els.result.classList.toggle("won", state.won);
      els.kicker.textContent = state.won ? `Got it in ${n}/${TIERS}` : "Out of tiers";
      els.answer.textContent = g.mode === "song" ? `${g.secret.answer}` : g.secret.answer;
      const at = state.won ? n - 1 : TIERS - 1;
      const unit = g.mode === "shape" ? "circles" : "sine waves at a time";
      els.detail.textContent = g.mode === "song"
        ? `${g.secret.artist} · ${state.won ? `named at ${g.tiers[at]} ${unit}, ${pct(g.errors[at])} error` : `last tier: ${g.tiers[at]} ${unit}`}`
        : state.won ? `Named at ${g.tiers[at]} ${unit}, ${pct(g.errors[at])} error` : `Last tier: ${g.tiers[at]} ${unit}, ${pct(g.errors[at])} error`;
      els.original.textContent = g.mode === "shape" ? "Full picture" : "Play original";
      els.credit.textContent = g.secret.credit || "";
    }

    for (const tab of document.querySelectorAll(".modes button")) {
      const m = tab.dataset.mode;
      tab.setAttribute("aria-selected", String(m === g.mode));
      const done = games[m]?.state.done ?? store.get(`phasle:${m}:${day + 1}:${data[m][day % data[m].length].id}`, {}).done;
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
    } else if (state.guesses.length >= TIERS) {
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
    const verdict = judge(text, g.secret);
    if (!verdict) return;
    if (g.state.guesses.some((x) => x.text && norm(x.text) === norm(text))) {
      els.form.classList.remove("shake");
      void els.form.offsetWidth;
      els.form.classList.add("shake");
      toast("Already guessed");
      return;
    }
    els.input.value = "";
    if (verdict.type === "warn") toast(verdict.note);
    else if (verdict.type === "bad") toast(g.state.guesses.length + 1 < TIERS ? "Not it. More terms coming…" : "Not it");
    advance(g, { type: verdict.type, text, ...(verdict.note ? { note: verdict.note } : {}) });
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
    const squares = Array.from({ length: TIERS }, (_, i) => (state.guesses[i] ? EMOJI[state.guesses[i].type] : "⬜")).join("");
    const at = state.won ? n - 1 : TIERS - 1;
    const unit = g.mode === "shape" ? "circles" : "sines";
    const tail = state.won ? `${g.tiers[at]} ${unit} · ${pct(g.errors[at])} error` : "stumped";
    return `Phasle #${day + 1} ${icon} ${g.mode === "shape" ? "Shape" : "Song"} ${state.won ? n : "X"}/${TIERS}\n${squares}\n${tail}`;
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
    const s = store.get(`phasle:stats:${mode}`, { played: 0, won: 0, streak: 0, maxStreak: 0, dist: [0, 0, 0, 0, 0, 0] });
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
    if (m === "song") songView.setData(g.puzzle, g.peaks);
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
