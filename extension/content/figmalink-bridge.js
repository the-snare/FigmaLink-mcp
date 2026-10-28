// MAIN-world bridge for FigmaLink: the code that actually touches window.figma.
//
// Two independent control surfaces are reachable from a content script running
// in the page's main world:
//
//   1. window.figma — on editor routes (/design/, /file/, /board/, /slides/,
//      /make/) this is a LIVE Plugin API object: createRectangle/createFrame/
//      currentPage/getNodeByIdAsync/ui/viewport all work, and mutations land in
//      the document. Its properties are non-enumerable, so Object.keys() lies —
//      probe by typeof. On non-editor routes it is undefined (or the void 0
//      decoy the app installs), so never assume; check.
//   2. The Rspack module graph — globalThis.rspackChunk_figma_web_bundler is a
//      writable global, so pushing a chunk with a runtime callback yields
//      __webpack_require__. This build does not expose require.c, so modules are
//      located by scanning factory source text and then requiring the id.
//
// Surface 1 is the documented API and is what the prototype drives. Surface 2 is
// the escape hatch used to find the in-page MCP tool dispatcher.
(() => {
  'use strict';
  if (window.__Figmalink) return;
  // Sentinel the executor parses out of this file's own text, so a page holding an
  // older bridge gets reinstalled even when the worker itself was not reloaded.
  const FIGMALINK_BRIDGE_VERSION = '0.25.0';

  const CHUNK_GLOBAL = 'rspackChunk_figma_web_bundler';
  let req = null;

  function boot() {
    if (req) return req;
    const arr = globalThis[CHUNK_GLOBAL];
    if (!Array.isArray(arr) || arr.push === Array.prototype.push) return null;
    arr.push([['__re_' + Math.random().toString(36).slice(2)], {}, (r) => { req = r; }]);
    return req;
  }

  function srcOf(fn) {
    try { return Function.prototype.toString.call(fn); } catch { return ''; }
  }

  function idsWith(needle, limit = 300) {
    boot();
    if (!req) return [];
    const hits = [];
    for (const id of Object.keys(req.m)) {
      if (srcOf(req.m[id]).includes(needle)) {
        hits.push(id);
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  function requireId(id) {
    try { return req(id); } catch { return null; }
  }

  function exportByName(name, guard) {
    for (const id of idsWith(name)) {
      const ex = requireId(id);
      if (!ex || typeof ex !== 'object' || !(name in ex)) continue;
      let v;
      try { v = ex[name]; } catch { continue; }
      if (!guard || guard(v)) return { id, key: name, value: v };
    }
    return null;
  }

  const isStore = (v) => v && typeof v.getState === 'function' && typeof v.dispatch === 'function';

  let storeCache = null;
  function store() {
    if (storeCache && storeCache.getState) return storeCache;
    const named = exportByName('globalReduxStore', isStore);
    if (named) storeCache = named.value;
    return storeCache || null;
  }

  // The MCP tool module is identifiable by its call-reason enum, whose string
  // values survive minification.
  let dispatcherCache;
  function dispatcher() {
    if (dispatcherCache !== undefined) return dispatcherCache;
    boot();
    if (!req) return null;
    for (const id of idsWith('SECTION_SELECTED', 40)) {
      if (!srcOf(req.m[id]).includes('LARGE_SELECTION')) continue;
      const ex = requireId(id);
      if (!ex || typeof ex !== 'object') continue;
      let best = null;
      for (const key of Object.keys(ex)) {
        const v = ex[key];
        if (typeof v !== 'function' || v.length < 3) continue;
        const body = srcOf(v);
        const score = (body.includes('get_design_context') ? 2 : 0) + (body.startsWith('async') ? 1 : 0);
        if (!best || score > best.score) best = { id, key, arity: v.length, fn: v, score };
      }
      if (best) { dispatcherCache = best; return best; }
    }
    dispatcherCache = null;
    return null;
  }

  function vfsFor(fileKey) {
    try {
      if (typeof window.getEntityVFS === 'function') return window.getEntityVFS(fileKey);
    } catch { /* falls through */ }
    return undefined;
  }

  function redact(v, depth = 0) {
    if (depth > 4) return '…';
    if (typeof v === 'function') return '[function]';
    if (typeof v === 'string') return v.length > 800 ? v.slice(0, 800) + '…' : v;
    if (typeof v === 'symbol') return String(v);
    if (v instanceof Error) return 'Error: ' + v.message;
    if (Array.isArray(v)) return v.slice(0, 60).map((x) => redact(x, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).slice(0, 80)) {
        if (/token|secret|cookie|password|privatekey|sessionid/i.test(k)) { o[k] = '[redacted]'; continue; }
        let val;
        try { val = v[k]; } catch { continue; }
        if (typeof val === 'function') continue;
        o[k] = redact(val, depth + 1);
      }
      return o;
    }
    return v;
  }

  // window.figma is an accessor: `()=>{ if (new Error().stack lacks two decoded
  // markers && !r) { fire __windowDotFigmaOnAccess; return o } }`.
  //
  // HYPOTHESIS NOW DEAD: the stack markers are what block a content script. In the
  // user's tab every call shape returned undefined — including a blob: script,
  // whose frames are page-origin. So the reason is either `r` truthy (revoked) or
  // `o` never assigned (the app did not install an API object in this tab).
  // setterProbe separates the two; tapReport answers whether a set() ever happens.
  async function getterProbe() {
    const shapes = {};
    const grab = (n) => {
      try { shapes[n] = typeof window.figma === 'object' ? 'object' : typeof window.figma; }
      catch { shapes[n] = 'throw'; }
    };
    const withTimeout = (p, ms, label) => Promise.race([
      p, new Promise((r) => setTimeout(() => r('stalled:' + label), ms))
    ]);

    grab('a_sync_inline');
    await withTimeout(new Promise((r) => setTimeout(() => { grab('b_setTimeout_0'); r(); }, 0)), 1500, 'b');
    await withTimeout(new Promise((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { grab('c_MessageChannel'); r(); };
      ch.port2.postMessage(0);
    }), 1500, 'c');

    // Page-origin code: a blob: script's own frames are blob:https://www.figma.com/…
    shapes.d_blob_script = await withTimeout(new Promise((resolve) => {
      const url = URL.createObjectURL(
        new Blob(['window.__Figmalink_pageGrab && window.__Figmalink_pageGrab()'], { type: 'text/javascript' }));
      const s = document.createElement('script');
      window.__Figmalink_pageGrab = () => {
        URL.revokeObjectURL(url);
        try { window.__Figmalink_stash = window.figma; } catch { /* ignore */ }
        resolve(typeof window.__Figmalink_stash === 'object' && window.__Figmalink_stash
          ? 'object' : 'undefined');
      };
      s.onerror = () => resolve('error_blocked_by_CSP');
      s.src = url;
      document.head.appendChild(s);
    }), 3000, 'd');

    let stashUsable = 'absent';
    if (window.__Figmalink_stash) {
      stashUsable = typeof window.__Figmalink_stash.createRectangle === 'function'
        ? 'usable' : 'present_but_no_createRectangle';
    }
    shapes.e_stashed_object = stashUsable;
    shapes.f_visibility = document.visibilityState;

    const d = Object.getOwnPropertyDescriptor(window, 'figma');
    return {
      shapes,
      accessor: !!(d && d.get),
      getterSrc: d && d.get ? String(d.get).slice(0, 500) : null,
      current: figmaOrNull() ? 'object' : 'undefined'
    };
  }


  // window.figma is an accessor the app installs only once the editor is really
  // up (user.id && openFile.key && userStateLoaded && mirror.appModel
  // .isInitialized && selectedView.view === 'fullscreen'). It is therefore
  // absent on the file browser, in Dev Mode, and for a while after navigation —
  // poll rather than assume.
  // Reads the accessor directly. If that is poisoned by this script's own stack
  // frames, falls back to the object the getter handed to page-origin code during
  // the `getterProbe` run — which only exists after you click that button, so the
  // fallback is opt-in and visible rather than silent.
  function figmaOrNull() {
    try { if (window.figma) return window.figma; } catch { /* ignore */ }
    const s = window.__Figmalink_stash;
    return s && typeof s.createRectangle === 'function' ? s : null;
  }

  function figmaOrigin() {
    try { if (window.figma) return 'accessor'; } catch { /* ignore */ }
    return window.__Figmalink_stash ? 'page-origin-stash' : 'none';
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitForFigma(timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const f = figmaOrNull();
      if (f && typeof f.createRectangle === 'function') return f;
      if (Date.now() > deadline) return null;
      await sleep(250);
    }
  }

  const NOT_READY = {
    error: 'window.figma 尚未安装',
    hint: '需要在**已打开的设计文件画布**里（/design/ 或 /file/ 且已进入全屏编辑视图）。'
      + '文件浏览器、Dev Mode、或文件还在加载时都不会有。点「自检」看卡在哪一项。'
  };

  function gateState() {
    const s = store();
    if (!s) return { reduxStore: false };
    const st = s.getState();
    const of = st.openFile || {};
    return {
      reduxStore: true,
      user: !!st.user && !!st.user.id,
      openFileKey: of.key || null,
      userStateLoaded: !!st.userStateLoaded,
      appModelInitialized: safe(() => !!st.mirror.appModel.isInitialized),
      selectedView: safe(() => st.selectedView && st.selectedView.view),
      canRunExtensions: safe(() => of.canRunExtensions),
      editorType: of.editorType || null,
      // Server-rendered per page load and the accessor's other hard gate: when this is
      // false, window.figma is undefined no matter how healthy everything else looks.
      canEdit: safe(() => {
        const o = (window.INITIAL_OPTIONS && window.INITIAL_OPTIONS.editing_file) || {};
        return typeof o.can_edit === 'boolean' ? o.can_edit : null;
      })
    };
  }

  function diag() {
    boot();
    const d = Object.getOwnPropertyDescriptor(window, 'figma');
    return {
      readyState: document.readyState,
      href: location.href.slice(0, 90),
      figma: { typeof: typeof window.figma, own: !!(d), accessor: !!(d && d.get),
        source: figmaOrigin(),
        createRectangle: safe(() => typeof figmaOrNull().createRectangle) },
      bridge: { version: window.__Figmalink && window.__Figmalink.version, requireCaptured: !!req,
        registeredModules: req ? Object.keys(req.m).length : 0 },
      iframes: Array.from(document.querySelectorAll('iframe')).slice(0, 10)
        .map((x) => x.getAttribute('src') || '(no src)'),
      gate: gateState()
    };
  }

  // The getter yields undefined two possible ways: `r` truthy (revoked), or `o`
  // never assigned (no API object installed in this tab). The setter is
  // `e => { r || (o = null != e ? e : void 0) }`, so a sentinel write separates
  // them — it sticks iff `r` is falsy.
  // The guard lives in an INLINE bootstrap script in the HTML (early-*.min.js),
  // not in any webpack module. Decoded with its own shift-by-1 helper h():
  //   m="gjhnb" -> "figma"   _="dispnf.fyufotjpo;00" -> "chrome-extension://"
  //   I="np{.fyufotjpo;00"    -> "moz-extension://"
  //   r = window.INITIAL_OPTIONS.editing_file?.can_edit === false
  // So window.figma is undefined when EITHER the file is non-editable for this
  // page load (r) OR the caller's stack contains an extension URL.
  function editRights() {
    const io = window.INITIAL_OPTIONS || {};
    const ef = io.editing_file || null;
    const h = (s) => Array.from(s).map((c) => String.fromCharCode(c.charCodeAt(0) - 1)).join('');
    let stackHasExt = 'unknown';
    try { stackHasExt = String(new Error().stack || '').includes(h('dispnf.fyufotjpo;00')); }
    catch { /* ignore */ }
    return {
      can_edit: ef ? ef.can_edit : 'no editing_file',
      can_edit_canvas: ef ? ef.can_edit_canvas : null,
      can_manage: ef ? !!ef.can_manage : null,
      editorType: ef ? ef.editor_type : null,
      r_would_be: ef ? ef.can_edit === false : 'unknown',
      blockedByStackMarker: stackHasExt,
      decodedMarkers: { prop: h('gjhnb'), chrome: h('dispnf.fyufotjpo;00'), moz: h('np{.fyufotjpo;00') },
      e2e_bypass: !!io.e2e_traffic || location.pathname.startsWith('/test/interactions'),
      note: 'e2e_traffic 或 /test/interactions 路径下这段 defineProperty 整体跳过（不装 accessor）；'
        + 'INITIAL_OPTIONS 由服务端每次加载渲染，can_edit 变了刷新即生效'
    };
  }

  // CAVEAT discovered the hard way: when the stack marker blocks us, the *read
  // back* is undefined regardless of whether the write landed, so `stuck:false`
  // does NOT prove `r` is true. Report both signals together and let the reader
  // decide — only trust this when blockedByStackMarker is false.
  function setterProbe() {
    const orig = window.figma;
    const before = typeof orig;
    const sentinel = { __re_probe: true };
    let threw = null;
    try { window.figma = sentinel; } catch (e) { threw = String(e && e.message || e).slice(0, 120); }
    const readBack = window.figma;
    const stuck = readBack === sentinel;
    // Restore whatever was there — writing undefined would clear the app's own
    // slot and permanently break the accessor for this tab.
    try { window.figma = orig; } catch { /* ignore */ }
    const d = Object.getOwnPropertyDescriptor(window, 'figma');
    return {
      before, threw, stuck, restoredTo: typeof window.figma,
      readBackType: typeof readBack,
      blockedByStackMarker: /chrome-extension:\/\/|moz-extension:\/\//.test(String(new Error().stack || '')),
      stillAccessor: !!(d && d.get),
      verdict: stuck
        ? 'setter 生效 → r 为假，所以是 o 从未被赋值：应用没在本页装 API 对象'
        : 'setter 被吞 → r 为真：本标签页的 figma 通道是被主动禁用/撤销的'
    };
  }

  // Passive tap on the accessor. Installed at document_start, before the app
  // defines window.figma: Object.defineProperty is wrapped so that when the app
  // defines the figma accessor, its get/set are wrapped to record. This answers
  // "does the app ever assign window.figma here, and from where" without forging
  // any call stack — we only observe the app's own writes.
  const tap = { armed: false, sets: [], hits: [], wrapped: false };

  function armTap() {
    if (tap.armed) return tap;
    tap.armed = true;

    const note = (kind, value) => {
      const isObj = !!value && typeof value === 'object';
      const rec = {
        kind, at: Math.round(performance.now()), t: typeof value,
        hasCreateRectangle: !!(isObj && typeof value.createRectangle === 'function'),
        stack: (new Error().stack || '').split('\n').slice(2, 7).join(' | ').slice(0, 400)
      };
      if (kind === 'set') { if (tap.sets.length < 12) tap.sets.push(rec); }
      else if (rec.hasCreateRectangle) {
        if (tap.hits.length < 6) tap.hits.push(rec);
        window.__Figmalink_stash = value;
      }
    };

    const wrap = (desc) => {
      const g = desc.get, s = desc.set;
      tap.wrapped = true;
      // Preserve the original configurability — the app defines this accessor as
      // configurable:false on purpose; widening it would change the page's own
      // lockdown, not just our visibility.
      return {
        configurable: !!desc.configurable, enumerable: !!desc.enumerable,
        get() { const v = g ? g.call(this) : undefined; note('get', v); return v; },
        set(v) { note('set', v); if (s) s.call(this, v); }
      };
    };

    const defineProperty = Object.defineProperty;
    try {
      Object.defineProperty = function (obj, prop, desc) {
        if (obj === window && prop === 'figma' && desc && typeof desc.get === 'function') {
          try { return defineProperty.call(this, obj, prop, wrap(desc)); } catch { /* fall through */ }
        }
        return defineProperty.call(this, obj, prop, desc);
      };
    } catch { Object.defineProperty = defineProperty; }

    // Armed after boot (popup self-heal): wrap the accessor already in place.
    const d = Object.getOwnPropertyDescriptor(window, 'figma');
    if (d && d.get) {
      tap.configurableAtArm = !!d.configurable;
      try { defineProperty.call(window, 'figma', wrap(d)); } catch (e) { tap.wrapError = String(e && e.message || e).slice(0, 90); }
    }
    // Verify the wrap actually took — a non-configurable accessor silently
    // defeats in-place redefinition, which is the difference between arming at
    // document_start (works) and arming after boot (cannot).
    const after = Object.getOwnPropertyDescriptor(window, 'figma');
    tap.getterIsOurs = !!(after && after.get && after.get !== d.get);
    return tap;
  }

  function tapReport() {
    const t = armTap();
    return {
      armed: t.armed, wrapped: t.wrapped, getterIsOurs: t.getterIsOurs,
      configurableAtArm: t.configurableAtArm, wrapError: t.wrapError || null,
      setsSeen: t.sets.length, sets: t.sets,
      successfulGets: t.hits.length,
      stash: window.__Figmalink_stash ? 'present' : 'absent',
      note: 'sets 记录应用对 window.figma 的每次赋值及调用栈。getterIsOurs=false 说明是在应用装好 accessor 之后才注入的，'
        + '原地包装被不可配置属性挡住了 —— 必须刷新标签页让 content script 在 document_start 生效才听得到。'
    };
  }


  const FIGMA_METHODS = ['createRectangle', 'createFrame', 'createText', 'createComponent',
    'createInstance', 'createLine', 'createEllipse', 'createPolygon', 'createStar',
    'getNodeByIdAsync', 'getNodeById', 'loadFontAsync', 'notify', 'closePlugin', 'showUI',
    'setStatusBarText', 'group', 'union', 'insertBefore'];

  function pluginAPI() {
    const f = figmaOrNull();
    if (!f) {
      const gate = gateState();
      return {
        present: false,
        note: gate.canEdit === false
          ? 'window.figma 不会出现：editing_file.can_edit=false（这个文件对当前账号只读）。其余门控都是绿的，等下去没用 —— 换成有编辑权限的文件，或让 owner 授权/复制一份到自己的 drafts。'
          : 'window.figma 尚未安装 — 点「自检」看卡在哪个条件',
        gate
      };
    }
    const out = { present: true, editorType: safe(() => f.editorType), command: safe(() => f.command),
      page: safe(() => f.currentPage && f.currentPage.name),
      pageChildren: safe(() => f.currentPage.children.length), methods: {}, objects: {} };
    for (const m of FIGMA_METHODS) out.methods[m] = safe(() => typeof f[m]);
    for (const o of ['currentPage', 'ui', 'viewport', 'root', 'mixed', 'mode', 'fileKey']) out.objects[o] = safe(() => typeof f[o]);
    return out;
  }

  function safe(fn) {
    try { return fn(); } catch (e) { return 'throw: ' + String(e && e.message || e).slice(0, 80); }
  }

  function describeNode(n) {
    return {
      id: n.id, name: n.name, type: n.type,
      x: safe(() => Math.round(n.x * 100) / 100), y: safe(() => Math.round(n.y * 100) / 100),
      width: safe(() => Math.round(n.width * 100) / 100), height: safe(() => Math.round(n.height * 100) / 100),
      visible: safe(() => n.visible), locked: safe(() => n.locked),
      childCount: safe(() => (n.children ? n.children.length : 0)),
      fills: safe(() => (Array.isArray(n.fills) ? n.fills.map((fl) => fl.type + (fl.visible === false ? '(hidden)' : '')) : String(n.fills)))
    };
  }

  // ---- edit + image helpers -------------------------------------------------
  // Every writer takes a property snapshot first, so the default behaviour is
  // apply -> assert -> put it back. Callers have to say revert:false to leave a
  // change standing.

  const WRITABLE = ['name', 'x', 'y', 'opacity', 'visible', 'locked', 'cornerRadius'];

  // Plain assignment properties (Figma exposes them as setters on StrokeMixin/BlendMixin),
  // listed separately so both applyProps and the snapshot walk the same names.
  const STROKE_GEOM = ['strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'dashPattern'];

  // Style bindings are plain string properties ('' = detached). Assigning one replaces the
  // node's local paint/font/effect, so they belong in the same snapshot as everything else.
  const STYLE_IDS = ['fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId', 'gridStyleId'];

  // Auto-layout keys, in the order they must be written: layoutMode has to exist
  // before spacing/alignment can be touched at all, and the sizing modes have to be
  // pinned to FIXED before anything else, because turning auto-layout on defaults to
  // hug-contents and silently collapses the frame's width.
  const LAYOUT = ['layoutMode', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'itemSpacing', 'counterAxisSpacing',
    'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
    'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutWrap',
    'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutGrow', 'layoutAlign'];

  function pickProps(f, n) {
    const o = {};
    for (const k of WRITABLE) {
      try { if (n[k] !== undefined && typeof n[k] !== 'function' && n[k] !== f.mixed) o[k] = n[k]; } catch { /* not on this type */ }
    }
    try { o.width = n.width; o.height = n.height; } catch { /* detached */ }
    try { if (Array.isArray(n.fills)) o.fills = JSON.parse(JSON.stringify(n.fills)); } catch { /* paint with functions in it */ }
    // Strokes/effects/stroke geometry are snapshot too — without them a revert:true patch
    // on strokes silently left the change behind (fills were captured, nothing else was).
    try { if (Array.isArray(n.strokes)) o.strokes = JSON.parse(JSON.stringify(n.strokes)); } catch { /* not strokeable */ }
    try { if (Array.isArray(n.effects)) o.effects = JSON.parse(JSON.stringify(n.effects)); } catch { /* no effects */ }
    for (const k of STROKE_GEOM) {
      try { if (n[k] !== undefined && n[k] !== f.mixed) o[k] = Array.isArray(n[k]) ? n[k].slice() : n[k]; } catch { /* not strokeable */ }
    }
    for (const k of STYLE_IDS) {
      try { if (typeof n[k] === 'string') o[k] = n[k]; } catch { /* type has no such binding */ }
    }
    try { if (typeof n.characters === 'string') o.characters = n.characters; } catch { /* mixed font */ }
    try { if (typeof n.fontSize === 'number') o.fontSize = n.fontSize; } catch { /* mixed size */ }
    try { if (typeof n.textAlignHorizontal === 'string') o.textAlignHorizontal = n.textAlignHorizontal; } catch { /* not text */ }
    try { if (typeof n.textAutoResize === 'string') o.textAutoResize = n.textAutoResize; } catch { /* not text */ }
    try { if (n.fontName && n.fontName !== f.mixed && typeof n.fontName.family === 'string') o.fontName = { family: n.fontName.family, style: n.fontName.style }; } catch { /* mixed */ }
    for (const k of LAYOUT) {
      try { if (n[k] !== undefined && typeof n[k] !== 'function') o[k] = n[k]; } catch { /* not an auto-layout frame */ }
    }
    return o;
  }

  // Accepts #RRGGBB, #RRGGBBAA, or {r,g,b,a} with 0–1 channels. `label` is what shows up
  // in the error, because "fillColor.r 必须是 0–1" is useless when you passed
  // fillGradient.stops[2].
  function toColor(v, label, defaultAlpha) {
    const where = label || 'color';
    const alpha = (x) => {
      if (x === undefined || x === null) return defaultAlpha === undefined ? 1 : defaultAlpha;
      const a = Number(x);
      if (!(a >= 0 && a <= 1)) throw new Error(`${where}.a 必须是 0–1，收到 ${x}`);
      return a;
    };
    if (typeof v === 'string') {
      const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v.trim());
      if (!m) throw new Error(`${where} 要 #RRGGBB / #RRGGBBAA 或 {r,g,b,a}（通道 0–1）`);
      const i = parseInt(m[1], 16);
      return {
        r: ((i >> 16) & 255) / 255, g: ((i >> 8) & 255) / 255, b: (i & 255) / 255,
        a: m[2] ? parseInt(m[2], 16) / 255 : alpha(undefined)
      };
    }
    if (v && typeof v === 'object') {
      const ch = (x, name) => {
        const y = Number(x);
        if (!(y >= 0 && y <= 1)) throw new Error(`${where}.${name} 必须是 0–1，收到 ${x}`);
        return y;
      };
      return { r: ch(v.r, 'r'), g: ch(v.g, 'g'), b: ch(v.b, 'b'), a: alpha(v.a) };
    }
    throw new Error(`${where} 类型不支持（要字符串或 {r,g,b,a}）`);
  }

  // A SOLID paint carries alpha in `opacity`; the colour itself is rgb only. This is the
  // one place that knows it, so #RRGGBBAA / {a} behaves the same for fills and strokes.
  function solidPaint(v, label) {
    const c = toColor(v, label);
    return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  }

  const GRADIENT_TYPES = {
    LINEAR: 'GRADIENT_LINEAR', RADIAL: 'GRADIENT_RADIAL',
    ANGULAR: 'GRADIENT_ANGULAR', DIAMOND: 'GRADIENT_DIAMOND'
  };

  // A gradient paint is {type, gradientTransform, gradientStops}. Figma's own default
  // transform is the identity, which reads left-to-right / centre-out, so a caller that
  // only gives stops still gets something sensible instead of a flat fill.
  function toGradientPaint(v) {
    if (!v || typeof v !== 'object') throw new Error('fillGradient 需要 {type, stops[]}');
    const key = String(v.type || 'LINEAR').toUpperCase().replace(/^GRADIENT_/, '');
    const type = GRADIENT_TYPES[key];
    if (!type) throw new Error(`fillGradient.type 只支持 ${Object.keys(GRADIENT_TYPES).join(' / ')}，收到 ${v.type}`);
    const raw = Array.isArray(v.stops) ? v.stops : null;
    if (!raw || raw.length < 2) throw new Error('fillGradient.stops 至少要两个色标');
    const stops = raw.map((st, i) => {
      const position = Number(st && st.position);
      if (!(position >= 0 && position <= 1)) throw new Error(`fillGradient.stops[${i}].position 必须是 0–1`);
      return { position, color: toColor(st.color, `fillGradient.stops[${i}].color`) };
    }).sort((a, b) => a.position - b.position);
    const t = Array.isArray(v.transform) && v.transform.length === 6
      ? v.transform
      : [[1, 0, 0], [0, 1, 0]];
    return { type, gradientTransform: t, gradientStops: stops, opacity: v.opacity === undefined ? 1 : Number(v.opacity), visible: true };
  }

  // Effects are a whole-list replacement in the Plugin API: there is no partial update,
  // so the patch always sends the full list the caller wants to end up with.
  function toEffects(list) {
    if (!Array.isArray(list)) throw new Error('effects 需要一个数组（传 [] 表示清空）');
    return list.map((e, i) => {
      const type = String((e && e.type) || '').toUpperCase();
      const off = (e && e.offset) || {};
      const x = e && e.x !== undefined ? e.x : off.x;
      const y = e && e.y !== undefined ? e.y : off.y;
      const radius = Number(e && e.radius);
      if (!(radius >= 0)) throw new Error(`effects[${i}].radius 必须 >= 0`);
      if (type === 'DROP_SHADOW' || type === 'INNER_SHADOW') {
        return {
          type, visible: e.visible !== false, blendMode: e.blendMode || 'NORMAL',
          color: toColor(e.color === undefined ? '#00000040' : e.color, `effects[${i}].color`),
          offset: { x: Number(x || 0), y: Number(y || 0) },
          radius, spread: Number(e.spread || 0)
        };
      }
      if (type === 'LAYER_BLUR' || type === 'BACKGROUND_BLUR') {
        return { type, radius, visible: e.visible !== false };
      }
      throw new Error(`effects[${i}].type 只支持 DROP_SHADOW / INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR`);
    });
  }

  // Text nodes refuse character writes until their font is loaded; mixed ranges
  // cannot be resolved here, so they surface as an error instead of a silent no-op.
  async function ensureFont(f, node) {
    let fn;
    try { fn = node.fontName; } catch { throw new Error('这个节点没有 characters 属性'); }
    if (!fn) throw new Error('fontName 取不到');
    if (fn === f.mixed || (fn && typeof fn.then === 'function')) {
      throw new Error('字体是 mixed（多选/多段），需要先用 setRangeFontName 指定范围');
    }
    await f.loadFontAsync(fn);
    return fn;
  }

  async function applyProps(f, n, patch) {
    const applied = [];
    for (const k of WRITABLE) {
      if (patch[k] === undefined) continue;
      n[k] = patch[k];
      applied.push(k);
    }
    // Font order matters: a font swap must be loaded first, characters next, then the
    // auto-resize mode, and only after those can size/alignment be written — resize()
    // on a text node still in WIDTH_AND_HEIGHT mode throws.
    if (patch.fontName !== undefined) {
      await f.loadFontAsync(patch.fontName);
      n.fontName = patch.fontName;
      applied.push('fontName');
    }
    if (patch.characters !== undefined) {
      await ensureFont(f, n);
      n.characters = String(patch.characters);
      applied.push('characters');
    }
    if (patch.textAutoResize !== undefined) {
      n.textAutoResize = patch.textAutoResize;
      applied.push('textAutoResize');
    }
    // Auto-layout writes are order-sensitive: layoutMode has to exist before spacing
    // or alignment, otherwise the Plugin API throws.
    if (patch.padding !== undefined) {
      const v = Number(patch.padding);
      patch = { ...patch, paddingLeft: v, paddingRight: v, paddingTop: v, paddingBottom: v };
      applied.push('padding');
    }
    for (const k of LAYOUT) {
      if (patch[k] === undefined) continue;
      n[k] = patch[k];
      applied.push(k);
    }
    if (patch.width !== undefined || patch.height !== undefined) {
      const w = patch.width !== undefined ? Number(patch.width) : n.width;
      const h = patch.height !== undefined ? Number(patch.height) : n.height;
      // SECTION is the one container with its own resize entry point; the generic
      // resize() throws on it ("Cannot resize a section without constraints").
      if (n.type === 'SECTION' && typeof n.resizeWithoutConstraints === 'function') n.resizeWithoutConstraints(w, h);
      else if (typeof n.resize === 'function') n.resize(w, h);
      else { n.width = w; n.height = h; }
      applied.push('size');
    }
    if (patch.fontSize !== undefined) {
      n.fontSize = Number(patch.fontSize);
      applied.push('fontSize');
    }
    if (patch.textAlignHorizontal !== undefined) {
      n.textAlignHorizontal = patch.textAlignHorizontal;
      applied.push('textAlignHorizontal');
    }
    if (patch.lineHeight !== undefined) {
      n.lineHeight = patch.lineHeight;
      applied.push('lineHeight');
    }
    // Gradient and solid are the same slot, so a gradient replaces fills[0] and keeps any
    // image fill the node already had underneath.
    if (patch.fillGradient !== undefined) {
      const paint = toGradientPaint(patch.fillGradient);
      const fills = Array.isArray(n.fills) ? n.fills.slice() : [];
      if (fills.length) fills[0] = paint;
      else fills.push(paint);
      n.fills = fills;
      applied.push('fillGradient');
    }
    if (patch.effects !== undefined) {
      n.effects = toEffects(patch.effects);
      applied.push('effects');
    }
    for (const k of STROKE_GEOM) {
      if (patch[k] === undefined) continue;
      n[k] = patch[k];
      applied.push(k);
    }
    for (const k of STYLE_IDS) {
      if (patch[k] === undefined) continue;
      if (k === 'textStyleId' && patch[k]) {
        await ensureFont(f, n).catch(() => {});
      }
      n[k] = String(patch[k]);
      applied.push(k);
    }
    if (patch.strokes !== undefined) {
      n.strokes = patch.strokes;
      applied.push('strokes');
    }
    if (patch.fillColor !== undefined) {
      // Alpha lives in paint.opacity, not in the colour object: dropping it silently
      // turned "#FFFFFF26" into solid white. solidPaint() keeps the two together.
      const paint = solidPaint(patch.fillColor, 'fillColor');
      const fills = Array.isArray(n.fills) ? n.fills.slice() : [];
      if (fills.length) fills[0] = { ...fills[0], ...paint };
      else fills.push(paint);
      n.fills = fills;
      applied.push('fillColor');
    }
    if (patch.opacityFill !== undefined) {
      const fills = Array.isArray(n.fills) ? n.fills.slice() : [];
      if (fills.length) fills[0] = { ...fills[0], opacity: Number(patch.opacityFill) };
      n.fills = fills;
      applied.push('opacityFill');
    }
    if (patch.strokeColor !== undefined || patch.strokeWeight !== undefined) {
      const strokes = Array.isArray(n.strokes) ? n.strokes.slice() : [];
      if (patch.strokeColor !== undefined) {
        const paint = solidPaint(patch.strokeColor, 'strokeColor');
        if (strokes.length) strokes[0] = { ...strokes[0], ...paint };
        else strokes.push(paint);
      }
      n.strokes = strokes;
      if (patch.strokeWeight !== undefined) n.strokeWeight = Number(patch.strokeWeight);
      applied.push('stroke');
    }
    if (patch.imagePaint !== undefined) {
      n.fills = [patch.imagePaint];
      applied.push('imagePaint');
    }
    if (patch.fills !== undefined) {
      n.fills = patch.fills;
      applied.push('fills');
    }
    return applied;
  }

  // Restoring has to go through the same setter path, but with the snapshot's raw
  // fills rather than re-deriving a colour.
  async function restoreProps(f, n, before) {
    const patch = {};
    for (const k of WRITABLE) if (before[k] !== undefined) patch[k] = before[k];
    if (before.width !== undefined && before.height !== undefined) { patch.width = before.width; patch.height = before.height; }
    if (before.fills !== undefined) patch.fills = before.fills;
    if (before.strokes !== undefined) patch.strokes = before.strokes;
    if (before.effects !== undefined) patch.effects = before.effects;
    for (const k of STROKE_GEOM) if (before[k] !== undefined) patch[k] = before[k];
    for (const k of STYLE_IDS) if (before[k] !== undefined) patch[k] = before[k];
    if (before.fontName !== undefined) patch.fontName = before.fontName;
    if (before.characters !== undefined) patch.characters = before.characters;
    if (before.fontSize !== undefined) patch.fontSize = before.fontSize;
    if (before.textAutoResize !== undefined) patch.textAutoResize = before.textAutoResize;
    for (const k of LAYOUT) if (before[k] !== undefined) patch[k] = before[k];
    if (before.textAlignHorizontal !== undefined) patch.textAlignHorizontal = before.textAlignHorizontal;
    await applyProps(f, n, patch);
    return Object.keys(patch);
  }

  // ---- layout: absolute-space maths, done here so the agent never does it ---------
  // These work on absoluteBoundingBox and write back through a delta, so they stay
  // correct inside nested frames and auto-layout parents instead of assuming "x/y are
  // already in the same space as the reference".

  const R2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  const boxOf = (n) => {
    try {
      const b = n.absoluteBoundingBox || n.absoluteRenderBounds;
      return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
    } catch { return null; }
  };
  // Move so that the node's absolute top-left becomes (ax, ay). Local coords are derived
  // from the current delta, which is what makes this work at any nesting depth.
  const moveAbs = (n, ax, ay) => {
    const b = boxOf(n);
    if (!b) return false;
    n.x += ax - b.x;
    n.y += ay - b.y;
    return true;
  };

  function nodeById(f, id) {
    if (!id) return { error: '需要 nodeId' };
    let n;
    try { n = f.getNodeById(String(id)); } catch (e) { return { error: 'getNodeById 抛错：' + String(e.message || e) }; }
    if (!n) return { error: '文档里找不到节点 ' + id };
    return { node: n };
  }

  function b64FromBytes(u8) {
    const CH = 0x8000;
    let s = '';
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }

  function bytesFromB64(b64) {
    const bin = atob(String(b64));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function makers(f) {
    return {
      rectangle: () => f.createRectangle(),
      frame: () => f.createFrame(),
      ellipse: () => f.createEllipse(),
      text: () => f.createText(),
      line: () => f.createLine(),
      star: () => f.createStar(),
      polygon: () => f.createPolygon(),
      component: () => f.createComponent(),
      section: () => f.createSection()
    };
  }

  // create*() auto-parents to the current page, so re-parenting only has to happen
  // when a parent was explicitly asked for.
  async function placeNode(f, node, parentId) {
    if (!parentId) {
      if (!node.parent) f.currentPage.appendChild(node);
      return {};
    }
    const hit = nodeById(f, parentId);
    if (hit.error) return hit;
    if (typeof hit.node.appendChild !== 'function') {
      return { error: `parentId 指向的是 ${hit.node.type}，不能容纳子节点` };
    }
    hit.node.appendChild(node);
    return { parent: hit.node };
  }

  function nodesByIds(f, ids) {
    const nodes = [];
    const missing = [];
    for (const id of (Array.isArray(ids) ? ids : [])) {
      const hit = nodeById(f, id);
      if (hit.node) nodes.push(hit.node);
      else missing.push(String(id));
    }
    return { nodes, missing };
  }

  const OPS = {
    env() {
      boot();
      return {
        requireCaptured: !!req,
        registeredModules: req ? Object.keys(req.m).length : 0,
        exposesModuleCache: !!(req && req.c),
        windowGlobals: {
          figma: typeof window.figma,
          Module: typeof window.Module,
          getEntityVFS: typeof window.getEntityVFS,
          LIVEGRAPH: typeof window.LIVEGRAPH,
          DebuggingHelpers: typeof window.DebuggingHelpers
        },
        pluginAPI: pluginAPI(),
        href: location.href,
        iframes: Array.from(document.querySelectorAll('iframe')).slice(0, 15)
          .map((f) => f.getAttribute('src') || f.getAttribute('id') || '(no src)')
      };
    },

    pluginApi: pluginAPI,

    file() {
      const s = store();
      if (!s) return { error: 'redux store not found' };
      const st = s.getState();
      const f = st.openFile || {};
      return {
        file: redact({ key: f.key, name: f.name, editorType: f.editorType, documentId: f.documentId, version: f.version }),
        user: st.user ? { id: st.user.id } : null,
        isFreeUser: st.isFreeUser
      };
    },

    diag,

    setterProbe,
    editRights,
    tapReport,

    getterProbe,

    readSelection: async () => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const sel = f.currentPage.selection;
      return { count: sel.length, nodes: sel.map(describeNode) };
    },

    readTree: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const maxDepth = (arg && arg.depth) || 2;
      // Without an offset a wide page is silently un-inspectable past the first page
      // of children, which is exactly where freshly added nodes land.
      const limit = Math.max(1, Number((arg && arg.limit) || 25));
      const offset = Math.max(0, Number((arg && arg.offset) || 0));
      // getNodeById is document-wide; scanning currentPage.children only reaches the
      // top level, which makes any nested frame un-readable by id.
      let root = null;
      if (arg && arg.nodeId) {
        try { root = f.getNodeById(String(arg.nodeId)); } catch { root = null; }
        if (!root) root = f.currentPage.children.find((c) => c.id === arg.nodeId);
      } else {
        root = f.currentPage;
      }
      if (!root) return { error: 'node not found: ' + arg.nodeId };
      // Hidden layers are usually builder scaffolding; an agent paying tokens for them is
      // the common complaint about scene-graph dumps. Off by default so the tree stays
      // truthful, but the count is always reported instead of silently dropping them.
      const visibleOnly = !!(arg && arg.visibleOnly);
      const walk = (n, d) => {
        const row = describeNode(n);
        if (Array.isArray(n.children)) {
          row.childCount = n.children.length;
          const kids = visibleOnly ? n.children.filter((c) => safe(() => c.visible) !== false) : n.children;
          const hidden = n.children.length - kids.length;
          if (hidden > 0) row.hiddenChildren = hidden;
          if (d < maxDepth) {
            row.children = kids.slice(offset, offset + limit).map((c) => walk(c, d + 1));
            const dropped = Math.max(0, kids.length - offset - limit);
            if (dropped > 0) row.omittedChildren = dropped;
          }
        }
        return row;
      };
      const out = walk(root, 0);
      out.window = { offset, limit };
      return out;
    },

    // Concrete write demo. Auto-reverts unless keep:true, so probing never leaves
    // debris in the user's document.
    createShape: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const kind = (arg && arg.kind) || 'rectangle';
      const keep = !!(arg && arg.keep);
      const maker = { rectangle: () => f.createRectangle(), frame: () => f.createFrame(),
        ellipse: () => f.createEllipse(), text: () => f.createText() }[kind];
      if (!maker) return { error: 'unsupported kind: ' + kind };
      try {
        const node = kind === 'text'
          ? await f.loadFontAsync({ family: 'Inter', style: 'Regular' }).then(() => maker())
          : maker();
        if (kind === 'text') node.characters = 'Qoder probe';
        node.name = 'Qoder RE probe';
        node.x = (arg && arg.x) || 40;
        node.y = (arg && arg.y) || 40;
        if (typeof node.resize === 'function') node.resize(180, 110);
        if (kind !== 'text') node.fills = [{ type: 'SOLID', color: { r: 0.98, g: 0.35, b: 0.15 } }];
        const created = describeNode(node);
        if (keep) return { created, kept: true };
        // create*() already parents the node, so remove() is the undo.
        let gone = false;
        try { node.remove(); gone = !f.currentPage.children.some((c) => c.id === node.id); } catch { gone = false; }
        return { created, reverted: gone };
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
    },

    findTool() {
      const d = dispatcher();
      return d ? { id: d.id, key: d.key, arity: d.arity, head: srcOf(d.fn).slice(0, 200) } : { error: 'not found' };
    },

    callTool(arg) {
      const d = dispatcher();
      if (!d) return Promise.resolve({ error: 'MCP dispatcher not found' });
      const s = store();
      const fileKey = s && s.getState().openFile && s.getState().openFile.key;
      return Promise.resolve(d.fn(arg.toolName, arg.args, s, vfsFor(fileKey), { name: 'figma-re-probe', version: '0.1' }))
        .then((r) => ({ ok: true, via: d.id + '.' + d.key, result: redact(r) }))
        .catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    },

    // Mirrors Figma's own execute_plugin_code tool: run code with the real figma
    // object, capture console output and the returned value.
    runCode: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const logs = [];
      const origLog = console.log;
      console.log = (...a) => logs.push(a.map((x) => {
        try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch { return String(x); }
      }).join(' '));
      let body = String((arg && arg.code) || '');
      if (/^\s*(async\s+)?function\s*\*?\s*__ext_main__\s*\(/.test(body)) body += '\nreturn __ext_main__();';
      return Promise.resolve()
        .then(() => {
          // eslint-disable-next-line no-new-func
          const fn = new Function('figma', '"use strict";\nreturn (async () => {\n' + body + '\n})();');
          return fn(f);
        })
        .then((v) => ({ ok: true, result: redact(v), console: logs }))
        .catch((e) => ({ ok: false, error: String(e && e.message || e), console: logs }))
        .finally(() => { console.log = origLog; });
    },

    getNode: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const wantId = (arg && arg.nodeId)
        || ((arg && arg.useSelection) && f.currentPage.selection[0] && f.currentPage.selection[0].id);
      const hit = nodeById(f, wantId);
      if (hit.error) return { ...hit, hint: '不给 nodeId 时会自动取当前选中的第一个节点' };
      const n = hit.node;
      return {
        node: describeNode(n),
        props: pickProps(f, n),
        parent: n.parent ? describeNode(n.parent) : null,
        childIds: safe(() => (Array.isArray(n.children) ? n.children.map((c) => c.id).slice(0, 40) : [])),
        page: f.currentPage.name,
        fileKey: f.fileKey
      };
    },

    createNode: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const mk = makers(f);
      const kind = String((arg && arg.kind) || 'rectangle').toLowerCase();
      if (!mk[kind]) return { error: '不支持的 kind: ' + kind, available: Object.keys(mk) };
      const p = (arg && arg.props) || {};
      const baseline = safe(() => f.currentPage.children.length);
      try {
        if (kind === 'text' && !p.fontName) await f.loadFontAsync({ family: 'Inter', style: 'Regular' });
        const node = mk[kind]();
        if (kind === 'text' && p.characters === undefined) node.characters = 'Qoder bridge';
        const applied = await applyProps(f, node, p);
        const placed = await placeNode(f, node, arg && arg.parentId);
        if (placed.error) return { error: placed.error, created: describeNode(node), note: '节点已建但没挂上目标父级' };
        const created = describeNode(node);
        let removed = null;
        if (arg.revert !== false) {
          try {
            node.remove();
            removed = !f.getNodeById(node.id);
          } catch (e) { removed = { error: '撤销失败，请手动 Ctrl+Z：' + String(e.message || e) }; }
        }
        return { kind, applied, created, removed, parentId: (arg && arg.parentId) || null, fileKey: f.fileKey, pageChildren: { before: baseline, now: safe(() => f.currentPage.children.length) } };
      } catch (e) {
        return { error: '创建失败：' + String(e && e.message || e), kind, pageChildren: { before: baseline, now: safe(() => f.currentPage.children.length) } };
      }
    },

    // One call builds a whole nested tree. Without this, laying out a screen costs one
    // round trip per node, which makes real design work impractical over MCP.
    createTree: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const spec = arg && arg.spec;
      if (!spec || typeof spec !== 'object' || !spec.kind) {
        return { error: '需要 spec：{kind, props?, children?} 形式的节点树' };
      }
      const mk = makers(f);
      const MAX_NODES = Number(arg && arg.maxNodes ? arg.maxNodes : 400);
      let created = 0;
      let failed = 0;
      const rejected = [];
      const baseline = safe(() => f.currentPage.children.length);

      let holder = f.currentPage;
      if (arg.parentId) {
        const hit = nodeById(f, arg.parentId);
        if (hit.error) return hit;
        if (typeof hit.node.appendChild !== 'function') return { error: `parentId 指向的是 ${hit.node.type}，不能容纳子节点` };
        holder = hit.node;
      }

      const build = async (s, parent) => {
        if (created + failed >= MAX_NODES) {
          if (!rejected.some((r) => /maxNodes/.test(r))) rejected.push(`达到 maxNodes ${MAX_NODES}，后面的节点没建`);
          return null;
        }
        const kind = String(s.kind || 'frame').toLowerCase();
        const maker = mk[kind];
        if (!maker) { rejected.push(`不支持的 kind: ${s.kind}`); failed += 1; return null; }
        const p = s.props || {};
        let node;
        try {
          if (kind === 'text' && !p.fontName) await f.loadFontAsync({ family: 'Inter', style: 'Regular' });
          node = maker();
          created += 1;
          parent.appendChild(node);
          if (kind === 'text' && p.characters === undefined) node.characters = '文本';
          await applyProps(f, node, p);
        } catch (e) {
          rejected.push(`${kind}${p.name ? ' "' + p.name + '"' : ''} 失败：${String(e && e.message || e)}`);
          failed += 1;
          return null;
        }
        if (Array.isArray(s.children)) {
          for (const c of s.children) await build(c, node);
        }
        return node;
      };

      const root = await build(spec, holder);
      if (!root) return { error: '根节点没建出来', rejected };
      // Snapshot before any revert: once the root is removed, reading .name or
      // .children off it throws "The node with id ... does not exist".
      const countIn = (n) => 1 + (Array.isArray(n.children) ? n.children.reduce((a, c) => a + countIn(c), 0) : 0);
      const rootDesc = describeNode(root);
      const subtreeSize = countIn(root);
      // Opposite default from the atomic tools: a build is meant to leave something
      // behind, so reverting has to be asked for.
      let removed = null;
      if (arg.revert === true) {
        try { root.remove(); removed = !f.getNodeById(root.id); }
        catch (e) { removed = { error: '删掉整棵失败：' + String(e && e.message || e) }; }
      }
      return {
        root: rootDesc,
        subtreeSize,
        created,
        rejected,
        removed,
        parent: describeNode(holder),
        pageChildren: { before: baseline, now: safe(() => f.currentPage.children.length) },
        fileKey: f.fileKey,
        undoHint: '插件一次执行通常合并为一个撤销步，Ctrl+Z 可整体撤掉'
      };
    },

    // Styles are how most design systems actually encode themselves (paint/text/effect/grid
    // styles), and they are a different read path from variables: a style carries the whole
    // paint/font/effect payload, and a node points at it by id.
    // ---- prototype reading ------------------------------------------------------
    // Reactions are the only place a file records "click here → go there", so this is how
    // an agent learns a flow instead of being told it. Everything is read-only and every
    // id is resolved to a name: a wall of destinationIds is unusable in a transcript.
    prototype: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const a = arg || {};
      const mode = String(a.mode || 'connections').toLowerCase();
      const varCache = new Map();
      const variableInfo = async (id) => {
        if (!id) return null;
        if (varCache.has(id)) return varCache.get(id);
        let out = null;
        try {
          if (f.variables && typeof f.variables.getVariableByIdAsync === 'function') {
            const v = await f.variables.getVariableByIdAsync(id);
            if (v) {
              out = { name: v.name, type: v.resolvedType, collectionId: v.variableCollectionId };
              try {
                const c = typeof f.variables.getVariableCollectionByIdAsync === 'function'
                  ? await f.variables.getVariableCollectionByIdAsync(v.variableCollectionId)
                  : null;
                if (c) { out.collection = c.name; out.modes = (c.modes || []).map((m) => ({ id: m.modeId, name: m.name })); }
              } catch { /* collection not readable */ }
            }
          }
        } catch { /* older builds */ }
        varCache.set(id, out);
        return out;
      };
      const nameOf = (id) => {
        if (!id) return null;
        try { const n = f.getNodeById(String(id)); return n ? n.name : '(节点已不存在)'; } catch { return null; }
      };
      const triggerOf = (t) => {
        if (!t) return null;
        const o = { type: t.type };
        // AFTER_TIMEOUT.timeout is in SECONDS in the plugin API, not ms.
        if (typeof t.timeout === 'number') o.timeoutSec = t.timeout;
        if (typeof t.delay === 'number') o.delaySec = t.delay;
        if (Array.isArray(t.keyCodes)) o.keyCodes = t.keyCodes.slice(0, 8);
        return o;
      };
      const transitionOf = (tr) => {
        if (!tr) return null;
        const o = { type: tr.type };
        for (const k of ['duration', 'easing', 'direction', 'matchLayers']) {
          const v = safe(() => tr[k]);
          if (v !== undefined && typeof v !== 'function') o[k] = v;
        }
        return o;
      };
      const actionOf = async (act) => {
        if (!act) return null;
        const o = { type: act.type };
        if (act.destinationId) { o.destinationId = act.destinationId; o.destinationName = nameOf(act.destinationId); }
        if (act.navigation) o.navigation = act.navigation;
        if (act.transition) o.transition = transitionOf(act.transition);
        if (act.url) o.url = act.url;
        if (act.type === 'SET_VARIABLE') {
          const info = await variableInfo(act.variableId);
          o.variableId = act.variableId;
          if (info) { o.variable = info.name; o.variableType = info.type; }
          const val = safe(() => act.variableValue);
          if (val) o.variableValue = val;
        }
        if (act.type === 'SET_VARIABLE_MODE') {
          o.variableCollectionId = act.variableCollectionId;
          o.variableModeId = act.variableModeId;
          const info = await variableInfo(act.variableId);
          if (info && info.modes) {
            const hit = info.modes.find((m) => m.id === act.variableModeId);
            if (hit) o.variableModeName = hit.name;
            o.variableCollection = info.collection;
          }
        }
        // Figma has shipped more than one action schema; if the expected navigation field
        // is absent, include the raw primitive fields instead of returning {type} only.
        if (!act.destinationId && /NODE|CHANGE_TO|SCROLL_TO|SWAP/.test(String(act.type || ''))) {
          const raw = {};
          for (const k of Object.keys(act)) {
            const v = safe(() => act[k]);
            if (v === undefined || typeof v === 'function') continue;
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') raw[k] = v;
            else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) raw[k] = v.slice(0, 8);
          }
          o.raw = raw;
        }
        if (Array.isArray(act.conditionalBlocks)) {
          o.conditionalBlocks = [];
          for (const block of act.conditionalBlocks) {
            const cond = block && block.condition ? (() => {
              const c = { type: block.condition.type };
              const raw = safe(() => block.condition.value);
              if (raw !== undefined) c.value = raw;
              return c;
            })() : null;
            o.conditionalBlocks.push({
              condition: cond,
              actions: await Promise.all((block && block.actions ? block.actions : []).map(actionOf))
            });
          }
        }
        return o;
      };
      const reactionsOf = async (node) => {
        const list = safe(() => node.reactions);
        if (!Array.isArray(list) || !list.length) return [];
        const out = [];
        for (const r of list) {
          out.push({
            trigger: triggerOf(safe(() => r.trigger)),
            actions: await Promise.all(safe(() => (r.actions || []).map((x) => x)) || []).then((acts) => Promise.all(acts.map(actionOf)))
          });
        }
        return out;
      };
      const destinations = (reactions, acc) => {
        for (const r of reactions) {
          for (const act of r.actions) {
            if (act.destinationId) acc.push(act.destinationId);
            for (const b of act.conditionalBlocks || []) {
              for (const nested of b.actions) if (nested.destinationId) acc.push(nested.destinationId);
            }
          }
        }
        return acc;
      };

      if (mode === 'flows' || mode === 'flow') {
        let points = [];
        try { points = f.currentPage.flowStartingPoints || []; } catch { points = []; }
        return {
          mode: 'flows',
          page: safe(() => f.currentPage.name),
          flows: points.map((p) => ({ nodeId: p.nodeId, name: p.name, nodeName: nameOf(p.nodeId) })),
          count: points.length,
          note: points.length ? null : '这一页没有设置原型起点（Figma 里：选中 frame → Prototype → 设为起点 / Add starting point）',
          fileKey: safe(() => f.fileKey)
        };
      }

      if (mode === 'trace') {
        const start = a.nodeId || a.startId || safe(() => (f.currentPage.flowStartingPoints[0] || {}).nodeId);
        if (!start) return { error: 'trace 需要 nodeId（起点），或这一页要有原型起点' };
        const maxDepth = Math.max(1, Math.min(12, Number(a.maxDepth) || 4));
        const visited = new Set([start]);
        const queue = [{ id: start, depth: 0 }];
        const edges = [];
        let expanded = 0;
        while (queue.length) {
          const cur = queue.shift();
          const node = safe(() => f.getNodeById(cur.id));
          if (!node) continue;
          expanded += 1;
          const reactions = await reactionsOf(node);
          for (const r of reactions) {
            const acts = [];
            for (const act of r.actions) {
              acts.push(act);
              for (const b of act.conditionalBlocks || []) for (const nested of b.actions) acts.push(nested);
            }
            for (const act of acts) {
              if (!act.destinationId) continue;
              edges.push({
                from: { id: node.id, name: node.name },
                trigger: r.trigger, action: act.type, navigation: act.navigation || null,
                to: { id: act.destinationId, name: act.destinationName || nameOf(act.destinationId) },
                depth: cur.depth
              });
              if (!visited.has(act.destinationId) && cur.depth + 1 <= maxDepth) {
                visited.add(act.destinationId);
                queue.push({ id: act.destinationId, depth: cur.depth + 1 });
              }
            }
          }
          if (expanded > 200) break;
        }
        return {
          mode: 'trace', start: { id: start, name: nameOf(start) },
          edges, screens: visited.size, maxDepth, truncated: expanded > 200,
          note: edges.length ? null : '从起点没有跟到任何跳转（这个节点没有 reactions，或目标节点不在当前页）',
          fileKey: safe(() => f.fileKey)
        };
      }

      // connections: walk a subtree (default: the current selection, else the page)
      let root = null;
      if (a.nodeId) root = safe(() => f.getNodeById(String(a.nodeId)));
      if (!root) root = (f.currentPage.selection && f.currentPage.selection[0]) || null;
      if (!root) root = f.currentPage;
      const depth = Math.max(0, Math.min(6, Number(a.depth) === undefined ? 2 : Number(a.depth)));
      const limit = Math.max(1, Math.min(200, Number(a.limit) || 60));
      const rows = [];
      const walk = async (n, d) => {
        if (rows.length >= limit) return;
        const reactions = await reactionsOf(n);
        if (reactions.length) {
          rows.push({
            id: n.id, name: n.name, type: n.type,
            x: safe(() => Math.round(n.x)), y: safe(() => Math.round(n.y)),
            reactions
          });
        }
        if (d >= depth || !Array.isArray(safe(() => n.children))) return;
        for (const c of safe(() => n.children) || []) {
          if (rows.length >= limit) return;
          await walk(c, d + 1);
        }
      };
      await walk(root, 0);
      const flowPoints = safe(() => (f.currentPage.flowStartingPoints || []).map((p) => ({ nodeId: p.nodeId, name: p.name })));
      return {
        mode: 'connections',
        root: { id: root.id, name: root.name, type: root.type },
        depth, limit,
        nodes: rows,
        count: rows.length,
        truncated: rows.length >= limit,
        flowStartingPoints: flowPoints || [],
        note: rows.length ? null : '这个子树里没有任何 reactions（先在 Figma 里连一条原型交互，或调大 depth）',
        fileKey: safe(() => f.fileKey)
      };
    },

    styles: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const a = arg || {};
      const limit = Math.max(1, Math.min(500, Number(a.limit) || 100));
      const paintOf = (s) => safe(() => (Array.isArray(s.paints) ? s.paints.map((p) => p.type) : undefined));
      const grabbed = (bucket, fn, shape) => {
        let all = [];
        try { all = fn(); } catch (e) { return { error: '读取失败：' + String(e && e.message || e) }; }
        const out = { total: all.length, truncated: all.length > limit };
        out[bucket] = all.slice(0, limit).map((s) => Object.assign({ id: s.id, name: s.name }, shape(s)));
        return out;
      };
      const textShape = (s) => ({
        fontName: safe(() => (s.fontName ? { family: s.fontName.family, style: s.fontName.style } : null)),
        fontSize: safe(() => s.fontSize),
        lineHeight: safe(() => s.lineHeight),
        letterSpacing: safe(() => s.letterSpacing),
        textCase: safe(() => s.textCase),
        textDecoration: safe(() => s.textDecoration),
        paragraphSpacing: safe(() => s.paragraphSpacing),
        paragraphIndent: safe(() => s.paragraphIndent)
      });
      const out = {
        paints: grabbed('styles', () => f.getLocalPaintStyles(), (s) => ({ paints: paintOf(s) })),
        text: grabbed('styles', () => f.getLocalTextStyles(), textShape),
        effects: grabbed('styles', () => f.getLocalEffectStyles(), (s) => ({ effects: safe(() => (s.effects || []).map((e) => e.type)) })),
        grids: grabbed('styles', () => f.getLocalGridStyles(), (s) => ({ layoutGrids: safe(() => (s.layoutGrids || []).map((g) => g.pattern)) }))
      };
      out.count = (out.paints.styles || []).length + (out.text.styles || []).length
        + (out.effects.styles || []).length + (out.grids.styles || []).length;
      out.howToApply = '给节点设 paintStyleId / textStyleId / effectStyleId / gridStyleId 即可套用（figma_patch_node）；传空字符串解除绑定';
      out.fileKey = safe(() => f.fileKey);
      return out;
    },

    duplicate: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const a = arg || {};
      const ids = Array.isArray(a.nodeIds) && a.nodeIds.length ? a.nodeIds : (a.nodeId ? [a.nodeId] : []);
      if (!ids.length) return { error: '需要 nodeId 或 nodeIds' };
      const count = Math.max(1, Math.min(50, Number(a.count || 1)));
      const dx = Number(a.dx !== undefined ? a.dx : (a.offset && a.offset.x) || 0);
      const dy = Number(a.dy !== undefined ? a.dy : (a.offset && a.offset.y) || 0);
      let parent = null;
      if (a.parentId) {
        const hit = nodeById(f, a.parentId);
        if (hit.error) return hit;
        parent = hit.node;
      }
      const made = [];
      const failed = [];
      for (const id of ids) {
        const hit = nodeById(f, id);
        if (hit.error) { failed.push({ nodeId: id, error: hit.error }); continue; }
        const src = hit.node;
        const target = parent || (src.parent && src.parent.type !== 'DOCUMENT' ? src.parent : f.currentPage);
        for (let i = 1; i <= count; i += 1) {
          let clone = null;
          try { clone = src.clone(); } catch (e) {
            failed.push({ nodeId: id, error: 'clone 抛错：' + String(e && e.message || e) });
            break;
          }
          if (!clone) { failed.push({ nodeId: id, error: 'clone() 返回 null（这种节点不支持复制）' }); break; }
          try { target.appendChild(clone); } catch (e) {
            failed.push({ nodeId: id, error: '挂到目标父级失败：' + String(e && e.message || e) });
            break;
          }
          if (dx || dy) {
            const b = boxOf(clone);
            if (b) moveAbs(clone, b.x + dx * i, b.y + dy * i);
          }
          made.push({
            from: id, id: clone.id, name: clone.name, type: clone.type,
            x: R2(clone.x), y: R2(clone.y), width: R2(clone.width), height: R2(clone.height)
          });
        }
      }
      let removed = null;
      if (a.revert !== false) {
        let n = 0;
        for (const m of made) {
          const node = f.getNodeById(m.id);
          if (!node) continue;
          try { node.remove(); n += 1; } catch { /* already gone */ }
        }
        removed = n;
      }
      return { created: made, count: made.length, failed, removed, fileKey: safe(() => f.fileKey) };
    },

    arrange: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const a = arg || {};
      const op = String(a.op || '').toLowerCase();
      const ids = Array.isArray(a.nodeIds) && a.nodeIds.length ? a.nodeIds : (a.nodeId ? [a.nodeId] : []);
      const nodes = [];
      const missing = [];
      for (const id of ids) {
        const hit = nodeById(f, id);
        if (hit.error) missing.push(id); else nodes.push(hit.node);
      }
      const before = nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
      const moved = [];
      const note = [];
      const push = (n, from) => moved.push({
        id: n.id, name: n.name,
        from: { x: R2(from.x), y: R2(from.y) },
        to: { x: R2(n.x), y: R2(n.y) }
      });

      if (op === 'distribute') {
        if (nodes.length < 3) return { error: 'distribute 需要至少 3 个节点（首尾不动，中间等距重排）' };
        const vertical = String(a.axis || 'horizontal').toLowerCase() === 'vertical';
        const items = nodes.map((n) => ({ n, b: boxOf(n) })).filter((it) => it.b);
        if (items.length < 3) return { error: '有节点取不到 bounding box（可能被隐藏或不在画布上）' };
        items.sort((p, q) => (vertical ? p.b.y - q.b.y : p.b.x - q.b.x));
        const first = items[0];
        const last = items[items.length - 1];
        const middle = items.slice(1, -1);
        const span = vertical
          ? last.b.y - (first.b.y + first.b.h)
          : last.b.x - (first.b.x + first.b.w);
        const occupied = middle.reduce((sum, it) => sum + (vertical ? it.b.h : it.b.w), 0);
        const gap = (span - occupied) / (middle.length + 1);
        if (!Number.isFinite(gap)) return { error: '首尾位置重叠，算不出间距' };
        let cursor = (vertical ? first.b.y + first.b.h : first.b.x + first.b.w) + gap;
        for (const it of middle) {
          const from = { x: it.b.x, y: it.b.y };
          moveAbs(it.n, vertical ? from.x : cursor, vertical ? cursor : from.y);
          push(it.n, from);
          cursor += (vertical ? it.b.h : it.b.w) + gap;
        }
        note.push(`首尾不动，中间 ${middle.length} 个等距，gap ${R2(gap)}`);
      } else if (op === 'align') {
        if (!nodes.length) return { error: 'align 需要 nodeId 或 nodeIds' };
        const edge = String(a.edge || 'left').toLowerCase();
        const refHit = a.relativeTo ? nodeById(f, a.relativeTo) : null;
        if (refHit && refHit.error) return refHit;
        let refBox = refHit ? boxOf(refHit.node) : null;
        if (refBox) note.push(`基准：${a.relativeTo}`);
        else {
          const parent = nodes[0].parent;
          refBox = parent && parent.type !== 'DOCUMENT' ? boxOf(parent) : null;
          if (refBox) note.push('基准：父级');
        }
        if (!refBox) return { error: '取不到对齐基准（父级或 relativeTo 没有 bounding box）' };
        for (const n of nodes) {
          const b = boxOf(n);
          if (!b) continue;
          const from = { x: b.x, y: b.y };
          let tx = b.x;
          let ty = b.y;
          if (edge === 'left') tx = refBox.x;
          else if (edge === 'right') tx = refBox.x + refBox.w - b.w;
          else if (edge === 'hcenter' || edge === 'centerx') tx = refBox.x + (refBox.w - b.w) / 2;
          else if (edge === 'top') ty = refBox.y;
          else if (edge === 'bottom') ty = refBox.y + refBox.h - b.h;
          else if (edge === 'vcenter' || edge === 'centery') ty = refBox.y + (refBox.h - b.h) / 2;
          else return { error: 'edge 只支持 left / right / hcenter / top / bottom / vcenter' };
          moveAbs(n, tx, ty);
          push(n, from);
        }
      } else if (op === 'grid') {
        if (!nodes.length) return { error: 'grid 需要 nodeId 或 nodeIds' };
        const size = Number(a.size || 8);
        if (!(size > 0)) return { error: `size 必须是正数，收到 ${a.size}` };
        const ox = Number(a.x || 0);
        const oy = Number(a.y || 0);
        for (const n of nodes) {
          const b = boxOf(n);
          if (!b) continue;
          const from = { x: b.x, y: b.y };
          moveAbs(n, Math.round((b.x - ox) / size) * size + ox, Math.round((b.y - oy) / size) * size + oy);
          push(n, from);
        }
        note.push(`栅格 ${size}，原点 (${ox},${oy})`);
      } else if (op === 'place') {
        const targetHit = a.nodeId ? nodeById(f, a.nodeId) : { error: 'place 需要 nodeId（被移动的节点）与 relativeTo（参照）' };
        if (targetHit.error) return targetHit;
        const refHit = a.relativeTo ? nodeById(f, a.relativeTo) : { error: 'place 需要 relativeTo（参照节点）' };
        if (refHit.error) return refHit;
        const tb = boxOf(targetHit.node);
        const rb = boxOf(refHit.node);
        if (!tb || !rb) return { error: '取不到 bounding box（节点可能不可见）' };
        const gap = Number(a.gap || 0);
        const side = String(a.side || 'below').toLowerCase();
        const al = String(a.align || 'start').toLowerCase();
        const along = (refLen, selfLen) => (al === 'center' ? (refLen - selfLen) / 2 : al === 'end' ? refLen - selfLen : 0);
        let tx = tb.x;
        let ty = tb.y;
        if (side === 'below') { ty = rb.y + rb.h + gap; tx = rb.x + along(rb.w, tb.w); }
        else if (side === 'above') { ty = rb.y - tb.h - gap; tx = rb.x + along(rb.w, tb.w); }
        else if (side === 'right') { tx = rb.x + rb.w + gap; ty = rb.y + along(rb.h, tb.h); }
        else if (side === 'left') { tx = rb.x - tb.w - gap; ty = rb.y + along(rb.h, tb.h); }
        else return { error: 'side 只支持 below / above / right / left' };
        moveAbs(targetHit.node, tx, ty);
        push(targetHit.node, { x: tb.x, y: tb.y });
        note.push(`${side} ${a.relativeTo}，gap ${gap}，对齐 ${al}`);
      } else if (op === 'fit') {
        const hit = nodeById(f, a.nodeId || (a.nodeIds && a.nodeIds[0]));
        if (hit.error) return hit;
        const sec = hit.node;
        if (sec.type !== 'SECTION') {
          return { error: `fit 只支持 SECTION（当前 ${sec.type}）：其他容器要改尺寸得自己算子节点包围盒` };
        }
        if (typeof sec.resizeWithoutConstraints !== 'function') return { error: '这个版本的 Plugin API 没有 resizeWithoutConstraints' };
        const kids = (sec.children || []).slice();
        if (!kids.length) return { error: 'section 是空的，没有内容可以贴合' };
        const padding = Math.max(0, Number(a.padding || 0));
        const boxes = kids.map((k) => boxOf(k)).filter(Boolean);
        if (!boxes.length) return { error: '子节点都取不到 bounding box' };
        const minX = Math.min(...boxes.map((b) => b.x));
        const minY = Math.min(...boxes.map((b) => b.y));
        const maxX = Math.max(...boxes.map((b) => b.x + b.w));
        const maxY = Math.max(...boxes.map((b) => b.y + b.h));
        const secBox = boxOf(sec);
        if (!secBox) return { error: '取不到 section 的 bounding box' };
        const sizeBefore = { width: R2(sec.width), height: R2(sec.height) };
        const kidsBefore = kids.map((k) => ({ id: k.id, x: k.x, y: k.y }));
        // Children first: shift the whole group so its bbox starts at padding inside the
        // section's origin, then resize the section around it.
        const dx = (secBox.x + padding) - minX;
        const dy = (secBox.y + padding) - minY;
        for (let i = 0; i < kids.length; i += 1) {
          const k = kids[i];
          const b = boxes[i] || boxOf(k);
          if (!b) continue;
          moveAbs(k, b.x + dx, b.y + dy);
          moved.push({ id: k.id, name: k.name, from: { x: R2(b.x), y: R2(b.y) }, to: { x: R2(k.x), y: R2(k.y) } });
        }
        const w = Math.max(1, Math.round((maxX - minX) + padding * 2));
        const h = Math.max(1, Math.round((maxY - minY) + padding * 2));
        sec.resizeWithoutConstraints(w, h);
        const result = {
          op, section: { id: sec.id, name: sec.name }, padding,
          sizeBefore, sizeAfter: { width: R2(sec.width), height: R2(sec.height) },
          children: kids.length, moved,
          reverted: null, revertAvailable: true,
          note: 'fit 只改 section 尺寸与子节点位置，可传 revert:true 还原'
        };
        if (a.revert === true) {
          // Restore the children first, then the section: the size was derived from them,
          // so undoing only the size left the artwork shifted (the first version did that).
          for (const snap of kidsBefore) {
            const n = f.getNodeById(snap.id);
            if (!n) continue;
            n.x = snap.x;
            n.y = snap.y;
          }
          sec.resizeWithoutConstraints(sizeBefore.width, sizeBefore.height);
          result.reverted = true;
          result.movedAfterRevert = kids.map((k) => ({ id: k.id, x: R2(k.x), y: R2(k.y) }));
        }
        return result;
      } else if (op === 'ungroup') {
        const hit = nodeById(f, a.nodeId || (a.nodeIds && a.nodeIds[0]));
        if (hit.error) return hit;
        const g = hit.node;
        if (g.type !== 'GROUP') {
          return { error: `ungroup 只支持 GROUP（当前 ${g.type}）：FRAME 带裁剪/auto-layout 语义，拆开要逐子节点换算坐标，没有实现` };
        }
        const parent = g.parent;
        if (!parent || parent.type === 'DOCUMENT') return { error: '这个 group 已经在页面顶层' };
        const kids = g.children.slice();
        const boxes = kids.map((k) => boxOf(k));
        kids.forEach((k, i) => {
          parent.appendChild(k);
          if (boxes[i]) moveAbs(k, boxes[i].x, boxes[i].y);
          moved.push({
            id: k.id, name: k.name,
            from: boxes[i] ? { x: R2(boxes[i].x), y: R2(boxes[i].y) } : null,
            to: { x: R2(k.x), y: R2(k.y) }
          });
        });
        const name = g.name;
        try { g.remove(); } catch { /* already gone */ }
        return {
          op, ungrouped: { name, children: kids.length, parent: { id: parent.id, name: parent.name } },
          moved, reverted: null, revertAvailable: false,
          note: '拆开后不自动还原（重新成组会丢层级/顺序），要撤销用 Ctrl+Z'
        };
      } else {
        return { error: `arrange 的 op 只支持 distribute / align / grid / place / fit / ungroup，收到 ${a.op}` };
      }

      // Geometry ops are pure x/y writes, so revert is exact. Default is keep, the way
      // figma_build keeps — you ran this in order to end up with the layout.
      let reverted = null;
      if (a.revert === true) {
        for (const snap of before) {
          const n = f.getNodeById(snap.id);
          if (!n) continue;
          n.x = snap.x;
          n.y = snap.y;
        }
        reverted = true;
      }
      return {
        op, moved, reverted, revertAvailable: true, missing,
        note: note.length ? note.join('；') : null, fileKey: safe(() => f.fileKey)
      };
    },

    // SVG is the one import path that produces real vector layers instead of pixels, so
    // it is what makes icons/logos/illustrations usable in a build. figma.createNodeFromSvg
    // does the parsing; everything here is validation + placement + revert.
    importSvg: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const a = arg || {};
      const svg = String(a.svg || '').trim();
      if (!svg) return { error: '需要 SVG 文本（.svg 文件由 bridge 读成字符串后放进 svg）' };
      if (svg.length > 2 * 1024 * 1024) return { error: `SVG 文本 ${svg.length} 字节超过 2MB` };
      if (!/^<svg[\s>]/i.test(svg)) return { error: '只接受以 <svg 开头的标记（不是 HTML / JS / data URI）' };
      // Not a security boundary (the sandbox has no DOM), just honesty about what the
      // Figma importer will silently drop vs. what it will choke on.
      if (/<script[\s>]|\son\w+=|javascript:/i.test(svg)) {
        return { error: 'SVG 里含 <script> / on* 事件属性 / javascript: URL —— Figma 会拒收，先清理' };
      }
      let node;
      try {
        node = f.createNodeFromSvg(svg);
      } catch (e) {
        return {
          error: 'createNodeFromSvg 失败：' + String(e && e.message || e),
          hint: 'Figma 不接受 <foreignObject>、外部 href、CSS 变量；路径要能解析成几何'
        };
      }
      const made = {
        id: node.id, name: node.name, type: node.type,
        width: Math.round(node.width * 100) / 100, height: Math.round(node.height * 100) / 100,
        childCount: node.children ? node.children.length : 0
      };
      // rescale() scales the vector children with the frame; resize() would only stretch
      // the wrapper and leave the artwork at its original size.
      const wantW = a.width !== undefined ? Number(a.width) : null;
      const wantH = a.height !== undefined ? Number(a.height) : null;
      let scaled = null;
      if (wantW || wantH) {
        const ratio = wantW && wantH ? wantH / wantW : null;
        const natural = made.width ? made.height / made.width : null;
        const factor = wantW ? wantW / made.width : wantH / made.height;
        if (!(factor > 0)) {
          node.remove();
          return { error: 'width/height 必须是正数' };
        }
        node.rescale(factor);
        scaled = {
          factor: Math.round(factor * 1000) / 1000,
          from: { width: made.width, height: made.height },
          to: { width: Math.round(node.width * 100) / 100, height: Math.round(node.height * 100) / 100 },
          uniform: true,
          note: ratio !== null && natural !== null && Math.abs(ratio - natural) > 0.01
            ? 'width 和 height 的比例与原图不一致：rescale 只能等比缩放，实际按 width 的比例生效'
            : null
        };
      }
      let parent = null;
      if (a.parentId) {
        const hit = nodeById(f, a.parentId);
        if (hit.error) {
          node.remove();
          return hit;
        }
        parent = hit.node;
      }
      try {
        (parent || f.currentPage).appendChild(node);
      } catch (e) {
        node.remove();
        return { error: '挂不到这个父级：' + String(e && e.message || e) + '（父级可能只接受特定子类型）' };
      }
      if (a.name) node.name = String(a.name);
      if (a.x !== undefined) node.x = Number(a.x);
      if (a.y !== undefined) node.y = Number(a.y);
      const placedAt = { x: Math.round(node.x * 100) / 100, y: Math.round(node.y * 100) / 100 };
      let removed = null;
      if (a.revert !== false) {
        try {
          node.remove();
          removed = true;
        } catch (e) {
          removed = '回填失败，请手动 Ctrl+Z：' + String(e && e.message || e);
        }
      }
      return {
        created: made,
        scaled,
        parent: parent ? { id: parent.id, name: parent.name } : 'currentPage',
        placedAt,
        removed,
        fileKey: safe(() => f.fileKey)
      };
    },

    patchNode: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;

      const one = async (nodeId, patch, revert) => {
        const hit = nodeById(f, nodeId);
        if (hit.error) return hit;
        const n = hit.node;
        const p = patch || {};
        if (!Object.keys(p).length) return { error: 'patch 是空的，没有可改的属性' };
        const before = pickProps(f, n);
        let applied;
        try {
          applied = await applyProps(f, n, p);
        } catch (e) {
          return { error: '应用失败：' + String(e && e.message || e), before, settled: pickProps(f, n), note: '部分属性可能已经写进去了' };
        }
        const after = pickProps(f, n);
        let reverted = null;
        let settled = after;
        if (revert !== false) {
          try {
            await restoreProps(f, n, before);
            reverted = true;
            settled = pickProps(f, n);
          } catch (e) {
            reverted = { error: '回填失败，请手动 Ctrl+Z：' + String(e && e.message || e) };
          }
        }
        return { nodeId: n.id, name: n.name, applied, before, after, reverted, settled };
      };

      // Layout work touches a dozen nodes at once; one round trip per node made that
      // impractical over MCP.
      if (Array.isArray(arg && arg.patches)) {
        const results = [];
        for (const item of arg.patches) {
          results.push({ ...(await one(item.nodeId, item.patch, arg.revert)), askedFor: item.nodeId });
        }
        const failed = results.filter((r) => r.error);
        return {
          batch: results.length,
          failedCount: failed.length,
          results,
          fileKey: f.fileKey
        };
      }
      return one(arg && arg.nodeId, arg && arg.patch, arg && arg.revert);
    },

    deleteNode: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const hit = nodeById(f, arg && arg.nodeId);
      if (hit.error) return hit;
      const n = hit.node;
      if (!n.parent) return { error: '这个节点没有父级（页或根），不能删' };
      const parent = n.parent;
      const index = parent.children.indexOf(n);
      const snapshot = describeNode(n);
      const mode = String((arg && arg.mode) || 'hide');

      // Verified against a real file: after node.remove() the node object is gone, so
      // insertChild fails with "The node id does not exist". Only hide is truly
      // reversible; remove leans on Figma's own undo history.
      if (mode === 'hide') {
        const before = safe(() => n.visible);
        try { n.visible = false; } catch (e) { return { error: '隐藏失败：' + String(e && e.message || e), snapshot }; }
        const hidden = safe(() => n.visible) === false;
        let restored = null;
        if (arg.revert !== false) {
          try { n.visible = before; restored = safe(() => n.visible) === before; }
          catch (e) { restored = { error: '恢复可见性失败：' + String(e && e.message || e) }; }
        }
        return { mode, snapshot, parentId: parent.id, index, beforeVisible: before, hidden, restored, fileKey: f.fileKey,
          note: 'mode:"hide" 只改 visible，节点对象还在，可完全还原' };
      }
      if (mode !== 'remove') return { error: 'mode 只支持 hide 或 remove', got: mode };
      if (arg.confirm !== true) {
        return { error: 'remove 会销毁节点对象，插不回来；确要删请传 confirm:true', snapshot, hint: '想无痕探测就用 mode:"hide"' };
      }
      if (arg.revert !== false) {
        return { error: 'remove 无法自动还原：remove() 之后 insertChild 会报 node does not exist。确认删除请同时传 revert:false；已经删了就在 Figma 里按 Ctrl+Z。' };
      }
      const baseline = parent.children.length;
      try {
        n.remove();
      } catch (e) {
        return { error: 'remove 抛错：' + String(e && e.message || e), snapshot };
      }
      return {
        mode, snapshot, parentId: parent.id, index,
        removedFrom: { before: baseline, now: parent.children.length },
        stillThere: !!f.getNodeById(n.id),
        undoHint: '这一步进了 Figma 历史，Ctrl+Z 可撤销',
        revertAvailable: false,
        fileKey: f.fileKey
      };
    },

    exportImage: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const batchIds = Array.isArray(arg && arg.nodeIds) && arg.nodeIds.length ? arg.nodeIds.slice(0, 40) : null;
      const wantId = batchIds ? null : ((arg && arg.nodeId) || (f.currentPage.selection[0] && f.currentPage.selection[0].id));
      let hit = null;
      if (!batchIds) {
        hit = nodeById(f, wantId);
        if (hit.error) return { ...hit, hint: '没有选中节点时要把 nodeId 传进来' };
      }
      const format = String((arg && arg.format) || 'PNG').toUpperCase();
      if (['PNG', 'JPG', 'SVG', 'PDF'].indexOf(format) < 0) {
        return { error: 'format 只支持 PNG / JPG / SVG / PDF', got: format };
      }
      const scale = Number((arg && arg.scale) || 1);
      const maxBytes = Number((arg && arg.maxBytes) || 4 * 1024 * 1024);
      // clip = export the node's visual contents cropped to its own bounds (Figma's
      // use_absolute_bounds): without it a PNG includes effects/overflow outside the frame.
      const clip = !!(arg && arg.clip);
      const mediaType = { PNG: 'image/png', JPG: 'image/jpeg', SVG: 'image/svg+xml', PDF: 'application/pdf' }[format];
      const settingsFor = () => {
        const extra = clip ? { contentsOnly: true, useAbsoluteBounds: true } : {};
        return (format === 'PNG' || format === 'JPG')
          ? { format, constraint: { type: 'SCALE', value: scale }, ...extra }
          : { format, ...extra };
      };
      const exportOne = async (node) => {
        let bytes;
        try {
          bytes = await node.exportAsync(settingsFor());
        } catch (e) {
          return { nodeId: node.id, error: 'exportAsync 抛错：' + String(e && e.message || e) };
        }
        if (!bytes || !bytes.length) return { nodeId: node.id, error: '导出是空的（节点可能不可见或尺寸为 0）' };
        if (bytes.length > maxBytes) {
          return { nodeId: node.id, error: `导出 ${bytes.length} 字节超过 maxBytes ${maxBytes}：把 scale 调小，或只导出子节点`, bytes: bytes.length };
        }
        return {
          nodeId: node.id, name: node.name, format, scale, bytes: bytes.length,
          base64: b64FromBytes(bytes), mediaType,
          nodeSize: { width: safe(() => Math.round(node.width)), height: safe(() => Math.round(node.height)) }
        };
      };

      // Batch mode: one round trip for "export the selection" / "export these 12 frames".
      if (batchIds) {
        const files = [];
        const failed = [];
        for (const id of batchIds) {
          const one = nodeById(f, id);
          if (one.error) { failed.push({ nodeId: id, error: one.error }); continue; }
          const got = await exportOne(one.node);
          if (got.error) failed.push({ nodeId: id, error: got.error });
          else files.push(got);
        }
        if (!files.length) return { error: '批量导出全部失败', failed, fileKey: f.fileKey };
        return { files, failed, count: files.length, clip, fileKey: f.fileKey };
      }

      const got = await exportOne(hit.node);
      if (got.error) return { ...got, nodeId: hit.node.id };
      return { ...got, clip, fileKey: f.fileKey };
    },

    importImage: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      if (!arg || !arg.base64) return { error: '需要 base64（由服务端从本地文件读出，不要让图片进模型上下文）' };
      let bytes;
      try { bytes = bytesFromB64(arg.base64); } catch (e) { return { error: 'base64 解码失败：' + String(e && e.message || e) }; }
      if (!bytes.length) return { error: '解出来是空的' };
      let image;
      try {
        image = await f.createImage(bytes);
      } catch (e) {
        return { error: 'createImage 被拒：' + String(e && e.message || e) + '（常见原因：不是真 PNG/JPG 字节，或文件图片配额到顶）', inputBytes: bytes.length };
      }
      const paint = { type: 'IMAGE', imageHash: image.hash, scaleMode: String(arg.scaleMode || 'FILL') };
      try {
        if (arg.nodeId) {
          const hit = nodeById(f, arg.nodeId);
          if (hit.error) return { error: hit.error + '；图片本身已进文件，hash ' + image.hash, imageHash: image.hash };
          const n = hit.node;
          const before = pickProps(f, n);
          n.fills = [paint];
          const after = describeNode(n);
          let reverted = null;
          if (arg.revert !== false) { await restoreProps(f, n, before); reverted = true; }
          return { mode: 'fill-node', imageHash: image.hash, nodeId: n.id, inputBytes: bytes.length, after, reverted, fileKey: f.fileKey,
            note: '图片资源一旦创建就留在文件里，revert 只把节点填充恢复原样' };
        }
        const rect = f.createRectangle();
        rect.name = String(arg.name || 'Imported image');
        rect.x = Number(arg.x || 40);
        rect.y = Number(arg.y || 40);
        const w = Number(arg.width || 240);
        const h = Number(arg.height || 160);
        if (typeof rect.resize === 'function') rect.resize(w, h);
        rect.fills = [paint];
        if (!rect.parent) f.currentPage.appendChild(rect);
        const created = describeNode(rect);
        let removed = null;
        if (arg.revert !== false) {
          try { rect.remove(); removed = !f.currentPage.children.some((c) => c.id === rect.id); }
          catch (e) { removed = { error: '删除失败，请手动 Ctrl+Z：' + String(e.message || e) }; }
        }
        return { mode: 'new-node', imageHash: image.hash, inputBytes: bytes.length, created, removed, fileKey: f.fileKey,
          note: '图片资源一旦创建就留在文件里，revert 只删除挂它的节点' };
      } catch (e) {
        return { error: '写入图片填充失败：' + String(e && e.message || e), imageHash: image.hash };
      }
    },

    find: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      let scope = f.currentPage;
      if (arg && arg.nodeId) {
        const hit = nodeById(f, arg.nodeId);
        if (hit.error) return hit;
        scope = hit.node;
      } else if (arg && arg.wholeDocument) {
        scope = f.root;
      }
      const types = Array.isArray(arg && arg.types) ? arg.types.map((t) => String(t).toUpperCase()) : null;
      let nameRe = null;
      if (arg && arg.name) {
        try { nameRe = new RegExp(String(arg.name), arg.icase === false ? '' : 'i'); }
        catch (e) { return { error: 'name 不是合法正则：' + String(e && e.message || e) }; }
      }
      const limit = Math.min(Math.max(1, Number((arg && arg.limit) || 100)), 300);
      const hits = [];
      let visited = 0;
      const scan = (n) => {
        if (hits.length >= limit || visited > 20000) return;
        visited += 1;
        if (n !== scope) {
          const okType = !types || types.indexOf(n.type) >= 0;
          const okName = !nameRe || nameRe.test(String(n.name || ''));
          if (okType && okName && hits.length < limit) hits.push(describeNode(n));
        }
        if (Array.isArray(n.children)) for (const c of n.children) scan(c);
      };
      scan(scope);
      return { scope: describeNode(scope), visited, matched: hits.length, truncated: hits.length >= limit, hits, fileKey: f.fileKey };
    },

    setSelection: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const { nodes, missing } = nodesByIds(f, (arg && (arg.nodeIds || (arg.nodeId ? [arg.nodeId] : null))) || []);
      if (!nodes.length) return { error: '一个节点都没找到', missing };
      f.currentPage.selection = nodes;
      if (arg && arg.scrollToFit !== false) {
        try { f.viewport.scrollAndZoomIntoView(nodes); } catch (e) { /* not fatal */ }
      }
      return {
        selected: f.currentPage.selection.slice(0, 20).map(describeNode),
        missing,
        page: f.currentPage.name,
        viewport: safe(() => ({ zoom: Math.round(f.viewport.zoom * 1000) / 1000 })),
        fileKey: f.fileKey
      };
    },

    moveNode: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const hit = nodeById(f, arg && arg.nodeId);
      if (hit.error) return hit;
      const n = hit.node;
      if (!n.parent) return { error: '这个节点没有父级（页或根），不能移动' };
      let target = f.currentPage;
      if (arg && arg.parentId) {
        const t = nodeById(f, arg.parentId);
        if (t.error) return t;
        target = t.node;
      }
      if (typeof target.appendChild !== 'function') return { error: `目标 ${target.type} 不能容纳子节点` };
      if (target === n.parent && arg && arg.index === undefined) return { error: '已经在目标父级下了，要么给 index 调顺序', node: describeNode(n) };
      const oldParent = n.parent;
      const oldIndex = oldParent.children.indexOf(n);
      target.appendChild(n);
      if (arg && arg.index !== undefined) {
        const i = Math.max(0, Math.min(Number(arg.index), target.children.length - 1));
        target.insertChild(i, n);
      }
      const movedTo = { parentId: n.parent && n.parent.id, index: n.parent ? n.parent.children.indexOf(n) : -1 };
      let reverted = null;
      if (arg && arg.revert !== false) {
        try {
          oldParent.insertChild(Math.max(0, oldIndex), n);
          reverted = { parentId: n.parent && n.parent.id, index: n.parent ? n.parent.children.indexOf(n) : -1 };
        } catch (e) { reverted = { error: '移回原位失败，请 Ctrl+Z：' + String(e && e.message || e) }; }
      }
      return { node: describeNode(n), movedTo, reverted, fileKey: f.fileKey };
    },

    group: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const { nodes, missing } = nodesByIds(f, arg && arg.nodeIds);
      if (nodes.length < 2) return { error: '成组至少需要 2 个能找到的节点', missing, found: nodes.length };
      const parent = nodes[0].parent;
      if (!parent) return { error: '首个节点没有父级' };
      if (nodes.some((n) => n.parent !== parent)) return { error: '跨父级不能直接成组，先 moveNode 到同一个父级' };
      let g;
      try {
        g = f.group(nodes, parent);
        if (arg && arg.name) g.name = String(arg.name);
      } catch (e) { return { error: 'group 抛错：' + String(e && e.message || e) }; }
      const created = describeNode(g);
      let ungrouped = null;
      if (arg && arg.revert !== false) {
        try { f.ungroup(g); ungrouped = true; }
        catch (e) { ungrouped = { error: '解组失败，请 Ctrl+Z：' + String(e && e.message || e) }; }
      }
      return { created, nodeCount: nodes.length, ungrouped, fileKey: f.fileKey };
    },

    // Boolean operations reparent the inputs into the result, so removing the result
    // would destroy the user's original shapes. That is not reversible from here.
    booleanOp: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const op = String((arg && arg.op) || 'union').toLowerCase();
      const fn = { union: f.union, subtract: f.subtract, intersect: f.intersect, exclude: f.exclude }[op];
      if (!fn) return { error: 'op 只支持 union / subtract / intersect / exclude', got: op };
      const { nodes, missing } = nodesByIds(f, arg && arg.nodeIds);
      if (nodes.length < 2) return { error: '布尔运算至少需要 2 个能找到的节点', missing, found: nodes.length };
      if (arg && arg.confirm !== true) {
        return { error: '布尔运算会把输入节点吸收进结果，删结果等于删原件，工具无法自动撤销。确认请传 confirm:true（撤销只能 Ctrl+Z）', inputs: nodes.map(describeNode) };
      }
      let result;
      try {
        result = fn(nodes, nodes[0].parent || f.currentPage);
        result.name = String((arg && arg.name) || `Qoder ${op}`);
      } catch (e) { return { error: `${op} 抛错：` + String(e && e.message || e) }; }
      return { op, result: describeNode(result), absorbed: nodes.length, missing, undoHint: 'Ctrl+Z 可撤销这一步', revertAvailable: false, fileKey: f.fileKey };
    },

    instance: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const action = String((arg && arg.action) || 'create');
      const hit = nodeById(f, arg && arg.nodeId);
      if (hit.error) return hit;
      const src = hit.node;

      if (action === 'create') {
        if (typeof src.createInstance !== 'function') return { error: `${src.type} 不能创建实例（需要 COMPONENT）`, node: describeNode(src) };
        let inst;
        try {
          inst = src.createInstance();
          const p = (arg && arg.props) || {};
          if (p.x !== undefined) inst.x = Number(p.x);
          if (p.y !== undefined) inst.y = Number(p.y);
          inst.name = String(p.name || `${src.name} · instance`);
          const placed = await placeNode(f, inst, arg && arg.parentId);
          if (placed.error) { try { inst.remove(); } catch { /* gone */ } return { error: placed.error, created: describeNode(inst) }; }
        } catch (e) { return { error: 'createInstance 抛错：' + String(e && e.message || e) }; }
        const created = describeNode(inst);
        let removed = null;
        if (arg && arg.revert !== false) {
          try { inst.remove(); removed = !f.getNodeById(inst.id); }
          catch (e) { removed = { error: '删除实例失败：' + String(e && e.message || e) }; }
        }
        return { action, created, mainComponent: describeNode(src), removed, fileKey: f.fileKey };
      }

      if (action === 'detach') {
        if (typeof src.detachInstance !== 'function') return { error: `${src.type} 不是实例，无法 detach`, node: describeNode(src) };
        if (arg && arg.confirm !== true) {
          return { error: 'detach 会用 frame 替换掉这个实例，实例本身没了，工具无法自动还原。确认请传 confirm:true（撤销只能 Ctrl+Z）', node: describeNode(src) };
        }
        let frame;
        try { frame = src.detachInstance(); }
        catch (e) { return { error: 'detachInstance 抛错：' + String(e && e.message || e) }; }
        return { action, detached: describeNode(frame), undoHint: 'Ctrl+Z 可撤销', revertAvailable: false, fileKey: f.fileKey };
      }
      return { error: 'action 只支持 create 或 detach', got: action };
    },

    mutatePage: async (arg) => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      const action = String((arg && arg.action) || 'list');
      const findPage = (idOrName) => f.root.children.find((p) => p.id === String(idOrName) || p.name === String(idOrName));

      if (action === 'list') {
        return {
          action,
          current: f.currentPage.name,
          pages: f.root.children.map((p) => ({ id: p.id, name: p.name, childCount: safe(() => p.children.length) })),
          fileKey: f.fileKey
        };
      }

      if (action === 'create') {
        const name = String((arg && arg.name) || 'Qoder page');
        let p;
        try {
          // figma.createPage() takes no arguments; the name has to be assigned after.
          p = await f.createPage();
          p.name = name;
        }
        catch (e) { return { error: 'createPage 抛错：' + String(e && e.message || e) }; }
        const made = { id: p.id, name: p.name };
        let removed = null;
        if (arg && arg.revert !== false) {
          try { p.remove(); removed = !f.root.children.some((x) => x.id === made.id); }
          catch (e) { removed = { error: '删页失败：' + String(e && e.message || e) }; }
        }
        return { action, made, removed, pageCount: f.root.children.length, fileKey: f.fileKey };
      }

      if (action === 'switch') {
        const p = findPage((arg && (arg.page || arg.name || arg.pageId)) || '');
        if (!p) return { error: '找不到页面（可传页面名或 id）', available: f.root.children.map((x) => x.name) };
        const before = f.currentPage;
        f.currentPage = p;
        let reverted = null;
        if (arg && arg.revert !== false) {
          try { f.currentPage = before; reverted = f.currentPage.name; }
          catch (e) { reverted = { error: '切回失败：' + String(e && e.message || e) }; }
        }
        return { action, now: f.currentPage.name, was: before.name, reverted, fileKey: f.fileKey };
      }

      if (action === 'rename') {
        const p = findPage((arg && arg.from) || '');
        if (!p) return { error: '找不到页面', available: f.root.children.map((x) => x.name) };
        const before = p.name;
        p.name = String((arg && arg.to) || '');
        let reverted = null;
        if (arg && arg.revert !== false) { p.name = before; reverted = p.name; }
        return { action, before, after: p.name, reverted, fileKey: f.fileKey };
      }

      if (action === 'delete') {
        const p = findPage((arg && (arg.page || arg.name || arg.pageId)) || '');
        if (!p) return { error: '找不到页面', available: f.root.children.map((x) => x.name) };
        if (f.root.children.length <= 1) return { error: '这是最后一页，Figma 不允许删除最后一页' };
        if (p === f.currentPage) return { error: '不能删除当前所在页，先 switch 到别的页' };
        if (arg && arg.confirm !== true) return { error: '删页会销毁整页内容且无法自动还原，确认请传 confirm:true', snapshot: { name: p.name, childCount: safe(() => p.children.length) } };
        if (arg && arg.revert !== false) return { error: 'delete 无法自动还原：确认删除请同时传 revert:false' };
        const snapshot = { name: p.name, childCount: safe(() => p.children.length) };
        p.remove();
        return { action, snapshot, pageCount: f.root.children.length, undoHint: 'Ctrl+Z 可撤销', revertAvailable: false, fileKey: f.fileKey };
      }

      return { error: 'action 只支持 create / switch / rename / delete', got: action };
    },

    variables: async () => {
      const f = await waitForFigma();
      if (!f) return NOT_READY;
      if (!f.variables || typeof f.variables.getLocalVariablesAsync !== 'function') {
        return { error: '这个运行时没有暴露 variables API（可能是编辑器版本或权限所致）' };
      }
      try {
        const [vars, cols] = await Promise.all([
          f.variables.getLocalVariablesAsync(),
          typeof f.variables.getLocalVariableCollectionsAsync === 'function' ? f.variables.getLocalVariableCollectionsAsync() : Promise.resolve([])
        ]);
        return {
          collections: cols.map((c) => ({ id: c.id, name: c.name, modes: (c.modes || []).map((m) => m.name) })),
          total: vars.length,
          variables: vars.slice(0, 120).map((v) => ({
            id: v.id, name: v.name, type: v.resolvedType, scopes: (v.scopes || []).slice(0, 6),
            valuesByMode: safe(() => v.valuesByMode)
          })),
          truncated: vars.length > 120,
          fileKey: f.fileKey
        };
      } catch (e) {
        return { error: '读变量被拒：' + String(e && e.message || e) + '（Free plan 对变量集合有限制）' };
      }
    }
  };

  const API = { boot, srcOf, idsWith, requireId, exportByName, store, dispatcher, pluginAPI, armTap, tap,
                describeNode, vfsFor, redact, figmaOrNull, waitForFigma, gateState };

  armTap();

  window.__Figmalink = {
    version: FIGMALINK_BRIDGE_VERSION,
    api: API,
    async run(op, arg) {
      const f = OPS[op];
      if (!f) {
        return { error: 'unknown op: ' + op, bridgeVersion: window.__Figmalink.version,
          available: Object.keys(OPS) };
      }
      try {
        const r = f(arg);
        return r && typeof r.then === 'function' ? await r : r;
      } catch (e) { return { error: String(e && e.message || e) }; }
    }
  };
})();
