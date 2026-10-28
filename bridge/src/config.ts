// All tunables are FIGMALINK_*. There is exactly one name per knob: no legacy alias, no
// precedence puzzle beyond "CLI flag > env > default".
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  port: number;
  /** Operator-supplied token; replaces whatever was generated earlier. */
  tokenOverride: string | null;
  callTimeoutMs: number;
  resultLimitBytes: number;
  maxNodes: number;
  outDir: string;
  importRoot: string;
  ioMaxBytes: number;
  pairingFile: string;
  enableRunCode: boolean;
  enablePageEval: boolean;
}

export class ConfigError extends Error {
  readonly exitCode = 64;

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_PORT = 1210;
export const DEFAULT_STATE_DIR = join(homedir(), '.figmalink');

const FLAG_PORT = ['--port', '-p'] as const;
const FLAG_TOKEN = ['--token', '-t'] as const;

/**
 * Reads a flag in both `--name value` and `--name=value` forms.
 * Returns `undefined` when absent and `null` when present without a value.
 */
export function takeArg(names: readonly string[], argv: readonly string[]): string | null | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    for (const name of names) {
      if (raw === name) return argv[i + 1] === undefined ? null : argv[i + 1];
      if (raw.startsWith(`${name}=`)) return raw.slice(name.length + 1);
    }
  }
  return undefined;
}

export function usage(): string {
  return `用法: figmalink-mcp [选项]

  -p, --port <1-65535>   扩展要连的 ws 端口，默认 ${DEFAULT_PORT}（env: FIGMALINK_PORT）
  -t, --token <串>       配对 token，8-128 个可打印非空白字符；给定时覆盖 pairing 文件
                         并写回（env: FIGMALINK_TOKEN）
  -h, --help             打印本说明

状态目录默认 ${DEFAULT_STATE_DIR}（pairing.json / out/），可用
FIGMALINK_PAIRING_FILE / FIGMALINK_OUT_DIR 覆盖。其余环境变量见 README 的「跑起来」一节。
`;
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} 不合法：${JSON.stringify(raw)}（要正数）`);
  }
  return value;
}

function parsePort(raw: string | null | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`端口不合法：${JSON.stringify(raw)}（要 1-65535 的整数，用 --port 或 FIGMALINK_PORT 指定）`);
  }
  return value;
}

function parseToken(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  // An operator-supplied token is a deliberate choice, not a validation hint: it replaces
  // whatever was generated earlier, so both sides can be pinned from one config line.
  if (!/^[\x21-\x7e]{8,128}$/.test(raw)) {
    throw new ConfigError('token 不合法：要 8-128 个可打印且不含空白的 ASCII 字符（用 --token 或 FIGMALINK_TOKEN 指定）');
  }
  return raw;
}

export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Config {
  const rawPort = takeArg(FLAG_PORT, argv) ?? env.FIGMALINK_PORT ?? String(DEFAULT_PORT);
  const port = parsePort(rawPort);
  const tokenOverride = parseToken(takeArg(FLAG_TOKEN, argv) ?? env.FIGMALINK_TOKEN ?? null);

  return {
    port,
    tokenOverride,
    callTimeoutMs: positiveNumber('FIGMALINK_TIMEOUT_MS', env.FIGMALINK_TIMEOUT_MS, 25000),
    // Results are budgeted in KB for humans and bytes in code.
    resultLimitBytes: positiveNumber('FIGMALINK_RESULT_LIMIT_KB', env.FIGMALINK_RESULT_LIMIT_KB, 40) * 1024,
    maxNodes: positiveNumber('FIGMALINK_MAX_NODES', env.FIGMALINK_MAX_NODES, 120),
    // Runtime state must not live inside the installed package: an npx cache is not
    // writable in every setup, and `dist/` is exactly what gets published.
    outDir: env.FIGMALINK_OUT_DIR || join(DEFAULT_STATE_DIR, 'out'),
    importRoot: resolve(env.FIGMALINK_IMPORT_ROOT || process.cwd()),
    ioMaxBytes: positiveNumber('FIGMALINK_IO_MAX_KB', env.FIGMALINK_IO_MAX_KB, 4096) * 1024,
    pairingFile: env.FIGMALINK_PAIRING_FILE || join(DEFAULT_STATE_DIR, 'pairing.json'),
    enableRunCode: env.FIGMALINK_ENABLE_RUN_CODE === '1',
    enablePageEval: env.FIGMALINK_ENABLE_PAGE_EVAL === '1'
  };
}
