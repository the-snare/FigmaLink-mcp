// Export bytes come OUT of the page and are written here, so the base64 never travels
// on to the model. The page op reports {bytes, format, mediaType} for a sanity check.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ExportPayload {
  base64?: unknown;
  bytes?: unknown;
  nodeId?: unknown;
  name?: unknown;
  format?: unknown;
  mediaType?: unknown;
  [key: string]: unknown;
}

export interface SaveInfo {
  savedTo: string;
  bytes: number;
  mediaType: unknown;
  format: unknown;
}

export type SaveOutcome = { ok: true; result: Record<string, unknown>; io: SaveInfo } | { ok: false; error: string };

export function saveExport(res: ExportPayload | null, outDir: string): SaveOutcome {
  if (!res || typeof res.base64 !== 'string') {
    return { ok: false, error: '页内没有回 base64：' + JSON.stringify(res).slice(0, 400) };
  }
  const buf = Buffer.from(res.base64, 'base64');
  if (buf.length !== res.bytes) {
    return { ok: false, error: `字节数对不上：解码得到 ${buf.length}，页内说 ${String(res.bytes)}` };
  }
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = String(res.nodeId || 'node')
    .replace(/[^0-9A-Za-z-]/g, '-')
    .slice(0, 24);
  const label = String(res.name || '')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 32);
  const ext = String(res.format).toLowerCase();
  const savedTo = join(outDir, `${id}${label ? '-' + label : ''}-${stamp}.${ext}`);
  writeFileSync(savedTo, buf);

  const rest: Record<string, unknown> = { ...res };
  delete rest.base64;
  return { ok: true, result: rest, io: { savedTo, bytes: buf.length, mediaType: res.mediaType, format: res.format } };
}
