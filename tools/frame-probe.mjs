// 单档虚拟帧驱动：给 REPO 装一套最小 DOM/音频/时钟桩，真进关卡，按 --fps 喂 rAF，
// 在若干虚拟时刻采样 window.takuzu 的状态，输出 JSON。
// 用法: node tools/frame-probe.mjs [repoDir] <fps> <seconds> <seed> [frames|behavior]
// 关键口径（两处已踩过的坑）：
//   ① 时间戳按 ts = START + i*step 直接算，不做 `+= step` 累加，避免浮点亏损少跑一步；
//      并且喂 n = round(seconds*fps) + 1 帧 —— 第一帧 dt 恒为 0（lastFrame 哨兵），
//      多喂这一帧之后"累加的动画时长"与"经过的虚拟秒"在三种帧率下都精确相等。
//   ② 沙箱虚拟时钟从 1000ms 起步，不从 0 起步。
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// 默认取本仓根：从仓根直接 `node tools/frame-parity.mjs` 就能复现全部数字。
const REPO = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const FPS = Number(process.argv[3] || 60);
const SECONDS = Number(process.argv[4] || 3);
const SEED = process.argv[5] || 'probe-seed-1';
const SCENARIO = process.argv[6] || 'frames';

const START = 1000;
let NOW = START;
Date.now = () => NOW;

/* ---------------------------------------------------------------- 桩 */

const ctxRec = { drawImage: 0, fill: 0, stroke: 0, clear: 0, save: 0, lastDraw: [] };

function makeCtx(canvas) {
  const bump = (k) => (...a) => { ctxRec[k]++; };
  return {
    canvas,
    save: bump('save'), restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    stroke: bump('stroke'), fill: bump('fill'), arc() {}, ellipse() {}, rect() {}, arcTo() {},
    roundRect() {}, fillRect() {}, strokeRect() {}, clearRect: bump('clear'),
    setLineDash() {}, setTransform() {}, scale() {}, translate() {}, rotate() {},
    fillText() {}, strokeText() {},
    // 逐帧记录贴图矩形的几何 —— 粒子画在屏幕哪个位置才是帧率无关性的真判据，
    // 而 drawImage 的总次数天生正比于帧数，不可比。
    drawImage(img, dx, dy, dw, dh) {
      ctxRec.drawImage++;
      ctxRec.lastDraw.push([dx, dy, dw, dh].map((v) => +Number(v).toFixed(6)));
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({ setTransform() {} }),
    measureText: () => ({ width: 10 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    putImageData() {}, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
}

const allEls = new Map();
function makeEl(id) {
  if (allEls.has(id)) return allEls.get(id);
  const e = {
    id,
    tagName: id === 'board' ? 'CANVAS' : /^btn-/.test(id) ? 'BUTTON' : 'DIV',
    textContent: '', innerHTML: '', hidden: false, title: '', value: '',
    dataset: {}, attrs: {}, children: [], _h: {},
    width: 0, height: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { const w = f === undefined ? !this._s.has(c) : !!f; w ? this._s.add(c) : this._s.delete(c); return w; },
      contains(c) { return this._s.has(c); },
    },
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, cb) { (this._h[t] = this._h[t] || []).push(cb); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    insertBefore(c) { return this.appendChild(c); },
    remove() {},
    querySelector: () => makeEl('sub:' + Math.random().toString(36).slice(2)),
    querySelectorAll: () => [],
    // closest('.stat') 在 main.js 里只用来 toggle class，给一个稳定桩即可。
    closest: () => makeEl('closest:stat'),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 480, right: 480, bottom: 480, x: 0, y: 0 }),
    focus() {}, blur() {}, click() { this.fire('click', {}); },
    setPointerCapture() {}, releasePointerCapture() {},
    fire(type, ev) { for (const cb of (this._h[type] || []).slice()) cb({ type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...ev }); },
  };
  if (e.tagName === 'CANVAS') {
    const c = makeCtx(e);
    e.getContext = () => c;
    e.style = { ...e.style, width: '', height: '' };
  }
  allEls.set(id, e);
  return e;
}

const docHandlers = {};
const doc = {
  documentElement: makeEl('html'),
  head: makeEl('head'),
  body: makeEl('body'),
  baseURI: pathToFileURL(path.join(REPO, 'index.html')).href,
  visibilityState: 'visible',
  fullscreenElement: null,
  querySelector(sel) {
    const m = /^#([\w-]+)$/.exec(sel);
    return m ? makeEl(m[1]) : makeEl('sel:' + sel);
  },
  getElementById: (id) => makeEl(id),
  querySelectorAll: () => [],
  createElement: (tag) => { const e = makeEl('new:' + tag + ':' + allEls.size); e.tagName = tag.toUpperCase(); return e; },
  createTextNode: (t) => ({ textContent: t }),
  addEventListener(t, cb) { (docHandlers[t] = docHandlers[t] || []).push(cb); },
  removeEventListener() {},
  fire(t, ev) { for (const cb of (docHandlers[t] || []).slice()) cb({ type: t, preventDefault() {}, ...ev }); },
};

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let rafSeq = 1;
let rafQueue = [];
const winHandlers = {};

class AudioStub {
  constructor() {
    this.state = 'running';
    this._t = 0;
    AudioStub.made++;
  }
  get currentTime() { return this._t + (NOW - START) / 1000; }
  createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect: (n) => n }; }
  createOscillator() {
    AudioStub.oscillators++;
    return {
      type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (n) => n, start() {}, stop() {},
    };
  }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
AudioStub.oscillators = 0;
AudioStub.made = 0;

class ImageStub {
  constructor() { this.complete = false; this.width = 0; this.height = 0; this.naturalWidth = 0; }
  set src(v) {
    this._src = v;
    queueMicrotask(() => {
      this.complete = true;
      this.width = this.naturalWidth = 64;
      this.height = 64;
      if (this.onload) this.onload({ type: 'load' });
    });
  }
  get src() { return this._src; }
}

function define(key, value) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

const stubs = {
  document: doc,
  localStorage,
  window: globalThis,
  self: globalThis,
  global: globalThis,
  innerWidth: 1280,
  innerHeight: 900,
  devicePixelRatio: 2,
  navigator: { userAgent: 'node-probe', serviceWorker: undefined, maxTouchPoints: 0 },
  location: new URL(doc.baseURI),
  matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {} }),
  requestAnimationFrame: (cb) => { const id = rafSeq++; rafQueue.push({ id, cb }); return id; },
  cancelAnimationFrame: (id) => { rafQueue = rafQueue.filter((r) => r.id !== id); },
  performance: { now: () => NOW },
  AudioContext: AudioStub,
  webkitAudioContext: AudioStub,
  Image: ImageStub,
  addEventListener(t, cb) { (winHandlers[t] = winHandlers[t] || []).push(cb); },
  removeEventListener() {},
  fire(t, ev) { for (const cb of (winHandlers[t] || []).slice()) cb({ type: t, target: globalThis, preventDefault() {}, ...ev }); },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
};
Object.entries(stubs).forEach(([k, v]) => define(k, v));

/* ---------------------------------------------------------------- 驱动 */

// 采样点用"虚拟秒"表达，再按帧率换算成帧号：三档在第 k 个采样点都已经累加了
// 恰好 targetMs 的动画时长，于是帧率之间可比。首帧 dt 恒为 0（lastFrame 哨兵），
// 所以第 i 帧之后累加的时长就是 i*step —— 帧号即时长。
// 采样点只取 0.5s 的整数倍：这样 target*fps 在 30/60/120 三档都是整数帧，
// 换成 2.95s 这类点会让 30Hz 凑不满整数帧、对齐性被 1 帧抖动破坏，比出假红。
const TARGETS = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.5];
const ACTIONS = [
  { at: 1.0, label: '提示', run: (A) => A.useHint() },
  { at: 1.5, label: '逻辑收局·迸发', run: (A) => A.solveWithLogic() },
];

function runFrames(A, fps, seconds) {
  const step = 1000 / fps;
  const n = Math.round(seconds * fps) + 1;
  const base = NOW;
  const want = new Map(TARGETS.filter((t) => t <= seconds + 1e-9)
    .map((t) => [Math.round(t * fps), t]));
  const acted = new Set();
  const out = [];
  for (let i = 0; i < n; i++) {
    NOW = base + i * step;
    ctxRec.lastDraw = [];
    const q = rafQueue;
    rafQueue = [];
    for (const r of q) r.cb(NOW);
    const t = want.get(i);
    if (t === undefined) continue;
    const act = ACTIONS.find((a) => Math.round(a.at * fps) === i && !acted.has(a.at));
    if (act) {
      acted.add(act.at);
      act.run(A);
      out.push(sample(A, `t=${t.toFixed(2)}s ${act.label}`));
    } else {
      out.push(sample(A, `t=${t.toFixed(2)}s`));
    }
  }
  return { framesFed: n, marks: out };
}

await import(pathToFileURL(path.join(REPO, 'js', 'main.js')).href);
const A = globalThis.takuzu;
if (!A) {
  console.error(JSON.stringify({ fatal: 'window.takuzu 未挂载' }));
  process.exit(2);
}

// 真进关卡：显式给 seed，不靠 Math.random；确认状态已是 playing 才开始取数。
A.begin({ tier: 'trainee', seed: SEED });
const g0 = A.game;
if (!g0 || g0.status !== 'playing') {
  console.error(JSON.stringify({ fatal: '进不了关卡', status: g0 && g0.status }));
  process.exit(3);
}

if (SCENARIO === 'behavior') {
  console.log(JSON.stringify(behavior(A), null, 1));
  process.exit(0);
}

const { framesFed, marks } = runFrames(A, FPS, SECONDS);

console.log(JSON.stringify({
  fps: FPS,
  seconds: SECONDS,
  seed: SEED,
  framesFed,
  audioContextsMade: AudioStub.made,
  marks,
  final: sample(A, 'final'),
}));

// 顺序敏感的几何折叠哈希：粒子先后顺序也是渲染行为的一部分，不能当集合处理。
function hashRects(rects) {
  let h = 2166136261;
  for (const r of rects) {
    for (const v of r) {
      h = (h ^ Math.round(v * 1000)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

function sample(A, tag) {
  const g = A.game;
  const st = A.state();
  const rt = A.runtime();
  const grid = g ? Array.from(g.st.grid) : [];
  let fingerprint = 0;
  for (let i = 0; i < grid.length; i++) fingerprint = (fingerprint * 31 + grid[i] + 3) % 2147483647;
  return {
    tag,
    animClock: +rt.animClock.toFixed(12),
    frames: rt.frames,
    elapsedMs: Math.round(rt.elapsedMs),
    pulse: rt.pulse,
    pulseProgress: rt.pulseProgress === null ? null : +rt.pulseProgress.toFixed(10),
    particles: rt.particles,
    burstAge: rt.burstAge < 0 ? -1 : +rt.burstAge.toFixed(10),
    paused: rt.paused,
    screen: rt.screen,
    reduceMotion: rt.reduceMotion,
    status: st && st.status,
    moves: st && st.moves,
    hints: st && st.hints,
    filled: st && st.filled,
    remaining: st && st.remaining,
    linesDone: st && st.linesDone,
    conflicts: st && st.conflicts,
    cursor: st && st.cursor,
    steps: st && st.steps,
    gridFingerprint: fingerprint,
    drawnSprites: ctxRec.lastDraw.length,
    drawFingerprint: hashRects(ctxRec.lastDraw),
    drawImage: ctxRec.drawImage,
    audioOscillators: AudioStub.oscillators,
    audioState: rt.audio.ctxState,
    audioEnabled: rt.audio.enabled,
  };
}

/* ------------------------------------------------------- 行为取证场景 */

function pump(fps, seconds) {
  const stepMs = 1000 / fps;
  const n = Math.round(seconds * fps);
  const base = NOW;
  for (let i = 1; i <= n; i++) {
    NOW = base + i * stepMs;
    const q = rafQueue;
    rafQueue = [];
    for (const r of q) r.cb(NOW);
  }
  return n;
}

function fingerprintOf(A) {
  const grid = Array.from(A.game.st.grid);
  let h = 0;
  for (let i = 0; i < grid.length; i++) h = (h * 31 + grid[i] + 3) % 2147483647;
  return h;
}

// 全部通过真实按钮与真实手势入口驱动，不直接调内部函数。
function behavior(A) {
  const rt = () => A.runtime();
  const st = () => A.state();
  const click = (id) => doc.querySelector('#' + id).click();
  const place = (value) => {
    const i = A.game.st.grid.findIndex((v) => v === A.engine.EMPTY);
    return i < 0 ? null : A.stroke([i], value ?? A.engine.ZERO);
  };
  const snapshot = () => ({
    animClock: +rt().animClock.toFixed(9),
    frames: rt().frames,
    elapsedMs: Math.round(rt().elapsedMs),
    moves: st().moves,
    hints: st().hints,
    steps: st().steps,
    filled: st().filled,
    particles: rt().particles,
    pulse: rt().pulse,
    paused: rt().paused,
    osc: rt().audio.oscillators,
    audioEnabled: rt().audio.enabled,
    ctxState: rt().audio.ctxState,
  });

  const out = { seed: SEED, marks: {} };
  out.marks.afterBegin = snapshot();
  out.marks.givens = st().filled;
  out.marks.fingerprint0 = fingerprintOf(A);

  pump(60, 0.5);
  out.marks.afterHalfSecond = snapshot();

  // ① 真静音：按下 #btn-sound 之后，落子仍走完整状态机，但一个振荡器都不许多。
  place(); place(); place();
  const oscBeforeMute = rt().audio.oscillators;
  click('btn-sound');
  out.marks.muted = snapshot();
  pump(60, 0.25);
  place(); place(); place();
  out.marks.placementsWhileMuted = {
    oscDelta: rt().audio.oscillators - oscBeforeMute,
    moves: st().moves,
    filled: st().filled,
    ctxState: rt().audio.ctxState,
    enabled: rt().audio.enabled,
    suspended: rt().audio.suspended,
  };
  click('btn-sound');
  const oscAtUnmute = rt().audio.oscillators;
  place();
  out.marks.unmuted = {
    ctxState: rt().audio.ctxState,
    enabled: rt().audio.enabled,
    oscDelta: rt().audio.oscillators - oscAtUnmute,
  };

  // ② 暂停：帧环继续跑，但动画时钟、秒表、帧计数都不许前进，且落子被拒。
  pump(60, 0.25);
  click('btn-pause');
  const pausedAt = snapshot();
  out.marks.pauseVeilHidden = doc.querySelector('#pause-veil').hidden;
  out.marks.pausedPressed = doc.querySelector('#btn-pause').getAttribute('aria-pressed');
  const rejected = [place(), A.useHint() ? 'hint-accepted' : 'hint-rejected'];
  pump(60, 1.0);
  const afterIdle = snapshot();
  out.marks.paused = {
    at: pausedAt,
    after: afterIdle,
    animClockDelta: +(afterIdle.animClock - pausedAt.animClock).toFixed(9),
    framesDelta: afterIdle.frames - pausedAt.frames,
    elapsedDelta: afterIdle.elapsedMs - pausedAt.elapsedMs,
    strokeReturnedNull: rejected[0] === null,
    hint: rejected[1],
  };
  click('btn-pause');
  pump(60, 0.5);
  const resumed = snapshot();
  out.marks.resumed = {
    animClockDelta: +(resumed.animClock - afterIdle.animClock).toFixed(9),
    framesDelta: resumed.frames - afterIdle.frames,
    elapsedDelta: resumed.elapsedMs - afterIdle.elapsedMs,
    veilHidden: doc.querySelector('#pause-veil').hidden,
  };

  // ③ 重开本局：先把乱落子的残局重启干净，再逻辑收局点燃粒子与脉冲，然后按 #btn-restart。
  click('btn-restart');
  pump(60, 0.1);
  out.marks.firstRestart = { ...snapshot(), status: st().status, fingerprint: fingerprintOf(A) };
  A.solveWithLogic();
  pump(60, 0.5);
  out.marks.won = {
    ...snapshot(),
    status: st().status,
    winVeilHidden: doc.querySelector('#win-veil').hidden,
    burstAge: +rt().burstAge.toFixed(6),
  };
  click('btn-restart');
  const r1 = { ...snapshot(), status: st().status, fingerprint: fingerprintOf(A), screen: rt().screen };
  A.useHint();
  pump(60, 0.1);
  const r2 = { ...snapshot(), status: st().status };
  click('btn-restart');
  pump(60, 0.25);
  const r = {
    ...snapshot(),
    status: st().status,
    fingerprint: fingerprintOf(A),
    screen: rt().screen,
    winVeilHidden: doc.querySelector('#win-veil').hidden,
    pauseVeilHidden: doc.querySelector('#pause-veil').hidden,
  };
  out.marks.afterHintOnFreshRun = r2;
  out.marks.afterRestart = r;
  out.restartVerdict = {
    movesCleared: r.moves === 0,
    hintsCleared: r.hints === 0,
    stepsCleared: r.steps === 0,
    elapsedCleared: r.elapsedMs <= 250,
    animClockRestarted: r.animClock <= 0.250000001 && r.animClock > 0.2,
    framesRestarted: r.frames === 15,
    particlesCleared: r.particles === 0 && out.marks.won.particles === 26,
    pulseCleared: r.pulse === false && r2.pulse === true,
    backToPlaying: r.status === 'playing',
    samePuzzle: r.fingerprint === out.marks.fingerprint0,
    filledEqualsGivens: r.filled === out.marks.givens,
    veilsHidden: r.winVeilHidden === true && r.pauseVeilHidden === true,
  };
  return out;
}
