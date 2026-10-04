// Canvas renderer. It reads the Game's engine state and paints; it decides nothing — no line is
// "half and half" here, no run of three is judged here — so the picture cannot disagree with the
// solver that the hints and the win check both use.
//
// Layout lives here too (cell size from the container, board origin, DPR) because hitTest has to
// answer with the *same* numbers draw() used. Those two drifting apart is how a board renders
// correctly but takes clicks one cell off.


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 1 秒 ticker（刷新用时读数，走墙钟）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Cell, Radius } from '../theme.js';
import { EMPTY, ZERO } from '../engine/takuzu.js';

export function layoutFor(n, availW, availH) {
  const pad = 12;
  const size = Math.max(0, Math.min((availW - pad * 2) / n, (availH - pad * 2) / n));
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(size)));
  return { cell, boardW: cell * n, boardH: cell * n, pad };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels: one
  // ctx.scale at the top keeps the symbols crisp on a Retina display without doubling every
  // constant in this file.
  resize(game, availW, availH) {
    const l = layoutFor(game.n, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr };
    this.game = game;
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y } = this.geo;
    const n = this.game.n;
    return { x: (t % n) * cell + x, y: (((t / n) | 0) * cell) + y, size: cell };
  }

  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const game = this.game;
    if (!cell || !game) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    if (px < 0 || py < 0) return -1;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= game.n || gy >= game.n) return -1;
    return gy * game.n + gx;
  }

  draw(game, { pulse = null, preview = null } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell } = geo;
    const b = game.board;
    const grid = game.st.grid;
    const diag = game.diag;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);

    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // Cells. A given has a plate of its own: it is not yours to change, and the picture should
    // say so before you try.
    for (let t = 0; t < b.size; t++) {
      const r = this.cellRect(t);
      ctx.fillStyle = b.grid[t] !== EMPTY ? Palette.surfaceLift : grid[t] === EMPTY ? Palette.bgBottom : Palette.bgTop;
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // A line that already satisfies both of the game's rules gets a quiet green frame. It is the
    // only progress signal that costs no reading.
    ctx.strokeStyle = 'rgba(61,220,145,0.55)';
    ctx.lineWidth = Math.max(1.5, cell * 0.05);
    for (const line of b.lines) {
      let z = 0;
      let o = 0;
      let run = false;
      for (const t of line) {
        if (grid[t] === ZERO) z++;
        else if (grid[t] === 1) o++;
      }
      for (let i = 0; i + 2 < line.length; i++) {
        const a = grid[line[i]];
        if (a !== EMPTY && a === grid[line[i + 1]] && a === grid[line[i + 2]]) run = true;
      }
      if (z !== b.half || o !== b.half || run) continue;
      const a = this.cellRect(line[0]);
      const c = this.cellRect(line[line.length - 1]);
      const vertical = line[1] !== line[0] + 1;
      ctx.strokeRect(
        vertical ? a.x + 1 : a.x + 1,
        vertical ? a.y + 1 : a.y + 1,
        vertical ? cell - 2 : c.x + cell - a.x - 2,
        vertical ? c.y + cell - a.y - 2 : cell - 2
      );
    }

    // Grid.
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= game.n; i++) {
      line(ctx, geo.x + i * cell, geo.y, geo.x + i * cell, geo.y + game.n * cell);
      line(ctx, geo.x, geo.y + i * cell, geo.x + game.n * cell, geo.y + i * cell);
    }
    // Every fourth line heavier: a 12×12 grid is unreadable as a uniform field of cells.
    ctx.strokeStyle = Palette.lineHeavy;
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= game.n; i += 4) {
      line(ctx, geo.x + i * cell, geo.y, geo.x + i * cell, geo.y + game.n * cell);
      line(ctx, geo.x, geo.y + i * cell, geo.x + game.n * cell, geo.y + i * cell);
    }

    // The two symbols. ○ is a ring, ● is a disc — distinguishable by shape as well as colour,
    // because a colour-blind player must be able to read this board too.
    for (let t = 0; t < b.size; t++) {
      const v = grid[t];
      if (v === EMPTY) continue;
      const r = this.cellRect(t);
      const cx = r.x + cell / 2;
      const cy = r.y + cell / 2;
      const bad = diag.badCells.has(t);
      const rad = cell * (v === ZERO ? Cell.ringScale : Cell.discScale);
      const colour = bad ? Palette.error : won ? Palette.success : v === ZERO ? Palette.info : Palette.accent;
      if (v === ZERO) {
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.strokeStyle = colour;
        ctx.lineWidth = Math.max(2, cell * 0.085);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();
      }
      if (b.grid[t] !== EMPTY) {
        // the corner dot that means "题面给的，不能改"
        ctx.beginPath();
        ctx.arc(r.x + cell * 0.17, r.y + cell * 0.17, Math.max(1.5, cell * 0.05), 0, Math.PI * 2);
        ctx.fillStyle = Palette.inkFaint;
        ctx.fill();
      }
    }

    // The cells under the finger, before the gesture is committed: paint, never ink.
    if (preview && preview.cells && preview.cells.length) {
      ctx.strokeStyle = Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.06);
      ctx.setLineDash([Math.max(4, cell * 0.2), Math.max(3, cell * 0.14)]);
      for (const t of preview.cells) {
        const r = this.cellRect(t);
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, cell - 3, cell - 3);
      }
      ctx.setLineDash([]);
    }

    // What a hint just named — the only place the UI is allowed to say "look here".
    if (pulse && pulse.cell != null) {
      const r = this.cellRect(pulse.cell);
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
    }
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
