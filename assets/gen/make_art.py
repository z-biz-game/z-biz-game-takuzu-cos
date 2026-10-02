#!/usr/bin/env python3
"""数白 Takuzu 的美术资产工厂：一条命令重跑，产出仓内全部位图。

    python3 assets/gen/make_art.py

母题就是玩法本身：一块 6×6 棋盘，○（冷蓝空心环）与 ●（暖琥珀实心点）各半、无三连——
图标上那张盘是一条**合法解**，脚本当场断言，所以它不会随规则改动而腐烂。
绿色描边那一行取自游戏里"这一行已经各半了"的那圈静绿。

配色不在这里重新发明：全部读 js/theme.js 的 Palette，改一处主题、重跑就同步。
"""
import array
import math
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))

# 合法 6×6 Takuzu 解：○=0 ●=1。每行每列三个 0 三个 1，且无三连续。
MOTIF_BOARD = [
    '001101',
    '110010',
    '011010',
    '100101',
    '010110',
    '101001',
]

# 题面给的格（带上角小点的那些），其余是玩家填的。
GIVENS = {(0, 0), (0, 3), (1, 1), (2, 4), (3, 2), (4, 0), (5, 5)}

CJK_FONTS = (
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
)


def load_palette():
    src = open(os.path.join(REPO, 'js', 'theme.js'), encoding='utf-8').read()
    body = src[src.index('export const Palette'):]
    body = body[:body.index('};')]
    found = dict(re.findall(r'(\w+)\s*:\s*[\'"]#([0-9a-fA-F]{6})[\'"]', body))
    if not found:
        raise SystemExit('js/theme.js 里没读到 Palette 的十六进制色')
    return {k: tuple(int(v[i:i + 2], 16) for i in (0, 2, 4)) for k, v in found.items()}


PAL = load_palette()
BG_TOP = PAL['bgTop']
BG_BOTTOM = PAL['bgBottom']
SURFACE = PAL['surface']
SURFACE_LIFT = PAL['surfaceLift']
LINE = PAL['line']
LINE_HEAVY = PAL['lineHeavy']
RING = PAL['info']
DISC = PAL['accent']
DONE = PAL['success']
INK = PAL['ink']


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(3))


def shade(c, f):
    return tuple(max(0, min(255, int(round(v * f)))) for v in c)


def check_board():
    """母题盘必须合法，否则这张图标在宣传一件游戏不允许的事。"""
    n = len(MOTIF_BOARD)
    half = n // 2
    grid = [[int(ch) for ch in row] for row in MOTIF_BOARD]
    lines = [grid, list(zip(*grid))]
    for group in lines:
        for i, line in enumerate(group):
            assert sorted(line) == [0] * half + [1] * (n - half), f'第{i}线不是各半'
            for j in range(n - 2):
                assert not (line[j] == line[j + 1] == line[j + 2]), f'第{i}线三连接'
    return grid


def vertical_gradient(size, top=BG_TOP, bottom=BG_BOTTOM, corner=None):
    img = Image.new('RGB', size)
    d = ImageDraw.Draw(img)
    for y in range(size[1]):
        d.line([(0, y), (size[0], y)], fill=mix(top, bottom, y / max(1, size[1] - 1)))
    if corner:
        glow = Image.new('L', size, 0)
        ImageDraw.Draw(glow).ellipse(
            [-size[0] * 0.35, -size[1] * 0.45, size[0] * 0.75, size[1] * 0.55], fill=54)
        glow = glow.filter(ImageFilter.GaussianBlur(size[0] * 0.12))
        img = Image.composite(Image.new('RGB', size, corner), img, glow)
    return img


def rounded_mask(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def board_layer(px, grid, *, plate=True, frame_done=True):
    n = len(grid)
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    inset = px * 0.10
    span = px - inset * 2
    cell = span / n
    with_alpha = lambda c, a=255: c + (a,)

    d.rounded_rectangle([inset * 0.45, inset * 0.45, px - inset * 0.45, px - inset * 0.45],
                        radius=px * 0.055, fill=with_alpha(SURFACE, 235),
                        outline=with_alpha(LINE_HEAVY, 190), width=max(1, int(px * 0.006)))

    if plate:
        for r, c in GIVENS:
            d.rectangle([inset + c * cell, inset + r * cell,
                         inset + (c + 1) * cell, inset + (r + 1) * cell], fill=with_alpha(SURFACE_LIFT))

    d.rectangle([inset, inset, inset + span, inset + span], outline=with_alpha(LINE), width=1)
    for i in range(1, n):
        col = with_alpha(LINE_HEAVY, 210) if i % 3 == 0 else with_alpha(LINE, 210)
        w = max(1, int(px * 0.004))
        d.line([inset + i * cell, inset, inset + i * cell, inset + span], fill=col, width=w)
        d.line([inset, inset + i * cell, inset + span, inset + i * cell], fill=col, width=w)

    if frame_done:
        r = 3
        d.rounded_rectangle([inset + cell * 0.12, inset + r * cell + cell * 0.10,
                             inset + span - cell * 0.12, inset + (r + 1) * cell - cell * 0.10],
                            radius=cell * 0.16, outline=with_alpha(DONE, 235),
                            width=max(2, int(px * 0.010)))

    for r in range(n):
        for c in range(n):
            cx = inset + c * cell + cell / 2
            cy = inset + r * cell + cell / 2
            if grid[r][c] == 0:
                d.ellipse([cx - cell * 0.30, cy - cell * 0.30, cx + cell * 0.30, cy + cell * 0.30],
                          outline=with_alpha(RING), width=max(2, int(cell * 0.11)))
            else:
                rr = cell * 0.28
                d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=with_alpha(DISC))
                d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                          outline=with_alpha(shade(DISC, 1.25), 150), width=max(1, int(rr * 0.1)))
            if plate and (r, c) in GIVENS:
                k = max(1.5, cell * 0.07)
                gx = inset + c * cell + cell * 0.13
                gy = inset + r * cell + cell * 0.13
                d.ellipse([gx - k, gy - k, gx + k, gy + k], fill=with_alpha(INK, 120))
    return img


def compose_icon(px, grid, *, bleed=False, content=1.0, radius=None):
    bg = vertical_gradient((px, px), corner=mix(BG_BOTTOM, DISC, 0.22)).convert('RGBA')
    layer = board_layer(px, grid)
    if content != 1.0:
        s = int(px * content)
        layer = layer.resize((s, s), Image.LANCZOS)
        pad = Image.new('RGBA', (px, px), (0, 0, 0, 0))
        pad.paste(layer, ((px - s) // 2, (px - s) // 2), layer)
        layer = pad
    bg = Image.alpha_composite(bg, layer)
    if bleed:
        return bg.convert('RGB')
    out = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    out.paste(bg, (0, 0), rounded_mask((px, px),
                                       radius if radius is not None else int(px * 0.225)))
    return out


def favicon_tile(px):
    """16/32 放不下整盘：取母题第 3 行前四格当 2×2，两符在像素级才分得开。"""
    bg = vertical_gradient((px, px), corner=mix(BG_BOTTOM, DISC, 0.3))
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    img.paste(bg, (0, 0), rounded_mask((px, px), max(2, int(px * 0.24))))
    d = ImageDraw.Draw(img, 'RGBA')
    cell = px / 2.0
    mini = MOTIF_BOARD[3][:4]
    for r in range(2):
        for c in range(2):
            cx, cy = cell * (c + 0.5), cell * (r + 0.5)
            if mini[r * 2 + c] == '0':
                d.ellipse([cx - cell * 0.30, cy - cell * 0.30, cx + cell * 0.30, cy + cell * 0.30],
                          outline=RING, width=max(2, int(cell * 0.19)))
            else:
                d.ellipse([cx - cell * 0.31, cy - cell * 0.31, cx + cell * 0.31, cy + cell * 0.31],
                          fill=DISC)
    return img


def board_texture(px=256):
    """可无缝平铺的盘面织理：只用整数频率正弦叠加，四边天然接得上。"""
    base = mix(SURFACE, SURFACE_LIFT, 0.5)
    lo, hi = shade(base, 0.82), shade(base, 1.20)
    freqs = ((1, 2, 0.5, 0.0), (3, 1, 0.3, 1.1), (2, 5, 0.2, 2.3), (5, 3, 0.12, 0.6))
    flat = array.array('B', bytes(px * px * 3))
    k = 0
    for y in range(px):
        for x in range(px):
            t = 0.0
            for fx, fy, amp, ph in freqs:
                t += amp * math.sin(2 * math.pi * (fx * x / px + fy * y / px) + ph)
            v = max(0.0, min(1.0, 0.5 + t * 0.16))
            flat[k] = int(lo[0] + (hi[0] - lo[0]) * v)
            flat[k + 1] = int(lo[1] + (hi[1] - lo[1]) * v)
            flat[k + 2] = int(lo[2] + (hi[2] - lo[2]) * v)
            k += 3
    return Image.frombytes('RGB', (px, px), flat.tobytes())


def spark_sprite(px=64):
    """胜利粒子的贴图：中心发亮的软点，靠径向渐变而不是实心圆。"""
    big = px * 4
    glow = Image.new('L', (big, big), 0)
    ImageDraw.Draw(glow).ellipse([big * 0.20, big * 0.20, big * 0.80, big * 0.80], fill=255)
    glow = glow.filter(ImageFilter.GaussianBlur(big * 0.13)).resize((px, px), Image.LANCZOS)
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    solid = Image.new('RGBA', (px, px), DISC + (255,))
    img.paste(solid, (0, 0), glow)
    return img


def cjk_font(size):
    for path in CJK_FONTS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def og_card(w=1200, h=630, grid=None):
    img = vertical_gradient((w, h), corner=mix(BG_BOTTOM, DISC, 0.20)).convert('RGBA')
    d = ImageDraw.Draw(img, 'RGBA')
    for i in range(1, 6):
        d.line([(0, h * i / 6), (w, h * i / 6)], fill=LINE + (70,), width=1)
        d.line([(w * i / 6, 0), (w * i / 6, h)], fill=LINE + (70,), width=1)

    board = compose_icon(470, grid, radius=int(470 * 0.16))
    img.paste(board, (w - 470 - 74, int(h / 2 - 235)), board)

    x = 74
    d.text((x, 88), '数白', font=cjk_font(104), fill=INK + (255,))
    d.text((x, 222), 'TAKUZU · 二值偶格推理', font=cjk_font(34), fill=DISC + (255,))
    for k, line in enumerate(('只有 ○ 与 ● 两种符号',
                              '每行每列两符各半 · 不许三连同符',
                              '每局唯一解，每局都能用逻辑推到底')):
        d.text((x, 300 + k * 52), line, font=cjk_font(36), fill=mix(INK, BG_BOTTOM, 0.30) + (255,))
    d.rounded_rectangle([x, 480, x + 340, 552], radius=16, outline=LINE_HEAVY + (220,), width=3)
    d.text((x + 30, 498), 'no guessing · pure logic', font=cjk_font(27), fill=RING + (255,))
    return img.convert('RGB')


def save(img, rel):
    dst = os.path.join(REPO, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    img.save(dst)
    size = img.size
    print(f'  {rel:34s} {size[0]:>4d}x{size[1]:<4d} {os.path.getsize(dst):>8d} B  {img.mode}')
    return dst


def main():
    grid = check_board()
    master = compose_icon(1024, grid)
    scaled = lambda s: master.resize((s, s), Image.LANCZOS)
    jobs = [
        (master, 'icons/icon-1024.png'),
        (scaled(512), 'icons/icon-512.png'),
        (scaled(192), 'icons/icon-192.png'),
        (scaled(96), 'icons/icon-96.png'),
        (scaled(64), 'icons/icon-64.png'),
        (scaled(48), 'icons/icon-48.png'),
        (compose_icon(180, grid, bleed=True), 'icons/apple-touch-icon.png'),
        (compose_icon(512, grid, bleed=True, content=0.72), 'icons/icon-maskable-512.png'),
        (favicon_tile(32), 'icons/favicon-32.png'),
        (favicon_tile(16), 'icons/favicon-16.png'),
        (spark_sprite(64), 'assets/img/spark.png'),
        (board_texture(256), 'assets/img/board-texture.png'),
        (og_card(grid=grid), 'assets/img/og-card.png'),
    ]
    print(f'palette from js/theme.js: {len(PAL)} tokens · motif board is a legal 6x6 Takuzu solution')
    for img, rel in jobs:
        save(img, rel)
    print(f'png count: {len(jobs)}')


if __name__ == '__main__':
    sys.exit(main())
