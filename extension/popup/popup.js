// Popup is a thin client: every op is routed to the service worker, which owns
// chrome.debugger. Two contexts attaching the same tab would fight over the single
// per-tab debugger slot, so the popup must not call chrome.debugger itself.
import { DEFAULT_WS_URL, EXECUTOR_REVISION } from '../lib/const.js';
import { applyI18n, detectLang, getLang, setLang, t } from '../lib/i18n.js';

const manifest = chrome.runtime.getManifest();

const link = document.getElementById('link');
const statusToggle = document.getElementById('statusToggle');
const langBtn = document.getElementById('lang');
const targetLabel = document.getElementById('target');
const verLabel = document.getElementById('ver');

// The header badge is a key, not a string, so switching language can repaint it
// without asking the SW again.
let targetState = { key: 'target.notConnected', cls: 'muted' };
let paneEmpty = true;
// The pane holds rendered text, not a live template, so remember which language it
// was rendered in; opening a stale pane is exactly how a half-translated UI appears.
let renderedLang = null;

function renderTarget(key, cls) {
  targetState = { key, cls };
  targetLabel.textContent = t(key);
  targetLabel.className = cls;
}

function renderVersion() {
  verLabel.textContent = t('version_line', { version: manifest.version, rev: EXECUTOR_REVISION });
}

// The "switch to this language" label stays untranslated on purpose.
function renderLangButton() {
  langBtn.textContent = getLang() === 'zh-CN' ? 'EN' : '中文';
}

function setStatusOpen(open) {
  link.hidden = !open;
  statusToggle.setAttribute('aria-expanded', String(open));
}

// The pane starts collapsed. Anything the user asked for explicitly, and every
// failure, opens it — a silently folded error is the same as no error at all.
function showLink(data, expand = false) {
  link.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  paneEmpty = false;
  renderedLang = getLang();
  if (expand) setStatusOpen(true);
}

function applyLanguage() {
  applyI18n(document);
  renderVersion();
  renderTarget(targetState.key, targetState.cls);
  renderLangButton();
  if (paneEmpty) link.textContent = t('pane.empty');
}

// Tooltips: one fixed-position element, driven by [data-tip]. See popup.css for why
// this is not a ::after pseudo-element.
const tooltip = document.getElementById('tooltip');
const tipTarget = (node) => (node && node.closest ? node.closest('[data-tip]') : null);

function showTooltip(el) {
  const text = el.dataset.tip;
  if (!text) return;
  tooltip.textContent = text;
  tooltip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  // Clamp horizontally so a tooltip on the rightmost control stays readable, and flip
  // above the target when there is no room below it.
  const left = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - w - 4));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - h - 6);
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hideTooltip() { tooltip.hidden = true; }

document.addEventListener('pointerover', (e) => { const el = tipTarget(e.target); if (el) showTooltip(el); });
document.addEventListener('pointerout', (e) => { if (tipTarget(e.target)) hideTooltip(); });
document.addEventListener('focusin', (e) => { const el = tipTarget(e.target); if (el) showTooltip(el); });
document.addEventListener('focusout', hideTooltip);
document.addEventListener('scroll', hideTooltip, true);

// Errors used to be swallowed into an empty pane; fold them into the one pane we have.
addEventListener('error', (e) => showLink({ [t('error.uncaught')]: e.message, at: `${e.filename}:${e.lineno}:${e.colno}` }, true));
addEventListener('unhandledrejection', (e) => showLink({ [t('error.unhandled')]: String((e.reason && e.reason.message) || e.reason) }, true));

// The popup has no way to open chrome://extensions for you, so it reports the
// three things that separate "service worker never registered" from "worker alive
// but its handler forgot to answer".
async function selfProbe() {
  const probe = {};
  // Unpacked extensions serve files from disk immediately, but the manifest (and
  // therefore whether a service worker exists at all) only updates on reload. A
  // version mismatch here means "you edited files, Chrome is still running the old
  // registration" — which shows up as the SW never answering.
  probe.extensionId = chrome.runtime.id;
  probe.registeredManifest = {
    name: manifest.name,
    version: manifest.version,
    hasBackground: !!manifest.background,
    permissions: manifest.permissions
  };
  probe.diskExecutorRevision = EXECUTOR_REVISION;
  if (manifest.version !== EXECUTOR_REVISION) {
    probe.verdict = t('probe.verdict', { name: manifest.name, version: manifest.version, disk: EXECUTOR_REVISION });
  }
  try {
    const r = await fetch(chrome.runtime.getURL('background/sw.js'));
    probe.swFile = `HTTP ${r.status}`;
  } catch (e) { probe.swFile = t('probe.swFile.unreadable', { msg: e.message }); }
  // Chrome renamed/kept this enum as BACKGROUND; SERVICE_WORKER throws the whole
  // getContexts call on builds that do not know it, so try and degrade.
  probe.activeContexts = await (async () => {
    if (typeof chrome.runtime.getContexts !== 'function') return t('probe.contexts.unavailable');
    for (const types of [['BACKGROUND', 'OFFSCREEN_DOCUMENT'], ['OFFSCREEN_DOCUMENT']]) {
      try {
        const ctx = await chrome.runtime.getContexts({ contextTypes: types });
        return ctx.length ? ctx.map((c) => c.contextType) : t('probe.contexts.none');
      } catch (e) {
        probe.contextEnumerationAttempts = (probe.contextEnumerationAttempts || '')
          + t('probe.contexts.rejected', { types: types.join('+'), msg: String((e && e.message) || e).slice(0, 90) });
      }
    }
    return t('probe.contexts.failed');
  })();
  // Discriminate "no such tab" from "we lost the right to see its URL": without host
  // permission, tabs.query({url}) silently matches nothing even though the tab exists.
  probe.sitePermission = await (async () => {
    try { return await chrome.permissions.contains({ origins: ['https://www.figma.com/*'] }); }
    catch (e) { return t('probe.permission.failed', { msg: String((e && e.message) || e) }); }
  })();
  try {
    const all = await chrome.tabs.query({});
    probe.tabVisibility = {
      allTabs: all.length,
      urlVisible: all.filter((t2) => !!t2.url).length,
      figmaMatches: (await chrome.tabs.query({ url: 'https://www.figma.com/*' })).length,
      currentWindow: (await chrome.tabs.query({ currentWindow: true })).length
    };
  } catch (e) { probe.tabVisibility = t('probe.tabs.failed', { msg: String((e && e.message) || e) }); }
  return probe;
}

async function sendMessageSafe(msg) {
  try {
    const value = await chrome.runtime.sendMessage(msg);
    const last = chrome.runtime.lastError;
    if (last) return { answered: false, error: last.message };
    if (value === undefined) return { answered: false, error: 'sendMessage returned nothing: the SW onMessage never called sendResponse' };
    return { answered: true, value };
  } catch (e) {
    return { answered: false, error: String((e && e.message) || e) };
  }
}

function hintFor(text) {
  if (/Receiving end does not exist|no receiving end/i.test(text)) return t('hint.receivingEnd');
  if (/message port closed/i.test(text)) return t('hint.portClosed');
  if (/sendMessage returned nothing/.test(text)) return t('hint.noResponse');
  return '';
}

async function status(expand = false) {
  const sent = await sendMessageSafe({ type: 'status' });
  // The self-check must never be the reason the real status goes missing.
  const probe = await selfProbe().catch((e) => ({ selfCheckItselfFailed: String((e && e.message) || e) }));
  if (!sent.answered || !sent.value || !sent.value.ok) {
    const reason = sent.error || (sent.value && sent.value.error) || t('common.unknown');
    showLink({
      verdict: sent.error ? t('verdict.swNoAnswer') : t('verdict.swFailure'),
      reason,
      stack: (sent.value && sent.value.stack) || undefined,
      hint: hintFor(reason),
      selfCheck: probe
    }, true);
    renderTarget('target.swError', 'bad');
    return null;
  }
  const s = sent.value;
  const ws = s.ws;
  // The SW answers with the revision it actually loaded, so a mismatch against the
  // file on disk means the worker is still running pre-reload code.
  const staleSw = s.revision !== EXECUTOR_REVISION;
  showLink({
    swLoadedRevision: staleSw ? t('status.staleRev', { rev: s.revision, disk: EXECUTOR_REVISION }) : s.revision,
    ws: ws ? {
      url: ws.url,
      hasToken: ws.hasToken,
      connecting: ws.open,
      swPort: ws.swPort,
      offscreenRevision: !ws.revision ? t('status.offscreenRev.missing')
        : ws.revision === EXECUTOR_REVISION ? ws.revision
        : t('status.offscreenRev.stale', { rev: ws.revision }),
      lastError: ws.lastError || t('common.none')
    } : t('status.ws.none'),
    offscreen: s.offscreen,
    storedPairing: s.stored,
    attachedTabs: s.attached,
    candidateTabs: s.tabs,
    selfCheck: probe
  }, expand);
  renderTarget(ws && ws.open ? 'target.linkUp' : 'target.linkDown', ws && ws.open ? 'ok' : 'bad');
  return s;
}

(async () => {
  const stored = await chrome.storage.local.get(['wsUrl', 'token', 'uiLang']);
  setLang(stored.uiLang || detectLang());
  applyLanguage();
  document.getElementById('wsUrl').value = stored.wsUrl || DEFAULT_WS_URL;
  document.getElementById('token').value = stored.token || '';
  await status().catch(() => { /* first paint failure is not worth a red pane */ });
})();

langBtn.addEventListener('click', async () => {
  const next = getLang() === 'zh-CN' ? 'en' : 'zh-CN';
  setLang(next);
  await chrome.storage.local.set({ uiLang: next }).catch(() => {});
  applyLanguage();
  // The pane holds an already-rendered snapshot, so it would keep the old language.
  if (!link.hidden) status(true).catch(() => {});
});

document.getElementById('refreshStatus').addEventListener('click', () => status(true).catch((e) => showLink(String(e.message || e), true)));

statusToggle.addEventListener('click', () => {
  const opening = link.hidden;
  setStatusOpen(opening);
  if (opening && !paneEmpty && renderedLang !== getLang()) status(true).catch(() => {});
});

document.getElementById('savePair').addEventListener('click', async () => {
  const url = document.getElementById('wsUrl').value.trim() || DEFAULT_WS_URL;
  const token = document.getElementById('token').value.trim();
  const saved = await sendMessageSafe({ type: 'savePairing', url, token });
  if (!saved.answered) {
    showLink({ verdict: t('verdict.saveFailed'), reason: saved.error, hint: hintFor(saved.error) }, true);
    return;
  }
  showLink(t('saved.ok', { notified: saved.value.notified ? t('saved.notified.yes') : t('saved.notified.no') }), true);
  setTimeout(() => status(true).catch(() => {}), 1500);
});

// The worker also does this by itself on every heartbeat; the button exists for the
// first reload after a code change, where the running worker predates the check.
document.getElementById('reloadExt').addEventListener('click', async () => {
  const r = await sendMessageSafe({ type: 'reloadSelf' });
  showLink({
    verdict: r.answered
      ? (r.value.reloaded ? t('reload.reloading') : (r.value.note || t('reload.notReloaded')))
      : `${t('verdict.swNoAnswer')}: ${r.error}`,
    inMemoryVersion: manifest.version,
    diskVersion: r.answered ? r.value.disk : undefined,
    details: r.answered ? r.value : undefined,
    hint: r.answered && r.value.disk && r.value.disk !== manifest.version ? t('reload.hint') : undefined
  }, true);
});

document.getElementById('release').addEventListener('click', async () => {
  const r = await sendMessageSafe({ type: 'release' });
  showLink(r.answered
    ? t('release.ok', { json: JSON.stringify(r.value) })
    : t('release.failed', { err: r.error, hint: hintFor(r.error) }), true);
});
