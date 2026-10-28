// Rasterize the source SVG into the PNG sizes a Chrome extension needs.
//
// Each size is rendered natively by headless Chrome rather than downscaled from one
// bitmap, because this design carries thin connector lines that turn to mush when
// shrunk. The page always lays out at 512 CSS px and the *device scale factor*
// carries the target size: Chrome then rasterizes the vectors at that resolution.
// (Rendering with --window-size=<target> directly is broken in headless=new: the
// capture comes back with only the top band painted.)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'icons');
// Once the artwork is in the repo it is its own source of truth; a Downloads copy is
// only the bootstrap.
const BOOTSTRAP = join(homedir(), 'Downloads', 'exported_image.svg');
const SRC = process.argv[2] || (existsSync(BOOTSTRAP) ? BOOTSTRAP : join(OUT, 'icon.svg'));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CANVAS = 512;
const SIZES = [16, 32, 48, 128, 512];
// The full artwork loses its connectors below ~32px, so the smallest size is drawn
// from a hand-simplified sibling instead of a shrink of the master.
const COMPACT = [16];
const COMPACT_FILE = join(OUT, 'icon-compact.svg');

const svg = readFileSync(SRC, 'utf8');
if (!/<svg[\s>]/i.test(svg)) throw new Error('源文件不像 SVG');
const compact = readFileSync(COMPACT_FILE, 'utf8');
writeFileSync(join(OUT, 'icon.svg'), svg);
console.log(`源 SVG 已入库：extension/icons/icon.svg（${Buffer.byteLength(svg)} 字节）`);

const tmp = join(HERE, 'tmp');
mkdirSync(tmp, { recursive: true });
// A private user-data-dir is mandatory: without it Chrome hands the request to the
// already-running browser process and no screenshot is produced.
const profile = join(tmp, 'chrome-profile');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const withSize = (doc, n) => doc.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
  const cleaned = attrs.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
  return `<svg${cleaned} width="${n}" height="${n}">`;
});
const page = (name, doc) => {
  const html = join(tmp, `icon-render-${name}.html`);
  writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${withSize(doc, CANVAS)}</body></html>`);
  return `file:///${html.replace(/\\/g, '/')}`;
};
const urls = { master: page('master', svg), compact: page('compact', compact) };

function shoot(png, dsf, url) {
  const r = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--force-device-scale-factor=${dsf}`, '--default-background-color=00000000',
    `--user-data-dir=${profile}`, `--screenshot=${png}`, `--window-size=${CANVAS},${CANVAS}`,
    url,
  ], { encoding: 'utf8', timeout: 60000 });
  return existsSync(png) && statSync(png).size > 0 ? statSync(png).size : `FAIL ${String(r.stderr || r.stdout).slice(0, 200)}`;
}

for (const size of SIZES) {
  const png = join(OUT, size === 512 ? 'master.png' : `icon${size}.png`);
  rmSync(png, { force: true });
  const kind = COMPACT.includes(size) ? 'compact' : 'master';
  console.log(`${size}px (${kind}) -> ${shoot(png, size / CANVAS, urls[kind])}`);
}

rmSync(profile, { recursive: true, force: true });
