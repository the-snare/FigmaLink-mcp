// Shared CDP executor: the only place that touches chrome.debugger.
//
// Why CDP at all: window.figma is an accessor that returns undefined when the
// caller's stack contains `chrome-extension://`. Anything injected as a content
// script keeps an extension frame in its own stack; CDP Runtime.evaluate does not.
// So this module stays the sole execution path even after the WebSocket transport
// arrived — moving execution into a content script would re-trip that guard.
import { BRIDGE_VERSION, BRIDGE_PATH, EVAL_TIMEOUT_MS, IDLE_DETACH_MS } from './const.js';

const attached = new Map();   // tabId -> timer handle
const timerByTab = new Map(); // tabId -> idle detach timer

const EDITOR_PATH = /^\/(design|file|board|slides|make|proto)\/([A-Za-z0-9]{6,64})(?:\/([^/?#]+))?/;
const FILE_KEY_ONLY = /^[A-Za-z0-9]{6,64}$/;
const NODE_ID = /^I?\d+[-:]\d+(?:;\d+[-:]\d+)*$/;

export function isFigmaEditor(url) {
  // `/design/new` used to match this and looked like an editor route while the app was
  // still creating the file. A real editor route always carries a file key.
  return !!url && /^https:\/\/www\.figma\.com\/(design|file|board|slides|make|proto)\/[A-Za-z0-9]{6,64}/.test(url);
}

// Figma writes node ids with '-' in the URL and ':' in the API. Accept either, always
// hand the API form around, because figma.getNodeById only knows the colon form.
export function normalizeNodeId(input) {
  const s = String(input == null ? '' : input).trim();
  if (!NODE_ID.test(s)) return null;
  return s.replace(/-/g, ':');
}

function buildFigmaUrl(editorType, fileKey, nodeId, label) {
  return `https://www.figma.com/${editorType}/${fileKey}/${label ? `${label}` : ''}${nodeId ? `?node-id=${nodeId.replace(/:/g, '-')}` : ''}`;
}

// One parser for every accepted spelling of "this file": full share link, link without
// scheme, or a bare fileKey. Everything else (host, editor route) is validated here so
// the caller never has to guess whether a string is openable.
export function parseFigmaLink(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { error: '需要 url（figma 链接）或 fileKey' };
  if (FILE_KEY_ONLY.test(raw)) {
    return { fileKey: raw, editorType: 'design', nodeId: null, url: buildFigmaUrl('design', raw, null) };
  }
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { error: `看不懂这个链接：${raw.slice(0, 120)}` }; }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) return { error: `不是 figma.com 的链接：${url.hostname}` };
  const m = EDITOR_PATH.exec(url.pathname);
  if (!m) {
    return { error: `不是设计文件的编辑器路由（要 /design /file /board /slides /make /proto）：${url.pathname.slice(0, 80)}` };
  }
  const nodeId = normalizeNodeId(url.searchParams.get('node-id') || '');
  // Keep the human-readable name segment so the address bar stays recognisable (and a
  // shared link keeps working if Figma ever keys off it). Used raw: decoding then
  // re-encoding a name with spaces/slashes is where these rebuilds usually corrupt.
  const label = (m[3] || '') === m[2] ? '' : (m[3] || '');
  return { fileKey: m[2], editorType: m[1], nodeId, label, url: buildFigmaUrl(m[1], m[2], nodeId, label) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listFigmaTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://www.figma.com/*' });
  return tabs.sort((a, b) => {
    const score = (t) => (isFigmaEditor(t.url) ? 2 : 0) + (t.active ? 1 : 0);
    return score(b) - score(a) || String(b.lastAccessed || '').localeCompare(String(a.lastAccessed || ''));
  });
}

function clearIdle(tabId) {
  const t = timerByTab.get(tabId);
  if (t) clearTimeout(t);
  timerByTab.delete(tabId);
}

// Holding the debugger between calls is much faster than re-attaching per tool
// call, but the "is debugging this browser" infobar stays up while attached —
// so drop it once the bridge goes quiet.
function armIdleDetach(tabId) {
  clearIdle(tabId);
  timerByTab.set(tabId, setTimeout(() => {
    chrome.debugger.detach({ tabId }).catch(() => {});
    attached.delete(tabId);
    timerByTab.delete(tabId);
  }, IDLE_DETACH_MS));
}

async function bridgeSource() {
  const r = await fetch(chrome.runtime.getURL(BRIDGE_PATH));
  if (!r.ok) throw new Error(`读不到内置桥源码：HTTP ${r.status}`);
  return r.text();
}

// The expected version comes out of the bridge source we just read from disk, not
// from the constant baked into this worker. Comparing against the baked constant is
// what let a page keep running an old bridge (and refuse new ops) after the file on
// disk had changed but the worker had not been reloaded.
function expectedVersion(src) {
  const m = /FIGMALINK_BRIDGE_VERSION\s*=\s*'([^']+)'/.exec(src);
  return m ? m[1] : BRIDGE_VERSION;
}

function buildExpression(op, arg, src) {
  const want = expectedVersion(src);
  return '(async () => {\n'
    + '  if (!window.__Figmalink || window.__Figmalink.version !== ' + JSON.stringify(want) + ') {\n'
    + '    delete window.__Figmalink;\n'
    + '    ' + src + '\n'
    + '  }\n'
    + '  if (!window.__Figmalink) throw new Error("bridge failed to install");\n'
    + '  return await window.__Figmalink.run(' + JSON.stringify(op) + ', ' + JSON.stringify(arg === undefined ? null : arg) + ');\n'
    + '})()';
}

function withTimeout(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).catch((e) => { throw e; }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms 未返回）`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function ensureAttached(tabId) {
  if (!attached.has(tabId)) {
    await withTimeout(chrome.debugger.attach({ tabId }, '1.3'), 10000, 'chrome.debugger.attach');
    attached.set(tabId, true);
  }
  clearIdle(tabId);
}

// A readiness probe has to run without injecting the page bridge: injecting 50KB of
// bridge source into a still-loading editor is wasteful, and it would also mark the
// page as "bridged" before it can actually serve ops. It is a raw CDP evaluate, so it
// keeps the one requirement that matters (no chrome-extension:// frame on the stack).
const PROBE_EXPR = '(() => { const o = (window.INITIAL_OPTIONS && window.INITIAL_OPTIONS.editing_file) || {};'
  + ' return { href: location.href, state: document.readyState, figmaType: typeof window.figma,'
  + ' canEdit: typeof o.can_edit === "boolean" ? o.can_edit : null, bridge: typeof window.__Figmalink }; })()';

export async function probeTab(tabId) {
  try {
    await ensureAttached(tabId);
    const res = await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: PROBE_EXPR, returnByValue: true
    }), 8000, '页面探针');
    armIdleDetach(tabId);
    if (res && res.exceptionDetails) return { error: '探针求值抛错：' + (res.exceptionDetails.text || '') };
    return (res && res.result && res.result.value) || { error: '探针没有返回值' };
  } catch (e) {
    attached.delete(tabId);
    try { await chrome.debugger.detach({ tabId }); } catch { /* not attached */ }
    return { error: String((e && e.message) || e) };
  }
}

export async function evaluate(tabId, op, arg, timeoutMs) {
  const src = await withTimeout(bridgeSource(), 8000, '读取内置桥源码');
  await ensureAttached(tabId);
  // A whole-tree build legitimately takes tens of seconds (a font load per text node),
  // so the page-evaluation budget follows the caller's timeout instead of a constant.
  const budget = Math.max(EVAL_TIMEOUT_MS, (Number(timeoutMs) || 0) - 5000);
  const res = await withTimeout(chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: buildExpression(op, arg, src),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }), budget, `页面内求值 ${op}`);
  armIdleDetach(tabId);
  if (res && res.exceptionDetails) {
    const ex = res.exceptionDetails;
    return { error: '页面内抛错: ' + ((ex.exception && (ex.exception.description || ex.exception.value)) || ex.text), line: ex.lineNumber };
  }
  return res && res.result ? res.result.value : { error: 'CDP 没有返回值' };
}

// Returns { ok, result, error, target } — never throws, because the caller is an
// agent turn with no human watching the popup for an error string.
//
// Targeting has to be explicit once more than one Figma tab is open, because "the active
// one" is a guess: the user may be looking at file B while the agent was told to edit
// file A. So: tabId must exist (no silent fallback — that is how a write lands in the
// wrong file), fileKey resolves to whichever tab is showing that file, and only when
// neither is given do we fall back to the most editor-like tab and say so.
export async function runOp(op, arg, tabIdHint, timeoutMs, fileKeyHint, strictHint) {
  const tabs = await listFigmaTabs();
  if (!tabs.length) {
    return { ok: false, error: '没有打开的 figma.com 标签页 —— 先打开一个设计文件（/design/ 或 /file/）' };
  }
  const keyOf = (t) => {
    const q = parseFigmaLink((t && (t.url || t.pendingUrl)) || '');
    return q.error ? null : q.fileKey;
  };
  let tab = null;
  let matchedBy = null;
  let wantedKey = null;
  if (fileKeyHint) {
    const parsedHint = parseFigmaLink(fileKeyHint);
    wantedKey = parsedHint.error ? String(fileKeyHint).trim() : parsedHint.fileKey;
    const pinned = tabs.filter((t) => keyOf(t) === wantedKey);
    if (!pinned.length) {
      return {
        ok: false,
        error: `没有打开 fileKey=${wantedKey} 的 Figma 标签页 —— 先用 figma_open 打开它，或改用 tabId 定向。当前可见：${tabs.map((t) => `${t.id}:${keyOf(t) || '?'}`).join(', ')}`,
        fileKey: wantedKey
      };
    }
    tab = (tabIdHint && pinned.find((t) => t.id === tabIdHint)) || pinned[0];
    matchedBy = 'fileKey';
  } else if (tabIdHint) {
    tab = tabs.find((t) => t.id === tabIdHint) || null;
    if (!tab) {
      return {
        ok: false,
        error: `tabId=${tabIdHint} 不是当前可见的 Figma 标签页（不静默换标签，否则写操作会落到别的文件）。可见：${tabs.map((t) => `${t.id}:${keyOf(t) || '?'}${t.active ? '(active)' : ''}`).join(', ')}`
      };
    }
    matchedBy = 'tabId';
  } else {
    tab = tabs[0];
    matchedBy = 'heuristic';
  }
  // Writes refuse to guess. With N tabs open and no explicit target, "the active one" is
  // a coin flip for an agent that was told to edit file A while the user looks at file B.
  if (strictHint && matchedBy === 'heuristic' && tabs.length > 1) {
    return {
      ok: false,
      error: `有 ${tabs.length} 个 Figma 标签页，写操作必须显式定向（传 tabId 或 fileKey），否则可能改错文件。可见：${tabs.map((t) => `${t.id}:${keyOf(t) || '?'}${t.active ? '(active)' : ''}`).join(', ')}`,
      needsTargeting: true
    };
  }
  const sameFileTabs = wantedKey ? tabs.filter((t) => keyOf(t) === wantedKey).length
    : tabs.filter((t) => keyOf(t) === keyOf(tab)).length;
  const target = {
    tabId: tab.id,
    pathname: (() => { try { return new URL(tab.url || tab.pendingUrl).pathname; } catch { return null; } })(),
    editorRoute: isFigmaEditor(tab.url),
    fileKey: keyOf(tab),
    matchedBy,
    sameFileTabs,
    otherFigmaTabs: tabs.length - 1,
    ...(matchedBy === 'heuristic' && tabs.length > 1 ? { ambiguity: `${tabs.length} 个 Figma 标签页，无定向参数时默认选最像编辑器的那个（active 优先）；要确定就传 tabId 或 fileKey` } : {})
  };
  if (!target.editorRoute) {
    return { ok: false, error: '选中的是 Figma 非编辑器页面（' + target.pathname + '），window.figma 在这种路由上不存在', target };
  }
  try {
    const result = await evaluate(tab.id, op, arg, timeoutMs);
    return { ok: !(result && result.error), result, error: result && result.error, target };
  } catch (e) {
    const text = String((e && e.message) || e);
    attached.delete(tab.id);
    chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    if (/Another debugger|already attached|Being debugged|Cannot access/i.test(text)) {
      return { ok: false, error: '该标签页已被 DevTools 或其他调试器占用（含 Qoder Browser Connector）—— 关掉占用方再试', raw: text, target };
    }
    return { ok: false, error: text, target };
  } finally {
    clearIdle(tab.id);
    if (attached.has(tab.id)) armIdleDetach(tab.id);
  }
}

// Polls until the editor can actually answer ops. "Tab finished loading" is not the
// same moment as "window.figma exists": the app boots after the document completes,
// and a file without edit permission never gets the API at all — that case must be
// reported instead of waited out.
async function waitForEditor(tabId, waitMs) {
  const started = Date.now();
  const deadline = started + waitMs;
  let lastUrl = null;
  let probeError = null;
  let lastProbe = null;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return { ready: false, error: '标签页已关闭', waitedMs: Date.now() - started }; }
    const url = tab.url || tab.pendingUrl || '';
    if (url) lastUrl = url;
    if (tab.status === 'complete' && isFigmaEditor(url)) {
      const probe = await probeTab(tabId);
      lastProbe = probe;
      if (probe && !probe.error) {
        if (probe.figmaType === 'object') {
          return {
            ready: true, waitedMs: Date.now() - started, url: probe.href || url,
            figmaType: probe.figmaType, canEdit: probe.canEdit
          };
        }
        if (probe.canEdit === false) {
          return {
            ready: false, waitedMs: Date.now() - started, url: probe.href || url,
            figmaType: probe.figmaType, canEdit: false,
            note: '页面已加载，但 INITIAL_OPTIONS.editing_file.can_edit=false：这个文件对当前账号是只读的，window.figma 永远不出现。等下去没用，先确认编辑权限/团队席位，或刷新页面让服务端重算。'
          };
        }
      } else if (probe && probe.error) {
        probeError = probe.error;
      }
    }
    await sleep(700);
  }
  return {
    ready: false, waitedMs: Date.now() - started, url: lastUrl,
    figmaType: lastProbe && lastProbe.figmaType, canEdit: lastProbe && lastProbe.canEdit,
    note: (probeError ? `等待超时；探针也没成功（${probeError}）。` : '等待编辑器就绪超时（大文件首屏可能要更久，或标签页在后台被节流）。')
      + '可以用 figma_status 再确认一次。'
  };
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (typeof tab.windowId === 'number') {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* 最小化/无窗口权限时忽略 */ }
    }
  } catch { /* 激活失败不影响已经完成的导航 */ }
}

// "Give me a link, jump the browser there." Browser state, not page state, so it runs
// here in the worker: it must also work when there is no Figma tab at all, which is
// exactly the case runOp() refuses.
// Verbatim navigation. Used for pages we deliberately do not understand (file browser,
// "new file" routes, settings): it must not pretend to be a design file, and it must not
// hijack the tab the user has a real file open in, so a new tab is the default.
async function rawNavigate(a, timeoutMs) {
  const raw = String(a.url || '').trim();
  if (!raw) return { ok: false, error: 'raw 模式需要 url' };
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { ok: false, error: `看不懂这个 URL：${raw.slice(0, 120)}` }; }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) return { ok: false, error: `raw 模式只允许 figma.com，收到 ${u.hostname}` };
  const created = await chrome.tabs.create({ url: u.toString(), active: a.activate !== false });
  const tabId = created.id;
  if (a.activate !== false) await focusTab(tabId);
  const waitMs = Math.max(2000, Math.min(Number(a.waitMs) || 12000, Math.max(4000, (Number(timeoutMs) || 30000) - 5000)));
  const deadline = Date.now() + waitMs;
  let finalUrl = u.toString();
  let title = null;
  let status = null;
  let prev = null;
  let stable = 0;
  while (Date.now() < deadline) {
    let t = null;
    try { t = await chrome.tabs.get(tabId); } catch { break; }
    finalUrl = t.url || finalUrl;
    title = t.title || title;
    status = t.status;
    // A client-side redirect shows up as url changes after status=complete; require the
    // same url twice so the reported fileKey is the one the app settled on.
    if (status === 'complete') {
      if (prev === finalUrl) stable += 1; else { stable = 0; prev = finalUrl; }
      if (stable >= 1) break;
    }
    await sleep(500);
  }
  const parsed = parseFigmaLink(finalUrl);
  return {
    ok: true,
    result: {
      action: 'raw', tabId,
      requestedUrl: u.toString(), url: finalUrl, title, status,
      editorRoute: isFigmaEditor(finalUrl),
      resolvedFileKey: parsed.error ? null : parsed.fileKey,
      note: isFigmaEditor(finalUrl)
        ? '落到了编辑器路由：可以用 figma_status 继续'
        : '这是一个非编辑器页面，window.figma 在这里不存在（只能看 URL/标题）'
    },
    target: { tabId, pathname: (() => { try { return new URL(finalUrl).pathname; } catch { return null; } })(), editorRoute: isFigmaEditor(finalUrl) }
  };
}

// Creating a file turned out to be reachable: Figma's /design/new route makes a real
// draft and redirects to /design/<key>/Untitled. It is not in the Plugin API, so this is
// browser navigation, not canvas work — and the file it leaves behind cannot be deleted by
// this bridge, which is why the server demands confirm:true before calling it.
// Main-world evaluation on any figma.com tab (editor or not). This is the seam for UI
// automation — file browser, dialogs — where the plugin API has nothing to offer. It is
// deliberately dumb: pick a tab, run the expression, return the JSON value. Policy (what
// is allowed to run) lives in the server, because that is where the operator config is.
export async function pageEval(expression, tabIdHint, fileKeyHint, timeoutMs) {
  const tabs = await chrome.tabs.query({ url: 'https://www.figma.com/*' });
  if (!tabs.length) return { ok: false, error: '没有 figma.com 标签页' };
  let tab = null;
  if (tabIdHint) tab = tabs.find((t) => t.id === tabIdHint) || null;
  if (!tab && fileKeyHint) {
    tab = tabs.find((t) => {
      const q = parseFigmaLink(t.url || '');
      return !q.error && q.fileKey === fileKeyHint;
    }) || null;
  }
  if (!tab) tab = tabs.find((t) => /\/files/.test(t.url || '')) || tabs[0];
  try {
    await ensureAttached(tab.id);
    // Wrapped as an async function body so `return`/top-level await work — otherwise a
    // "return {...}" expression is aSyntaxError and shows up as a bare "Uncaught".
    const wrapped = '(async () => { ' + expression + ' })()';
    const res = await withTimeout(chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', {
      expression: wrapped, awaitPromise: true, returnByValue: true, userGesture: true
    }), Math.max(5000, (Number(timeoutMs) || 30000) - 5000), '页面主世界求值');
    armIdleDetach(tab.id);
    if (res && res.exceptionDetails) {
      return { ok: false, error: '页面内抛错：' + (res.exceptionDetails.text || ''), target: { tabId: tab.id, url: tab.url } };
    }
    return { ok: true, result: res && res.result ? res.result.value : null, target: { tabId: tab.id, url: tab.url } };
  } catch (e) {
    attached.delete(tab.id);
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch { /* not attached */ }
    return { ok: false, error: String((e && e.message) || e), target: { tabId: tab.id, url: tab.url } };
  }
}

export async function createFigmaFile(arg, timeoutMs) {
  const a = arg || {};
  const nav = await rawNavigate({
    url: 'https://www.figma.com/design/new',
    activate: a.activate !== false,
    waitMs: 6000
  }, timeoutMs);
  if (!nav.ok) return nav;
  const tabId = nav.result.tabId;
  const waitMs = Math.max(15000, Math.min(Number(a.waitMs) || 45000, Math.max(20000, (Number(timeoutMs) || 90000) - 8000)));
  const deadline = Date.now() + waitMs;
  let fileKey = nav.result.resolvedFileKey;
  let url = nav.result.url;
  // The tab reports "complete" on /design/new before the server has handed out a key; the
  // redirect to /design/<key>/Untitled comes later, so poll for the key itself.
  while (!fileKey && Date.now() < deadline) {
    try { const t = await chrome.tabs.get(tabId); url = t.url || url; } catch { break; }
    const p = parseFigmaLink(url);
    if (!p.error) fileKey = p.fileKey;
    else await sleep(700);
  }
  if (!fileKey) {
    return {
      ok: false,
      tabId,
      error: `等了 ${Math.round(waitMs / 1000)}s 仍没拿到 fileKey（当前 ${url}）—— Figma 可能改了这个路由、账号不让建文件，或者文件其实建好了但没跳转`,
      result: { ...nav.result, url }
    };
  }
  const ready = await waitForEditor(tabId, Math.max(8000, deadline - Date.now()));
  return {
    ok: true,
    result: {
      action: 'created', fileKey, url, title: nav.result.title,
      tabId, ready: ready.ready === true,
      waitedMs: ready.waitedMs, canEdit: ready.canEdit ?? null,
      note: ready.ready === true
        ? '新文件已可编辑；名字还是 Untitled，改名只能在 Figma 界面里做'
        : (ready.error || ready.note || '新建了，但没能在超时内变成可编辑状态')
    },
    target: { tabId, pathname: (() => { try { return new URL(url).pathname; } catch { return null; } })(), editorRoute: isFigmaEditor(url) }
  };
}

export async function openFigma(arg, timeoutMs) {
  const a = arg || {};
  if (a.raw === true) return rawNavigate(a, timeoutMs);
  const parsed = parseFigmaLink(a.url || a.link || a.fileKey || a.file);
  if (parsed.error) return { ok: false, error: parsed.error };
  if (a.nodeId != null && String(a.nodeId).trim() !== '') {
    const nodeId = normalizeNodeId(a.nodeId);
    if (!nodeId) return { ok: false, error: `nodeId 格式不对：${a.nodeId}（要 1:2 或 1-2）` };
    parsed.nodeId = nodeId;
    parsed.url = buildFigmaUrl(parsed.editorType, parsed.fileKey, nodeId, parsed.label);
  }

  const waitMs = Math.max(3000, Math.min(Number(a.waitMs) || 45000, Math.max(5000, (Number(timeoutMs) || 120000) - 5000)));
  const activate = a.activate !== false;
  const tabs = await listFigmaTabs();
  const parsedOf = (t) => parseFigmaLink((t && (t.url || t.pendingUrl)) || '');
  // An explicit tabId has to win over the tab list: a tab that is mid-navigation is
  // missing from query({url}) for a moment, and letting that fall through to the
  // "open a new tab" branch produces a duplicate tab for the file you just navigated.
  let explicit = null;
  if (a.tabId != null && a.tabId !== '') {
    try { explicit = await chrome.tabs.get(Number(a.tabId)); } catch { explicit = null; }
  }
  const unique = [...(explicit ? [explicit] : []), ...tabs].filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);
  const sameFile = unique.filter((t) => { const q = parsedOf(t); return !q.error && q.fileKey === parsed.fileKey; });
  const identicalTo = (t) => {
    const q = parsedOf(t);
    return !q.error && q.fileKey === parsed.fileKey && (q.nodeId || null) === (parsed.nodeId || null);
  };

  // Same file, different node: select in place so the user's undo history and any
  // unsaved canvas state survive. Only reload the URL if the page cannot answer.
  const jumpWithinTab = async (tab, current) => {
    if (parsed.nodeId && !current.error && current.fileKey === parsed.fileKey) {
      const sel = await runOp('setSelection', { nodeId: parsed.nodeId, scrollToFit: true }, tab.id, Math.min(20000, waitMs));
      if (sel.ok) return 'focused';
    }
    await chrome.tabs.update(tab.id, { url: parsed.url });
    return 'navigated';
  };

  let tabId;
  let action;
  if (explicit && a.newTab !== true) {
    tabId = explicit.id;
    action = identicalTo(explicit) ? 'reused' : await jumpWithinTab(explicit, parsedOf(explicit));
  } else if (sameFile.length && a.newTab !== true) {
    const target = sameFile.find((t) => t.id === Number(a.tabId)) || sameFile[0];
    tabId = target.id;
    action = identicalTo(target) ? 'reused' : await jumpWithinTab(target, parsedOf(target));
  } else if (a.reuse === true && tabs.length) {
    const target = tabs.find((t) => t.id === Number(a.tabId)) || tabs[0];
    tabId = target.id;
    action = identicalTo(target) ? 'reused' : await jumpWithinTab(target, parsedOf(target));
  } else {
    // Default for an unopened file is a new tab: navigating someone's current tab away
    // from an open design is destructive in a way no tool result could undo.
    const created = await chrome.tabs.create({ url: parsed.url, active: activate });
    tabId = created.id;
    action = 'opened';
  }

  if (activate) await focusTab(tabId);
  const ready = await waitForEditor(tabId, waitMs);
  let finalUrl = ready.url || parsed.url;
  try { const t = await chrome.tabs.get(tabId); finalUrl = t.url || finalUrl; } catch { /* tab gone */ }

  return {
    ok: true,
    result: {
      action, tabId, fileKey: parsed.fileKey, editorType: parsed.editorType, nodeId: parsed.nodeId,
      url: finalUrl, ready: ready.ready === true,
      waitedMs: ready.waitedMs, canEdit: ready.canEdit ?? null, figmaType: ready.figmaType ?? null,
      note: ready.error ? ready.error : (ready.note || null),
      otherFigmaTabs: Math.max(0, tabs.length - (action === 'opened' ? 0 : 1))
    },
    target: { tabId, pathname: (() => { try { return new URL(finalUrl).pathname; } catch { return null; } })(), editorRoute: isFigmaEditor(finalUrl) }
  };
}

export async function detachAll() {
  for (const tabId of [...attached.keys()]) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    clearIdle(tabId);
  }
  attached.clear();
}

export function attachedTabs() { return [...attached.keys()]; }

// Guarded so the pure link/id helpers in this file stay importable from Node: the
// parsing rules are the part of this module worth unit-testing outside a browser.
if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && typeof source.tabId === 'number') { attached.delete(source.tabId); clearIdle(source.tabId); }
  });
}
