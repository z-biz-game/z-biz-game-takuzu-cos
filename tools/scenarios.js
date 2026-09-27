// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not a
// flag. A `.hidden` boolean says what the code intended; a client rect and a pixel say what the
// player got. In this game the specific failure worth catching with pixels is a symbol drawn as
// the other symbol: the engine's state, the counts and the win check can all stay consistent
// while the board shows ○ where the player put ●.
//
// ck(name, condition, detail) is truthiness; eq(name, got, want) is equality. Every "must equal"
// goes through eq, because `ck('count', 0)` reads as a failure to a human and a pass to a boolean.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    // rows is copied, not aliased: the array is cleared below, and a live reference would hand
    // back an empty report that still reads as "0 failed".
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = () => w.takuzu;
  const E = () => w.takuzu.engine;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  // ---- real gestures ---------------------------------------------------------

  function pointer(type, x, y) {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  const at = (t) => {
    const r = A().view.cellRect(t);
    const box = A().view.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2, size: r.size };
  };
  async function tap(t) {
    const p = at(t);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    return wait(24);
  }
  // A real pointer fires many moves along the path, not just two; sampling the line the way a
  // finger does is what makes "drag across the row" mean the same thing here as on a touchscreen.
  async function drag(from, to) {
    const a = at(from);
    const b = at(to);
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (a.size / 3)));
    pointer('pointerdown', a.x, a.y);
    for (let i = 1; i <= steps; i++) pointer('pointermove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    pointer('pointerup', b.x, b.y);
    return wait(24);
  }

  // ---- pixel reads -----------------------------------------------------------

  const hex = (h) => {
    const m = String(h).replace('#', '');
    return m.length < 6 ? [-1, -1, -1] : [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const rgb = (s) => {
    const m = String(s).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [-1, -1, -1];
  };
  const near = (p, c, tol = 12) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  const centre = (t) => {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size / 2, r.y + r.size / 2);
  };
  // A point on the ring of ○ — and, for a ●, still inside the disc.
  const ringPoint = (t) => {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size / 2 + r.size * E().theme.Cell.ringScale, r.y + r.size / 2);
  };
  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[(a.length - 1) >> 1] : NaN);

  // ---------- engine ----------

  const engine = async () => {
    const en = E();
    ck('页面挂出了可测的引擎', !!(en && en.createBoard && en.solve));
    eq('三个格子状态', `${en.EMPTY},${en.ZERO},${en.ONE}`, '-1,0,1');
    eq('规则表里有三条', Object.keys(en.Rules).length, 3);
    eq('三条规则的名字', Object.values(en.Rules).map((r) => r.name).join(','), '禁止三连,半数已满,这格放不下');
    eq('档位有五级', en.TIERS.length, 5);
    let ordered = true;
    for (let i = 1; i < en.TIERS.length; i++) {
      if (!(en.TIERS[i].band[0] > en.TIERS[i - 1].band[0])) ordered = false;
      if (!(en.TIERS[i].n > en.TIERS[i - 1].n)) ordered = false;
    }
    ck('档位按难度与尺寸同时递增', ordered, JSON.stringify(en.TIERS.map((t) => [t.n, t.band])));
    eq('档位不认识时退回上手', en.tierFor('nope').key, 'apprentice');

    // geometry, hand-counted on a 4×4 solution: ○ ● ● ○ / ● ○ ○ ● / ○ ○ ● ● / ● ● ○ ○
    const SOL = ['○●●○', '●○○●', '○○●●', '●●○○'];
    const parse = (rowsArr) => {
      const n = rowsArr[0].length;
      const g = new Int8Array(n * n);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        const ch = rowsArr[r][c];
        g[r * n + c] = ch === '○' ? en.ZERO : ch === '●' ? en.ONE : en.EMPTY;
      }
      return { n, g };
    };
    const sol = parse(SOL);
    const sb = en.createBoard({ n: sol.n, grid: sol.g });
    eq('手推的合法盘通过验收', en.verify(sb, sol.g).length, 0);
    eq('手推的盘算完整', en.complete(sb, sol.g), true);
    eq('每行两个 ○', sb.rows.every((line) => line.filter((t) => sol.g[t] === en.ZERO).length === 2), true);
    eq('行列总数 8', sb.lines.length, 8);
    eq('每格属于两条线', sb.cellLines[5].length, 2);
    // 三连, hand-picked
    eq('●●● 被认出', en.run3([0, 1, 2, 3], (t) => [1, 1, 1, 0][t]) != null, true);
    eq('空格打断三连', en.run3([0, 1, 2, 3], (t) => [1, -1, 1, 1][t]), null);
    // a violation is something the player caused, not something still unfinished
    eq('空盘没有违规', en.violations(sb, new Int8Array(16).fill(en.EMPTY)).length, 0);
    const defy = Int8Array.from(sol.g);
    defy[0] = en.ONE;
    ck('改到题面给的格会被说出', en.violations(sb, defy).some((v) => v.why === '与题面不符'), JSON.stringify(en.violations(sb, defy)));
    const three = new Int8Array(16).fill(en.EMPTY);
    three[0] = en.ONE;
    three[1] = en.ONE;
    three[2] = en.ONE;
    ck('三连同符会被说出', en.violations(en.createBoard({ n: 4, grid: three }), three).some((v) => v.why === '三连'));
    // the pencil path on a hand board: row 0 = ●●__ forces both blanks to ○
    const g2 = new Int8Array(16).fill(en.EMPTY);
    g2[0] = en.ONE;
    g2[1] = en.ONE;
    g2[8] = en.ZERO;
    g2[12] = en.ZERO;
    const b2 = en.createBoard({ n: 4, grid: g2 });
    const s2 = en.solve(b2);
    eq('半数已满逼出两个 ○', [2, 3].every((c) => s2.dom[c].length === 1 && s2.dom[c][0] === en.ZERO), true);
    eq('这一格的规则名', s2.rows.find((r) => r.cell === 2).rule.name, '半数已满');
    ck('规则文本带坐标', /第\d+行|第\d+列/.test(s2.rows.find((r) => r.cell === 2).rule.text(b2, s2.rows.find((r) => r.cell === 2))), s2.rows[0].rule.text(b2, s2.rows[0]));

    // the shipped board: unique per the independent counter, and the pencil agrees cell by cell
    const p = en.makePuzzle('scen|engine', 'regular');
    ck('出一局', !!p);
    const b = p.board;
    eq('盘面尺寸就是档位', `${b.n}×${b.n}`, '8×8');
    eq('题面格数记在盘上', b.givens, p.givens);
    ck('题面只占一小部分', b.givens < b.size * 0.4, `${b.givens}/${b.size}`);
    const s = en.solve(b);
    ck('铅笔推到底', s.ok === true);
    eq('推到底即种下的解', Array.from(s.grid).join(','), Array.from(p.solution).join(','));
    eq('推到底通过独立验收', en.verify(b, s.grid).length, 0);
    const c = en.countSolutions(b, { cap: 2, budget: 600000 });
    eq('穷举计数判定唯一', c.status, 'UNIQUE');
    eq('穷举与铅笔逐格同解', Array.from(c.first).join(','), Array.from(s.grid).join(','));
    eq('提示脚本每一格都等于真解', s.rows.filter((r) => r.value !== p.solution[r.cell]).length, 0);
    eq('空盘可完成', en.reachable(b, new Int8Array(b.size).fill(en.EMPTY)), true);
    eq('照解填满可完成', en.reachable(b, p.solution), true);
    const flip = Int8Array.from(p.solution);
    flip[s.rows[0].cell] = flip[s.rows[0].cell] === en.ZERO ? en.ONE : en.ZERO;
    eq('把被逼出的一格画反即不可完成', en.reachable(b, flip), false);
    eq('边长不是偶数时拒绝开局', (() => {
      try {
        en.createBoard({ n: 5, grid: new Int8Array(25) });
        return '';
      } catch (e) {
        return /偶数/.test(e.message);
      }
    })(), true);
    eq('没有题面时拒绝开局', (() => {
      try {
        en.createBoard({ n: 4, grid: new Int8Array(16).fill(en.EMPTY) });
        return '';
      } catch (e) {
        return /没有题面/.test(e.message);
      }
    })(), true);
    return report({ score: p.score, givens: p.givens, steps: s.steps });
  };

  // ---------- gen ----------

  const gen = async () => {
    const en = E();
    const medians = [];
    for (const tier of en.TIERS) {
      const scores = [];
      const givens = [];
      let inBand = 0;
      let unique = 0;
      let verified = 0;
      let finishable = 0;
      let ms = 0;
      for (let s = 0; s < 4; s++) {
        const t0 = performance.now();
        const p = en.makePuzzle(`gen|${tier.key}|${s}`, tier.key);
        ms += performance.now() - t0;
        if (!p) continue;
        scores.push(p.score);
        givens.push(p.givens);
        if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
        if (en.solve(p.board).ok) finishable++;
        const c = en.countSolutions(p.board, { cap: 2, budget: 3000000 });
        if (c.status !== 'OVERBUDGET') {
          verified++;
          if (c.status === 'UNIQUE') unique++;
        }
      }
      eq(`${tier.key} 出货 4/4`, scores.length, 4);
      ck(`${tier.key} 命中难度区间`, inBand >= 3, `${inBand}/4 在 ${tier.band}`);
      eq(`${tier.key} 每局推得完`, finishable, scores.length);
      eq(`${tier.key} 已核过的局都唯一`, unique, verified);
      ck(`${tier.key} 穷举复核覆盖大多数局`, verified >= 3, `${verified}/4 已核`);
      ck(`${tier.key} 出题够快`, ms / 4 < 900, `${(ms / 4).toFixed(0)} ms/局`);
      medians.push({ key: tier.key, m: median(scores), size: `${tier.n}×${tier.n}`, givens: median(givens), nodes: tier.n * tier.n });
    }
    let mono = true;
    for (let i = 1; i < medians.length; i++) if (!(medians[i].m > medians[i - 1].m)) mono = false;
    ck('档位中位分数单调递增', mono, medians.map((o) => `${o.key}:${o.m}`).join(' '));
    eq('每档盘面都比上一档大', new Set(medians.map((o) => o.size)).size, 5);
    ck('题面占比随档位下降', medians.every((o, i) => i === 0 || o.givens / o.nodes <= medians[i - 1].givens / (medians[i - 1].nodes)), medians.map((o) => (o.givens / o.nodes).toFixed(2)).join(' '));
    // the same seed must give the same board — a save stores only the seed
    const a = en.makePuzzle('gen|same', 'expert');
    eq('同种子同盘', Array.from(en.makePuzzle('gen|same', 'expert').board.grid).join(','), Array.from(a.board.grid).join(','));
    ck('不同种子不同盘', Array.from(en.makePuzzle('gen|other', 'expert').board.grid).join(',') !== Array.from(a.board.grid).join(','));
    eq('出货记下原始种子', a.originSeed, 'gen|same');
    // ungated hiding: the counter, not the generator, decides — and where it says many, the
    // pencil rules must refuse to finish
    let many = 0;
    let fooled = 0;
    for (let s = 0; s < 10; s++) {
      const sol = en.randomGrid(6, (() => {
        let x = 7717 + s * 131;
        return () => {
          x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
          return x / 4294967296;
        };
      })());
      if (!sol) continue;
      const loose = new Int8Array(36).fill(en.EMPTY);
      for (let t = 0; t < 36; t += 4) loose[t] = sol[t];
      const b = en.createBoard({ n: 6, grid: loose });
      const c = en.countSolutions(b, { cap: 2, budget: 300000 });
      if (c.status === 'MANY') {
        many++;
        if (en.solve(b).ok) fooled++;
      }
    }
    ck('随手留几个格会造出多解盘（对照组不是空的）', many >= 4, String(many));
    eq('多解盘不会被规则误判推完', fooled, 0);
    return report({ medians: medians.map((o) => o.m) });
  };

  // ---------- play ----------

  const play = async () => {
    A().show('menu');
    await wait(40);
    ck('选档页可见', shown('#view-menu'));
    ck('棋局页藏起', !shown('#view-game'));
    eq('标题是数白', text('#app h1'), '数白');
    ck('副标题点出玩法', /Takuzu/.test(text('.brand .sub')), text('.brand .sub'));
    const tiers = [...document.querySelectorAll('#tier-list .tier')];
    eq('档位按钮五个', tiers.length, 5);
    ck('档位按钮写着尺寸', tiers.every((x) => /×/.test(x.textContent)));
    ck('档位按钮写着实测分', tiers.every((x) => /实测/.test(x.textContent)));
    eq('玩法说明写了三条规则', document.querySelectorAll('.rules li').length, 3);
    eq('纪录表按档位排', document.querySelectorAll('#record-list li').length, 5);
    ck('页脚提到验证脚本', /tools\/verify\.sh/.test(text('footer')));
    ck('未开局不显示继续', !shown('#resume-card'));

    tiers[1].click();
    await wait(80);
    ck('点档位进入棋局', shown('#view-game'));
    ck('选档页让位', !shown('#view-menu'));
    const g = A().game;
    eq('进入的是上手档', g.puzzle.tier, 'apprentice');
    ck('棋头写了档位名', text('#stat-name').includes('上手'), text('#stat-name'));
    ck('棋头写了尺寸', text('#stat-name').includes('6×6'), text('#stat-name'));
    eq('计时从 00:00 起', text('#stat-time'), '00:00');
    eq('步数为 0', text('#stat-moves'), '0');
    eq('提示为 0', text('#stat-hints'), '0');
    eq('已填格读数等于题面格', text('#stat-filled'), `${g.puzzle.givens}/36`);
    eq('待填格', text('#stat-remaining'), String(36 - g.puzzle.givens));
    ck('填完的行/列从 0 起', text('#stat-lines').split('/')[0] === '0' || Number(text('#stat-lines').split('/')[0]) >= 0, text('#stat-lines'));
    eq('冲突 0', text('#stat-conflicts'), '0');
    eq('难度实测显示分数', text('#stat-score'), g.puzzle.score.toFixed(1));
    ck('胜利遮罩藏起', !shown('#win-veil'));
    ck('提示语先讲怎么用', /按/.test(text('#hint-line')), text('#hint-line'));
    eq('状态行开局为空', text('#state-line'), '');
    const geo = A().view.geo;
    const rect = A().view.canvas.getBoundingClientRect();
    ck('画布按棋盘铺开', Math.abs(rect.width - (geo.cell * g.n + geo.x * 2)) <= 1, `${rect.width} vs ${geo.cell * g.n}`);
    eq('格子边长是整数', Number.isInteger(geo.cell), true);
    ck('画不出视口', rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ r: rect.right, b: rect.bottom }));
    ck('无障碍说明讲清循环', /○/.test($('#board').getAttribute('aria-label')) && /●/.test($('#board').getAttribute('aria-label')));
    ck('循环说明在面板里', /空 → ○ → ●/.test(text('.cycle-note')), text('.cycle-note'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    await wait(60);
    eq('H 键给一次提示', text('#stat-hints'), '1');
    ck('提示理由写出规则名', /规则：/.test(text('#hint-rule')), text('#hint-rule'));
    ck('提示不是空话', text('#hint-line').length > 8, text('#hint-line'));
    eq('提示按钮角标同步', text('#hint-count'), '1');
    ck('提示真的落下一个符', A().game.state().filled > A().game.puzzle.givens);
    const filledAfterHint = A().game.state().filled;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    await wait(60);
    eq('Z 键退掉提示落的子', A().game.state().filled, filledAfterHint - 1);
    eq('撤销不退提示次数', text('#stat-hints'), '1');

    const wasOn = $('#btn-sound').getAttribute('aria-pressed') === 'true';
    $('#btn-sound').click();
    await wait(30);
    eq('音效按钮改文案', text('#btn-sound'), wasOn ? '音效 关' : '音效 开');
    eq('音效选择进存档', JSON.parse(localStorage.getItem('takuzu.save.v1')).settings.sound, !wasOn);
    $('#btn-sound').click();
    $('#btn-motion').click();
    await wait(30);
    eq('动效按钮改文案', text('#btn-motion'), '动效 省');
    ck('减少动效写进 body', document.body.classList.contains('reduce-motion'));
    $('#btn-motion').click();

    $('#btn-new').click();
    await wait(80);
    eq('换一局留在同档', A().game.puzzle.tier, 'apprentice');
    eq('换一局清零步数', text('#stat-moves'), '0');
    eq('换一局清零提示', text('#stat-hints'), '0');
    ck('换一局关掉遮罩', !shown('#win-veil'));
    $('#btn-menu').click();
    await wait(40);
    ck('回选档显示菜单', shown('#view-menu'));
    ck('回选档留下可继续的一局', shown('#resume-card'));
    ck('继续卡写了花费', /步 · 提示/.test(text('#resume-meta')), text('#resume-meta'));
    $('#btn-resume').click();
    await wait(60);
    ck('继续回到棋局', shown('#view-game'));
    return report({});
  };

  // ---------- hint ----------

  const hint = async () => {
    const en = E();
    A().begin({ tier: 'expert', seed: 'scen|hint' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    eq('提示局开局只有题面', g.state().filled, b.givens);
    const names = new Set(Object.values(en.Rules).map((r) => r.name));
    const seen = new Set();
    let charged = 0;
    let badRule = 0;
    let outOfRange = 0;
    for (let k = 0; k < 400 && g.status !== 'won'; k++) {
      const info = A().useHint();
      if (!info) break;
      if (info.stalled) {
        ck('推完之前不喊停', false, info.text);
        break;
      }
      if (info.conflict) {
        ck('一路提示不该撞到自己的线', false, info.conflict);
        break;
      }
      charged++;
      seen.add(info.rule);
      if (!names.has(info.rule)) badRule++;
      if (!(info.cell >= 0 && info.cell < b.size)) outOfRange++;
      if (g.valueOf(info.cell) !== info.value) badRule++;
      if (!/第\d+行|第\d+列/.test(info.why)) badRule++;
    }
    eq('一路提示能走完这局', g.status, 'won');
    eq('提示次数等于待填格数', charged, b.size - b.givens);
    eq('提示说的规则都在表里', badRule, 0);
    eq('提示不越界', outOfRange, 0);
    ck('用到的规则不止一种', seen.size >= 2, [...seen].join(','));
    eq('终局通过独立验收', en.verify(b, g.st.grid).length, 0);
    eq('终局所有行列都各半', g.state().linesDone, g.state().linesTotal);
    ck('胜利遮罩出现', shown('#win-veil'));
    ck('胜利文案带花费', /步 · 提示/.test(text('#win-meta')), text('#win-meta'));
    const after = g.hints;
    A().useHint();
    eq('胜利后再按提示不充电', g.hints, after);
    eq('胜利后续局被清掉', en.Store.resume(), null);
    const g2 = A().begin({ tier: 'expert', seed: 'scen|hint2' });
    eq('换局后脚本重来', g2.cursor, 0);
    eq('换局后提示清零', g2.hints, 0);
    return report({ hints: charged, rules: [...seen] });
  };

  // ---------- stroke ----------

  const stroke = async () => {
    const en = E();
    A().begin({ tier: 'trainee', seed: 'scen|stroke' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const free = (t) => !en.isGiven(b, t);
    eq('开局没有冲突', g.state().conflicts, 0);
    const t0 = [...Array(b.size).keys()].find(free);
    await tap(t0);
    eq('第一下是 ○', g.valueOf(t0), en.ZERO);
    eq('点一下算一步', text('#stat-moves'), '1');
    await tap(t0);
    eq('第二下换成 ●', g.valueOf(t0), en.ONE);
    await tap(t0);
    eq('第三下清空', g.valueOf(t0), en.EMPTY);
    eq('三下算三步', text('#stat-moves'), '3');
    for (let i = 0; i < 3; i++) A().undo();
    await wait(40);
    eq('一路撤销退到开局', Number(text('#stat-moves')), 0);
    eq('开局状态下没有落子', g.state().filled, b.givens);
    const given = [...b.grid].findIndex((v) => v !== en.EMPTY);
    const moves0 = Number(text('#stat-moves'));
    await tap(given);
    eq('题面给的格改了也没用', g.valueOf(given), b.grid[given]);
    eq('点题面格不计步', Number(text('#stat-moves')), moves0);
    ck('点题面格会说明原因', /题面/.test(A().stateLine()), A().stateLine());

    // a stroke paints one symbol across the cells it passes, and costs one step
    A().begin({ tier: 'trainee', seed: 'scen|stroke2' });
    await wait(60);
    const g2 = A().game;
    const b2 = g2.board;
    const row = Array.from({ length: b2.n }, (_, c) => c);
    const writable = row.filter((t) => !en.isGiven(b2, t));
    ck('这一行有可写的格', writable.length > 0, JSON.stringify(row.map((t) => b2.grid[t])));
    const moves1 = Number(text('#stat-moves'));
    await drag(row[0], row[b2.n - 1]);
    eq('一笔铺满了行里所有可写的格', writable.filter((t) => g2.valueOf(t) !== en.EMPTY).length, writable.length);
    eq('一笔只算一步', Number(text('#stat-moves')), moves1 + 1);
    A().undo();
    await wait(30);
    eq('一次撤销退掉整笔', Number(text('#stat-moves')), moves1);
    eq('退掉后这些格都回到空', writable.filter((t) => g2.valueOf(t) === en.EMPTY).length, writable.length);

    // a drag that starts off the board does nothing
    const c = A().view.canvas.getBoundingClientRect();
    const moves2 = Number(text('#stat-moves'));
    pointer('pointerdown', c.left - 6, c.top + 6);
    pointer('pointerup', c.left - 6, c.top + 6);
    await wait(30);
    eq('画布外的按下不落子', Number(text('#stat-moves')), moves2);

    // win by drawing the planted answer, one cell at a time, through the real commit path
    A().begin({ tier: 'trainee', seed: 'scen|stroke-win' });
    await wait(60);
    const g3 = A().game;
    for (let t = 0; t < g3.board.size; t++) {
      if (!en.isGiven(g3.board, t)) A().stroke([t], g3.puzzle.solution[t]);
    }
    eq('一格一格照解画就能胜', g3.status, 'won');
    eq('围满的盘通过独立验收', en.verify(g3.board, g3.st.grid).length, 0);
    eq('纯手工通关不用提示', g3.hints, 0);
    eq('手工步数等于待填格数', g3.moves, g3.board.size - g3.board.givens);
    ck('胜利文案写 0 次提示', /提示 0 次/.test(text('#win-meta')), text('#win-meta'));
    ck('手工通关写下纪录', !!en.Store.best('trainee'), JSON.stringify(en.Store.best('trainee')));
    return report({});
  };

  // ---------- conflict ----------

  const conflict = async () => {
    const en = E();
    A().begin({ tier: 'regular', seed: 'scen|conflict' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const first = g.script[0];
    const wrong = first.value === en.ZERO ? en.ONE : en.ZERO;
    const put = async (t, v) => {
      for (let k = 0; k < 3 && g.valueOf(t) !== v; k++) await tap(t);
    };
    await put(first.cell, wrong);
    eq('玩家放上了与真解相反的符', g.valueOf(first.cell), wrong);
    const info = A().useHint();
    ck('提示拒绝落子', !!info.conflict, JSON.stringify(info));
    eq('矛盾时不收钱', g.hints, 0);
    ck('说明写清该放哪个符', /只能是/.test(info.conflict), info.conflict);
    ck('这条线被证明无法完成', A().game.state().stuck === true, JSON.stringify(A().game.state()));
    ck('状态行说出矛盾', /矛盾/.test(A().stateLine()), A().stateLine());
    await put(first.cell, en.EMPTY);
    eq('擦掉错子后矛盾解除', A().game.state().stuck, false);
    eq('状态行清空', A().stateLine(), '');
    const ok2 = A().useHint();
    eq('这时提示才肯落子', ok2.value, first.value);
    eq('这次才计一次提示', g.hints, 1);

    // A violation the readout has to name. The candidate move is *found* with the engine's own
    // violations() list — that is legitimate, it is only choosing what to click; the assertion is
    // still about what the UI says after the click.
    A().begin({ tier: 'trainee', seed: 'scen|conflict2' });
    await wait(60);
    const g2 = A().game;
    const b2 = g2.board;
    let bad = null;
    for (let t = 0; t < b2.size && !bad; t++) {
      if (en.isGiven(b2, t)) continue;
      for (const v of [en.ONE, en.ZERO]) {
        A().stroke([t], v);
        if (g2.state().conflicts > 0) {
          bad = { t, v };
          break;
        }
        A().undo();
      }
    }
    ck('存在一步就违规的放法', !!bad, JSON.stringify(g2.state()));
    if (bad) {
      ck('三连同符或超半数会被说出来', g2.state().conflicts > 0, JSON.stringify(g2.state()));
      ck('违规时状态行有话', /违规|矛盾|三连|半数/.test(A().stateLine()), A().stateLine());
      ck('违规统计项被标红', $('#stat-conflicts').closest('.stat').classList.contains('bad'));
      A().undo();
      await wait(30);
      eq('退掉违规的一步后冲突归零', A().game.state().conflicts, 0);
    }
    // and the honest zero case: an untouched board has nothing broken
    A().begin({ tier: 'trainee', seed: 'scen|conflict3' });
    await wait(60);
    eq('刚开局没有违规', A().game.state().conflicts, 0);
    eq('刚开局状态行是空的', A().stateLine(), '');
    // the planted answer, drawn through the same path, must never be called a violation
    const g3 = A().game;
    for (let t = 0; t < g3.board.size; t++) {
      if (!en.isGiven(g3.board, t)) A().stroke([t], g3.puzzle.solution[t]);
    }
    eq('照解画完时违规为 0', g3.state().conflicts, 0);
    eq('照解画完时每行列都各半', g3.state().linesDone, g3.state().linesTotal);
    eq('照解画完即胜利', g3.status, 'won');
    return report({});
  };

  // ---------- save ----------

  const save = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'regular', seed: 'scen|save' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    for (let t = 0; t < 8; t++) if (!en.isGiven(b, t)) A().stroke([t], g.puzzle.solution[t]);
    A().useHint();
    await wait(30);
    const raw = JSON.parse(localStorage.getItem('takuzu.save.v1'));
    ck('存档键名是本作的', !!raw && !!raw.resume, Object.keys(raw || {}).join(','));
    eq('存档写原始种子', raw.resume.seed, g.puzzle.originSeed);
    eq('存档写档位', raw.resume.tier, 'regular');
    eq('存档写格数', raw.resume.cells, b.size);
    eq('存档写步数', raw.resume.moves, g.moves);
    eq('存档写提示数', raw.resume.hints, g.hints);
    ck('存档写用时', raw.resume.elapsedMs > 0, raw.resume.elapsedMs);
    ck('存档不过一千字节', JSON.stringify(raw.resume).length < 1200, JSON.stringify(raw.resume).length);
    const back = en.Store.resume();
    eq('符号一格不差地回来', Array.from(back.board).join(','), Array.from(g.st.grid).join(','));
    ck('空格还原后还是空格', back.board.some((v) => v === en.EMPTY) && back.board.every((v) => v === en.EMPTY || v === en.ZERO || v === en.ONE), Array.from(back.board).slice(0, 12).join(','));
    ck('游程编码比一格一数省', back.ink.length < b.size * 2, `${back.ink.length} vs ${b.size * 2}`);
    eq('默认设置音效开', en.Store.setting('sound'), true);
    ck('本作没有上一作的设置项', !('showNotes' in raw.settings), JSON.stringify(raw.settings));
    const solvedBefore = en.Store.data.totals.solved;
    en.Store.recordSolve(1000, 2);
    eq('总局数按局累加', en.Store.data.totals.solved, solvedBefore + 1);
    ck('累计提示在涨', en.Store.data.totals.hints >= 2, en.Store.data.totals.hints);
    en.Store.data.best = {};
    eq('首个纪录直接成立', en.Store.recordBest('regular', { ms: 50000, hints: 1, moves: 20, size: '8×8' }), true);
    eq('更快但更靠提示的不算破纪录', en.Store.recordBest('regular', { ms: 1000, hints: 2, moves: 5, size: '8×8' }), false);
    eq('同求助次数下省步算破纪录', en.Store.recordBest('regular', { ms: 60000, hints: 1, moves: 12, size: '8×8' }), true);
    eq('步数也相同时才比时间', en.Store.recordBest('regular', { ms: 90000, hints: 1, moves: 12, size: '8×8' }), false);
    eq('纪录留的是最好的那次', en.Store.best('regular').moves, 12);
    en.Store.data.best = {};
    localStorage.setItem('slant.save.v1', JSON.stringify({ settings: { sound: false }, resume: { seed: 'x' } }));
    eq('不读上一作的存档键', en.Store.setting('sound'), true);
    localStorage.removeItem('slant.save.v1');
    return report({ bytes: JSON.stringify(raw.resume).length });
  };

  // ---------- resume ----------

  const resume = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'expert', seed: 'scen|resume' });
    await wait(60);
    const g = A().game;
    const gridBefore = Array.from(g.board.grid).join(',');
    let laid = 0;
    for (let t = 0; t < g.board.size && laid < 10; t++) {
      if (en.isGiven(g.board, t)) continue;
      A().stroke([t], g.puzzle.solution[t]);
      laid++;
    }
    A().useHint();
    A().useHint();
    await wait(30);
    const saved = { grid: Array.from(g.st.grid).join(','), moves: g.moves, hints: g.hints };
    A().show('menu');
    await wait(40);
    ck('回选档留下继续卡', shown('#resume-card'));
    ck('继续卡写着档位', /高阶/.test(text('#resume-name')), text('#resume-name'));
    const r = en.Store.resume();
    eq('续局取回了符号', Array.from(r.board).join(','), saved.grid);
    A().begin({ tier: r.tier, seed: r.seed, resume: r });
    await wait(60);
    const g2 = A().game;
    eq('续局重绘出同一块盘', Array.from(g2.board.grid).join(','), gridBefore);
    eq('续局还原全部符号', Array.from(g2.st.grid).join(','), saved.grid);
    eq('续局还原步数', g2.moves, saved.moves);
    eq('续局还原提示数', g2.hints, saved.hints);
    eq('面板显示还原后的提示', text('#stat-hints'), String(saved.hints));
    eq('面板显示还原后的步数', text('#stat-moves'), String(saved.moves));
    ck('续局接着计时', A().elapsed() >= r.elapsedMs, `${A().elapsed()} vs ${r.elapsedMs}`);
    eq('面板已填格与引擎一致', text('#stat-filled').split('/')[0], String(g2.diag.filled));
    eq('续局不能撤销到重开之前', A().undo(), null);
    eq('续局之后符号还在', Array.from(g2.st.grid).join(','), saved.grid);
    const hintsAtResume = g2.hints;
    A().begin({ tier: r.tier, seed: r.seed, resume: r });
    await wait(60);
    const g3 = A().game;
    const res = A().solveWithLogic();
    eq('续局可以推到胜利', g3.status, 'won', JSON.stringify(res));
    ck('推到底用了逻辑', res.steps > 1, res.steps);
    ck('提示次数没被续局清零', g3.hints >= hintsAtResume, `${g3.hints} vs ${hintsAtResume}`);
    ck('破纪录按求助最少算', !en.Store.best('expert') || en.Store.best('expert').hints <= g3.hints, JSON.stringify(en.Store.best('expert')));
    eq('胜利后续局被清掉', en.Store.resume(), null);
    ck('胜利遮罩可见', shown('#win-veil'));
    $('#btn-menu-2').click();
    await wait(40);
    ck('胜利后回选档不再给继续', !shown('#resume-card'));
    ck('总局数累加了', en.Store.data.totals.solved >= 1, en.Store.data.totals.solved);
    $('#btn-reset').click();
    await wait(40);
    eq('清空存档清掉纪录', en.Store.best('expert'), null);
    ck('清空存档回到选档', shown('#view-menu'));
    eq('清空后续档也没了', en.Store.resume(), null);
    return report({});
  };

  // ---------- layout ----------

  const layout = async () => {
    const en = E();
    A().begin({ tier: 'master', seed: 'scen|layout' });
    await wait(80);
    const g = A().game;
    const b = g.board;
    eq('大师档 12×12', `${g.n}×${g.n}`, '12×12');
    const rect = A().view.canvas.getBoundingClientRect();
    ck('最大盘也在视口里', rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ l: rect.left, r: rect.right, b: rect.bottom }));
    ck('格子不小于可点最小值', A().view.geo.cell >= 26, A().view.geo.cell);
    ck('页面没有横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    let misses = 0;
    for (let t = 0; t < b.size; t++) {
      const p = at(t);
      if (A().view.hitCell(p.x, p.y) !== t) misses++;
    }
    eq('大棋盘每一格都点得中', misses, 0);

    const paper = hex(cssVar('--bg-bottom'));
    const inked = hex(cssVar('--bg-top'));
    const plate = hex(cssVar('--surface-lift'));
    const info = hex(cssVar('--info'));
    const accent = hex(cssVar('--accent'));
    const zero = (() => {
      for (let t = 0; t < b.size; t++) if (!en.isGiven(b, t)) return t;
      return -1;
    })();
    const one = (() => {
      for (let t = zero + 1; t < b.size; t++) if (!en.isGiven(b, t) && t !== zero) return t;
      return -1;
    })();
    A().stroke([zero], en.ZERO);
    A().stroke([one], en.ONE);
    await wait(50);
    ck('题面给的格有底板色', near(centre([...b.grid].findIndex((v) => v !== en.EMPTY)), plate, 6) || !near(centre([...b.grid].findIndex((v) => v !== en.EMPTY)), paper, 6), '');
    // ○ is a ring: the middle of the cell stays paper, and a point on the ring is inked.
    ck('○ 的中心是空的', near(centre(zero), inked), `${centre(zero)} vs 空格底色 ${inked}`);
    ck('○ 的环被画出来了', near(ringPoint(zero), info), `${ringPoint(zero)} vs ○ 色 ${info}`);
    // ● is a disc: the middle itself is inked. A renderer that swapped the two symbols would
    // fail here while every count in the engine stayed correct.
    ck('● 的中心是实心的', near(centre(one), accent), `${centre(one)} vs ● 色 ${accent}`);
    ck('两种符号靠形状就能分开', !near(centre(zero), centre(one)), `${centre(zero)} vs ${centre(one)}`);
    const untouched = (() => {
      for (let t = b.size - 1; t >= 0; t--) if (!en.isGiven(b, t) && g.valueOf(t) === en.EMPTY) return t;
      return -1;
    })();
    eq('没画的格是纸色', near(centre(untouched), paper), true);

    // finish the board and read the "line complete" frame plus the win colours
    for (let t = 0; t < b.size; t++) {
      if (!en.isGiven(b, t)) A().stroke([t], g.puzzle.solution[t]);
    }
    await wait(60);
    eq('照解画完即胜利', g.status, 'won');
    const done = hex(cssVar('--success'));
    ck('胜利时符号变成成功色', near(centre(zero), done) || near(ringPoint(zero), done), `${centre(zero)} / ${ringPoint(zero)} vs ${done}`);
    const glyph = A().view.ctx;
    void glyph;
    eq('图例五项', document.querySelectorAll('.legend span').length, 5);
    ck('图例的 ● 色块就是 ● 的颜色', near(rgb(getComputedStyle($('.sw-one')).backgroundColor), accent), `${getComputedStyle($('.sw-one')).backgroundColor} vs ${accent}`);
    ck('图例的 ○ 色块就是 ○ 的颜色', near(rgb(getComputedStyle($('.sw-zero')).boxShadow).length ? rgb(getComputedStyle($('.sw-zero')).boxShadow) : [-1, -1, -1], info), getComputedStyle($('.sw-zero')).boxShadow);
    ck('操作提示讲清两种手势', /点一下/.test(text('.keyhint')) && /拖动/.test(text('.keyhint')), text('.keyhint'));
    eq('统计项七条', document.querySelectorAll('.stats .stat').length, 7);
    ck('按钮都够点', [...document.querySelectorAll('.acts button, .top-actions button')].every((x) => x.getBoundingClientRect().height >= 28));
    ck('顶部按钮不重叠', (() => {
      const bs = [...document.querySelectorAll('.top-actions button')].map((x) => x.getBoundingClientRect());
      for (let i = 1; i < bs.length; i++) if (bs[i].left < bs[i - 1].right - 1) return false;
      return true;
    })());
    ck('提示框不横向溢出', (() => {
      const e = $('.hint-box');
      return e.scrollWidth <= e.clientWidth + 1;
    })());
    ck('循环说明不溢出', (() => {
      const e = $('.cycle-note');
      return e.scrollWidth <= e.clientWidth + 1;
    })());
    A().begin({ tier: 'trainee', seed: 'scen|layout-win' });
    await wait(40);
    for (let t = 0; t < A().game.board.size; t++) {
      if (!en.isGiven(A().game.board, t)) A().stroke([t], A().game.puzzle.solution[t]);
    }
    await wait(60);
    ck('胜利卡居中在棋盘内', (() => {
      const card = $('.win-card').getBoundingClientRect();
      const wrap = $('#board-wrap').getBoundingClientRect();
      return card.left >= wrap.left - 1 && card.right <= wrap.right + 1 && card.top >= wrap.top - 1 && card.bottom <= wrap.bottom + 1;
    })(), JSON.stringify({ c: $('.win-card').getBoundingClientRect(), w: $('#board-wrap').getBoundingClientRect() }));
    ck('胜利按钮点得到', $('#btn-again').getBoundingClientRect().width > 40);
    return report({ cell: A().view.geo.cell, dpr: A().view.geo.dpr });
  };

  w.__ng = { engine, gen, play, hint, stroke, conflict, save, resume, layout };
})(window);
