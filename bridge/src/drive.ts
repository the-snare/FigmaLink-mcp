// CLI driver. Talks to whatever bridge is already listening on the port; only spawns
// one when nothing is there — so using this never requires stopping the MCP connector.
//   node dist/drive.js                                   -> figma_status
//   node dist/drive.js figma_read_tree '{"depth":2}'
//   FIGMALINK_BATCH=plan.json node dist/drive.js         -> run every {tool,args} in order
// Env: FIGMALINK_PORT / FIGMALINK_BATCH / FIGMALINK_WAIT_CLIENT_MS.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { PairingStore } from './pairing.js';
import type { ToolArgs } from './tools/types.js';

interface Health {
  clients?: number;
  liveSockets?: number;
  clientBoot?: string | null;
  pendingCalls?: number;
}

interface CallBody {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

const config = loadConfig([], process.env);
const BASE = `http://127.0.0.1:${config.port}`;
const token = new PairingStore(config.pairingFile, null).token;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Printing whole arguments would dump a build spec straight into the transcript.
function summarize(args: ToolArgs | undefined): string {
  const count = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0;
    const record = node as { children?: unknown };
    return 1 + (Array.isArray(record.children) ? record.children.reduce<number>((n, c) => n + count(c), 0) : 0);
  };
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args || {})) {
    if (key === 'spec' && value && typeof value === 'object' && 'kind' in value) {
      const spec = value as { kind?: unknown; props?: { name?: unknown } };
      parts.push(`spec=${String(spec.kind)}:"${String(spec.props?.name ?? '')}" 共 ${count(value)} 节点`);
    } else if (value && typeof value === 'object') {
      parts.push(`${key}={…}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(' ');
}

async function health(): Promise<Health | null> {
  try {
    return (await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })).json()) as Health;
  } catch {
    return null;
  }
}

let child: ChildProcess | null = null;
if (!(await health())) {
  console.log(`${config.port} 上没有 bridge，临时起一个（用完会收掉）`);
  child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url))], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, FIGMALINK_PORT: String(config.port) }
  });
  child.on('exit', (code) => {
    if (code) console.log(`子进程退出 code=${code}`);
  });
  for (let i = 0; i < 20 && !(await health()); i += 1) await sleep(500);
}

async function call(tool: string, args: ToolArgs): Promise<{ status: number; body: CallBody }> {
  const response = await fetch(`${BASE}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-figmalink-token': token },
    body: JSON.stringify({ tool, args: args || {} })
  });
  return { status: response.status, body: (await response.json()) as CallBody };
}

async function run(tool: string, args: ToolArgs, maxPrint?: number): Promise<CallBody> {
  let { status, body } = await call(tool, args);
  // After the server forces a blind instance to yield, the next one needs a couple of
  // seconds to reconnect; without this a whole batch fails on the first bad answer.
  for (let i = 0; i < 3 && body && body.ok === false && /未连接|让位/.test(String(body.error || '')); i += 1) {
    await sleep(3000);
    ({ status, body } = await call(tool, args));
  }
  console.log(`\n${tool} ${summarize(args)} -> HTTP ${status} ok=${String(body.ok)}`);
  console.log(JSON.stringify(body, null, 2).slice(0, maxPrint || 1500));
  return body;
}

const h = await health();
console.log(
  `bridge ${h ? '在线' : '未连上'} · ${JSON.stringify({
    clients: h?.clients,
    liveSockets: h?.liveSockets,
    clientBoot: h?.clientBoot,
    pending: h?.pendingCalls
  })}`
);

// The extension reconnects on a backoff timer (up to 15s), so wait for a client
// instead of firing calls into an empty socket.
const needClient = Number(process.env.FIGMALINK_WAIT_CLIENT_MS || 45000);
let current = h;
for (let waited = 0; waited < needClient; waited += 2000) {
  if (current && (current.clients ?? 0) >= 1) break;
  await sleep(2000);
  current = await health();
}
console.log(
  `等待扩展回连：clients=${current?.clients ?? 0}${
    current && (current.clients ?? 0) >= 1 ? '' : '（超时，仍调用一次取错误原文）'
  }`
);

interface BatchStep {
  tool: string;
  args?: ToolArgs;
  maxPrint?: number;
}

const steps: Array<[string, ToolArgs, number | undefined]> = process.env.FIGMALINK_BATCH
  ? (JSON.parse(readFileSync(process.env.FIGMALINK_BATCH, 'utf8')) as BatchStep[]).map((step) => [
      step.tool,
      step.args ?? {},
      step.maxPrint
    ])
  : [[process.argv[2] || 'figma_status', process.argv[3] ? (JSON.parse(process.argv[3]) as ToolArgs) : {}, undefined]];

for (const [tool, args, maxPrint] of steps) await run(tool, args, maxPrint);

if (child) {
  child.kill();
  console.log('\n已收掉临时起的 bridge');
}
process.exit(0);
