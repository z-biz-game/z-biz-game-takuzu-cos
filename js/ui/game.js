// The playable state machine: what a tap does, what an undo takes back, when a board counts as
// solved, and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/takuzu.js:
//   * the ink lives in the engine's own `st.grid`, and the win check is the engine's independent
//     `verify()` — written from the rules of the game rather than from this file's bookkeeping —
//     so "the UI said I won" cannot disagree with "every line is half and half with no three".
//   * hints are read out of a script the *givens* produced (`solve()`), never from the player's
//     own marks. A wrong symbol therefore cannot make the hints agree with the mistake.

import {
  createState,
  setCell,
  snapshot,
  undo as undoState,
  nextValue,
  isGiven,
  solve,
  verify,
  complete,
  reachable,
  diagnose,
  Rules,
  EMPTY,
  ZERO,
  ONE,
  sym,
} from '../engine/takuzu.js';

export { EMPTY, ZERO, ONE, sym };

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.n = puzzle.board.n;
    this.w = puzzle.board.n;
    this.h = puzzle.board.n;
    this.st = createState(puzzle.board);
    this.script = solve(puzzle.board).rows;
    this.cursor = 0;
    this.steps = [];
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    this.lastHint = null;
    this.recompute();
  }

  // 重开**同一道题**：把这一局整个归零，题面不动。
  //
  // 本仓与同族那几仓有个结构差别：引擎这边**没有** resetXxx() 这类复位函数，
  // createState() 才是造一份干净状态的入口（grid 从题面重铺、history 清空），
  // 所以这里直接换一份新的 st，而不是在旧 st 上逐字段清——后者漏一个字段就是
  // 半局的痕迹（实测只清盘面时 steps 6 → 6、cursor 40 → 40，玩家还按得动撤销
  // 回到走错那一步）。
  //
  // 换 st 之外，UI 层那一堆各自独立存着的缓存仍要挨个点名：撤销栈 this.steps、
  // 步数 this.moves、提示次数 this.hints、提示游标 this.cursor、胜负 this.status、
  // 上一条提示文案 this.lastHint。提示游标尤其要点：它决定下一条提示从推导脚本的
  // 哪一行继续，不归零的话重开后的第一条提示会被跳过，玩家会觉得提示坏了。
  resetAll() {
    this.st = createState(this.board);  // 盘面重铺 + 引擎 history 清空
    this.steps = [];                    // UI 撤销栈：换 st 清的是引擎那份，这份在 UI 层
    this.moves = 0;                     // 步数归零
    this.hints = 0;                     // 提示次数归零：提示要收钱，留着等于让玩家白嫖上一局的帮助
    this.cursor = 0;                    // 提示脚本从头再来
    this.status = 'playing';            // 胜负回判：上一局赢了也不能把重开后的盘算成已通关
    this.lastHint = null;               // 上一条提示文案属于上一局
    this.recompute();
    return this;
  }

  recompute() {
    this.diag = diagnose(this.board, this.st.grid);
    this.problems = verify(this.board, this.st.grid);
    this.stuck = !reachable(this.board, this.st.grid);
    return this.diag;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.n || y >= this.n) return -1;
    return y * this.n + x;
  }

  valueOf(t) {
    return t >= 0 && t < this.board.size ? this.st.grid[t] : EMPTY;
  }

  writable(t) {
    return t >= 0 && t < this.board.size && !isGiven(this.board, t);
  }

  // Every gesture consumes exactly one engine snapshot and records the cells it changed with
  // their prior values, so 撤销 is an exact reverse rather than a re-derivation.
  commit(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else this.moves++;
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  // One predictable cycle: empty → ○ → ● → empty. Tapping a given cell does nothing at all.
  tap(t) {
    if (this.status === 'won' || !this.writable(t)) return null;
    const from = this.st.grid[t];
    const want = nextValue(this.st, t);
    if (!setCell(this.st, t, want)) return null;
    return this.commit('tap', { writes: [{ cell: t, from, to: want }], value: want });
  }

  // A drag paints one value; cells the drag passes over are set, never toggled — otherwise
  // sweeping back across your own marks would eat them mid-gesture.
  stroke(cells, value) {
    if (this.status === 'won') return null;
    const writes = [];
    const seen = new Set();
    for (const t of cells) {
      if (!this.writable(t) || seen.has(t)) continue;
      seen.add(t);
      if (this.st.grid[t] === value) continue;
      writes.push({ cell: t, from: this.st.grid[t], to: value });
    }
    if (!writes.length) return null;
    snapshot(this.st);
    for (const w of writes) this.st.grid[w.cell] = w.to;
    return this.commit('stroke', { writes, value });
  }

  load(grid) {
    for (let t = 0; t < this.board.size; t++) {
      const v = grid[t];
      this.st.grid[t] = v === ZERO || v === ONE ? v : this.board.grid[t];
    }
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    for (const w of step.writes || []) this.st.grid[w.cell] = w.from;
    // A hint taken back is still a hint that was taken: records rank runs by help used, so
    // refunding the counter would let a player undo their way to a clean 提示 0.
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    return step;
  }

  hint() {
    if (this.status === 'won') return null;
    while (this.cursor < this.script.length) {
      const row = this.script[this.cursor];
      if (this.st.grid[row.cell] === row.value) {
        this.cursor++;
        continue;
      }
      if (this.st.grid[row.cell] !== EMPTY && this.st.grid[row.cell] !== row.value) {
        return {
          conflict: `${this.board.cellName(row.cell)} 上的 ${sym(this.st.grid[row.cell])} 与题面矛盾：这里只能是 ${sym(row.value)}。`,
          cell: row.cell,
        };
      }
      const from = this.st.grid[row.cell];
      setCell(this.st, row.cell, row.value);
      this.cursor++;
      this.commit('hint', { writes: [{ cell: row.cell, from, to: row.value }], value: row.value, rule: row.rule.name });
      const info = {
        rule: row.rule.name,
        cell: row.cell,
        value: row.value,
        line: row.line,
        why: row.rule.text(this.board, row),
        charged: true,
      };
      this.lastHint = info;
      return info;
    }
    return { stalled: true, text: '题面能推的都已经推完了：剩下的格子只能自己收尾。' };
  }

  checkWin() {
    this.status = complete(this.board, this.st.grid) ? 'won' : 'playing';
    return this.status === 'won';
  }

  // Used by the verification harness and nothing else: play the clue-derived script to its end.
  solveWithLogic({ cap = 4000 } = {}) {
    let k = 0;
    while (this.status !== 'won' && k++ < cap) {
      const before = this.steps.length;
      const h = this.hint();
      if (!h || h.stalled || h.conflict) break;
      if (this.steps.length === before) break;
    }
    return { status: this.status, steps: k };
  }

  state() {
    const g = this.diag;
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      filled: g.filled,
      total: g.total,
      remaining: g.remaining,
      givens: g.givens,
      linesDone: g.linesDone,
      linesTotal: g.linesTotal,
      conflicts: g.conflicts,
      stuck: this.stuck,
      script: this.script.length,
      cursor: this.cursor,
      score: this.puzzle.score,
      steps: this.steps.length,
    };
  }
}

export { Rules };
