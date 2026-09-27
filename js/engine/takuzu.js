// Takuzu / Binairo engine. An even n×n grid of two symbols; no three equal symbols may touch in
// a row or column, and every row and column holds exactly n/2 of each. A cell's value is the
// whole state, so the engine is one array and the rules are statements about a single line.
//
// `solve()` below is the pencil path: the player's route, the generator's acceptance test and the
// source of every hint, so it never backtracks. Search lives only in count.js, and the generator
// trusts neither.

export const EMPTY = -1;
export const ZERO = 0; // ○
export const ONE = 1; // ●

export const other = (v) => (v === ZERO ? ONE : ZERO);

export function createBoard({ n, grid }) {
  if (!(n >= 4 && n % 2 === 0)) throw new Error('数白的边长必须是 ≥4 的偶数');
  if (grid.length !== n * n) throw new Error('grid length mismatch');
  const rows = [];
  const cols = [];
  for (let r = 0; r < n; r++) rows.push(Array.from({ length: n }, (_, c) => r * n + c));
  for (let c = 0; c < n; c++) cols.push(Array.from({ length: n }, (_, r) => r * n + c));
  const cellLines = Array.from({ length: n * n }, (_, t) => [rows[(t / n) | 0], cols[t % n]]);
  let givens = 0;
  for (let t = 0; t < n * n; t++) {
    const v = grid[t];
    if (v === EMPTY) continue;
    if (v !== ZERO && v !== ONE) throw new Error(`格子 ${t} 的值 ${v} 不是两种符号之一`);
    givens++;
  }
  // One given at minimum: with nothing stated, every legal grid is a solution and there is no
  // puzzle to solve. How *many* givens make a good puzzle is the generator's business, not this
  // constructor's.
  if (!givens) throw new Error('盘上没有题面');
  return {
    n,
    half: n / 2,
    size: n * n,
    grid: Int8Array.from(grid),
    rows,
    cols,
    lines: [...rows, ...cols],
    cellLines,
    givens,
    lineName: (line) => {
      const first = line[0];
      const r = (first / n) | 0;
      const c = first % n;
      return r * n + c === first && c === 0 ? `第${r + 1}行` : `第${c + 1}列`;
    },
    cellName: (t) => `第${((t / n) | 0) + 1}行${(t % n) + 1}列`,
  };
}

// ---- the two rules of the game, as checks --------------------------------------------------

// A run of three equal *known* symbols. Empty cells are not a violation yet — they are the
// reason a partially filled line must not be judged by the complete-line rules.
export function run3(line, get) {
  for (let i = 0; i + 2 < line.length; i++) {
    const a = get(line[i]);
    if (a !== EMPTY && a === get(line[i + 1]) && a === get(line[i + 2])) return [line[i], line[i + 1], line[i + 2]];
  }
  return null;
}

export function tally(board, line, get) {
  let z = 0;
  let o = 0;
  let open = 0;
  for (const t of line) {
    const v = get(t);
    if (v === EMPTY) open++;
    else if (v === ZERO) z++;
    else o++;
  }
  return { z, o, open, half: board.half };
}

// ---- the pencil rules -----------------------------------------------------------------------

export const Rules = {
  pair: {
    name: '禁止三连',
    weight: 1,
    text: (b, d) => `${b.lineName(d.line)} 里已经有两个相邻的 ${sym(d.value)}，它两边的格子都只能是 ${sym(other(d.value))}`,
  },
  // One rule, two readings: "this line already holds n/2 ○" and "this line still needs exactly
  // as many ○ as it has blanks" are the same fact (z + open === half ⟺ o === half), so naming
  // both would be a rule list with an alias in it.
  majority: {
    name: '半数已满',
    weight: 1.5,
    text: (b, d) => `${b.lineName(d.line)} 里 ${sym(d.symbol)} 已经有 ${b.half} 个，这一${b.lineName(d.line)[1] === '行' ? '行' : '列'}剩下的格只能是 ${sym(d.value)}`,
  },
  forbid: {
    name: '这格放不下',
    weight: 2,
    text: (b, d) => `${b.cellName(d.cell)} 如果放 ${sym(d.bad)}，${b.lineName(d.line)} 立刻违规——所以这格只能是 ${sym(d.value)}`,
  },
};

export const sym = (v) => (v === ZERO ? '○' : v === ONE ? '●' : '空');

// One sweep over every line. Each write below follows from a single line's own counts or from the
// three-in-a-row ban, so it holds in every completion of the board.
export function propagate(board, dom) {
  const found = [];
  let changed = false;
  const get = (t) => (dom[t].length === 1 ? dom[t][0] : EMPTY);
  // narrow(t, v): rule out symbol v for cell t. Returns 'dead' when nothing is left, true when
  // the cell just became decided (and the caller labels which rule did it).
  const narrow = (t, v) => {
    const d = dom[t];
    if (d.length === 1) return d[0] === v ? 'dead' : false;
    if (!d.includes(v)) return false;
    const next = d.filter((x) => x !== v);
    dom[t] = next;
    if (!next.length) return 'dead';
    if (next.length === 1) found.push({ cell: t, value: next[0] });
    changed = true;
    return true;
  };
  const label = (wrote, rule, extra) => {
    if (wrote !== true) return wrote;
    const last = found[found.length - 1];
    if (last && !last.rule) Object.assign(last, { rule, ...extra });
    return true;
  };
  const dead = () => ({ found: [], changed: false, dead: true });

  for (const line of board.lines) {
    const { z, o, open, half } = tally(board, line, get);
    if (z > half || o > half || z + open < half || o + open < half) return dead();
    for (const t of line) {
      if (get(t) !== EMPTY) continue;
      if (z === half && label(narrow(t, ZERO), Rules.majority, { line, symbol: ZERO }) === 'dead') return dead();
      if (o === half && label(narrow(t, ONE), Rules.majority, { line, symbol: ONE }) === 'dead') return dead();
    }
    // 禁止三连：相邻两格同符，这条线上它们两侧的格必须是另一符
    for (let i = 0; i + 1 < line.length; i++) {
      const a = get(line[i]);
      if (a === EMPTY || a !== get(line[i + 1])) continue;
      for (const j of [i - 1, i + 2]) {
        if (j < 0 || j >= line.length) continue;
        const t = line[j];
        if (get(t) !== EMPTY) continue;
        if (label(narrow(t, a), Rules.pair, { line, symbol: a }) === 'dead') return dead();
      }
    }
  }

  // 这格放不下那个符：把某个符试进这一格，所在行或列立刻违规 → 这格只能是另一个。
  // Rows and columns are separate arrays, so a line never wraps: the guard is just array bounds.
  for (let t = 0; t < board.size; t++) {
    if (dom[t].length !== 2) continue;
    const broken = [];
    for (const v of [ZERO, ONE]) {
      for (const line of board.cellLines[t]) {
        const try_ = (x) => (x === t ? v : get(x));
        const { z, o, open, half } = tally(board, line, try_);
        if (run3(line, try_) || z > half || o > half || z + open < half || o + open < half) broken.push([v, line]);
      }
    }
    const impossible = [...new Set(broken.map(([v]) => v))];
    if (impossible.length === 2) return dead();
    if (impossible.length === 1) {
      const [bad, line] = broken.find(([v]) => v === impossible[0]);
      if (label(narrow(t, bad), Rules.forbid, { line, bad, cell: t }) === 'dead') return dead();
    }
  }
  return { found, changed };
}

// The pencil path from the givens alone. The returned rows are the hint script: the same list
// the generator judged the board by.
export function solve(board) {
  const dom = Array.from({ length: board.size }, (_, t) =>
    board.grid[t] === EMPTY ? [ZERO, ONE] : [board.grid[t]]
  );
  const rows = [];
  const used = new Map();
  for (let round = 0; round < board.size * 4; round++) {
    const sweep = propagate(board, dom);
    if (sweep.dead) return { ok: false, dead: true, rows, steps: rows.length, score: 0, breakdown: {} };
    for (const f of sweep.found) {
      const key = f.rule.name;
      const cur = used.get(key) || { n: 0, weight: f.rule.weight };
      cur.n++;
      used.set(key, cur);
      rows.push({ cell: f.cell, value: f.value, rule: f.rule, line: f.line, need: f.need, bad: f.bad, symbol: f.symbol });
    }
    if (!sweep.changed) break;
  }
  const filled = dom.every((d) => d.length === 1);
  let score = 0;
  for (const x of used.values()) score += x.n * x.weight;
  const grid = filled ? Int8Array.from(dom.map((d) => d[0])) : null;
  return {
    ok: filled,
    dead: false,
    grid,
    dom,
    rows,
    steps: rows.length,
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries([...used].map(([k, v]) => [k, v.n])),
  };
}

export function nextDeduction(board, dom) {
  const copy = dom.map((d) => d.slice());
  const sweep = propagate(board, copy);
  if (sweep.dead) return { dead: true };
  return sweep.found[0] || null;
}

// ---- is this ink still survivable? ---------------------------------------------------------

// Every write the line rules make holds in every completion, so if seeding the player's own
// symbols and running those rules reaches a contradiction, no completion of this board exists.
export function reachable(board, grid) {
  const dom = Array.from({ length: board.size }, (_, t) =>
    grid[t] === EMPTY ? (board.grid[t] === EMPTY ? [ZERO, ONE] : [board.grid[t]]) : [grid[t]]
  );
  for (let round = 0; round < board.size * 4; round++) {
    const sweep = propagate(board, dom);
    if (sweep.dead) return false;
    if (!sweep.changed) break;
  }
  return true;
}

// ---- acceptance test, independent of the machinery above ------------------------------------

// Judged straight from the rules of the game: every cell filled, no three in a row, every line
// half and half, and no given cell contradicted. It reads no domain and no hint script.
export function verify(board, grid) {
  const bad = [];
  const get = (t) => grid[t];
  for (let t = 0; t < board.size; t++) {
    if (grid[t] === EMPTY) bad.push({ why: '空格', cell: t });
    else if (board.grid[t] !== EMPTY && board.grid[t] !== grid[t]) bad.push({ why: '与题面不符', cell: t });
  }
  for (const line of board.lines) {
    const run = run3(line, get);
    if (run) bad.push({ why: '三连', cells: run, line });
    const { z, o, half } = tally(board, line, get);
    if (z !== half || o !== half) bad.push({ why: '两符不等', line, z, o, half });
  }
  return bad;
}

export function complete(board, grid) {
  return verify(board, grid).length === 0;
}

// What the player has *already* broken. verify() is the end-of-game judge and counts every empty
// cell and every unfinished line; a readout that used it would sit at "36 处冲突" on a board
// nobody has touched yet. This one only reports a mistake the ink itself made.
export function violations(board, grid) {
  const bad = [];
  const get = (t) => grid[t];
  for (let t = 0; t < board.size; t++) {
    if (board.grid[t] !== EMPTY && grid[t] !== EMPTY && board.grid[t] !== grid[t]) bad.push({ why: '与题面不符', cell: t });
  }
  for (const line of board.lines) {
    const run = run3(line, get);
    if (run) bad.push({ why: '三连', cells: run, line });
    const { z, o, open, half } = tally(board, line, get);
    if (z > half || o > half) bad.push({ why: '超过半数', line, z, o, half });
    else if (z + open < half || o + open < half) bad.push({ why: '凑不够半数', line, z, o, open, half });
  }
  return bad;
}

export function diagnose(board, grid) {
  let filled = 0;
  for (let t = 0; t < board.size; t++) if (grid[t] !== EMPTY) filled++;
  const problems = violations(board, grid);
  const badCells = new Set();
  const badLines = new Set();
  for (const p of problems) {
    if (p.cells) for (const t of p.cells) badCells.add(t);
    if (p.cell != null) badCells.add(p.cell);
    if (p.line) badLines.add(board.lineName(p.line));
  }
  const doneLines = board.lines.filter((line) => {
    const { z, o, half } = tally(board, line, (t) => grid[t]);
    return z === half && o === half && !run3(line, (t) => grid[t]);
  }).length;
  return {
    filled,
    total: board.size,
    remaining: board.size - filled,
    givens: board.givens,
    badCells,
    badLines,
    conflicts: problems.length,
    linesDone: doneLines,
    linesTotal: board.lines.length,
  };
}

// ---- the player's own grid ------------------------------------------------------------------

export function createState(board) {
  return { board, grid: Int8Array.from(board.grid), history: [] };
}

export function snapshot(st) {
  st.history.push(Int8Array.from(st.grid));
  if (st.history.length > 500) st.history.shift();
  return st;
}

export function undo(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.grid.set(last);
  return true;
}

export function isGiven(board, t) {
  return board.grid[t] !== EMPTY;
}

export function setCell(st, t, value) {
  if (t < 0 || t >= st.board.size || isGiven(st.board, t)) return false;
  if (st.grid[t] === value) return false;
  snapshot(st);
  st.grid[t] = value;
  return true;
}

// One predictable cycle for taps and drag starts: empty → ○ → ● → empty.
export function nextValue(st, t) {
  if (isGiven(st.board, t)) return null;
  const cur = st.grid[t];
  return cur === EMPTY ? ZERO : cur === ZERO ? ONE : EMPTY;
}

export function eraseCell(st, t) {
  return setCell(st, t, EMPTY);
}
