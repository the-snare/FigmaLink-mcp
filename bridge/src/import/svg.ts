// SVG is text, not bytes: it goes to the page as markup so Figma can build real vector
// layers. Same containment rule as images (only paths under the import root).
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

export const SVG_MAX_BYTES = 2 * 1024 * 1024;

export type PrepareSvg =
  | { ok: true; args: Record<string, unknown>; abs?: string; bytes: number; inline: boolean }
  | { ok: false; error: string };

// SVG arrives either inline (the agent already has the markup) or as a path. Only the
// path form needs the containment check; both end up as args.svg so the page op stays
// one code path.
export function prepareSvgImport(
  args: Record<string, unknown> | null | undefined,
  importRoot: string
): PrepareSvg {
  const input = args ?? {};
  const inline = typeof input.svg === 'string' ? input.svg.trim() : '';
  if (inline) {
    const bytes = Buffer.byteLength(inline);
    if (bytes > SVG_MAX_BYTES) return { ok: false, error: `SVG 文本 ${bytes} 字节超过上限 ${SVG_MAX_BYTES}` };
    return { ok: true, args: { ...input, svg: inline }, bytes, inline: true };
  }
  if (typeof input.path !== 'string' || !input.path.trim()) {
    return { ok: false, error: '需要 svg 文本或本机 .svg 文件路径 path' };
  }
  const abs = resolve(input.path);
  const rel = relative(importRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `path 必须落在允许根目录内（当前 ${importRoot}），收到 ${abs}` };
  }
  if (extname(abs).toLowerCase() !== '.svg') {
    return { ok: false, error: `只接受 .svg 文件，收到 ${extname(abs) || '(无扩展名)'}` };
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, error: `文件不存在：${abs}` };
  }
  if (!st.isFile()) return { ok: false, error: 'path 不是普通文件' };
  if (st.size > SVG_MAX_BYTES) return { ok: false, error: `文件 ${st.size} 字节超过上限 ${SVG_MAX_BYTES}` };
  const rest: Record<string, unknown> = { ...input };
  delete rest.path;
  return { ok: true, args: { ...rest, svg: readFileSync(abs, 'utf8') }, abs, bytes: st.size, inline: false };
}
