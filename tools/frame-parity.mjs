// 三档帧率对拍驱动：对同一仓、同一 seed、同一虚拟时长，分别在 30/60/120Hz 起独立子进程
// 跑 probe.mjs，然后逐字段比对。frames 一列本身就是帧率的函数，单独列出、不参与判定。
// 用法: node tools/frame-parity.mjs [repoDir] [seconds] [seed]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const SECONDS = Number(process.argv[3] || 3.5);
const SEED = process.argv[4] || 'probe-seed-1';
const RATES = [30, 60, 120];

// drawImage 总次数与 frames 一样是帧率的线性函数，天生不可比；渲染几何由 drawFingerprint 判。
const EXCLUDED = new Set(['tag', 'frames', 'drawImage']);

function run(repo, fps) {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'frame-probe.mjs'), repo, String(fps), String(SECONDS), SEED], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  if (r.status !== 0) {
    throw new Error(`probe 失败 fps=${fps} status=${r.status}\n${r.stderr.slice(0, 600)}`);
  }
  return JSON.parse(r.stdout);
}

// 逐字段比对：返回 [{field, values, differs}]。
function diff(runs) {
  const fields = new Set();
  for (const ru of runs) for (const m of ru.marks) Object.keys(m).forEach((k) => fields.add(k));
  const rows = [];
  for (const f of [...fields].sort()) {
    if (EXCLUDED.has(f)) continue;
    const perMark = [];
    let differs = false;
    const n = Math.min(...runs.map((ru) => ru.marks.length));
    for (let i = 0; i < n; i++) {
      const vals = runs.map((ru) => JSON.stringify(ru.marks[i][f]));
      if (new Set(vals).size > 1) { differs = true; perMark.push(`${runs[0].marks[i].tag} → ${vals.join(' / ')}`); }
    }
    rows.push({ field: f, differs, sample: perMark[0] || null, count: perMark.length });
  }
  return rows;
}

function report(label, runs) {
  console.log(`\n=== ${label} · seed=${SEED} · 虚拟时长=${SECONDS}s ===`);
  console.log('帧数（本应随帧率变化，不参与判定）: '
    + runs.map((r) => `${r.fps}Hz→${r.marks[r.marks.length - 1].frames}`).join('  '));
  const rows = diff(runs);
  const red = rows.filter((r) => r.differs);
  for (const r of rows) {
    console.log(`${r.differs ? 'RED ' : 'ok  '}${r.field.padEnd(18)}`
      + (r.differs ? `第 ${r.count} 个采样点起分叉：${r.sample}` : `三档全等（末点 ${runs[0].marks[runs[0].marks.length - 1][r.field]}）`));
  }
  console.log(`→ ${label}: ${rows.length - red.length}/${rows.length} 字段三档一致，${red.length} 个分叉`);
  return red.length;
}

const green = RATES.map((f) => run(REPO, f));
const badGreen = report('正向（当前仓）', green);

// 阴性对照：把仍在吃帧 dt 的那一行改成常量步长，必须让比对变红，否则这套对拍是假闸。
const MUT = '/tmp/takuzu_mut';
fs.rmSync(MUT, { recursive: true, force: true });
fs.cpSync(REPO, MUT, { recursive: true });
const mainJs = path.join(MUT, 'js', 'main.js');
const src = fs.readFileSync(mainJs, 'utf8');
const before = src.replace('animClock += dt;', 'animClock += 1 / 60;');
if (before === src) {
  console.log('\n!! 阴性对照失效：没找到 `animClock += dt;` 这一行，改动点已被重构掉。');
  process.exit(4);
}
fs.writeFileSync(mainJs, before);
console.log(`\n阴性对照改动: js/main.js  animClock += dt  →  animClock += 1/60`
  + `  (${src.split('\n').findIndex((l) => l.includes('animClock += dt;')) + 1} 行)`);

const red = RATES.map((f) => run(MUT, f));
const badMut = report('阴性对照（帧 dt 换成常量步长）', red);

console.log('\n' + '─'.repeat(60));
console.log(`正向分叉字段数 = ${badGreen}（必须为 0）`);
console.log(`阴性对照分叉字段数 = ${badMut}（必须 > 0）`);
const verdict = badGreen === 0 && badMut > 0;
console.log(`结论：${verdict ? '绿 + 阴性对照红 —— 帧率无关性成立，且这套对拍确实能抓到退化' : '不成立'}`);
process.exit(verdict ? 0 : 1);
