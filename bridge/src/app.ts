// Wiring only: this module decides which piece talks to which, and nothing else.
import type { Config } from './config.js';
import { SwitchableDispatcher } from './control/dispatcher.js';
import { ExtensionHub } from './control/hub.js';
import { HttpFace } from './control/http-face.js';
import { LocalCall } from './control/local-call.js';
import { log } from './log.js';
import { McpServer } from './mcp/server.js';
import { meta } from './meta.js';
import { PairingStore } from './pairing.js';
import { buildTools, findToolByName } from './tools/registry.js';
import type { CallHandler } from './tools/types.js';

export interface BridgeApp {
  readonly pairing: PairingStore;
  readonly port: number;
  start(): void;
  stop(): Promise<void>;
}

export function createBridge(config: Config): BridgeApp {
  const pairing = new PairingStore(config.pairingFile, config.tokenOverride);
  const tools = buildTools();
  const hub = new ExtensionHub({ pairing, port: config.port, log });

  const health = (): Record<string, unknown> => ({
    ok: true,
    role: meta.name,
    ...hub.snapshot(),
    pinnedOrigin: pairing.pinnedOrigin || null,
    uptimeSec: Math.round(process.uptime())
  });

  const httpFace = new HttpFace({
    port: config.port,
    serviceName: meta.name,
    pairing,
    health,
    log
  });
  httpFace.attachHub(hub);

  const local = new LocalCall({ config, pairing, hub, tools, log });
  const dispatcher = new SwitchableDispatcher({
    local,
    http: httpFace,
    pairing,
    log,
    timeoutFor: (toolName) => findToolByName(tools, toolName)?.timeoutMs || config.callTimeoutMs
  });

  // A front end may hand a call over right before the host closes stdin; counting them is
  // what lets the shutdown wait instead of dropping the answer.
  let inflight = 0;
  const call: CallHandler = async (name, args) => {
    inflight += 1;
    try {
      return await dispatcher.call(name, args);
    } finally {
      inflight -= 1;
    }
  };
  httpFace.setCallHandler(call);

  const mcp = new McpServer({
    tools,
    call,
    getInflight: () => inflight,
    serviceName: meta.name,
    version: meta.version,
    log
  });
  mcp.attachStdin();

  return {
    pairing,
    port: config.port,
    start(): void {
      httpFace.listen();
      log(`MCP(stdio) 已就绪 · ws://127.0.0.1:${config.port} · 工具 ${tools.length} 个`);
      log(
        `结果预算 ${Math.round(config.resultLimitBytes / 1024)}KB / ${config.maxNodes} 节点，落盘目录 ${config.outDir}`
      );
      log(`图片导入根目录 ${config.importRoot} · 单次上限 ${Math.round(config.ioMaxBytes / 1024)}KB`);
      log(
        `配对 token：${pairing.token}（存在 ${pairing.file}，重启不变；扩展 popup 里粘一次${
          config.tokenOverride !== null ? '；本次由启动参数指定' : ''
        }）`
      );
      log(`已钉住的扩展来源：${pairing.pinnedOrigin || '(尚未配对)'}`);
    },
    stop: () => httpFace.close()
  };
}
