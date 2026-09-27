// 难度实测台. Reads the difficulty of each tier off generated boards — it does not set it.
//
// The numbers printed here are what TIERS[].band is supposed to contain. Changing the rules or
// the hiding without re-running this is how a band becomes decoration and the README's measured
// table becomes a lie.

import { performance } from 'node:perf_hooks';
import { TIERS, makePuzzle, generate, randomGrid, hideCells } from '../js/engine/generate.js';
import { createBoard, solve, verify, complete } from '../js/engine/takuzu.js';
import { countSolutions, UNIQUE, OVERBUDGET } from '../js/engine/count.js';

const N = Number(process.env.SAMPLES || 40);
const q = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))] : NaN);
const sort = (a) => a.slice().sort((x, y) => x - y);

let worst = 0;
const ladder = [];
for (const tier of TIERS) {
  const scores = [];
  const steps = [];
  const givens = [];
  const nodes = tier.n * tier.n;
  let accepted = 0;
  let inBand = 0;
  let drawn = 0;
  let unsolvable = 0;
  let ms = 0;
  for (let s = 0; s < N; s++) {
    const t0 = performance.now();
    const p = makePuzzle(`balance|${s}`, tier.key);
    ms += performance.now() - t0;
    if (!p) continue;
    accepted++;
    drawn += p.gen || 1;
    if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
    if (!solve(p.board).ok) unsolvable++;
    scores.push(p.score);
    steps.push(p.steps);
    givens.push(p.givens);
  }
  const line = (label, arr, fmt = (v) => v) => {
    const a = sort(arr);
    console.log(`    ${label.padEnd(10)} p25 ${fmt(q(a, 0.25))}  中位 ${fmt(q(a, 0.5))}  p75 ${fmt(q(a, 0.75))}  max ${fmt(a[a.length - 1])}`);
  };
  console.log(`\n${tier.name} ${tier.key} ${tier.n}×${tier.n}（留 ${Math.round(tier.keepRatio * 100)}% 的题面，目标分 ${tier.band[0]}–${tier.band[1]}）`);
  console.log(`    出题成功率 ${accepted}/${N}，命中目标区间 ${inBand}/${accepted}，平均每局抽 ${(drawn / Math.max(1, accepted)).toFixed(1)} 次，耗时 ${(ms / Math.max(1, N)).toFixed(1)} ms/局`);
  line('分数', scores, (v) => (v || 0).toFixed(1));
  line('推理步数', steps);
  line('题面格', givens, (v) => `${v}/${nodes}`);
  console.log(`    推不出来的盘 ${unsolvable}`);
  ladder.push({ label: `${tier.name} ${tier.n}×${tier.n}`, median: q(sort(scores), 0.5) || 0, inBand, accepted, unsolvable });
  worst = Math.max(worst, ms / Math.max(1, N));
}

// The ladder is the product promise: 初学 must read easier than 大师, and a tier that never lands
// in its own band means the band is decoration.
console.log('\n== 档位阶梯（中位分数必须单调，命中率不能是个位数，推不完的盘必须为零）==');
let mono = true;
{
  let prev = -Infinity;
  for (const l of ladder) {
    const okScore = l.median > prev;
    const okHit = l.accepted === 0 || l.inBand / l.accepted >= 0.8;
    const okSolve = l.unsolvable === 0;
    if (!okScore || !okHit || !okSolve) mono = false;
    console.log(`  ${okScore && okHit && okSolve ? '✓' : '✗'} ${l.label} 中位 ${l.median.toFixed(1)}  命中区间 ${l.inBand}/${l.accepted}  推不完 ${l.unsolvable}`);
    prev = l.median;
  }
  console.log(mono ? '  阶梯成立' : '  阶梯不成立：band 需要重测');
}

// Cross-check: the pencil path says "one solution, reachable"; the exhaustive counter is allowed
// to disagree and must not. A board it could not finish counting is reported as unverified —
// never as agreement.
console.log('\n== 独立计数复核（穷举解数，并逐格比对答案）==');
let checked = 0;
let bad = 0;
let skipped = 0;
for (const tier of TIERS) {
  for (let s = 0; s < 4; s++) {
    const p = makePuzzle(`cross|${s}`, tier.key);
    if (!p) continue;
    const c = countSolutions(p.board, { cap: 2, budget: 8000000 });
    if (c.status === OVERBUDGET) {
      skipped++;
      continue;
    }
    checked++;
    if (c.status !== UNIQUE) {
      bad++;
      console.log(`  ✗ ${tier.name} seed ${s}: 穷举解数 ${c.solutions}（铅笔判定可推完）`);
      continue;
    }
    const mine = Array.from(solve(p.board).grid).join(',');
    if (Array.from(c.first).join(',') !== mine) {
      bad++;
      console.log(`  ✗ ${tier.name} seed ${s}: 两套实现给出的解答不是同一盘`);
    }
  }
}
console.log(`  ${checked - bad}/${checked} 局穷举复核与铅笔判定一致（含逐格解答比对）${skipped ? `，另有 ${skipped} 局超出节点预算未核` : ''}`);
if (skipped) console.log('  注：唯一性由铅笔路径证明（每条规则写下的格子在该盘的每一个解里都成立），穷举只是第二意见；12×12 的隐藏盘偶尔数不完。');

// A second, independent read on the score: re-solving the accepted board must reproduce it, or
// the score is a property of the generator's state and not of the board.
console.log('\n== 复解一致（同一块盘重跑一次必须同分）==');
{
  let drift = 0;
  for (const tier of TIERS) {
    const p = makePuzzle(`drift|1`, tier.key);
    if (!p) continue;
    const again = solve(p.board);
    if (!again.ok || again.score !== p.score) {
      drift++;
      console.log(`  ✗ ${tier.name} 复解不一致`, again.ok, again.score, p.score);
    }
  }
  console.log(`  复解一致：${TIERS.length - drift}/${TIERS.length} 档`);
}

// Sanity for the generator itself: whatever it plants must pass the rules-of-the-game check that
// has nothing to do with how it was built.
console.log('\n== 出题器种下的解，与验收器认的解 ==');
{
  let total = 0;
  let broken = 0;
  for (let s = 0; s < 60; s++) {
    const tier = TIERS[s % TIERS.length];
    let x = 90000 + s * 7919;
    const r = () => {
      x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
      return x / 4294967296;
    };
    const sol = randomGrid(tier.n, r);
    if (!sol) continue;
    const full = createBoard({ n: tier.n, grid: sol });
    const grid = hideCells(full, r, Math.round(tier.n * tier.n * tier.keepRatio));
    const b = createBoard({ n: tier.n, grid });
    total++;
    if (verify(b, sol).length || !complete(b, sol)) {
      broken++;
      if (broken <= 3) console.log(`  ✗ ${tier.name} 种下的解没通过验收`, JSON.stringify(verify(b, sol).slice(0, 2)));
    }
  }
  console.log(`  种解合法：${total - broken}/${total}`);
}

// The hiding is the difficulty knob, so its own yield is worth printing: how much of the board
// stays visible once every removal has been gated on solvability.
console.log('\n== 不设选取目标时，能藏到多满（每档 6 局，tries=1）==');
for (const tier of TIERS) {
  const left = [];
  for (let s = 0; s < 6; s++) {
    const r = generate({ n: tier.n, seed: `bare|${s}`, keepRatio: 0.05, band: null, tries: 1 });
    if (r.ok) left.push(r.givens);
  }
  console.log(`  ${tier.name} ${tier.n}×${tier.n}: 最少能藏到 中位 ${q(sort(left), 0.5)}/${tier.n * tier.n} 格（出货 ${left.length}/6）`);
}

console.log(`\n最慢档位 ${worst.toFixed(1)} ms/局`);
process.exit(mono && bad === 0 ? 0 : 1);
