// Two-language catalogue for the popup.
//
// Why not `_locales/` + chrome.i18n: that follows the browser UI language and cannot
// be switched at runtime, which is exactly what you need when you are debugging with
// a bilingual team. So the catalogue and the choice live here instead.
//
// Scope: this only covers strings the popup itself owns. Text produced deeper in the
// stack (`background/sw.js`, `lib/executor.js`) is diagnostic payload that also goes
// out over MCP to the agent, so it stays as-is and is shown verbatim.
//
// The *keys* of the status JSON stay English on purpose: they are identifiers you grep
// for, not prose. Only their values are translated.
export const LANGS = ['en', 'zh-CN'];

const MESSAGES = {
  en: {
    'version_line': 'v{version} · executor {rev}',
    'group.link': 'Link · local MCP bridge ↔ extension',

    'field.url': 'URL',
    'field.url.tip': 'Address of the local MCP bridge. Default ws://127.0.0.1:1210',
    'field.token': 'Token',
    'field.token.tip': 'Pairing token: printed to the bridge stderr at startup, also kept in bridge/pairing.json',
    'field.token.ph': 'paste token',

    'btn.save.aria': 'Save and reconnect',
    'btn.save.tip': 'Save URL + token, then push them to the offscreen socket and reconnect',
    'btn.refresh.aria': 'Read link status',
    'btn.refresh.tip': 'Read link status now — this popup never refreshes itself',
    'btn.release.aria': 'Release debugger',
    'btn.release.tip': 'Detach the debugger from every Figma tab — usually unnecessary, it also drops itself after 3 min idle',
    'btn.reload.aria': 'Reload extension',
    'btn.reload.tip': 'Reload the extension from disk — it also does this by itself within ~20s once manifest.json version moves',
    'btn.status': 'Status',
    'btn.status.tip': 'Show or hide the raw status JSON',
    'btn.lang.tip': 'Switch interface language',

    'pane.empty': '// status not read yet.',
    'target.notConnected': 'not connected',
    'target.swError': 'SW error',
    'target.linkUp': 'link up',
    'target.linkDown': 'link down',

    'error.uncaught': 'uncaught error',
    'error.unhandled': 'unhandled promise rejection',

    'hint.receivingEnd': 'the SW is not registered, or it throws as soon as it wakes. Open chrome://extensions and read the Errors for this extension — that is the only place the raw exception shows up.',
    'hint.portClosed': 'the SW is alive but never replied — one of its branches returned early.',
    'hint.noResponse': 'the SW is alive but that async branch threw without a catch. Every branch answers since 0.10.1; seeing this again means the new sw.js on disk has not been reloaded.',

    'verdict.swNoAnswer': 'SW did not answer',
    'verdict.swFailure': 'SW answered with a failure',
    'verdict.saveFailed': 'save failed: SW did not answer',
    'common.unknown': 'unknown',
    'common.none': '(none)',

    'probe.swFile.unreadable': 'unreadable: {msg}',
    'probe.verdict': 'running {name} v{version} (registration snapshot) while disk is {disk} — reload the extension; if the snapshot has no background field the SW cannot exist at all, and if reload does not take, remove the extension and install it again (packaged file, or the unpacked folder when developing)',
    'probe.contexts.unavailable': 'chrome.runtime.getContexts unavailable',
    'probe.contexts.none': 'none (also normal while the SW sleeps)',
    'probe.contexts.failed': 'getContexts failed both ways',
    'probe.contexts.rejected': '{types} rejected: {msg}; ',
    'probe.permission.failed': 'query failed: {msg}',
    'probe.tabs.failed': 'query threw: {msg}',

    'status.staleRev': '{rev} ← disk is {disk}, reload required',
    'status.ws.none': 'offscreen reported nothing (see offscreen and storage below)',
    'status.offscreenRev.missing': '(not reported)',
    'status.offscreenRev.stale': '{rev} ← stale document, the SW is rebuilding it',

    'saved.ok': 'Saved. Config pushed down to the offscreen document: {notified}',
    'saved.notified.yes': 'yes',
    'saved.notified.no': 'no (fresh document, it connects on its own)',

    'release.ok': 'Debugger released: {json}',
    'release.failed': 'release failed: {err} {hint}',

    'reload.reloading': 'reloading: this popup closes now, reopen for the new build',
    'reload.notReloaded': 'not reloaded',
    'reload.hint': 'if the version still does not move after a few seconds, this SW is too old to know the message: click the refresh icon for this extension on chrome://extensions.'
  },

  'zh-CN': {
    'version_line': 'v{version} · 执行器 {rev}',
    'group.link': '链路 · 本机 MCP bridge ↔ 扩展',

    'field.url': 'URL',
    'field.url.tip': '本机 MCP bridge 的地址，默认 ws://127.0.0.1:1210',
    'field.token': 'Token',
    'field.token.tip': '配对 token：bridge 启动时打印在 stderr，也写在 bridge/pairing.json',
    'field.token.ph': '粘贴 token',

    'btn.save.aria': '保存并重连',
    'btn.save.tip': '保存 URL + token，下发给 offscreen 并重连',
    'btn.refresh.aria': '读链路状态',
    'btn.refresh.tip': '立刻读一次链路状态 —— 这个弹窗不会自己刷新',
    'btn.release.aria': '释放调试器占用',
    'btn.release.tip': '从所有 Figma 标签页上 detach 调试器 —— 通常不需要，空闲 3 分钟它自己也会放',
    'btn.reload.aria': '重载扩展',
    'btn.reload.tip': '从磁盘重载扩展 —— manifest.json 版本一变，它自己也会在 ~20 秒内重载',
    'btn.status': '状态',
    'btn.status.tip': '展开或收起原始状态 JSON',
    'btn.lang.tip': '切换界面语言',

    'pane.empty': '// 还没读状态。',
    'target.notConnected': '未连接',
    'target.swError': 'SW 报错',
    'target.linkUp': '已连接',
    'target.linkDown': '未连接',

    'error.uncaught': '未捕获错误',
    'error.unhandled': '未处理的 Promise 拒绝',

    'hint.receivingEnd': 'SW 没注册，或一被唤醒就抛错。去 chrome://extensions 看本扩展的「Errors/错误」红字，那是唯一能看到原始异常的地方。',
    'hint.portClosed': 'SW 活着但没回包 —— 它的分支提前返回了。',
    'hint.noResponse': 'SW 活着，但那次调用的 async 分支抛错且没有 catch。0.10.1 起每个分支都保证回包；如果还在报这条，说明磁盘上的新 sw.js 还没被重新加载。',

    'verdict.swNoAnswer': 'SW 没应答',
    'verdict.swFailure': 'SW 回了失败',
    'verdict.saveFailed': '保存失败：SW 没应答',
    'common.unknown': '未知',
    'common.none': '(无)',

    'probe.swFile.unreadable': '读不到：{msg}',
    'probe.verdict': '正在跑的是 {name} v{version}（注册快照），磁盘已是 {disk} —— 重新加载扩展；快照里没有 background 字段时 SW 必然不存在，重新加载若没生效就移除后重新安装扩展（打包版直接装；本地开发时才是「加载已解压的扩展程序」）',
    'probe.contexts.unavailable': 'chrome.runtime.getContexts 不可用',
    'probe.contexts.none': '无（SW 休眠时这里也可能为空，属正常）',
    'probe.contexts.failed': 'getContexts 两次都失败',
    'probe.contexts.rejected': '{types} 被拒：{msg}；',
    'probe.permission.failed': '查询失败：{msg}',
    'probe.tabs.failed': '查询抛错：{msg}',

    'status.staleRev': '{rev} ← 磁盘已是 {disk}，必须重载',
    'status.ws.none': 'offscreen 没回过状态（看下面的 offscreen 与 storage）',
    'status.offscreenRev.missing': '(未上报)',
    'status.offscreenRev.stale': '{rev} ← 旧文档，SW 正在重建',

    'saved.ok': '已保存。已把配置下发给 offscreen：{notified}',
    'saved.notified.yes': '是',
    'saved.notified.no': '否（文档刚创建，稍后自动连）',

    'release.ok': '调试器已释放：{json}',
    'release.failed': '释放失败：{err} {hint}',

    'reload.reloading': '正在重载：本弹窗会立刻关闭，重开即新版本',
    'reload.notReloaded': '没重载',
    'reload.hint': '若几秒后版本号仍然没变，说明这个 SW 太旧不认识这条消息：去 chrome://extensions 点本扩展的刷新图标。'
  }
};

let current = 'en';

export function getLang() { return current; }

export function setLang(lang) {
  current = MESSAGES[lang] ? lang : 'en';
  return current;
}

export function t(key, vars) {
  const dict = MESSAGES[current] || MESSAGES.en;
  let out = dict[key] !== undefined ? dict[key] : (MESSAGES.en[key] !== undefined ? MESSAGES.en[key] : key);
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
  return out;
}

// Prefer the browser UI language, fall back to whatever the page exposes, then English.
export function detectLang() {
  let raw = '';
  try { raw = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || ''; } catch { raw = ''; }
  raw = raw || (typeof navigator !== 'undefined' && navigator.language) || 'en';
  return /^zh/i.test(raw) ? 'zh-CN' : 'en';
}

// Attributes rather than a big JS table keep popup.html readable: the English string
// lives in the catalogue, the markup only carries the key.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-tip]')) el.dataset.tip = t(el.dataset.i18nTip);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  if (root.documentElement) root.documentElement.lang = current;
}
