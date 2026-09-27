// Generator. Solution first: fill the grid symbol by symbol so no line ever breaks a rule, and
// the puzzle is that grid with most of its cells hidden. A board therefore cannot be born
// unsolvable — the answer is what we planted. Difficulty is the one knob the game has: how many
// symbols stay visible. A hiding is kept only if the pencil path still finishes the board, so
// "unique" and "no guessing" are the same test here, and count.js exists to check the two have
// not drifted apart.

import { EMPTY, ZERO, ONE, createBoard, solve, verify, run3, tally } from './takuzu.js';

function mix(seed) {
  let x = typeof seed === 'string' ? 2166136261 : seed >>> 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
  }
  x = x || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

// A legal full grid, built by scan-order fill with backtracking. Every partial line stays
// winnable, so the first complete grid is a real solution rather than a candidate to check.
export function randomGrid(n, rand, budget = 300000) {
  const half = n / 2;
  const size = n * n;
  const g = new Int8Array(size).fill(EMPTY);
  const rows = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => r * n + c));
  const cols = Array.from({ length: n }, (_, c) => Array.from({ length: n }, (_, r) => r * n + c));
  const lines = [];
  for (let t = 0; t < size; t++) lines.push([rows[(t / n) | 0], cols[t % n]]);
  const fits = (t, v) => {
    for (const line of lines[t]) {
      let z = 0;
      let o = 0;
      let open = 0;
      for (const x of line) {
        const val = x === t ? v : g[x];
        if (val === EMPTY) open++;
        else if (val === ZERO) z++;
        else o++;
      }
      if (z > half || o > half || z + open < half || o + open < half) return false;
      for (let i = 0; i + 2 < line.length; i++) {
        const a = line[i] === t ? v : g[line[i]];
        if (a !== EMPTY && a === (line[i + 1] === t ? v : g[line[i + 1]]) && a === (line[i + 2] === t ? v : g[line[i + 2]])) return false;
      }
    }
    return true;
  };
  let nodes = 0;
  function go(t) {
    if (nodes++ > budget) return false;
    if (t === size) return true;
    const order = rand() < 0.5 ? [ZERO, ONE] : [ONE, ZERO];
    for (const v of order) {
      if (!fits(t, v)) continue;
      g[t] = v;
      if (go(t + 1)) return true;
      g[t] = EMPTY;
    }
    return false;
  }
  return go(0) ? g : null;
}

// Hide cells one at a time, shuffled. A hiding survives only while the pencil path still reaches
// every remaining cell — which, because each rule writes only what every completion must hold,
// also proves the answer is unique.
export function hideCells(board, rand, target) {
  const grid = Int8Array.from(board.grid);
  let shown = board.givens;
  const order = [];
  for (let t = 0; t < grid.length; t++) order.push(t);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const t of order) {
    if (shown <= target) break;
    if (grid[t] === EMPTY) continue;
    grid[t] = EMPTY;
    shown--;
    const probe = createBoard({ n: board.n, grid });
    if (!solve(probe).ok) {
      grid[t] = board.grid[t];
      shown++;
    }
  }
  return grid;
}

export function generate(opts = {}) {
  const { n = 6, seed = 'plain', keepRatio = 0.3, band = null, tries = 40, report = () => {} } = opts;
  const target = Math.max(n, Math.round(n * n * keepRatio));
  let best = null;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const rand = mix(trial);
    let board;
    let solution;
    try {
      solution = randomGrid(n, rand);
      if (!solution) continue;
      board = createBoard({ n, grid: solution });
      board = createBoard({ n, grid: hideCells(board, rand, target) });
    } catch {
      continue;
    }
    const p = solve(board);
    if (!p.ok) continue;
    if (verify(board, p.grid).length) continue;
    const offBand = band ? Math.abs(p.score - clamp(p.score, band[0], band[1])) : 0;
    const cand = {
      board,
      solution,
      seed: trial,
      score: p.score,
      steps: p.steps,
      breakdown: p.breakdown,
      givens: board.givens,
      offBand,
      gen: k + 1,
    };
    if (!best || cand.offBand < best.offBand) best = cand;
    report({ k, score: p.score, givens: board.givens, offBand });
    if (band && cand.offBand === 0) break;
  }
  if (!best) return { ok: false, board: null, reason: '没找到既唯一又能纯逻辑推到底的盘面' };
  return { ok: true, ...best };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Bands are selection targets, and every number below is the measured spread of that
// (n, keepRatio) pair — 12 boards per tier on 2026-09-27, medians 11.5 / 40.5 / 77 / 120.5 / 177
// with a spread of a few points around each. tools/balance.mjs re-measures them and fails the
// build when the ladder stops ordering or a tier stops landing in its own band.
export const TIERS = [
  { key: 'trainee', name: '初学', n: 4, keepRatio: 0.55, band: [9, 15] },
  { key: 'apprentice', name: '上手', n: 6, keepRatio: 0.34, band: [36, 46] },
  { key: 'regular', name: '熟练', n: 8, keepRatio: 0.28, band: [70, 88] },
  { key: 'expert', name: '高阶', n: 10, keepRatio: 0.26, band: [110, 135] },
  { key: 'master', name: '大师', n: 12, keepRatio: 0.25, band: [160, 195] },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = generate({ n: tier.n, seed, keepRatio: tier.keepRatio, band: tier.band, tries: tier.tries || 60 });
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.n}×${tier.n}`,
    n: tier.n,
    w: tier.n,
    h: tier.n,
  };
}

export { EMPTY, ZERO, ONE, run3, tally };
