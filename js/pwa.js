// Service worker 注册。单独一个文件，是为了让 index.html 里那一行 <script> 就是全部的接线成本。
//
// 两条硬边界：
//   * file:// 是 Electron 的 loadFile 形态，那里没有 SW 语义，注册会以未捕获的
//     SecurityError 收场 —— 整段跳过，且不许抛出。
//   * 明文 http 只有本机回环算安全上下文；Pages 上是 https，本地 npm start 是 127.0.0.1。
//     在别的 http 源上注册会静默失败并留一条控制台报错，不如不注册。

const inSecureContext = () => {
  const proto = typeof location === 'undefined' ? '' : location.protocol;
  if (proto === 'https:') return true;
  if (proto !== 'http:') return false;
  const host = location.hostname || '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
};

export function registerServiceWorker() {
  if (!inSecureContext()) return 'skipped';
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  try {
    // base 必须写字面量 document.baseURI：部署集闸（tools/deploy-set.mjs）靠那条正则
    // 认出「sw.js 是一份真引用」——写成 base 变量它就认不出，产物里少了 sw.js 也没人红。
    // 兜底仍留着：document.baseURI 为空串时用 location.href，否则 new URL 会抛。
    const base = document.baseURI || (typeof location !== 'undefined' ? location.href : '/');
    const reg = navigator.serviceWorker.register(new URL('sw.js', document.baseURI || base).href, {
      scope: new URL('./', document.baseURI || base).pathname,
    });
    // 注册失败（离线首帧、配额、Pages 未部署完）不该变成页面上的未捕获拒绝。
    if (reg && typeof reg.catch === 'function') reg.catch(() => {});
    return 'registered';
  } catch {
    return 'failed';
  }
}

const status = registerServiceWorker();

if (typeof window !== 'undefined') {
  window.takuzuPwa = { status: () => status };
}
