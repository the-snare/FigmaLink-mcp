// Offscreen document: owns the WebSocket, and nothing else.
//
// Two Chrome constraints decide this shape, both verified on a real build:
//   1. A MV3 service worker cannot hold a long-lived socket — it is reclaimed after
//      ~30s idle and in-flight frames are lost, so the socket lives here instead.
//   2. chrome.storage is NOT available in an offscreen document (chrome.runtime is).
//      So configuration is pushed down by the worker over the port; this file must
//      never try to read it locally.
import { EXECUTOR_REVISION, DEFAULT_WS_URL, BRIDGE_VERSION } from '../lib/const.js';

const HB_MS = 20000;
const ASK_CFG_MS = 3000;
// Two Chrome profiles can load the same unpacked folder and get the SAME extension id,
// so Origin alone cannot tell the clients apart. This distinguishes them in logs.
const BOOT_ID = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;

let port = null;
let ws = null;
let retryTimer = null;
let askTimer = null;
let cfg = { url: DEFAULT_WS_URL, token: '' };
let backoff = 1000;
let lastError = '等待 SW 下发配置';
let connectedAt = 0;

function state(extra) {
  return {
    type: 'wsState',
    url: cfg.url,
    hasToken: !!cfg.token,
    open: !!(ws && ws.readyState === 1),
    swPort: !!port,
    lastError,
    connectedAt,
    revision: EXECUTOR_REVISION,
    bridgeVersion: BRIDGE_VERSION,
    ...extra
  };
}

// The port dies whenever the worker is reclaimed; every post must assume that.
function tryPost(payload) {
  if (!port) return false;
  try { port.postMessage(payload); return true; } catch { port = null; return false; }
}

function pushState() { tryPost(state()); }

function connect() {
  if (!cfg.token) {
    lastError = '没有 token：SW 还没把配置下发过来';
    pushState();
    clearTimeout(askTimer);
    askTimer = setTimeout(() => { tryPost({ type: 'wantCfg' }); connect(); }, ASK_CFG_MS);
    return;
  }
  clearTimeout(askTimer);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  let sock;
  try { sock = new WebSocket(cfg.url); } catch (e) { lastError = `地址无效：${e.message}`; pushState(); return; }
  ws = sock;

  sock.onopen = () => {
    backoff = 1000;
    connectedAt = Date.now();
    lastError = '';
    sock.send(JSON.stringify({ type: 'hello', token: cfg.token, version: EXECUTOR_REVISION, bridgeVersion: BRIDGE_VERSION, bootId: BOOT_ID }));
    pushState();
  };
  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg && msg.type === 'call' && !tryPost(msg)) {
      lastError = 'SW 通道已断，这条 call 没送出去';
      scheduleReconnect();
    }
  };
  sock.onclose = (ev) => {
    // A superseded socket (config change, manual restart) must not schedule a
    // reconnect behind the new one.
    if (sock !== ws) return;
    const wasOpen = connectedAt;
    ws = null;
    connectedAt = 0;
    lastError = ev.reason === 'bad token' ? 'token 不被服务端接受'
      : ev.reason === 'origin not pinned' ? '服务端已钉住另一个扩展来源'
      : ev.code === 1006 ? '连接中断（服务端没在跑，或被代理吃掉）'
      : `关闭 code=${ev.code} ${ev.reason || ''}`.trim();
    if (wasOpen) pushState();
    scheduleReconnect();
  };
  sock.onerror = () => { lastError = lastError || '连接失败'; pushState(); };
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  const wait = backoff;
  backoff = Math.min(backoff * 2, 15000);
  retryTimer = setTimeout(connect, wait);
}

// One socket at a time, always.
function restart() {
  clearTimeout(retryTimer);
  backoff = 1000;
  const old = ws;
  ws = null;
  if (old && old.readyState !== 3) { try { old.close(); } catch { /* already gone */ } }
  connect();
  pushState();
}

function applyCfg(next) {
  const url = next.url || DEFAULT_WS_URL;
  const token = next.token || '';
  const changed = url !== cfg.url || token !== cfg.token;
  cfg = { url, token };
  if (changed) restart();
  else pushState();
}

function onPortMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'cfg') {
    // A cfg carrying no fields comes from an older worker; ask for the real payload
    // instead of wiping the token and going unpaired.
    if (m.url === undefined && m.token === undefined) { tryPost({ type: 'wantCfg' }); return; }
    applyCfg(m);
    return;
  }
  if (m.type === 'result') {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
    else { lastError = 'SW 回了 result 但 socket 已断'; pushState(); }
    return;
  }
  if (m.type === 'poll') { pushState(); return; }
  if (m.type === 'reconnect') { restart(); return; }
  if (m.type === 'hb-ack') { lastError = ''; return; }
}

function openPort() {
  const p = chrome.runtime.connect({ name: 'bridge' });
  p.onMessage.addListener(onPortMessage);
  p.onDisconnect.addListener(() => {
    port = null;
    lastError = 'SW 通道断开（worker 被回收），正在重建';
    // Reconnecting is also what wakes the worker again, and the fresh worker is the
    // only place that can read the stored token.
    setTimeout(() => { port = openPort(); pushState(); tryPost({ type: 'wantCfg' }); }, 500);
  });
  return p;
}

port = openPort();

// Keeps the service worker's idle timer reset while the bridge is expected to be live.
setInterval(() => { if (!tryPost({ type: 'hb', at: Date.now() })) pushState(); }, HB_MS);

pushState();
tryPost({ type: 'wantCfg' });
connect();
