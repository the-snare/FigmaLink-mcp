// One version for the package, the MCP identity and the extension, so they cannot drift.
import { readFileSync } from 'node:fs';

export interface PackageMeta {
  name: string;
  version: string;
  description?: string;
}

// Resolved from the emitted file (dist/) and from src/ alike: both sit one level below
// the package root, so this works under `tsx` and after `tsc`.
function readPackageMeta(): PackageMeta {
  const url = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as PackageMeta;
}

export const meta: PackageMeta = readPackageMeta();

export const PROTOCOL_LATEST = '2025-03-26';
export const PROTOCOL_KNOWN: ReadonlySet<string> = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

// The local control face authenticates with exactly this header.
export const HEADER_TOKEN = 'x-figmalink-token';
