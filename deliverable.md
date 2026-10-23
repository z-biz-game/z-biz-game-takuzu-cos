# 交付说明 · 数白 Takuzu（并线收口这一轮）

本轮做的事：**把这个仓从「整局不可玩」修回可玩，并把并线留下的缝合体拆成「两侧并集」**。

## 一、并线的两侧各管什么

分叉点 `ab76d0f`（2026-09-28）。两侧各自往前走了：

| | 本地侧 `505aaff`（10-02） | 远端侧 `923cec7`（10-06） |
|---|---|---|
| app | 重写了整份页面与实现：暂停遮罩、HUD 图形键、`js/pwa.js`、safe-area、44×44 拇指下限、系统 reduceMotion、dt 动画环 | 只在 app 上加过三样：`重开本题` 的 `Game.resetAll()`、320 档顶栏折行、社交卡 og:image 绝对 URL |
| 闸与工程 | 自带 `tools/frame-parity.mjs` + `frame-probe.mjs`（三档对拍 + 阴性对照） | 部署集闸（`deploy-set.mjs` / `selftest` / `assemble-site.sh`）、CI 两种 URL 形态、`.gitignore`、README 重写 |

**并线工具把两边按块裁到了一起，裁出来的结果是缝合体**：`index.html` 成了「远端侧的头 + 本地侧的身」，
`js/main.js` 成了「本地侧的身 + 远端侧接在末尾的实现块」，`js/audio/synth.js` 两边的函数各留一半。
结果页面在模块求值那一刻就 `ReferenceError`，**整局不可玩**，仓里的浏览器闸一步都没跑到。

## 二、缝出来的断裂（逐条修掉）

| # | 断裂 | 症状 | 怎么修的 |
|---|---|---|---|
| 1 | `js/main.js` 丢了本地侧的 `syncPauseHud` / `syncFullHud` / `toggleFullscreen` / `fullscreenElement` 四段定义，调用点还在 | 模块求值即 `ReferenceError` ⇒ 整页只剩壳 | 恢复本地侧那一份实现（它写的是本仓真实存在的 `#btn-full` / `#btn-pause`） |
| 2 | `js/main.js` 末尾接进了远端侧那一整块：绑**并不存在**的 `#btn-fullscreen` 的全屏 IIFE、第二份暂停实现、第二份静音键 | 同一颗键两个处理器 ⇒ 双开关；那颗全屏按钮点了没反应，量具却算它"已实现" | 删掉那一块；只留一份实现，被删那份带的前缀能力（`webkit`/`ms`、不支持就置灰并说明）**并进**留下那份 |
| 3 | `js/audio/synth.js` 两边各留一半：`audible()` / `suspended` / `oscillators` / `syncContext()` 的声明和定义全被裁掉，使用点还在 | 每次发声 `ReferenceError`（`oscillators++` 是给未声明变量赋值，模块严格模式） | 恢复本地侧那一份（它带 `setSuspended`，暂停时真 suspend AudioContext） |
| 4 | `index.html` 是「远端侧的头 + 本地侧的身」：顶栏多出 `#btn-fullscreen` 与一枚 `#btn-pause`，而本地侧要的 `#btn-full`（图形键）根本没进页面 | **重复 id `#btn-pause`**；`el.btnFull` 取到 null ⇒ `syncFullHud()` 必炸 | 页面整体回到本地侧那一份（闸 `tools/frame-probe.mjs` 认的正是 `#pause-veil` / `#btn-pause`） |
| 5 | 两处 service worker 注册：`js/main.js` 里一份、`js/sw-register.js` 里一份 | 同一个 scope 注册两次 | 留本地侧的 `js/pwa.js`（它还多两件事：`file://` 与非安全上下文整段跳过、注册失败不冒泡），删掉 `js/sw-register.js` |
| 6 | `js/pwa.js` 里 `new URL('sw.js', base)` 的 base 是变量 ⇒ 部署集闸那条正则（认 `document.baseURI`）认不出「sw.js 是一份真引用」 | 产物里少了 `sw.js` 也没人红 | 把字面量 `document.baseURI` 写回调用里（兜底仍留着）——这是**修 helper 的盲区**，不是削弱 |
| 7 | 远端侧的社交卡 og:image（绝对 URL）被本地侧的相对写法盖掉 | 部署集闸 R7「og:image 是本站绝对 URL」会红；抓取器也不会替 Pages 补 `/<slug>/` | 页面回到本地侧，但 og:image / twitter:image 保留远端侧的绝对 URL（并指到本地侧新产的 `assets/img/og-card.png`） |
| 8 | 远端侧 320 档顶栏折行的修复（`@media (max-width: 420px)`）没进本地侧的 CSS | 320 宽下顶栏最右那枚键掉出屏幕 | 把那段并进本地侧的 CSS（注释里的按钮 id 改成真实存在的 `#btn-full`） |
| 9 | 本地侧的帧率无关性闸（`tools/frame-parity.mjs`）**只在本机跑过**，CI 里没有 | 闸写了不跑等于没有闸 | 接进 CI 的 check job，并加 `npm run parity` 入口 |

## 三、闸：一条断言没删，强度只升不降

- **新增一条浏览器腿 `hud`（23 条断言）**：这一轮恢复的那批入口此前**没有任何断言覆盖**——
  暂停遮罩、全屏键、静音键、重开键、? 回选档。现在逐条咬住：暂停真的停表（`#stat-time` 1.2 秒不变）、
  真的挂起音频设备（`runtime().audio.suspended`）、恢复不丢步数；静音键与音效按钮必须是同一条路
  （键位与 `aria-pressed` 不得各说各话）；重开留在同一张盘且账本归零。
- `tools/deploy-set.mjs`：**实数钉** `EXPECT_CHECKS 24 → 26`、`EXPECT_ROWS 43 → 45`
  （页面回到本地侧那版，head 里多三档图标 + manifest + `js/pwa.js`，R 段因此多解析出两条引用）。
  **钉的是实数，强度不变**：R12/R13 两条断言本身没动。
- `tools/deploy-set-selftest.mjs` 未改：十三刀照旧发力，X10 阴性对照照旧不发力。

## 四、文档按实测读数对齐

`README.md` / `DESIGN.md` / `.github/workflows/ci.yml`：124 项 Node 断言、**273** 项浏览器断言（10 个场景）、
部署集 26 条引用 / 45 行断言；键位表补齐（Enter·Space 开局 / P 暂停 / R 重开本局 / N 换一局 /
M 静音 / F 全屏 / H 提示 / Z 撤销 / ? 看规则）；`DESIGN.md` 新增 §12「暂停、复位、静音：三把互不串味的锁」
与 §13「帧率无关性：仓里自带一把尺」。

## 五、实数读数（本机实跑）

```
npm run check          OK
npm test               124 通过 / 0 失败
npm run balance        阶梯成立
npm run parity         正向分叉字段数 = 0；阴性对照分叉 7 个字段（尺子有效）
bash tools/verify.sh   10 腿 273 checks / 0 failed（root 形态）
                       10 腿 273 checks / 0 failed（前缀形态 = Pages 实际服务的形态）
deploy-set             26 条引用（含 3 张位图尺寸核对），失败 0 项 / rows 45
deploy-set-selftest    rc=0（每一刀都按预期发力）
cos_load_sweep         LOADED（并线后是 LOAD-ERROR）
```

## 六、需人接手的三条

1. **`重开本题`（远端侧的 `Game.resetAll()`）这一版没有接进主线**：主线用的是本地侧的
   `restart()`（同一道题重出一份干净的 `st`，并返回前后数值对）。两者语义相同，但实现路线不同，
   `resetAll()` 如今在 `js/ui/game.js` 里没有调用点。要不要把 `restart()` 改成走 `resetAll()`（省一次出题），
   需要拍板 —— 这一步会动到引擎层的复位语义。
2. **页面归属**：本轮让页面整体回到本地侧那一份（它带暂停遮罩与图形键，闸也认它）。
   若组织更希望保留远端侧那份页面（顶栏文字键），那要改的是 `js/main.js` 的 `el` 映射与
   `syncPauseHud` 的目标 id，不是改页面。
3. **帧率闸的官方探针**：`cos_frame_probe.js` 载不动本仓的 ESM 形态（装载期就 SyntaxError），
   本轮接进 CI 的是仓里自带那把尺。若组织希望官方探针也能跑，得先给它一条 ESM 装载路径。

## 七、改过的文件

```
index.html          回到本地侧那一份；og:image / twitter:image 保留远端侧的绝对 URL
js/main.js          回到本地侧那一份（恢复四段定义、完整键位线）；全屏前缀能力取并集
js/audio/synth.js   回到本地侧那一份（audible / suspended / oscillators / syncContext 归位）
css/game.css        回到本地侧那一份；并进远端侧 320 档顶栏折行
js/pwa.js           取径写回 document.baseURI（让部署集闸认得出 sw.js）
js/sw-register.js   删除（与 pwa.js 重复注册 service worker；闸与文档都没点名它）
js/ui/game.js       不动（两侧只差一个 resetAll，留着远端侧那份）
tools/scenarios.js  新增 hud 腿（23 条断言）
tools/verify.sh     场景列表加 hud
tools/deploy-set.mjs 实数钉 26 / 45
package.json        加 parity 入口
.github/workflows/ci.yml  接进帧率无关性闸 + 读数
README.md / DESIGN.md      读数、键位表、设计说明对齐
deliverable.md      本文件（新建）
```
