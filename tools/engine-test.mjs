// Engine unit tests, run in plain Node: `node tools/engine-test.mjs`.
//
// The risk in this repo is not arithmetic but soundness: one rule that wrote a symbol the two
// rules of the game do not force, and every board would still ship, the hints would still read
// well, and "每局都能推到底" would be a caption on a coin flip. So the expectations below are
// hand-derived from grids worked out on paper and written as literals — never read back off the
// solver.

import {
  createBoard,
  createState,
  solve,
  verify,
  complete,
  reachable,
  diagnose,
  propagate,
  nextValue,
  isGiven,
  run3,
  tally,
  Rules,
  sym,
  EMPTY,
  ZERO,
  ONE,
} from '../js/engine/takuzu.js';
import { countSolutions, UNIQUE, MANY, NONE } from '../js/engine/count.js';
import { generate, makePuzzle, randomGrid, hideCells, TIERS } from '../js/engine/generate.js';
import { Store } from '../js/store.js';
import { Game } from '../js/ui/game.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const grid = (rows) => {
  const h = rows.length;
  const w = rows[0].length;
  const g = new Int8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const ch = rows[r][c];
    g[r * w + c] = ch === '○' ? ZERO : ch === '●' ? ONE : EMPTY;
  }
  return { n: w, g };
};
const boardOf = (rows) => {
  const { n, g } = grid(rows);
  return createBoard({ n, grid: g });
};
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};

// ---------- the two rules of the game, hand-checked ----------

// A 4×4 solution worked out on paper: every row and column is ○● in some order, so it is legal,
// and no three ever touch.
const SOL = ['○●●○', '●○○●', '○○●●', '●●○○'];
{
  const b = boardOf(SOL);
  eq('手推的合法盘通过验收', verify(b, b.grid).length, 0);
  eq('验收认它为完整', complete(b, b.grid), true);
  eq('行名带序号', b.lineName(b.rows[1]), '第2行');
  eq('列名带序号', b.lineName(b.cols[2]), '第3列');
  eq('格名带行列', b.cellName(6), '第2行3列');
  eq('符号名', `${sym(ZERO)}${sym(ONE)}${sym(EMPTY)}`, '○●空');
  // run3, hand-picked: ●●● in a row, and none in ○●○●
  eq('三连同符被认出', run3([0, 1, 2, 3], (t) => [ONE, ONE, ONE, ZERO][t]) != null, true);
  eq('交替不算三连', run3([0, 1, 2, 3], (t) => [ONE, ZERO, ONE, ZERO][t]), null);
  eq('空格打断三连', run3([0, 1, 2, 3], (t) => [ONE, EMPTY, ONE, ONE][t]), null);
  const line = b.rows[0];
  const t = tally(b, line, (x) => b.grid[x]);
  eq('第一行 ○ 的个数', t.z, 2);
  eq('第一行 ● 的个数', t.o, 2);
  eq('半数', t.half, 2);
}

// ---------- the givens have to be possible ----------

eq('边长必须是偶数', throws(() => createBoard({ n: 5, grid: new Int8Array(25) })), '数白的边长必须是 ≥4 的偶数');
eq('太小的盘不开', throws(() => createBoard({ n: 2, grid: new Int8Array(4) })), '数白的边长必须是 ≥4 的偶数');
eq('长度不对的数组不放行', throws(() => createBoard({ n: 4, grid: new Int8Array(12) })), 'grid length mismatch');
eq('第三种值不放行', throws(() => createBoard({ n: 4, grid: Int8Array.from([7, ...new Array(15).fill(EMPTY)]) })), '格子 0 的值 7 不是两种符号之一');
eq('一个题面都不给时不开盘', throws(() => createBoard({ n: 4, grid: new Int8Array(16).fill(EMPTY) })), '盘上没有题面');
// One row already holds three ○ in a 4-wide row: no completion exists, and the engine must say
// so rather than wander. Hand count: half = 2, so z = 3 > half.
eq('一行塞进三个 ○ 时判死', solve(createBoard({ n: 4, grid: Int8Array.from([0, 0, 0, -1, ...new Array(12).fill(EMPTY)]) })).dead, true);

// ---------- each rule, on a board solved by hand ----------

// 禁止三连: row 0 = ○ ● ● _ → the last cell of that row can only be ○.
{
  const g = new Int8Array(16).fill(EMPTY);
  g[0] = ZERO;
  g[1] = ONE;
  g[2] = ONE;
  const b = createBoard({ n: 4, grid: g });
  const s = solve(b);
  eq('三连两侧被排掉后落定为 ○', s.dom[3][0], ZERO);
  const pair = s.rows.find((r) => r.cell === 3);
  eq('那一格的规则名', pair && pair.rule.name, '半数已满');
  // the same constraint read the other way: _ ● ● _ with the row's two ○ already elsewhere
  const g2 = new Int8Array(16).fill(EMPTY);
  g2[4] = ZERO;
  g2[5] = ONE;
  g2[6] = ONE;
  g2[7] = ZERO;
  eq('行内 ●● 两侧的 ○ 被排掉', solve(createBoard({ n: 4, grid: g2 })).dom[4][0], ZERO);
}

// 半数已满: a row that already holds n/2 ○ has no room left for another.
{
  const g = new Int8Array(16).fill(EMPTY);
  g[0] = ZERO;
  g[1] = ZERO;
  g[8] = ONE;
  g[9] = ONE;
  g[10] = ZERO;
  g[11] = ZERO;
  const b = createBoard({ n: 4, grid: g });
  const s = solve(b);
  eq('行内 ○ 已满，其余格只能 ●', s.dom[2][0], ONE);
  ok('半数已满这条规则真的出手', Object.keys(s.breakdown).includes('半数已满'), JSON.stringify(s.breakdown));
}

// The other reading of the same fact — "this row still needs exactly as many ○ as it has
// blanks" — must not be billed as a second rule. Row 1 is ●●○○, so row 0's two blanks are forced
// by whichever wording you prefer; the engine has one name for it.
{
  const g = new Int8Array(16).fill(EMPTY);
  g[0] = ZERO;
  g[4] = ONE;
  g[5] = ONE;
  g[6] = ZERO;
  g[7] = ZERO;
  const b0 = createBoard({ n: 4, grid: g });
  const s0 = solve(b0);
  // The negative half of the anchor: from these five givens nothing in row 0 is forced, so a
  // rule set that "derives" a value here is inventing it. (dom[c][0] is the first *candidate*
  // of an undecided cell, which is why the check is on the domain's length.)
  eq('未被逼出的格不会被写成定值', [1, 2, 3].filter((c) => s0.dom[c].length === 1).length, 0);
  // and the positive half, hand-worked: a row that already holds both ● has no room left for one
  const gf = new Int8Array(16).fill(EMPTY);
  gf[0] = ONE;
  gf[1] = ONE;
  gf[8] = ZERO;
  gf[12] = ZERO;
  const sf = solve(createBoard({ n: 4, grid: gf }));
  eq('两个 ● 占满半数后，同行另两格定为 ○', [2, 3].every((c) => sf.dom[c].length === 1 && sf.dom[c][0] === ZERO), true);
  eq('这一格的规则名', sf.rows.find((r) => r.cell === 2).rule.name, '半数已满');
  eq('规则表里没有同义反复的第二条', Object.keys(Rules).length, 3);
  ok('三条规则各有名字', Object.values(Rules).map((r) => r.name).join(',') === '禁止三连,半数已满,这格放不下', Object.values(Rules).map((r) => r.name).join(','));
}

// 这格放不下: a cell whose ○ would complete three-in-a-row above it and whose ● would tip the
// row over half. Hand-built: column 3 already has ● at rows 0 and 1, so (2,3) cannot be ●;
// row 2 already has two ○, so (2,3) cannot be ○ either — the board is dead, not forced.
{
  const g = new Int8Array(16).fill(EMPTY);
  g[3] = ONE;
  g[7] = ONE;
  g[8] = ZERO;
  g[9] = ZERO;
  const b = createBoard({ n: 4, grid: g });
  const s = solve(b);
  eq('两符都不可行时判死', s.dead, true);
  // and the same shape with only the column pressure: (2,3) is forced to ○
  const g2 = new Int8Array(16).fill(EMPTY);
  g2[3] = ONE;
  g2[7] = ONE;
  const b2 = createBoard({ n: 4, grid: g2 });
  const s2 = solve(b2);
  eq('竖着两个 ● 之后，下一格只能是 ○', s2.dom[11][0], ZERO);
  const row = s2.rows.find((r) => r.cell === 11);
  ok('排除法或三连法给出的这一格说得出理由', /只能是/.test(row.rule.text(b2, row)), row.rule.text(b2, row));
}

// ---------- the hint script must be the answer ----------

// The bug this assertion exists for: two rules report "the symbol that filled up" and "the
// symbol that is impossible". If those share a field with the symbol actually being written, the
// hint script tells the player to write the *opposite* of what the solver derived — the board
// still finishes, the text still reads well, and every line ends up broken.
{
  let checked = 0;
  let wrongRow = 0;
  let gridDrift = 0;
  for (const tier of TIERS) {
    for (let s = 0; s < 6; s++) {
      const p = makePuzzle(`script|${s}`, tier.key);
      if (!p) continue;
      checked++;
      const r = solve(p.board);
      for (const row of r.rows) {
        if (row.value !== p.solution[row.cell]) wrongRow++;
        if (row.cell === undefined || row.value === EMPTY) wrongRow++;
      }
      if (r.grid && Array.from(r.grid).join(',') !== Array.from(p.solution).join(',')) gridDrift++;
    }
  }
  ok('检查的局数够多', checked >= 24, String(checked));
  eq('提示脚本的每一格都等于真解', wrongRow, 0);
  eq('铅笔的最终盘等于种下的解', gridDrift, 0);
}

// ---------- the two independent implementations must agree ----------

// Boards come from three sources — full grids, the generator's gated hiding, and a naive hiding
// that no filter touched — because only the last can produce a disagreement.
{
  let unique = 0;
  let many = 0;
  let disagree = 0;
  let pencilButNotUnique = 0;
  for (let s = 0; s < 30; s++) {
    const n = [4, 6, 8][s % 3];
    let x = 4409 + s * 7919;
    const rand = () => {
      x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
      return x / 4294967296;
    };
    const sol = randomGrid(n, rand);
    if (!sol) continue;
    const full = createBoard({ n, grid: sol });
    const loose = new Int8Array(n * n).fill(EMPTY);
    for (let t = 0; t < n * n; t += 3) loose[t] = sol[t];
    const boards = [full, createBoard({ n, grid: hideCells(full, rand, Math.round(n * n * 0.3)) }), createBoard({ n, grid: loose })];
    for (const b of boards) {
      const c = countSolutions(b, { cap: 2, budget: 400000 });
      const p = solve(b);
      if (c.status === 'UNIQUE') {
        unique++;
        if (!p.ok) disagree++;
        else if (Array.from(p.grid).join(',') !== Array.from(c.first).join(',')) disagree++;
      } else if (c.status === 'MANY') {
        many++;
        if (p.ok) pencilButNotUnique++;
      }
    }
  }
  eq('唯一盘一律能推到底且与穷举同解', disagree, 0, `${unique} 个唯一盘`);
  eq('多解盘不会被规则误判推完', pencilButNotUnique, 0, `${many} 个多解盘`);
  ok('样本里两种判定都够多', unique >= 20 && many >= 5, `唯一 ${unique} 多解 ${many}`);
}

// ---------- verify() reads only the board ----------

{
  const b = boardOf(SOL);
  const good = b.grid;
  eq('正解无罪', verify(b, good).length, 0);
  const run = Int8Array.from(good);
  run[1] = ZERO;
  const why = verify(b, run).map((x) => x.why);
  ok('三连被判错', why.includes('三连'), why.join(';'));
  ok('计数跟着被打破', why.includes('两符不等'), why.join(';'));
  const hole = Int8Array.from(good);
  hole[5] = EMPTY;
  ok('留空格被判错', verify(b, hole).some((x) => x.why === '空格'));
  const defy = Int8Array.from(good);
  defy[0] = ONE;
  ok('改到题面给的格被判错', verify(b, defy).some((x) => x.why === '与题面不符'), JSON.stringify(verify(b, defy)));
  // an empty board is not "wrong" in the way a broken line is: only 空格 and 两符不等 show up
  // A board nobody has touched has nothing *broken*: 空格 and unfinished lines are progress, not
  // mistakes. The readout counts only what the ink itself did wrong.
  const d = diagnose(b, new Int8Array(16).fill(EMPTY));
  eq('空盘的已填格为 0', d.filled, 0);
  eq('空盘没有违规', d.conflicts, 0);
  eq('空盘没有填完的行', d.linesDone, 0);
  const half = Int8Array.from(good);
  half[3] = EMPTY;
  eq('擦掉一格不算违规', diagnose(b, half).conflicts, 0);
  const d2 = diagnose(b, good);
  eq('解完之后所有行列都各半', `${d2.linesDone}/${d2.linesTotal}`, '8/8');
  eq('解完之后没有违规', d2.conflicts, 0);
}

// ---------- survivable ink: a warning that is always true ----------

{
  const p = makePuzzle('unit|reach', 'regular');
  const b = p.board;
  eq('空盘当然可完成', reachable(b, new Int8Array(b.size).fill(EMPTY)), true);
  eq('照解填满可完成', reachable(b, p.solution), true);
  const first = solve(b).rows[0];
  const wrong = Int8Array.from(p.solution);
  wrong[first.cell] = first.value === ZERO ? ONE : ZERO;
  eq('把被逼出来的一格画反，判为矛盾', reachable(b, wrong), false);
  const only = new Int8Array(b.size).fill(EMPTY);
  only[first.cell] = wrong[first.cell];
  eq('只画错那一格也判矛盾', reachable(b, only), false);
  const right = new Int8Array(b.size).fill(EMPTY);
  right[first.cell] = first.value;
  eq('画对一格仍可完成', reachable(b, right), true);
}

// ---------- the state machine: the cycle, the stroke, the undo ----------

{
  const p = makePuzzle('unit|game', 'apprentice');
  const g = new Game(p);
  const free = [...Array(p.board.size).keys()].find((t) => !isGiven(p.board, t));
  eq('开局没有冲突', g.state().conflicts, 0);
  g.tap(free);
  eq('第一下是 ○', g.valueOf(free), ZERO);
  g.tap(free);
  eq('第二下换成 ●', g.valueOf(free), ONE);
  g.tap(free);
  eq('第三下清空', g.valueOf(free), EMPTY);
  eq('三下算三步', g.moves, 3);
  for (let i = 0; i < 3; i++) g.undo();
  eq('撤销回到起点', g.moves, 0);
  eq('历史栈与步数对齐', g.st.history.length, g.steps.length);
  const given = [...p.board.grid].findIndex((v) => v !== EMPTY);
  eq('题面给的格不能改', g.tap(given), null);
  const row = Array.from({ length: p.board.n }, (_, c) => c).filter((t) => !isGiven(p.board, t));
  const before = g.moves;
  const step = g.stroke(row, ONE);
  ok('一笔铺满可写的格', !!step && step.writes.length === row.length, JSON.stringify(step && step.writes));
  eq('一笔只算一步', g.moves, before + 1);
  g.undo();
  eq('一次撤销退掉整笔', g.state().filled, p.board.givens);
  eq('退干净后历史栈也空', g.st.history.length, g.steps.length);
  // a stroke over cells that already hold the value writes nothing and costs nothing
  const moves2 = g.moves;
  eq('什么都不写的笔不算一步', g.stroke(row, EMPTY), null);
  eq('步数没动', g.moves, moves2);
}

// ---------- hints come from the givens, not from the player's ink ----------

{
  const p = makePuzzle('unit|hint', 'regular');
  const g = new Game(p);
  const names = new Set(Object.values(Rules).map((r) => r.name));
  let charged = 0;
  let badRule = 0;
  let outOfRange = 0;
  for (let k = 0; k < 400 && g.status !== 'won'; k++) {
    const info = g.hint();
    if (!info || info.stalled) break;
    if (info.conflict) {
      badRule++;
      break;
    }
    charged++;
    if (!names.has(info.rule)) badRule++;
    if (!(info.cell >= 0 && info.cell < p.board.size)) outOfRange++;
    if (g.valueOf(info.cell) !== info.value) badRule++;
    if (!/第\d+行\d+列|第\d+行 |第\d+列 /.test(info.why)) badRule++;
  }
  eq('一路提示能走完这局', g.status, 'won');
  eq('提示次数等于待填格数', charged, p.board.size - p.board.givens);
  eq('提示说的规则与写下的格都对', badRule, 0);
  eq('提示不越界', outOfRange, 0);
  eq('终局通过独立验收', verify(p.board, g.st.grid).length, 0);
  eq('胜利后再按提示不充电', (() => {
    const h = g.hints;
    g.hint();
    return g.hints === h;
  })(), true);
}

{
  const p = makePuzzle('unit|wrong', 'trainee');
  const g = new Game(p);
  const first = g.script[0];
  const wrong = first.value === ZERO ? ONE : ZERO;
  // the cycle is empty → ○ → ● → empty, so reaching a specific symbol takes a specific number of
  // taps; guessing "two taps gets me there" is how this test used to pass by accident
  const tapsTo = (t, v) => {
    for (let k = 0; k < 3 && g.valueOf(t) !== v; k++) g.tap(t);
  };
  tapsTo(first.cell, wrong);
  eq('玩家放上了与真解相反的符', g.valueOf(first.cell), wrong);
  const info = g.hint();
  ok('与题面矛盾时提示拒绝落子', !!info.conflict, JSON.stringify(info));
  eq('拒绝落子时不收钱', g.hints, 0);
  ok('说明写清该放哪个符', /只能是/.test(info.conflict), info.conflict);
  tapsTo(first.cell, EMPTY);
  eq('擦掉错的之后提示才落子', g.hint().value, first.value);
  eq('这次才计一次提示', g.hints, 1);
  eq('提示落的子与真解一致', g.valueOf(first.cell), p.solution[first.cell]);
}

// ---------- storage: the run's cost travels with the board ----------

{
  Store.reset();
  const p = makePuzzle('unit|store', 'expert');
  const full = Int8Array.from(solve(p.board).grid);
  const ink = full.map((v, t) => (t % 3 === 0 ? EMPTY : v));
  Store.saveResume(p, ink, 61000, { moves: 9, hints: 2 });
  const r = Store.resume();
  eq('存档带上步数', r.moves, 9);
  eq('存档带上提示数', r.hints, 2);
  eq('存档带计时', r.elapsedMs, 61000);
  eq('存档能一格不差地还原符号', Array.from(r.board).join(','), Array.from(ink).join(','));
  ok('空格还原后仍是空格', r.board.some((v) => v === EMPTY) && r.board.every((v) => v === EMPTY || v === ZERO || v === ONE), Array.from(r.board).slice(0, 10).join(','));
  eq('存档记的是原始种子', r.seed, p.originSeed);
  const again = makePuzzle(r.seed, r.tier);
  eq('从存档种子重绘得到同一块盘', Array.from(again.board.grid).join(','), Array.from(p.board.grid).join(','));
  eq('重绘出来的盘尺寸也对', `${again.n}×${again.n}`, p.size);
  Store.saveResume(p, full.map((v, t) => (t < 8 ? v : EMPTY)), 4000, { moves: 3, hints: 0 });
  const early = Store.resume();
  ok('开局就退出时，存档明显小于一格一数', early.ink.length < p.board.size / 2, `${early.ink.length} vs ${p.board.size} 格`);
  eq('首个纪录直接成立', Store.recordBest('expert', { ms: 50000, hints: 1, moves: 20, size: '10×10' }), true);
  eq('更快但更靠提示的不算破纪录', Store.recordBest('expert', { ms: 1000, hints: 2, moves: 5, size: '10×10' }), false);
  eq('同样求助次数下省步数的算破纪录', Store.recordBest('expert', { ms: 60000, hints: 1, moves: 12, size: '10×10' }), true);
  eq('步数也相同时才比时间', Store.recordBest('expert', { ms: 90000, hints: 1, moves: 12, size: '10×10' }), false);
  eq('纪录里存的是最好的那一次', Store.best('expert').moves, 12);
  Store.clearResume();
  eq('清档之后没有续局', Store.resume(), null);
  eq('默认设置里音效是开的', Store.setting('sound'), true);
}

// ---------- difficulty: the ladder is measured ----------

{
  const med = (a) => a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1];
  const rows = [];
  for (const tier of TIERS) {
    const scores = [];
    let inBand = 0;
    let unsolvable = 0;
    let unique = 0;
    let unverified = 0;
    for (let s = 0; s < 6; s++) {
      const p = makePuzzle(`band|${s}`, tier.key);
      if (!p) continue;
      scores.push(p.score);
      if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
      if (!solve(p.board).ok) unsolvable++;
      const c = countSolutions(p.board, { cap: 2, budget: 6000000 });
      if (c.status === UNIQUE) unique++;
      else if (c.status === 'OVERBUDGET') unverified++;
      else unsolvable++;
    }
    rows.push({ key: tier.key, median: med(scores), inBand, n: scores.length, unique });
    eq(`${tier.key} 出货 6/6`, scores.length, 6);
    eq(`${tier.key} 每局都能推到底`, unsolvable, 0);
    // Uniqueness is *proven* by the pencil path (its rules are sound, checked above and on every
  // smaller tier); the counter confirms it independently wherever it can finish counting.
  eq(`${tier.key} 已核过的局都唯一`, unique, scores.length - unverified);
    // A 12×12 hiding can outrun any fixed node budget, so an unverified board is reported rather
    // than silently counted as a pass — but it must stay rare.
    ok(`${tier.key} 穷举复核覆盖大多数局`, unverified <= 1, `${6 - unverified}/6 已核`);
    ok(`${tier.key} 分数落在自己的区间里`, inBand >= 5, `${inBand}/6 在 ${tier.band}`);
  }
  let mono = true;
  for (let i = 1; i < rows.length; i++) if (!(rows[i].median > rows[i - 1].median)) mono = false;
  eq('档位中位分数单调递增', mono, true);
  eq('每档盘面都比上一档大', new Set(TIERS.map((t) => t.n)).size, 5);
  const noband = generate({ n: 6, seed: 'band|noband', tries: 6 });
  ok('不给区间也能出货', noband.ok && noband.offBand === 0);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
