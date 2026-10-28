// Import: bytes go INTO the page, so the file is read here and never handed to the
// model. Only paths under the operator-chosen root are accepted.
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

const IMAGE_EXT: Record<string, string> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  '.gif': 'gif'
};

export type PrepareImage =
  | { ok: true; args: Record<string, unknown>; abs: string; size: number; kind: string }
  | { ok: false; error: string };

export function prepareImageImport(
  args: Record<string, unknown> | null | undefined,
  importRoot: string,
  ioMaxBytes: number
): PrepareImage {
  if (!args || typeof args.path !== 'string' || !args.path.trim()) {
    return { ok: false, error: '需要本机图片的绝对路径 path' };
  }
  const abs = resolve(args.path);
  const rel = relative(importRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `path 必须落在允许根目录内（当前 ${importRoot}），收到 ${abs}` };
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { ok: false, error: `文件不存在：${abs}` };
  }
  if (!st.isFile()) return { ok: false, error: 'path 不是普通文件' };
  if (st.size > ioMaxBytes) {
    return { ok: false, error: `文件 ${st.size} 字节超过上限 ${ioMaxBytes}（FIGMALINK_IO_MAX_KB 可调）` };
  }
  const ext = extname(abs).toLowerCase();
  const kind = IMAGE_EXT[ext];
  if (!kind) {
    return { ok: false, error: `只支持 ${Object.keys(IMAGE_EXT).join(' / ')}，收到 ${ext || '(无扩展名)'}` };
  }
  const rest: Record<string, unknown> = { ...args };
  delete rest.path;
  return {
    ok: true,
    args: { ...rest, base64: readFileSync(abs).toString('base64') },
    abs,
    size: st.size,
    kind
  };
}
