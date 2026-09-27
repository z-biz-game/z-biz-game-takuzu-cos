// An exhaustive counter. It shares no rule, no domain and no helper with takuzu.js's solver — the
// lines are rebuilt here from the rules of the game, because the point of a second opinion is that
// a mistake in the first one cannot show up in both.
//
// It answers one question — how many completions does this clue set have? — and stops at `cap`,
// spending its node budget rather than lying about a board it could not finish counting.

export const EMPTY = -1;
export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE';
export const OVERBUDGET = 'OVERBUDGET';

export function countSolutions(board, { cap = 2, budget = 400000 } = {}) {
  const n = board.n;
  const half = n / 2;
  const size = n * n;
  // rebuilt here on purpose: rows left-to-right, columns top-to-bottom, no shared table
  const rowsOf = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => r * n + c));
  const colsOf = Array.from({ length: n }, (_, c) => Array.from({ length: n }, (_, r) => r * n + c));
  const lineOf = [];
  for (let t = 0; t < size; t++) lineOf.push([rowsOf[(t / n) | 0], colsOf[t % n]]);
  const g = Int8Array.from(board.grid);
  let nodes = 0;
  let solutions = 0;
  let first = null;
  let over = false;

  // A line is still winnable if the symbol counts, with every undecided cell going either way,
  // can still land on half/half — and no three equal symbols may already touch.
  function feasible(line, t, v) {
    let z = 0;
    let o = 0;
    let open = 0;
    for (const x of line) {
      const val = x === t ? v : g[x];
      if (val === EMPTY) open++;
      else if (val === 0) z++;
      else o++;
      if (z > half || o > half) return false;
    }
    if (z + open < half || o + open < half) return false;
    for (let i = 0; i + 2 < line.length; i++) {
      const a = (line[i] === t ? v : g[line[i]]);
      if (a === EMPTY) continue;
      if (a === (line[i + 1] === t ? v : g[line[i + 1]]) && a === (line[i + 2] === t ? v : g[line[i + 2]])) return false;
    }
    return true;
  }

  function go(t) {
    if (nodes++ > budget) {
      over = true;
      return true;
    }
    if (t === size) {
      solutions++;
      if (!first) first = Int8Array.from(g);
      return solutions >= cap;
    }
    if (g[t] !== EMPTY) return go(t + 1);
    for (const v of [0, 1]) {
      if (!feasible(lineOf[t][0], t, v) || !feasible(lineOf[t][1], t, v)) continue;
      g[t] = v;
      if (go(t + 1)) {
        g[t] = EMPTY;
        return true;
      }
      g[t] = EMPTY;
    }
    return false;
  }
  go(0);
  if (over) return { status: OVERBUDGET, solutions, nodes, first: null };
  return {
    status: solutions >= cap ? MANY : solutions === 1 ? UNIQUE : NONE,
    solutions,
    nodes,
    first,
  };
}
