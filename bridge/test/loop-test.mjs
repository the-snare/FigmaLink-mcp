// Stand-in for the Chrome side: proves the MCP(stdio) -> ws -> reply loop, the
// pairing token, and the origin pin without needing a browser. The half this test
// cannot cover is chrome.debugger reaching the Figma tab; that needs real Chrome.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist', 'cli.js');
const PORT = 8799;
const TMP = join(HERE, 'tmp');
const PAIRING = join(TMP, 'pairing.json');
// A path outside FIGMALINK_IMPORT_ROOT; must work on Windows and Linux CI alike.
const OUTSIDE = join(TMP, '..', 'outside-import-test.txt');

mkdirSync(TMP, { recursive: true });
if (existsSync(PAIRING)) rmSync(PAIRING);

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${label}${detail ? ' · ' + detail : ''}`);
};

const child = spawn(process.execPath, [DIST], {
  env: {
    ...process.env,
    FIGMALINK_PORT: String(PORT),
    FIGMALINK_PAIRING_FILE: PAIRING,
    FIGMALINK_OUT_DIR: join(TMP, 'out'),
    FIGMALINK_IMPORT_ROOT: TMP
  },
  stdio: ['pipe', 'pipe', 'pipe']
});
const stderrAll = [];
child.stderr.on('data', (d) => stderrAll.push(String(d).trimEnd()));

let outBuf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  outBuf += chunk;
  let nl;
  while ((nl = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, nl).trim();
    outBuf = outBuf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let rpcId = 0;
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} 无响应`)), 30000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}

function textOf(resp) {
  const c = resp.result && resp.result.content;
  return c && c[0] ? JSON.parse(c[0].text) : null;
}

// A 1x1 PNG, used both as the fake export payload and as the real file an import
// reads from disk.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64').length;
const FIXTURE = join(TMP, 'tiny.png');
writeFileSync(FIXTURE, Buffer.from(PNG_B64, 'base64'));
const STUB_BRIDGE_VERSION = '0.25.0';
const TOOLS_N = 28;
const FILE = 'TESTFILEKEY';

function fakePage(op, arg, tabId, fileKey, strict) {
  const a = arg || {};
  switch (op) {
    case 'env':
      return { requireCaptured: true, registeredModules: 12386, windowGlobals: { figma: 'object' } };
    case 'readTree':
      return a.depth >= 3
        ? {
          id: 'I1:2', name: 'Page root', type: 'PAGE',
          children: Array.from({ length: 400 }, (_, i) => ({ id: `4311:${i}`, name: `Rect ${i}`, type: 'RECTANGLE', x: i * 60, y: 0, width: 40, height: 40 }))
        }
        : { id: 'I1:2', name: 'Page root', type: 'PAGE', children: [{ id: '4311:2', name: 'Frame', type: 'FRAME' }] };
    case 'getNode':
      return {
        node: { id: a.nodeId || '1:2', name: 'Frame A', type: 'FRAME' },
        props: { name: 'Frame A', x: 238, y: 17, width: 685, height: 492, opacity: 1, visible: true, locked: false, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] },
        parent: null, childIds: ['1:4'], page: 'Page 1', fileKey: FILE
      };
    case 'createNode':
      return {
        kind: a.kind, applied: Object.keys(a.props || {}),
        created: { id: '9:1', name: (a.props || {}).name || 'Qoder bridge', type: (a.kind || 'rectangle').toUpperCase() },
        removed: a.revert === false ? null : true, fileKey: FILE,
        pageChildren: { before: 35, now: a.revert === false ? 36 : 35 }
      };
    case 'importSvg':
      return {
        created: { id: 'SVG:1', name: a.name || 'svg', type: 'FRAME', width: 24, height: 24, childCount: 3 },
        scaled: a.width ? { factor: Number(a.width) / 24, from: { width: 24, height: 24 }, to: { width: Number(a.width), height: Number(a.width) }, uniform: true } : null,
        parent: a.parentId ? { id: a.parentId, name: 'Parent' } : 'currentPage',
        placedAt: { x: a.x ?? 0, y: a.y ?? 0 },
        removed: a.revert === false ? null : true,
        svgEcho: { bytes: String(a.svg || '').length, startsWithSvg: /^<svg/i.test(String(a.svg || '')) },
        fileKey: FILE
      };
    case 'duplicate': {
      const srcs = a.nodeIds && a.nodeIds.length ? a.nodeIds : [a.nodeId];
      const count = Number(a.count || 1);
      const dx = Number(a.dx || 0), dy = Number(a.dy || 0);
      if (!srcs[0]) return { error: '需要 nodeId 或 nodeIds' };
      const created = [];
      for (const src of srcs) for (let i = 1; i <= count; i++) created.push({ from: src, id: `D${created.length + 1}`, name: 'copy', type: 'RECTANGLE', x: dx * i, y: dy * i, width: 100, height: 100 });
      return { created, count: created.length, failed: [], removed: a.revert === false ? null : created.length, fileKey: FILE };
    }
    case 'arrange': {
      const ops = ['distribute', 'align', 'grid', 'place', 'fit', 'ungroup'];
      if (!ops.includes(a.op)) return { error: `arrange 的 op 只支持 ${ops.join(' / ')}，收到 ${a.op}` };
      return {
        op: a.op, moved: [{ id: '1:2', name: 'a', from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
        reverted: a.revert === true && a.op !== 'ungroup' ? true : null,
        revertAvailable: a.op !== 'ungroup', missing: [],
        section: a.op === 'fit' ? { id: a.nodeId, name: 'sec' } : undefined,
        sizeAfter: a.op === 'fit' ? { width: 420, height: 260 } : undefined,
        note: a.op === 'ungroup' ? '拆开后不自动还原（重新成组会丢层级/顺序），要撤销用 Ctrl+Z' : 'stub',
        fileKey: FILE
      };
    }
    case '__pageEval':
      return { evaluated: String(a.expression || '').slice(0, 40), href: 'https://www.figma.com/files/recents' };
    case '__createFile':
      return { action: 'created', fileKey: 'NEWFILEKEY00000000000', url: 'https://www.figma.com/design/NEWFILEKEY00000000000/Untitled', title: 'Untitled', tabId: 9, ready: true, waitedMs: 9000, canEdit: true, note: '新文件已可编辑' };
    case 'prototype': {
      const mode = String(a.mode || 'connections');
      if (mode === 'flows') {
        return { mode: 'flows', page: 'Page 1', flows: [{ nodeId: '1:2', name: 'Flow 1', nodeName: 'Home' }], count: 1, note: null, fileKey: FILE };
      }
      if (mode === 'trace') {
        return {
          mode: 'trace', start: { id: a.nodeId || '1:2', name: 'Home' }, screens: 2, maxDepth: a.maxDepth ?? 4, truncated: false,
          edges: [{ from: { id: '1:2', name: 'Home' }, trigger: { type: 'ON_CLICK' }, action: 'NODE', navigation: 'NAVIGATE', to: { id: '1:3', name: 'Detail' }, depth: 0 }],
          note: null, fileKey: FILE
        };
      }
      return {
        mode: 'connections', root: { id: '1:2', name: 'Home', type: 'FRAME' }, depth: a.depth ?? 2, limit: a.limit ?? 60,
        nodes: [{
          id: '1:2', name: 'Home', type: 'FRAME', x: 0, y: 0,
          reactions: [{ trigger: { type: 'AFTER_TIMEOUT', timeoutSec: 0.8 }, actions: [{ type: 'NODE', destinationId: '1:3', destinationName: 'Detail', navigation: 'NAVIGATE' }] }]
        }],
        count: 1, truncated: false, flowStartingPoints: [{ nodeId: '1:2', name: 'Flow 1' }], note: null, fileKey: FILE
      };
    }
    case 'styles':
      return {
        count: 3, howToApply: 'stub',
        paints: { total: 1, truncated: false, styles: [{ id: 'S:p1', name: 'brand/primary', paints: ['SOLID'] }] },
        text: { total: 1, truncated: false, styles: [{ id: 'S:t1', name: 'heading/h1', fontName: { family: 'Inter', style: 'Bold' }, fontSize: 32 }] },
        effects: { total: 1, truncated: false, styles: [{ id: 'S:e1', name: 'shadow/card', effects: ['DROP_SHADOW'] }] },
        grids: { total: 0, truncated: false, styles: [] },
        limit: a.limit ?? null, fileKey: FILE
      };
    case 'runCode':
      return { ok: true, result: { echoed: String(a.code || '').slice(0, 40) }, console: ['log line'], codeLength: String(a.code || '').length };
    case 'patchNode': {
      const one = (nodeId, patch) => ({
        nodeId,
        applied: Object.keys(patch || {}),
        before: { opacity: 1 },
        after: { opacity: (patch || {}).opacity },
        reverted: a.revert === false ? null : true,
        settled: { opacity: a.revert === false ? (patch || {}).opacity : 1 }
      });
      if (Array.isArray(a.patches)) {
        const results = a.patches.map((p) => ({ ...one(p.nodeId, p.patch), askedFor: p.nodeId }));
        return { batch: results.length, failedCount: 0, results, fileKey: FILE };
      }
      return { ...one(a.nodeId, a.patch), fileKey: FILE };
    }
    case 'createTree': {
      const spec = a.spec;
      if (!spec || !spec.kind) return { error: '需要 spec：{kind, props?, children?} 形式的节点树' };
      const count = (s) => 1 + (Array.isArray(s.children) ? s.children.reduce((n, c) => n + count(c), 0) : 0);
      const size = count(spec);
      const cap = a.maxNodes || 400;
      const created = Math.min(size, cap);
      return {
        root: { id: '5000:1', name: (spec.props && spec.props.name) || 'built', type: String(spec.kind).toUpperCase(), childCount: (spec.children || []).length },
        subtreeSize: size, created,
        rejected: created < size ? [`达到 maxNodes ${cap}，后面的节点没建`] : [],
        removed: a.revert === true ? true : null,
        parent: { id: '0:1', name: 'Page 1', type: 'PAGE' },
        pageChildren: { before: 35, now: a.parentId || a.revert === true ? 35 : 36 },
        fileKey: FILE, undoHint: '插件一次执行通常合并为一个撤销步，Ctrl+Z 可整体撤掉'
      };
    }
    case 'readSelection':
      return { error: '没有打开的 figma.com 标签页 —— 先打开一个设计文件（/design/ 或 /file/）' };
    case 'deleteNode': {
      const mode = a.mode || 'hide';
      if (mode === 'hide') {
        return { mode, snapshot: { id: a.nodeId, name: 'Rect', visible: true }, parentId: '1:1', index: 4,
          beforeVisible: true, hidden: true, restored: a.revert === false ? null : true, fileKey: FILE };
      }
      if (mode !== 'remove') return { error: 'mode 只支持 hide 或 remove', got: mode };
      if (a.confirm !== true) return { error: 'remove 会销毁节点对象，插不回来；确要删请传 confirm:true', hint: '想无痕探测就用 mode:"hide"' };
      if (a.revert !== false) return { error: 'remove 无法自动还原：remove() 之后 insertChild 会报 node does not exist。确认删除请同时传 revert:false；已经删了就在 Figma 里按 Ctrl+Z。' };
      return { mode, snapshot: { id: a.nodeId }, removedFrom: { before: 35, now: 34 }, stillThere: false,
        revertAvailable: false, undoHint: '这一步进了 Figma 历史，Ctrl+Z 可撤销', fileKey: FILE };
    }
    case 'exportImage':
      if (Array.isArray(a.nodeIds) && a.nodeIds.length) {
        const files = a.nodeIds.map((id) => ({
          nodeId: id, name: `n-${id}`, format: a.format || 'PNG', scale: a.scale || 1,
          bytes: PNG_BYTES, base64: PNG_B64, mediaType: 'image/png', nodeSize: { width: 100, height: 50 }
        }));
        return { files, failed: [], count: files.length, clip: a.clip === true, fileKey: FILE };
      }
      return {
        nodeId: a.nodeId || '1:2', name: 'Frame A', format: a.format || 'PNG', scale: 1,
        bytes: PNG_BYTES, base64: PNG_B64, mediaType: 'image/png',
        nodeSize: { width: 685, height: 492 }, fileKey: FILE
      };
    case 'importImage': {
      const got = Buffer.from(a.base64 || '', 'base64').length;
      return a.nodeId
        ? { mode: 'fill-node', imageHash: 'IMG1', inputBytes: got, nodeId: a.nodeId, after: { id: a.nodeId, name: 'Target' }, reverted: a.revert !== false, fileKey: FILE }
        : { mode: 'new-node', imageHash: 'IMG1', inputBytes: got, created: { id: '9:9', width: a.width || 240 }, removed: a.revert !== false, fileKey: FILE };
    }
    case '__tabs':
      return { tabs: [{ tabId: 1, pathname: '/design/x', editorRoute: true, active: true }, { tabId: 2, pathname: '/files/x', editorRoute: false, active: false }] };
    case '__open': {
      // The real worker parses the link, reuses/navigates/creates the tab and waits for
      // the editor; the server only forwards, so echoing the URL proves the payload and
      // the tabId pass-through stayed intact.
      if (!a.url && !a.fileKey) return { error: '需要 url（figma 链接）或 fileKey' };
      const key = a.fileKey || (/\/(design|file|board|slides|make|proto)\/([A-Za-z0-9]+)/.exec(a.url) || [])[2] || null;
      const nodeFromUrl = /node-id=([0-9]+)-([0-9]+)/.exec(a.url || '');
      return {
        action: a.reuse === true ? 'navigated' : 'opened', tabId: tabId ?? 7, fileKey: key,
        editorType: 'design', nodeId: a.nodeId || (nodeFromUrl ? `${nodeFromUrl[1]}:${nodeFromUrl[2]}` : null),
        url: a.url || `https://www.figma.com/design/${key}/`, ready: true, waitedMs: 1200, canEdit: true, figmaType: 'object'
      };
    }
    case 'find':
      return { scope: { id: '0:1', name: 'Page 1', type: 'PAGE' }, visited: 320, matched: 2, truncated: false, requestedTabId: tabId ?? null, requestedFileKey: fileKey ?? null, requestedStrict: strict ?? null,
        hits: [{ id: '1:8', name: 'Start here', type: 'TEXT' }, { id: '1:9', name: 'Start here 2', type: 'TEXT' }], fileKey: FILE };
    case 'variables':
      return { collections: [{ id: 'C1', name: 'Brand', modes: ['Mode 1'] }], total: 2,
        variables: [{ id: 'V1', name: 'orange/500', type: 'COLOR', valuesByMode: { 0: { r: 1, g: 0.4, b: 0.1 } } }], truncated: false, fileKey: FILE };
    case 'mutatePage': {
      const act = a.action || 'list';
      if (act === 'list') return { action: act, current: 'Page 1', pages: [{ id: '0:1', name: 'Page 1', childCount: 35 }], fileKey: FILE };
      if (act === 'create') return { action: act, made: { id: 'P2', name: a.name || 'Qoder page' }, removed: a.revert === false ? null : true, pageCount: a.revert === false ? 2 : 1, fileKey: FILE };
      if (act === 'delete') return a.confirm !== true
        ? { error: '删页会销毁整页内容且无法自动还原，确认请传 confirm:true' }
        : { action: act, snapshot: { name: 'Page 2', childCount: 0 }, pageCount: 1, revertAvailable: false, fileKey: FILE };
      return { error: 'action 只支持 create / switch / rename / delete', got: act };
    }
    case 'moveNode':
      return { node: { id: a.nodeId, name: 'moved', type: 'FRAME' },
        movedTo: { parentId: a.parentId || '0:1', index: a.index ?? 0 },
        reverted: a.revert === false ? null : { parentId: '0:1', index: 3 }, fileKey: FILE };
    case 'group':
      return { created: { id: '6000:1', name: a.name || 'Group', type: 'GROUP', childCount: (a.nodeIds || []).length },
        nodeCount: (a.nodeIds || []).length, ungrouped: a.revert === false ? null : true, fileKey: FILE };
    case 'booleanOp':
      if (a.confirm !== true) return { error: '布尔运算会把输入节点吸收进结果，删结果等于删原件，工具无法自动撤销。确认请传 confirm:true（撤销只能 Ctrl+Z）' };
      return { op: a.op, result: { id: '6000:2', name: a.name || 'union', type: 'BOOLEAN_OPERATION' }, absorbed: (a.nodeIds || []).length,
        undoHint: 'Ctrl+Z 可撤销这一步', revertAvailable: false, fileKey: FILE };
    case 'instance': {
      const act = a.action || 'create';
      if (act === 'create') return { action: act, created: { id: '6000:3', name: 'inst', type: 'INSTANCE' },
        mainComponent: { id: a.nodeId, type: 'COMPONENT' }, removed: a.revert === false ? null : true, fileKey: FILE };
      if (act === 'detach') return a.confirm !== true
        ? { error: 'detach 会用 frame 替换掉这个实例，实例本身没了，工具无法自动还原。确认请传 confirm:true（撤销只能 Ctrl+Z）' }
        : { action: act, detached: { id: a.nodeId, type: 'FRAME' }, revertAvailable: false, fileKey: FILE };
      return { error: 'action 只支持 create 或 detach', got: act };
    }
    default:
      return { error: 'stub 不认的 op：' + op };
  }
}

function stubClient(token, handler, origin, version = 'stub-0.11.0', bridgeVersion = STUB_BRIDGE_VERSION) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: origin ? { origin } : {} });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, version, bridgeVersion })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'call' && handler) handler(msg, ws);
  });
  return ws;
}

const onceClose = (ws) => new Promise((resolve) => ws.once('close', (code) => resolve(code)));

const toolCall = (name, args) => rpc('tools/call', { name, arguments: args ?? {} });

try {
  await waitFor(() => stderrAll.some((l) => l.includes('配对 token')), 8000, 'server 启动并打印 token');
  const token = JSON.parse(readFileSync(PAIRING, 'utf8')).token;

  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'loop-test', version: '1' } });
  check('initialize 回协议与能力', init.result && init.result.protocolVersion === '2025-03-26' && !!init.result.capabilities.tools,
    init.result && init.result.protocolVersion);
  notify('notifications/initialized');

  const EXPECT_TOOLS = 'figma_status,figma_get_selection,figma_read_tree,figma_get_node,figma_find,'
    + 'figma_variables,figma_pages,figma_tabs,figma_open,figma_set_selection,figma_create_node,figma_build,figma_patch_node,'
    + 'figma_move_node,figma_group,figma_boolean,figma_instance,figma_delete_node,figma_export_image,figma_import_image,'
    + 'figma_import_svg,figma_duplicate,figma_arrange,figma_get_styles,figma_run_code,'
    + 'figma_create_file,figma_page_eval,figma_get_prototype';
  const list = await rpc('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name);
  check(`tools/list ${TOOLS_N} 个工具顺序正确`, names.join(',') === EXPECT_TOOLS, names.join(','));
  const destructive = (list.result?.tools || []).filter((t) => t.annotations && t.annotations.destructiveHint).map((t) => t.name);
  check('写类工具标了 destructiveHint', destructive.join(',') === 'figma_pages,figma_create_node,figma_build,figma_patch_node,'
    + 'figma_move_node,figma_group,figma_boolean,figma_instance,figma_delete_node,figma_import_image,'
    + 'figma_duplicate,figma_arrange,figma_run_code,figma_create_file,figma_page_eval', destructive.join(','));
  const withTabId = (list.result?.tools || []).filter((t) => t.inputSchema.properties.tabId).map((t) => t.name);
  check('每个工具都接受 tabId', withTabId.length === TOOLS_N, `${withTabId.length}/${TOOLS_N}`);

  const offline = textOf(await toolCall('figma_status'));
  check('未连接时报可读错误而非挂起', offline && offline.ok === false && /扩展未连接/.test(offline.error || ''), offline && offline.error);
  // The agent cannot see the popup, so the error itself has to be the instruction sheet:
  // without url + token it can only say "go pair it" and leave the user guessing.
  check('未连接错误自带 pairing 指引（url/token/步骤）', offline && offline.pairing
    && offline.pairing.url === `ws://127.0.0.1:${PORT}`
    && offline.pairing.token === token
    && Array.isArray(offline.pairing.steps) && offline.pairing.steps.length >= 4
    && /Save and reconnect/.test(offline.pairing.steps.join(' ')), JSON.stringify(offline && offline.pairing && offline.pairing.url));

  const badTokenClient = stubClient('wrong-token', null, 'chrome-extension://eee111');
  const badClose = await Promise.race([onceClose(badTokenClient), sleep(5000).then(() => 'timeout')]);
  check('错 token 被 4001 断开', badClose === 4001, `code=${badClose}`);

  const EXT_ORIGIN = 'chrome-extension://mmockextaaa11122233344455566677';
  const live = stubClient(token, (msg, ws) => {
    const raw = fakePage(msg.op, msg.arg, msg.tabId, msg.fileKey, msg.strict);
    // Echo the routing flags on every reply so the assertions below can see what the
    // server actually put on the wire.
    const res = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...raw, requestedStrict: msg.strict ?? null }
      : raw;
    ws.send(JSON.stringify({
      // Mirror the real worker: a page-level error means ok:false and is also lifted
      // into a top-level error field, which is what the server shows the caller.
      type: 'result', id: msg.id, ok: !(res && res.error), result: res, error: res && res.error,
      target: { tabId: 1, pathname: '/design/FAKEFILEKEY0000000000000/x', editorRoute: true }
    }));
  }, EXT_ORIGIN);
  await waitFor(() => stderrAll.some((l) => l.includes('扩展已配对')), 8000, 'stub 完成握手');

  const status = textOf(await toolCall('figma_status'));
  check('status 走通 ws 往返', status.ok === true && status.result.registeredModules === 12386 && status.client.bridgeVersion === STUB_BRIDGE_VERSION,
    JSON.stringify(status.result));
  // 连上以后不再下发 token：它只需要出现在「让人去填」的现场，不应每回调一次。
  check('已连接的回包带端口但不带 token', status.bridge && status.bridge.port === PORT
    && !JSON.stringify(status).includes(token), `port=${status.bridge && status.bridge.port}`);

  const tree = textOf(await toolCall('figma_read_tree', { depth: 1 }));  check('readTree 带参数走通', tree.ok === true && tree.result.children[0].id === '4311:2', JSON.stringify(tree.result.children));
  check('小结果不打包', tree.packed === false, `bytes=${tree.bytes} 节点=${tree.nodeCount}`);

  const big = textOf(await toolCall('figma_read_tree', { depth: 4 }));
  let fileText = '';
  try { fileText = readFileSync(big.savedTo, 'utf8'); } catch { /* asserted below */ }
  check('超大结果整体落文件，只回裁剪树', big.packed === true && big.nodeCount > 300 && big.returnedNodes <= 120
    && /Rect 399/.test(fileText) && !big.result.children.some((c) => c.name === 'Rect 399')
    && big.result.omittedChildren > 0 && big.result.children.length === big.returnedNodes - 1,
    `节点 ${big.nodeCount} · 回传 ${big.returnedNodes} · 根上标记省略 ${big.result.omittedChildren} · 文件 ${big.bytes} 字节`);

  const node = textOf(await toolCall('figma_get_node', { nodeId: '1:2' }));  check('get_node 取到精确属性与 fileKey', node.ok === true && node.result.props.opacity === 1
    && node.result.fileKey === FILE, JSON.stringify(node.result.props));

  const created = textOf(await toolCall('figma_create_node', { kind: 'rectangle', props: { name: 'probe', x: 10 } }));
  check('create_node 默认 revert 且审计如实', created.ok === true && created.audit.revertRequested === true
    && created.audit.restoreOutcome === true && created.result.pageChildren.now === 35 && created.audit.fileKey === FILE,
    JSON.stringify(created.audit));

  const kept = textOf(await toolCall('figma_create_node', { kind: 'frame', props: { name: 'keepme' }, revert: false }));
  check('revert:false 明确报告节点被留下', kept.ok === true && kept.audit.revertRequested === false
    && kept.audit.restoreOutcome === null && kept.result.pageChildren.now === 36, JSON.stringify(kept.audit));

  const built = textOf(await toolCall('figma_build', {
    spec: {
      kind: 'frame', props: { name: 'Landing', width: 1440, height: 900, fillColor: '#0B1220' },
      children: [
        { kind: 'text', props: { name: 'H1', characters: '标题', fontSize: 56, fontName: { family: 'Inter', style: 'Bold' } } },
        { kind: 'frame', props: { name: 'nav' }, children: [{ kind: 'text', props: { characters: 'a' } }, { kind: 'rectangle', props: { name: 'cta' } }] }
      ]
    }
  }));
  check('build 一次建出嵌套树、默认保留并如实回报规模', built.ok === true && built.result.subtreeSize === 5
    && built.result.created === 5 && built.result.rejected.length === 0 && built.audit.revertRequested === false,
    `subtree ${built.result && built.result.subtreeSize}`);

  const capped = textOf(await toolCall('figma_build', { maxNodes: 2, spec: { kind: 'frame', props: { name: 'big' }, children: [{ kind: 'rectangle' }, { kind: 'rectangle' }, { kind: 'rectangle' }] } }));
  check('build 的 maxNodes 会截断并报告', capped.ok === true && capped.result.subtreeSize === 4
    && capped.result.created === 2 && capped.result.rejected.length === 1, JSON.stringify(capped.result.rejected));

  const badBuild = textOf(await toolCall('figma_build', { spec: { props: { name: 'no kind' } } }));
  check('build 缺 kind 被拒', badBuild.ok === false && /需要 spec/.test(badBuild.error || ''), badBuild.error);

  const patched = textOf(await toolCall('figma_patch_node', { nodeId: '1:2', patch: { opacity: 0.5 } }));
  check('patch_node 回 before/after/settled 三件套', patched.ok === true && patched.result.after.opacity === 0.5
    && patched.result.settled.opacity === 1 && patched.result.reverted === true,
    JSON.stringify(patched.result.settled));

  const batchPatch = textOf(await toolCall('figma_patch_node', {
    patches: [{ nodeId: '1:2', patch: { opacity: 0.2 } }, { nodeId: '1:3', patch: { layoutMode: 'HORIZONTAL', itemSpacing: 40 } }]
  }));
  check('patch 批量模式一次改多节点并识别 auto-layout 键', batchPatch.ok === true && batchPatch.result.batch === 2
    && batchPatch.result.results[1].applied.includes('layoutMode')
    && /批量 2 全部落地/.test(String(batchPatch.audit.restoreOutcome)), JSON.stringify(batchPatch.audit));

  const found = textOf(await toolCall('figma_find', { name: 'Start', types: ['TEXT'], tabId: 77 }));
  check('find 走通且 tabId 透传给扩展', found.ok === true && found.result.matched === 2
    && found.result.requestedTabId === 77, JSON.stringify(found.result.hits));

  const byKey = textOf(await toolCall('figma_find', { name: 'Start', fileKey: 'KEY_FROM_CLIENT' }));
  check('fileKey 定向作为路由参数透传，不混进页面参数', byKey.ok === true
    && byKey.result.requestedFileKey === 'KEY_FROM_CLIENT', JSON.stringify(byKey.result.requestedFileKey));

  // Writes are never aimed by a heuristic: the worker gets strict:true and may refuse
  // when several tabs are open. Reads stay lenient.
  const strictWrite = textOf(await toolCall('figma_patch_node', { nodeId: '1:2', patch: { opacity: 1 } }));
  check('写类工具带 strict 标记（多标签时由扩展拒绝猜测）', strictWrite.ok === true
    && strictWrite.result.requestedStrict === true, JSON.stringify(strictWrite.result.requestedStrict));
  const lenientRead = textOf(await toolCall('figma_find', { name: 'Start' }));
  check('读类工具不被 strict 限制', lenientRead.ok === true && lenientRead.result.requestedStrict === false,
    JSON.stringify(lenientRead.result.requestedStrict));

  const tabs = textOf(await toolCall('figma_tabs'));
  check('figma_tabs 列出可见标签页', tabs.ok === true && tabs.result.tabs.length === 2
    && tabs.result.tabs[0].editorRoute === true, JSON.stringify(tabs.result.tabs[0]));

  const opened = textOf(await toolCall('figma_open', { url: 'https://www.figma.com/design/KEYABC123456/Name?node-id=12-34' }));
  check('figma_open 接链接并回报 fileKey / nodeId / 就绪', opened.ok === true
    && opened.result.fileKey === 'KEYABC123456' && opened.result.nodeId === '12:34'
    && opened.result.ready === true && opened.result.action === 'opened', JSON.stringify(opened.result));

  const openedTab = textOf(await toolCall('figma_open', { fileKey: 'KEYABC123456', tabId: 42 }));
  check('figma_open 支持裸 fileKey 与 tabId 透传', openedTab.ok === true
    && openedTab.result.fileKey === 'KEYABC123456' && openedTab.result.tabId === 42, JSON.stringify(openedTab.result));

  const badOpen = textOf(await toolCall('figma_open', {}));
  check('figma_open 缺链接时报错而不是乱开标签', badOpen.ok === false && /url|fileKey/.test(badOpen.error || ''), badOpen.error);

  const vars = textOf(await toolCall('figma_variables'));
  check('variables 读集合与变量', vars.ok === true && vars.result.collections[0].name === 'Brand'
    && vars.result.variables[0].type === 'COLOR', JSON.stringify(vars.result.collections));

  const pages = textOf(await toolCall('figma_pages', { action: 'list' }));
  check('pages list 可读', pages.ok === true && pages.result.pages[0].name === 'Page 1', JSON.stringify(pages.result.pages));

  const pageDel = textOf(await toolCall('figma_pages', { action: 'delete', page: 'Page 2' }));
  check('删页缺 confirm 被拒', pageDel.ok === false && /confirm:true/.test(pageDel.error || ''), pageDel.error);

  const bool = textOf(await toolCall('figma_boolean', { op: 'union', nodeIds: ['1:2', '1:3'] }));
  check('布尔运算缺 confirm 被拒并说明不可自动撤销', bool.ok === false && /无法自动撤销/.test(bool.error || ''), bool.error);

  const bool2 = textOf(await toolCall('figma_boolean', { op: 'union', nodeIds: ['1:2', '1:3'], confirm: true }));
  check('布尔运算确认后如实报告 revertAvailable:false', bool2.ok === true
    && bool2.result.revertAvailable === false && bool2.audit.restoreOutcome === null, JSON.stringify(bool2.result.result));

  const inst = textOf(await toolCall('figma_instance', { nodeId: '1:2' }));
  check('instance create 默认撤销实例', inst.ok === true && inst.result.removed === true
    && inst.result.created.type === 'INSTANCE', JSON.stringify(inst.result.created));

  const detach = textOf(await toolCall('figma_instance', { nodeId: '1:2', action: 'detach' }));
  check('detach 缺 confirm 被拒', detach.ok === false && /无法自动还原/.test(detach.error || ''), detach.error);

  const moved = textOf(await toolCall('figma_move_node', { nodeId: '1:2', parentId: '1:10', index: 1 }));
  check('move_node 报告 movedTo 与回填位置', moved.ok === true && moved.result.movedTo.parentId === '1:10'
    && moved.result.reverted.parentId === '0:1', JSON.stringify(moved.result.movedTo));

  const grp = textOf(await toolCall('figma_group', { nodeIds: ['1:2', '1:3'] }));
  check('group 默认解组回去', grp.ok === true && grp.result.ungrouped === true && grp.result.nodeCount === 2,
    JSON.stringify(grp.result.created));

  const hidden = textOf(await toolCall('figma_delete_node', { nodeId: '1:2' }));
  check('delete_node 默认 hide 且能还原可见性', hidden.ok === true && hidden.result.mode === 'hide'
    && hidden.result.hidden === true && hidden.result.restored === true, JSON.stringify(hidden.result).slice(0, 160));

  const badMode = textOf(await toolCall('figma_delete_node', { nodeId: '1:2', mode: 'nuke' }));
  check('未知 mode 被拒', badMode.ok === false && /只支持 hide 或 remove/.test(badMode.error || ''), badMode.error);

  const unconfirmed = textOf(await toolCall('figma_delete_node', { nodeId: '1:2', mode: 'remove' }));
  check('remove 缺 confirm 被拒', unconfirmed.ok === false && /confirm:true/.test(unconfirmed.error || ''), unconfirmed.error);

  const autoRevert = textOf(await toolCall('figma_delete_node', { nodeId: '1:2', mode: 'remove', confirm: true }));
  check('remove + 默认 revert 被拒而不是假装能还原', autoRevert.ok === false
    && /无法自动还原/.test(autoRevert.error || ''), autoRevert.error);

  const removed = textOf(await toolCall('figma_delete_node', { nodeId: '1:2', mode: 'remove', confirm: true, revert: false }));
  check('remove 明确报告不可自动还原并给出 Ctrl+Z 提示', removed.ok === true && removed.result.revertAvailable === false
    && removed.result.stillThere === false && /Ctrl\+Z/.test(removed.result.undoHint || ''), JSON.stringify(removed.result.removedFrom));

  const exp = textOf(await toolCall('figma_export_image', { nodeId: '1:2', format: 'PNG' }));
  let expOk = false;
  try {
    expOk = exp.ok === true && exp.result.base64 === undefined && exp.io.bytes === PNG_BYTES
      && readFileSync(exp.io.savedTo).length === PNG_BYTES;
  } catch { /* asserted below */ }
  check('export 落盘且 base64 不进回包', expOk, `${exp.io && exp.io.bytes} 字节 → ${exp.io && exp.io.savedTo}`);

  const imp = textOf(await toolCall('figma_import_image', { path: FIXTURE, x: 10, y: 20, width: 100, height: 50 }));
  check('import 读本地文件并把字节送进页面', imp.ok === true && imp.io.bytes === PNG_BYTES
    && imp.result.inputBytes === PNG_BYTES && imp.result.mode === 'new-node',
    `${imp.io && imp.io.readFrom} → hash ${imp.result && imp.result.imageHash}`);

  // ---- SVG: real vectors, inline or from a file, and the same containment rule ----
  const svgMarkup = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24H0z"/></svg>';
  const svgInline = textOf(await toolCall('figma_import_svg', { svg: svgMarkup, x: 10, y: 20, width: 48 }));
  check('import_svg 内联标记走通并回报缩放', svgInline.ok === true && svgInline.result.created.type === 'FRAME'
    && svgInline.result.svgEcho.startsWithSvg === true && svgInline.result.scaled.to.width === 48
    && svgInline.io && svgInline.io.inline === true, JSON.stringify(svgInline.result.svgEcho));
  check('import_svg 默认 revert 且审计记录', svgInline.ok === true && svgInline.audit.revertRequested === true
    && svgInline.audit.restoreOutcome === true, JSON.stringify(svgInline.audit));
  check('import_svg 被算作写操作（多标签时需定向）', svgInline.result.requestedStrict === true);

  const svgFile = join(TMP, 'icon.svg');
  writeFileSync(svgFile, svgMarkup);
  const svgFromFile = textOf(await toolCall('figma_import_svg', { path: svgFile, revert: false }));
  check('import_svg 从本机 .svg 文件读入', svgFromFile.ok === true && svgFromFile.io.readFrom === svgFile
    && svgFromFile.result.reverted === undefined && svgFromFile.audit.revertRequested === false,
    JSON.stringify(svgFromFile.io));

  const svgOutside = textOf(await toolCall('figma_import_svg', { path: OUTSIDE }));
  check('import_svg 拒绝允许根目录外/非 .svg 的路径', svgOutside.ok === false
    && /必须落在允许根目录内|只接受 \.svg/.test(svgOutside.error || ''), svgOutside.error);

  const svgMissing = textOf(await toolCall('figma_import_svg', { path: join(TMP, 'nope.svg') }));
  check('import_svg 拒绝不存在的文件', svgMissing.ok === false && /不存在/.test(svgMissing.error || ''), svgMissing.error);

  const svgNone = textOf(await toolCall('figma_import_svg', {}));
  check('import_svg 既没 svg 也没 path 时明确报错', svgNone.ok === false && /svg 文本|path/.test(svgNone.error || ''), svgNone.error);

  // ---- batch export + clip + section (the three gaps vs the other bridge) ----------
  const batchExp = textOf(await toolCall('figma_export_image', { nodeIds: ['1:2', '1:3'], format: 'PNG', clip: true }));
  check('批量导出一次写多个文件且字节不进回包', batchExp.ok === true
    && batchExp.result.count === 2 && batchExp.io.count === 2
    && batchExp.result.clip === true && !/base64/.test(JSON.stringify(batchExp.result)),
    `${batchExp.io.count} 个文件`);
  const singleExp = textOf(await toolCall('figma_export_image', { nodeId: '1:2', format: 'PNG' }));
  check('单节点导出仍走原路径（io.savedTo 单值）', singleExp.ok === true && typeof singleExp.io.savedTo === 'string',
    String(singleExp.io.savedTo).slice(-30));

  const fit = textOf(await toolCall('figma_arrange', { op: 'fit', nodeId: 'sec:1', padding: 16 }));
  check('arrange fit 报告 section 尺寸前后', fit.ok === true && fit.result.sizeAfter.width === 420,
    JSON.stringify(fit.result.sizeAfter));

  // ---- styles are a different read path from variables -----------------------------
  const styles = textOf(await toolCall('figma_get_styles', { limit: 10 }));
  check('get_styles 分开返回 paint/text/effect/grid', styles.ok === true
    && styles.result.paints.styles[0].name === 'brand/primary'
    && styles.result.text.styles[0].fontName.style === 'Bold'
    && styles.result.effects.styles[0].effects[0] === 'DROP_SHADOW', JSON.stringify(styles.result.count));
  const styleBind = textOf(await toolCall('figma_patch_node', { nodeId: '1:2', patch: { fillStyleId: 'S:p1', effectStyleId: 'S:e1' } }));
  check('节点可以套用样式（fillStyleId/effectStyleId 进属性词表）', styleBind.ok === true
    && styleBind.result.applied.join(',') === 'fillStyleId,effectStyleId', JSON.stringify(styleBind.result.applied));

  // ---- page_eval is off unless the operator turns it on ----------------------------
  const peOff = textOf(await toolCall('figma_page_eval', { expression: 'return document.title' }));
  check('page_eval 默认关闭并说明怎么开', peOff.ok === false
    && /FIGMALINK_ENABLE_PAGE_EVAL=1/.test(peOff.error || ''), (peOff.error || '').slice(0, 80));

  // ---- creating a file is a permanent side effect, so it is confirm-gated -------------
  const noConfirm = textOf(await toolCall('figma_create_file', {}));
  check('create_file 缺 confirm 被拒并说明无法撤销', noConfirm.ok === false
    && noConfirm.needsConfirm === true && /Drafts/.test(noConfirm.error || ''), (noConfirm.error || '').slice(0, 80));
  const newFile = textOf(await toolCall('figma_create_file', { confirm: true }));
  check('create_file 回报 fileKey / url / ready', newFile.ok === true
    && newFile.result.fileKey === 'NEWFILEKEY00000000000' && newFile.result.ready === true
    && newFile.audit !== null, JSON.stringify(newFile.result.fileKey));
  check('create_file 不要求 tabId 定向（浏览器级操作）', newFile.ok === true && !/定向/.test(newFile.error || ''));

  // ---- prototype wiring is readable, with names resolved ----------------------------
  const conns = textOf(await toolCall('figma_get_prototype', { nodeId: '1:2', depth: 2 }));
  check('prototype connections 带 trigger/destination 名字', conns.ok === true
    && conns.result.nodes[0].reactions[0].trigger.type === 'AFTER_TIMEOUT'
    && conns.result.nodes[0].reactions[0].actions[0].destinationName === 'Detail', JSON.stringify(conns.result.count));
  const flows = textOf(await toolCall('figma_get_prototype', { mode: 'flows' }));
  check('prototype flows 列出原型起点', flows.ok === true && flows.result.flows[0].name === 'Flow 1', JSON.stringify(flows.result.count));
  const traced = textOf(await toolCall('figma_get_prototype', { mode: 'trace', nodeId: '1:2', maxDepth: 3 }));
  check('prototype trace 返回跳转边与屏幕数', traced.ok === true && traced.result.edges.length === 1
    && traced.result.screens === 2 && traced.result.edges[0].to.name === 'Detail', JSON.stringify(traced.result.screens));

  // ---- run_code is off unless the owner process opts in ----------------------------
  const gated = textOf(await toolCall('figma_run_code', { code: 'return 1' }));
  check('run_code 默认关闭并说明怎么开', gated.ok === false
    && /FIGMALINK_ENABLE_RUN_CODE=1/.test(gated.error || ''), (gated.error || '').slice(0, 90));

  // ---- layout: duplicate + arrange are one round trip each, not N ------------------
  const dup = textOf(await toolCall('figma_duplicate', { nodeId: '1:2', count: 3, dx: 24, dy: 0 }));
  check('duplicate 按 count 复制并逐个偏移', dup.ok === true && dup.result.count === 3
    && dup.result.created.map((c) => c.x).join(',') === '24,48,72', JSON.stringify(dup.result.created.map((c) => c.x)));
  check('duplicate 默认 revert 删掉副本', dup.result.removed === 3 && dup.audit.revertRequested === true, JSON.stringify(dup.result.removed));
  const dupKeep = textOf(await toolCall('figma_duplicate', { nodeIds: ['1:2', '1:3'], count: 2, revert: false }));
  check('duplicate 支持多源 + revert:false 留下', dupKeep.ok === true && dupKeep.result.count === 4
    && dupKeep.result.removed === null && dupKeep.audit.revertRequested === false, JSON.stringify(dupKeep.result.count));

  const dist = textOf(await toolCall('figma_arrange', { op: 'distribute', nodeIds: ['1:2', '1:3', '1:4'] }));
  check('arrange distribute 默认保留布局', dist.ok === true && dist.result.op === 'distribute'
    && dist.result.reverted === null && dist.result.revertAvailable === true, JSON.stringify(dist.result.moved));
  const distDry = textOf(await toolCall('figma_arrange', { op: 'distribute', nodeIds: ['1:2', '1:3', '1:4'], revert: true }));
  check('arrange revert:true 当干跑用', distDry.ok === true && distDry.result.reverted === true, JSON.stringify(distDry.result.reverted));
  const ungroup = textOf(await toolCall('figma_arrange', { op: 'ungroup', nodeId: '9:9' }));
  check('ungroup 如实报告不可自动还原', ungroup.ok === true && ungroup.result.revertAvailable === false
    && /Ctrl\+Z/.test(ungroup.result.note || ''), ungroup.result.note);
  const badOp = textOf(await toolCall('figma_arrange', { op: 'teleport', nodeIds: ['1:2'] }));
  check('arrange 未知 op 明确报错', badOp.ok === false && /只支持/.test(badOp.error || ''), badOp.error);

  // Gradient / effects travel through the same patch call, so the property vocabulary
  // has to accept them without inventing new tools.
  const styled = textOf(await toolCall('figma_patch_node', {
    nodeId: '1:2',
    patch: {
      fillGradient: { type: 'LINEAR', stops: [{ position: 0, color: '#0B1220' }, { position: 1, color: '#1E293B' }] },
      effects: [{ type: 'DROP_SHADOW', x: 0, y: 8, radius: 24, color: '#00000033' }],
      strokeAlign: 'INSIDE', dashPattern: [8, 4]
    }
  }));
  check('patch 接受 fillGradient / effects / 描边几何', styled.ok === true
    && styled.result.applied.join(',') === 'fillGradient,effects,strokeAlign,dashPattern'
    && styled.result.requestedStrict === true, JSON.stringify(styled.result.applied));

  // Shape validation of paint/effect specs lives in the page bridge (toGradientPaint /
  // toEffects), not here: the server declares JSON Schema but never enforces it, so a bad
  // spec comes back as a page error naming the exact field. Assert that contract instead
  // of pretending the schema is enforced.

  const impOut = textOf(await toolCall('figma_import_image', { path: OUTSIDE }));
  check('import 拒绝允许根目录外的路径', impOut.ok === false && /必须落在允许根目录内/.test(impOut.error || ''), impOut.error);

  const impMiss = textOf(await toolCall('figma_import_image', { path: join(TMP, 'nope.txt') }));
  check('import 拒绝不存在或非图片文件', impMiss.ok === false && /不存在|只支持/.test(impMiss.error || ''), impMiss.error);

  // HTTP face: same tools, but it must not be reachable without the pairing token —
  // an open loopback endpoint would let any web page trigger Figma writes.
  const noAuth = await fetch(`http://127.0.0.1:${PORT}/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'figma_status', args: {} })
  });
  const noAuthBody = await noAuth.json().catch(() => null);
  check('POST /call 无 token 被 401 拒绝', noAuth.status === 401 && noAuthBody && noAuthBody.ok === false, `HTTP ${noAuth.status}`);

  // A web page can POST to loopback, so the token is not the only gate: anything the
  // browser attaches an Origin to is refused before the token is even looked at.
  const withOrigin = await fetch(`http://127.0.0.1:${PORT}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-figmalink-token': token, origin: 'https://evil.example' },
    body: JSON.stringify({ tool: 'figma_status', args: {} })
  });
  const originBody = await withOrigin.json().catch(() => null);
  check('POST /call 带 Origin 即使 token 正确也被 403 拒绝', withOrigin.status === 403
    && originBody && /Origin/.test(originBody.error || ''), `HTTP ${withOrigin.status}`);

  const authed = await fetch(`http://127.0.0.1:${PORT}/call`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-figmalink-token': token }, body: JSON.stringify({ tool: 'figma_status', args: {} })
  });
  const authedBody = await authed.json().catch(() => null);
  check('POST /call 带 token 走通同一实现', authed.status === 200 && authedBody && authedBody.ok === true
    && authedBody.result.registeredModules === 12386, `HTTP ${authed.status}`);

  const unknown = await toolCall('figma_no_such_tool');
  check('未知工具报 -32602', unknown.error && unknown.error.code === -32602, unknown.error && unknown.error.message);

  // The pin: a second origin with the same token must be refused.
  const second = stubClient(token, null, 'chrome-extension://zzz99999999999999999999999999');
  const secondRefused = await Promise.race([onceClose(second), sleep(5000).then(() => 'timeout')]);
  check('第二个来源被 origin 钉死挡下', secondRefused === 4003, `code=${secondRefused}`);

  const reloaded = await toolCall('figma_read_tree', { depth: 2 });
  check('被拒连接没有顶掉在用的客户端', textOf(reloaded).ok === true);

  // Same origin twice is the reconnect race that used to kill calls in flight: the
  // newcomer must be refused without disturbing the incumbent.
  const dupe = stubClient(token, null, EXT_ORIGIN);
  const dupeCode = await Promise.race([onceClose(dupe), sleep(5000).then(() => 'timeout')]);
  check('同源重复连接被 4009 拒绝', dupeCode === 4009, `code=${dupeCode}`);
  const afterDupe = textOf(await toolCall('figma_get_node', { nodeId: '1:2' }));
  check('重复连接没有在用的客户端被踢', afterDupe.ok === true, afterDupe.error);

  const blind = textOf(await toolCall('figma_get_selection'));
  check('看不到标签页的实例会被强制让位', blind.ok === false && /让位/.test(blind.error || ''), (blind.error || '').slice(0, 130));

  live.close();
  await waitFor(() => stderrAll.some((l) => l.includes('扩展连接已断开')), 5000, '断开事件');
  const afterGone = textOf(await toolCall('figma_status'));
  check('断开后立刻可读失败', afterGone.ok === false && /扩展未连接/.test(afterGone.error || ''), afterGone.error);

  // Same unpacked extension, two builds: the older one must not be able to hold the
  // socket after the newer one reconnects, otherwise a reloaded build is invisible.
  const staleEcho = (msg, ws) => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: { who: 'stale' }, target: null }));
  const stale = stubClient(token, staleEcho, EXT_ORIGIN, '0.13.0', '0.13.0');
  const staleClosed = onceClose(stale);
  await waitFor(async () => (textOf(await toolCall('figma_status'))).result?.who === 'stale', 5000, '旧构建接上');
  const freshEcho = (msg, ws) => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: { who: 'fresh' }, target: null }));
  const fresh = stubClient(token, freshEcho, EXT_ORIGIN, '0.14.0', '0.14.0');
  const staleCode = await Promise.race([staleClosed, sleep(6000).then(() => 'timeout')]);
  check('更新的构建能顶掉同源的旧构建', staleCode === 4002, `code=${staleCode}`);
  const afterFresh = textOf(await toolCall('figma_status'));
  check('接管后调用落到新构建', afterFresh.ok === true && afterFresh.result && afterFresh.result.who === 'fresh', JSON.stringify(afterFresh.result));
  fresh.close();

  // Reloading the extension kills the socket mid-call. A read has to survive that by
  // waiting for the reconnect and replaying, otherwise every reload looks like a bug.
  const dropper = stubClient(token, (msg, ws) => ws.close(), EXT_ORIGIN, '0.15.0', '0.15.0');
  void dropper;
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())).clientKey === 'v:0.15.0', 5000, '断线桩接上');
  const inFlight = toolCall('figma_status');
  await sleep(400);
  const rejoined = stubClient(token, (msg, ws) => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: { who: 'after-retry' }, target: null })), EXT_ORIGIN, '0.15.0', '0.15.0');
  const retried = textOf(await inFlight);
  check('调用中途断线时只读工具等重连后重试一次', retried.ok === true && retried.result && retried.result.who === 'after-retry', JSON.stringify(retried));
  rejoined.close();

  // CLI flags. An MCP host can only pass --port/--token through `args`, so they must beat
  // the env: otherwise one connector entry cannot pick its own port without editing env.
  const ALT_PORT = PORT + 1;
  const ALT_PAIRING = join(TMP, 'pairing-cli.json');
  if (existsSync(ALT_PAIRING)) rmSync(ALT_PAIRING);
  const altChild = spawn(process.execPath,
    [DIST, '--port', String(ALT_PORT), '--token', 'cli-flag-token-1'],
    {
      // FIGMALINK_PORT deliberately points at the primary port: the flag has to win.
      env: { ...process.env, FIGMALINK_PORT: String(PORT), FIGMALINK_PAIRING_FILE: ALT_PAIRING, FIGMALINK_OUT_DIR: join(TMP, 'out') },
      stdio: ['ignore', 'ignore', 'ignore']
    });
  const altUp = await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${ALT_PORT}/health`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
  }, 8000, '--port 生效').then(() => true).catch(() => false);
  check('--port 覆盖 FIGMALINK_PORT，另起一个实例', altUp, `port=${ALT_PORT}`);

  const altToken = existsSync(ALT_PAIRING) ? JSON.parse(readFileSync(ALT_PAIRING, 'utf8')).token : null;
  check('--token 覆盖并写回 pairing.json', altToken === 'cli-flag-token-1', String(altToken));

  // 'accepted' = the server kept the socket open (it only answers bad tokens with a close).
  const altHello = (tok) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ALT_PORT}`, { headers: { origin: 'chrome-extension://clitestaaaaaaaaaaaaaaaaaaaaaa' } });
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); try { ws.close(); } catch { /* gone */ } };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: tok, version: 'cli-1', bridgeVersion: STUB_BRIDGE_VERSION })));
    ws.on('close', (code) => finish(code));
    setTimeout(() => finish('accepted'), 1200);
  });
  check('--token 指定的 token 能配对', (await altHello('cli-flag-token-1')) === 'accepted');
  check('--token 之外的值被 4001 拒绝', (await altHello('cli-flag-token-2')) === 4001);

  altChild.kill();

  const badPort = spawn(process.execPath, [DIST, '--port', '70000'], { stdio: ['ignore', 'ignore', 'ignore'] });
  const badCode = await new Promise((resolve) => badPort.once('exit', resolve));
  check('非法端口 exit 64，不静默回退默认值', badCode === 64, `exit=${badCode}`);

  writeFileSync(join(TMP, 'server-stderr.txt'), stderrAll.join('\n'));
} catch (e) {
  check('测试脚本自身', false, String(e && e.message || e));
  writeFileSync(join(TMP, 'server-stderr.txt'), stderrAll.join('\n'));
} finally {
  child.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项。`);
process.exit(failed.length ? 1 : 0);
