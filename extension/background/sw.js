// MV3 service worker: owns the debugger execution and the offscreen lifecycle.
// Transport (offscreen, holds the socket) and execution (here, holds chrome.debugger)
// are split because neither context can do both reliably — a worker cannot keep a
// socket alive, and the reason strings an offscreen document may declare are limited.
import { runOp, openFigma, createFigmaFile, pageEval, detachAll, attachedTabs, listFigmaTabs, isFigmaEditor } from '../lib/executor.js';
import { EXECUTOR_REVISION, DEFAULT_WS_URL } from '../lib/const.js';

let toOffscreen = null;
let lastWsState = null;
let bootOffscreen = null;
let activeOps = 0;
let pendingReload = null;

// Unpacked extensions keep running the code they were registered with: the files on
// disk are served fresh, but the manifest snapshot (and therefore the worker) only
// changes on reload. That mismatch is the single most confusing failure mode here —
// the agent sees behaviour of a build nobody edited. So the worker compares itself
// against the manifest on disk and reloads when the disk wins, once it is idle.
const RELOAD_ATTEMPT_KEY = 'autoReloadAttempts';
let lastDiskCheck = 0;

async function diskManifest() {
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function noteReloadAttempt(version) {
  // A version mismatch that reload cannot fix (broken manifest) would otherwise loop
  // forever, one reload per heartbeat.
  const stored = await chrome.storage.local.get([RELOAD_ATTEMPT_KEY]).catch(() => ({}));
  const map = stored[RELOAD_ATTEMPT_KEY] || {};
  map[version] = (map[version] || 0) + 1;
  await chrome.storage.local.set({ [RELOAD_ATTEMPT_KEY]: map }).catch(() => {});
  return map[version];
}

async function attemptsFor(version) {
  const stored = await chrome.storage.local.get([RELOAD_ATTEMPT_KEY]).catch(() => ({}));
  const map = stored[RELOAD_ATTEMPT_KEY] || {};
  return map[version] || 0;
}

async function reloadIfDiskNewer(reason, force) {
  if (!force && Date.now() - lastDiskCheck < 15000) return null;
  lastDiskCheck = Date.now();
  const disk = await diskManifest();
  const loaded = chrome.runtime.getManifest().version;
  if (!disk || !disk.version) return { ok: false, error: '读不到磁盘上的 manifest.json' };
  if (disk.version === loaded) {
    return { ok: true, reloaded: false, loaded, disk: disk.version, note: '内存里跑的就是磁盘版本' };
  }
  const attempts = await attemptsFor(disk.version);
  if (attempts >= 3) {
    return { ok: false, reloaded: false, loaded, disk: disk.version,
      error: `磁盘 ${disk.version} 已尝试自动重载 ${attempts} 次仍未生效 —— manifest 可能写坏了，去 chrome://extensions 手动移除后重新加载` };
  }
  if (activeOps > 0) {
    pendingReload = { reason, disk: disk.version, loaded };
    return { ok: true, reloaded: false, deferred: true, loaded, disk: disk.version, note: '有调用在跑，等它结束再重载' };
  }
  const n = await noteReloadAttempt(disk.version);
  console.warn(`[rea-sw] 磁盘 ${disk.version} ≠ 内存 ${loaded}（${reason}，第 ${n} 次）—— 自动重载扩展`);
  chrome.runtime.reload();
  return { ok: true, reloaded: true, loaded, disk: disk.version };
}

function finishOp() {
  activeOps = Math.max(0, activeOps - 1);
  if (activeOps === 0 && pendingReload) {
    const p = pendingReload;
    pendingReload = null;
    reloadIfDiskNewer(p.reason, true).catch(() => {});
  }
}

async function hasOffscreen() {
  if (typeof chrome.runtime.getContexts !== 'function') return false;
  try {
    const docs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return Array.isArray(docs) && docs.length > 0;
  } catch { return false; }
}

// The Reason enum has grown between Chrome releases; passing a value this build
// does not know rejects createDocument outright, so pick the first supported one.
function pickReason() {
  const known = (chrome.offscreen && chrome.offscreen.Reason) ? Object.values(chrome.offscreen.Reason) : [];
  for (const r of ['MESSAGE_PORT', 'WORKERS', 'DOM_PARSER', 'STATIC_FILES']) {
    if (!known.length || known.includes(r)) return r;
  }
  return known[0] || 'MESSAGE_PORT';
}

// Never throws: an offscreen failure must not take down status/savePairing, which
// is what made the popup hang with "no response".
async function ensureOffscreen() {
  try {
    if (await hasOffscreen()) return { created: false, existed: true };
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: [pickReason()],
      justification: 'Keeps a loopback WebSocket open to the local FigmaLink bridge, which an idle service worker cannot hold.'
    });
    return { created: true };
  } catch (e) {
    const error = String((e && e.message) || e);
    if (/already exists/i.test(error)) return { created: false, existed: true };
    return { created: false, error };
  }
}

// Every branch answers, including on throw. A rejected async body used to close the
// message port silently, which the popup could only report as "SW 没应答".
function reply(sendResponse, fn) {
  Promise.resolve().then(fn).then((r) => {
    sendResponse(r === undefined ? { ok: true } : r);
  }).catch((e) => {
    console.warn('[rea-sw] 处理消息抛错', e);
    sendResponse({ ok: false, error: `${String((e && e.message) || e)}`, stack: String((e && e.stack) || '').split('\n').slice(0, 4).join(' | ') });
  });
}

function answer(p, payload) {
  if (!p) return false;
  try { p.postMessage(payload); return true; } catch { return false; }
}

// The offscreen document cannot read chrome.storage, so the worker is the only
// config source and it must push on demand as well as on change.
async function cfgPayload() {
  const s = await chrome.storage.local.get(['wsUrl', 'token']);
  return { type: 'cfg', url: s.wsUrl || DEFAULT_WS_URL, token: s.token || '' };
}

async function pushCfg() {
  return answer(toOffscreen, await cfgPayload());
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.wsUrl)) pushCfg().catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bridge') return;
  toOffscreen = port;
  pushCfg().catch(() => {});
  port.onMessage.addListener((m) => {
    if (!m || typeof m !== 'object') return;

    if (m.type === 'wsState') { lastWsState = m; maybeRecycleOffscreen(m.revision); reloadIfDiskNewer('心跳时发现磁盘版本变了').catch(() => {}); return; }
    if (m.type === 'hb') { answer(port, { type: 'hb-ack' }); reloadIfDiskNewer('心跳时发现磁盘版本变了').catch(() => {}); return; }
    if (m.type === 'wantCfg') { pushCfg().catch(() => {}); return; }

    if (m.type === 'call') {
      // Answered here rather than in the page: "which tabs exist" is browser state, and
      // the agent needs it before it can pin a tabId on a later call.
      if (m.op === '__tabs') {
        listFigmaTabs().then((tabs) => answer(port, {
          type: 'result',
          id: m.id,
          ok: true,
          result: {
            tabs: tabs.map((t) => ({
              tabId: t.id,
              title: t.title,
              pathname: (() => { try { return new URL(t.url).pathname; } catch { return null; } })(),
              editorRoute: isFigmaEditor(t.url),
              active: t.active
            }))
          }
        })).catch((e) => answer(port, { type: 'result', id: m.id, ok: false, error: String((e && e.message) || e) }));
        return;
      }

      if (m.op === '__pageEval') {
        activeOps += 1;
        pageEval(String((m.arg && m.arg.expression) || ''), m.tabId, m.fileKey, m.timeoutMs).then((r) => answer(port, {
          type: 'result', id: m.id, ok: r.ok !== false && !r.error,
          result: r.result === undefined ? null : r.result, error: r.error, target: r.target
        })).catch((e) => answer(port, { type: 'result', id: m.id, ok: false, error: String((e && e.message) || e) }))
          .finally(finishOp);
        return;
      }

      // Creating a file is browser state too: there is no tab to target yet.
      if (m.op === '__createFile') {
        activeOps += 1;
        createFigmaFile(m.arg, m.timeoutMs).then((r) => answer(port, {
          type: 'result', id: m.id, ok: r.ok !== false && !r.error,
          result: r.result === undefined ? null : r.result, error: r.error, target: r.target
        })).catch((e) => answer(port, { type: 'result', id: m.id, ok: false, error: String((e && e.message) || e) }))
          .finally(finishOp);
        return;
      }

      // Opening a file is browser state, answered here for the same reason as __tabs:
      // it has to work before any Figma tab exists, and it may create the tab itself.
      if (m.op === '__open') {
        activeOps += 1;
        openFigma(m.arg, m.timeoutMs).then((r) => answer(port, {
          type: 'result', id: m.id, ok: r.ok !== false && !r.error,
          result: r.result === undefined ? null : r.result, error: r.error, target: r.target
        })).catch((e) => answer(port, { type: 'result', id: m.id, ok: false, error: String((e && e.message) || e) }))
          .finally(finishOp);
        return;
      }

      const budget = Math.max(2000, Number(m.timeoutMs) || 25000) - 3000;
      // Answer exactly once. The MCP side has its own timer, so a late duplicate
      // would only confuse it.
      let settled = false;
      const once = (payload) => { if (!settled) { settled = true; answer(port, payload); } };
      const guard = setTimeout(() => once({
        type: 'result', id: m.id, ok: false,
        error: `扩展侧 ${budget}ms 未完成 ${m.op}（页面内求值没返回）`
      }), budget);
      activeOps += 1;
      runOp(m.op, m.arg, m.tabId, m.timeoutMs, m.fileKey, m.strict).then((r) => {
        clearTimeout(guard);
        once({
          type: 'result',
          id: m.id,
          ok: r.ok !== false && !r.error,
          result: r.result === undefined ? null : r.result,
          error: r.error,
          target: r.target
        });
      }).catch((e) => {
        clearTimeout(guard);
        once({ type: 'result', id: m.id, ok: false, error: `SW 路由异常：${String((e && e.message) || e)}` });
      }).finally(finishOp);
    }
  });
  port.onDisconnect.addListener(() => {
    toOffscreen = null;
    lastWsState = null;
    ensureOffscreen().catch(() => {});
  });
});

// An offscreen document keeps running the code it was created with, even after the
// files on disk change. Since it cannot be forced to reload from outside, recycle it
// when it reports a stale revision — once per revision so a cache that keeps serving
// old JS cannot loop here.
let recycledFor = null;

function maybeRecycleOffscreen(revision) {
  if (!revision || revision === EXECUTOR_REVISION || recycledFor === revision) return;
  recycledFor = revision;
  chrome.offscreen.closeDocument()
    .catch(() => {})
    .then(() => ensureOffscreen())
    .then((r) => { bootOffscreen = { ...r, recycledFrom: revision }; toOffscreen = null; });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'status') {
    reply(sendResponse, async () => {
      const tabs = await listFigmaTabs();
      return {
        ok: true,
        ws: lastWsState,
        attached: attachedTabs(),
        offscreen: bootOffscreen,
        stored: await chrome.storage.local.get(['wsUrl', 'token']).then((s) => ({ wsUrl: s.wsUrl || null, hasToken: !!s.token })),
        tabs: tabs.slice(0, 6).map((t) => ({ tabId: t.id, pathname: new URL(t.url).pathname, editorRoute: isFigmaEditor(t.url), active: t.active })),
        revision: EXECUTOR_REVISION
      };
    });
    return true;
  }

  if (msg.type === 'savePairing') {
    reply(sendResponse, async () => {
      const url = msg.url || DEFAULT_WS_URL;
      const token = (msg.token || '').trim();
      await chrome.storage.local.set({ wsUrl: url, token });
      const offscreen = await ensureOffscreen();
      const notified = await pushCfg();
      return { ok: !offscreen.error, notified, offscreen, stored: { url, hasToken: !!token } };
    });
    return true;
  }

  if (msg.type === 'op') {
    reply(sendResponse, () => runOp(msg.op, msg.arg, msg.tabId));
    return true;
  }

  if (msg.type === 'reloadSelf') {
    reply(sendResponse, () => reloadIfDiskNewer('popup 手动触发', true));
    return true;
  }

  if (msg.type === 'reconnect') {
    reply(sendResponse, async () => {
      const offscreen = await ensureOffscreen();
      const notified = await pushCfg();
      return { ok: !offscreen.error, offscreen, notified };
    });
    return true;
  }

  if (msg.type === 'release') {
    reply(sendResponse, async () => {
      await detachAll();
      return { ok: true, attached: attachedTabs() };
    });
    return true;
  }
});

chrome.runtime.onStartup.addListener(() => { ensureOffscreen().then((r) => { bootOffscreen = r; }); });
chrome.runtime.onInstalled.addListener(() => { ensureOffscreen().then((r) => { bootOffscreen = r; }); });

ensureOffscreen().then((r) => { bootOffscreen = r; });
reloadIfDiskNewer('扩展加载时', true).catch(() => {});
