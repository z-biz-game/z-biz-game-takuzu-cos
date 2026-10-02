// Wiring: DOM, pointer gestures, the clock, storage, and the `window.takuzu` surface the
// verification harness drives. No rule about the board lives here — every judgement comes from
// js/engine/takuzu.js through js/ui/game.js.

import { Palette, Cell, applyThemeVars, setReduceMotion, systemPrefersReducedMotion, prefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, makePuzzle, generate, randomGrid, hideCells } from './engine/generate.js';
import * as Engine from './engine/takuzu.js';
import { countSolutions } from './engine/count.js';
import { BoardView } from './render/board.js';
import { Game, EMPTY, ZERO, ONE, sym } from './ui/game.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  filled: $('#stat-filled'),
  remaining: $('#stat-remaining'),
  lines: $('#stat-lines'),
  conflicts: $('#stat-conflicts'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  stateLine: $('#state-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  pauseVeil: $('#pause-veil'),
  btnPause: $('#btn-pause'),
  btnPausePlay: $('#btn-pause-play'),
  btnPauseMenu: $('#btn-pause-menu'),
  btnRestart: $('#btn-restart'),
  btnFull: $('#btn-full'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);
let game = null;
let pulse = null;
let stroke = null;
let startedAt = 0;
let baseElapsed = 0;
let paused = false;

// animClock 只由帧 dt 累加；每一段装饰动画都按 (animClock - t0) 取**闭式解**，
// 不做 `x += v*dt` 那种增量积分。于是同一虚拟时刻在 30/60/120Hz 下读到同一个值——
// 帧率无关是结构性的，不是把系数调到看起来一致。
const PULSE_LIFE = 1.6;
const BURST_LIFE = 1.5;
let animClock = 0;
let lastFrame = -1;
let frames = 0;
let rafId = 0;
let burst = null;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;
const interactive = () => !!game && game.status !== 'won' && !paused;

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function availBox() {
  const narrow = window.innerWidth <= 900;
  const w = narrow ? window.innerWidth - 60 : el.viewGame.clientWidth - 340;
  return { w: Math.max(240, w), h: Math.max(240, window.innerHeight - 250) };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, {
    pulse: pulseInfo(),
    preview: stroke && stroke.items.length ? { cells: stroke.items.map((i) => i.cell) } : null,
    burst: burstView(),
  });
}

// 存活与过期只在 advanceAnimations 里判；draw 只读。暂停时不推进 animClock，
// 于是脉冲停在原地——恢复后接着走完剩下的路，而不是被一个 setTimeout 到点抹掉。
function pulseInfo() {
  if (!pulse) return null;
  return { cell: pulse.cell, color: pulse.color, progress: Math.min(1, (animClock - pulse.t0) / PULSE_LIFE) };
}

function burstView() {
  if (!burst) return null;
  return { age: animClock - burst.t0, seeds: burst.seeds };
}

let dirty = true;
let loopOn = false;
let lastShownSecond = -1;

function advanceAnimations(dt) {
  animClock += dt;
  frames++;
  if (pulse && animClock - pulse.t0 >= PULSE_LIFE) { pulse = null; dirty = true; }
  if (burst && animClock - burst.t0 >= BURST_LIFE) { burst = null; dirty = true; }
}

// 单一入口：帧 dt 只在这里被消费一次，其余地方一律读 animClock。
function frame(ts) {
  if (!loopOn) return;
  rafId = requestAnimationFrame(frame);
  const dt = lastFrame < 0 ? 0 : Math.min(1, (ts - lastFrame) / 1000);
  lastFrame = ts;
  if (!paused) advanceAnimations(dt);
  const shown = Math.floor(clock() / 1000);
  if (shown !== lastShownSecond) {
    lastShownSecond = shown;
    el.time.textContent = fmtMs(clock());
  }
  if (dirty || pulse || burst) {
    dirty = false;
    draw();
  }
}

function startLoop() {
  if (loopOn) return;
  loopOn = true;
  lastFrame = -1;
  rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  if (!loopOn) return;
  loopOn = false;
  if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
  rafId = 0;
}

// One place writes the readouts, so a stat can never be updated by half the file.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = `${st.name} · ${game.n}×${game.n}`;
  el.tier.textContent = tierFor(st.tier).name;
  el.tier.dataset.tier = st.tier;
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.filled.textContent = `${st.filled}/${st.total}`;
  el.remaining.textContent = st.remaining;
  el.lines.textContent = `${st.linesDone}/${st.linesTotal}`;
  el.conflicts.textContent = st.conflicts;
  el.score.textContent = st.score.toFixed(1);
  el.conflicts.closest('.stat').classList.toggle('bad', st.conflicts > 0);
  el.remaining.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.remaining > 0);
  el.lines.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.conflicts > 0);
  renderStateLine();
}

// Two things want that one line: what the board says about itself, and what the gesture just said
// back to the player. The board wins while it is complaining; otherwise the last thing the player
// did stays on screen until the next gesture, instead of being wiped by a redraw.
let note = { text: '', good: false };
function renderStateLine() {
  const st = game ? game.state() : null;
  const stuck = st && st.stuck ? '这些格和题面已经矛盾了：不管剩下的格怎么填，都不可能让每行每列各半。撤销一步再想。' : '';
  const wrong = st && !stuck && st.conflicts ? `${st.conflicts} 处违规：三连同符、某行某列两符不等，或者改了题面给的格。` : '';
  el.stateLine.textContent = stuck || wrong || note.text;
  el.stateLine.classList.toggle('good', !stuck && !wrong && note.good);
}

function syncAll() {
  syncStats();
  dirty = true;
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.st.grid, clock(), { moves: game.moves, hints: game.hints });
}

// 计时读数由动画环按帧检查秒界，不再单开一个 setInterval —— 两条时钟迟早会漂。
function startClock() {
  startedAt = Date.now();
  lastShownSecond = -1;
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
}

function showHint(info) {
  if (!info) return;
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    return;
  }
  if (info.conflict) {
    el.hintRule.textContent = '这里和题面矛盾';
    el.hintLine.textContent = info.conflict;
    pulse = { cell: info.cell, color: Palette.error, t0: animClock };
    dirty = true;
    Sound.conflict();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.why;
  pulse = { cell: info.cell, t0: animClock };
  dirty = true;
  Sound.hint();
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 粒子存的是**种子**（归一化坐标与初速度），位置由渲染层对 t 取闭式解。
// 种子来自本局 seed 的哈希而不是 Math.random —— 否则同一虚拟时刻在 30/60/120Hz 下
// 会各自掷出一套不同的粒子，对拍就成了比随机数。
function spawnBurst() {
  if (prefersReducedMotion()) {
    burst = null;
    return;
  }
  const rnd = lcg(hashSeed(game.puzzle.originSeed || game.puzzle.seed));
  const seeds = [];
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const sp = 0.22 + rnd() * 0.5;
    seeds.push({
      x: 0.5 + (rnd() - 0.5) * 0.55,
      y: 0.5 + (rnd() - 0.5) * 0.35,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 0.45,
      delay: rnd() * 0.25,
      life: 0.7 + rnd() * 0.5,
      size: 0.05 + rnd() * 0.06,
    });
  }
  burst = { t0: animClock, seeds, gravity: 1.6 };
  dirty = true;
}

function onWin() {
  stopClock();
  const ms = clock();
  const better = Store.recordBest(game.puzzle.tier, {
    ms,
    hints: game.hints,
    moves: game.moves,
    size: `${game.n}×${game.n}`,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  el.winMeta.textContent = `${tierFor(game.puzzle.tier).name} · ${game.n}×${game.n} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent = better ? '新纪录：这一局比存档里的更不求人。' : '未破纪录：同档先比提示次数。';
  el.winVeil.hidden = false;
  spawnBurst();
  Sound.win();
  renderRecords();
}

function afterStep(soundKey) {
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (soundKey) Sound[soundKey]();
    if (game.stuck || game.diag.conflicts) Sound.conflict();
  }
}

function useHint() {
  if (!interactive()) return null;
  const before = game.hints;
  const info = game.hint();
  if (!info) return null;
  showHint(info);
  // An unproductive hint is not a purchase: nothing was written, nothing is charged.
  if (game.hints !== before) afterStep('place');
  else syncAll();
  return info;
}

function undo() {
  if (!game || paused) return null;
  const step = game.undo();
  if (!step) return null;
  pulse = null;
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

// 一局的全部可变状态在这一个函数里清零：漏一项就是"重开之后还带着上一局的余温"。
function resetRunState() {
  pulse = null;
  stroke = null;
  burst = null;
  note = { text: '', good: false };
  paused = false;
  animClock = 0;
  lastFrame = -1;
  frames = 0;
  baseElapsed = 0;
  startedAt = 0;
  lastShownSecond = -1;
  el.winVeil.hidden = true;
  el.pauseVeil.hidden = true;
  syncPauseHud();
}

function begin({ tier = 'trainee', seed = null, resume = null } = {}) {
  const origin = seed || `s${Math.floor(Math.random() * 1e9)}`;
  const puzzle = makePuzzle(origin, tier);
  if (!puzzle) return null;
  resetRunState();
  game = new Game(puzzle);
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.cursor = 0;
    game.load(resume.board);
  }
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  syncAll();
  flushResume();
  renderResumeCard();
  return game;
}

// 重开本局 ≠ 换一局：同一张题面（生成器按 origin seed 确定，所以盘一模一样），
// 把自己填的墨与计时、脉冲、粒子、拖动缓冲一并擦掉。返回前后数值对，供实测复核。
function restart() {
  if (!game) return null;
  const { originSeed, seed: innerSeed, tier } = game.puzzle;
  const from = { moves: game.moves, hints: game.hints, steps: game.steps.length, elapsedMs: clock() };
  const puzzle = makePuzzle(originSeed || innerSeed, tier);
  if (!puzzle) return null;
  resetRunState();
  game = new Game(puzzle);
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。';
  syncAll();
  flushResume();
  return { from, to: { moves: game.moves, hints: game.hints, steps: game.steps.length, elapsedMs: clock() } };
}

function syncPauseHud() {
  el.pauseVeil.hidden = !paused;
  el.btnPause.setAttribute('aria-pressed', String(paused));
  el.btnPause.textContent = paused ? '▶' : '⏸';
  el.btnPause.setAttribute('aria-label', paused ? '继续' : '暂停');
  el.btnPause.title = paused ? '继续 (P)' : '暂停 (P)';
}

// 暂停要做满三件事：计时折进 baseElapsed（虚拟时长因此不再增长）、输入冻结、
// AudioContext 真 suspend。恢复时反过来，盘面一个字节都不动。
function setPaused(next) {
  if (!game || game.status === 'won') return paused;
  const v = !!next;
  if (v === paused) return paused;
  paused = v;
  if (paused) {
    stopClock();
    Sound.setSuspended(true);
    flushResume();
  } else {
    startClock();
    Sound.setSuspended(false);
  }
  syncPauseHud();
  syncStats();
  dirty = true;
  draw();
  return paused;
}

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

function syncFullHud() {
  const on = !!fullscreenElement();
  el.btnFull.setAttribute('aria-pressed', String(on));
  el.btnFull.setAttribute('aria-label', on ? '退出全屏' : '全屏');
  el.btnFull.title = on ? '退出全屏 (F)' : '全屏 (F)';
  return on;
}

// iOS Safari 与 Electron 的老版本各有各的前缀；两边都没有时按钮仍在、状态不改，
// 比抛一个未捕获的 rejection 诚实。
function toggleFullscreen() {
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const target = fullscreenElement() ? exit : req;
  if (!target) return Promise.resolve(syncFullHud());
  let p;
  try {
    p = target.call(fullscreenElement() ? document : root);
  } catch {
    return Promise.resolve(syncFullHud());
  }
  return p && typeof p.then === 'function'
    ? p.then(() => syncFullHud()).catch(() => syncFullHud())
    : Promise.resolve(syncFullHud());
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    stopLoop();
    stopClock();
    pulse = null;
    burst = null;
    paused = false;
    Sound.setSuspended(false);
    syncPauseHud();
    renderMenu();
  }
  if (which === 'game') {
    startLoop();
    draw();
  }
  return which;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderResumeCard();
}

const TIER_NOTE = {
  trainee: '格少、给得多，一行一眼数得完',
  apprentice: '开始要用"半数已满"倒推空格',
  regular: '三连与各半得连着看',
  expert: '给的格子不到三成，全靠排除',
  master: '盘大题疏，一步放错整列堵死',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${t.name}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.key] || ''}</span>` +
      `<span class="tier-size mono">${t.n}×${t.n} · 实测 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume();
  // Do not offer "继续" for the board already on screen.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.seed === game.puzzle.originSeed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} 的一局`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次`;
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  // 关了动效就不该还有东西在飘：已经在飞的粒子与脉冲当场清掉。
  if (reduce && (burst || pulse)) {
    burst = null;
    pulse = null;
    dirty = true;
  }
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
}

// ---- pointer gestures: down picks the symbol for the whole stroke, up commits one step -------

// During a drag the cells are painted ahead of the commit so the picture follows the finger.
// Each preview remembers the state the cell had *before* the gesture, because the committed step
// has to record that as its undo target.
function preview(t, value) {
  stroke.items.push({ cell: t, from: game.st.grid[t] });
  game.st.grid[t] = value;
  game.recompute();
}

function unpreview() {
  for (const it of stroke.items) game.st.grid[it.cell] = it.from;
  game.recompute();
}

function pointerDown(ev) {
  if (!interactive()) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  ev.preventDefault();
  el.canvas.setPointerCapture?.(ev.pointerId);
  note = { text: '', good: false };
  if (!game.writable(t)) {
    note = { text: '这一格是题面给的，改不了', good: false };
    renderStateLine();
    return;
  }
  stroke = { items: [] };
  // The cycle decides the value once, at the start: empty → ○, ○ → ●, ● → 空. The whole drag then
  // paints that one symbol, so a stroke never depends on what each cell happened to hold.
  stroke.value = Engine.nextValue(game.st, t);
  preview(t, stroke.value);
  draw();
}

function pointerMove(ev) {
  if (!stroke || !game) return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0 || !game.writable(t)) return;
  if (stroke.items.some((it) => it.cell === t) || game.st.grid[t] === stroke.value) return;
  preview(t, stroke.value);
  draw();
}

function pointerUp() {
  if (!stroke || !game) return null;
  const s = stroke;
  const cells = s.items.map((it) => it.cell);
  unpreview();
  stroke = null;
  const step = game.stroke(cells, s.value);
  if (!step) {
    syncAll();
    return null;
  }
  afterStep(s.value === EMPTY ? 'rub' : 'place');
  return step;
}

el.canvas.addEventListener('pointerdown', pointerDown);
el.canvas.addEventListener('pointermove', pointerMove);
el.canvas.addEventListener('pointerup', pointerUp);
el.canvas.addEventListener('pointercancel', () => {
  if (!stroke) return;
  unpreview();
  stroke = null;
  syncAll();
});
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

function toggleMute() {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  // 开的那一刻给一声，让玩家知道声音真回来了；关的时候这一调用不会新建任何振荡器。
  Sound.place();
}

$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-restart').addEventListener('click', restart);
$('#btn-pause').addEventListener('click', () => setPaused(!paused));
$('#btn-pause-play').addEventListener('click', () => setPaused(false));
$('#btn-pause-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-full').addEventListener('click', () => toggleFullscreen());
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  if (!r) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-sound').addEventListener('click', toggleMute);
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

// 键盘线：Enter/Space 开局（选档页）或切暂停（关卡内）· P 暂停 · R 重开 · M 静音 ·
// F 全屏 · H 提示 · Z 撤销 · ?/Esc 回选档看规则。
window.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const tag = (ev.target && ev.target.tagName) || '';
  if (/input|textarea|select/i.test(tag)) return;
  // 焦点停在某个按钮上时，Space/Enter 属于浏览器的原生激活，抢过来只会变成"按了没反应"。
  if ((ev.key === ' ' || ev.key === 'Enter') && tag === 'BUTTON') return;
  const menu = el.viewGame.hidden;
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  const take = (fn) => {
    ev.preventDefault();
    fn();
  };

  if (k === 'Enter' || k === ' ') return menu ? take(() => begin({ tier: 'trainee' })) : take(() => setPaused(!paused));
  if (k === 'p') return take(() => setPaused(!paused));
  if (k === 'r' && !menu) return take(restart);
  if (k === 'm') return take(toggleMute);
  if (k === 'f') return take(() => toggleFullscreen());
  if (k === 'h') return take(useHint);
  if (k === 'z') return take(undo);
  if (k === '?' || k === 'Escape') return take(() => show('menu'));
  return undefined;
});

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushResume();
    // 人已经离开这一页了，计时不该继续走：自动进暂停，回来由玩家亲手续。
    if (game && game.status !== 'won' && !paused) setPaused(true);
  }
});
window.addEventListener('pagehide', flushResume);
document.addEventListener('fullscreenchange', syncFullHud);
document.addEventListener('webkitfullscreenchange', syncFullHud);

applyThemeVars();
applySettings();
renderMenu();

window.takuzu = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  restart,
  setPaused,
  toggleFullscreen,
  toggleMute,
  useHint,
  undo,
  // 窗口状态挂出来：任何探针读不到状态的仓，判据都无法复验。
  runtime: () => ({
    paused,
    animClock,
    frames,
    elapsedMs: clock(),
    running: running(),
    screen: el.viewGame.hidden ? 'menu' : 'game',
    pulse: !!pulse,
    pulseProgress: pulse ? Math.min(1, (animClock - pulse.t0) / PULSE_LIFE) : 0,
    particles: burst ? burst.seeds.length : 0,
    burstAge: burst ? animClock - burst.t0 : -1,
    reduceMotion: prefersReducedMotion(),
    fullscreen: !!fullscreenElement(),
    audio: Sound.state(),
  }),
  // The harness commits through the same path a pointer release does, so a scenario that passes
  // here has driven the real state machine rather than a copy of it.
  stroke(cells, value) {
    if (!interactive()) return null;
    const step = game.stroke(cells, value);
    if (step) afterStep(step.value === EMPTY ? 'rub' : 'place');
    return step;
  },
  tap(t) {
    if (!interactive()) return null;
    const step = game.tap(t);
    if (step) afterStep(step.value === EMPTY ? 'rub' : 'place');
    return step;
  },
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock() } : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  valueOf: (t) => (game ? game.valueOf(t) : EMPTY),
  sym,
  stateLine: () => el.stateLine.textContent,
  engine: {
    ...Engine,
    makePuzzle,
    generate,
    randomGrid,
    hideCells,
    countSolutions,
    TIERS,
    tierFor,
    Game,
    Store,
    theme: { ...Palette, Cell },
    EMPTY,
    ZERO,
    ONE,
  },
};
