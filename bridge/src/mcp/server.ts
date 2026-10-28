// stdout/stdin -> MCP (newline-delimited JSON-RPC 2.0) for the agent host. Nothing may
// ever be written to stdout except MCP frames.
import type { Logger } from '../log.js';
import { sleep } from '../log.js';
import { PROTOCOL_KNOWN, PROTOCOL_LATEST } from '../meta.js';
import type { RpcRequest } from '../protocol.js';
import type { CallHandler, ToolArgs, ToolDef } from '../tools/types.js';

export interface McpServerOptions {
  tools: readonly ToolDef[];
  call: CallHandler;
  getInflight: () => number;
  serviceName: string;
  version: string;
  log: Logger;
}

export class McpServer {
  private hostSeen = false;
  private stdinBuf = '';

  constructor(private readonly opts: McpServerOptions) {}

  attachStdin(): void {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      this.stdinBuf += chunk;
      let newline: number;
      while ((newline = this.stdinBuf.indexOf('\n')) >= 0) {
        const line = this.stdinBuf.slice(0, newline).trim();
        this.stdinBuf = this.stdinBuf.slice(newline + 1);
        if (!line) continue;
        let msg: RpcRequest;
        try {
          msg = JSON.parse(line) as RpcRequest;
        } catch {
          this.opts.log(`跳过无法解析的 stdio 行：${line.slice(0, 120)}`);
          continue;
        }
        void this.handle(msg).catch((err: unknown) => {
          const detail = err instanceof Error ? err.stack || err.message : String(err);
          this.opts.log(`处理 ${String(msg.method)} 抛错：${detail}`);
          if (msg.id !== undefined) {
            this.replyError(msg.id, -32603, err instanceof Error ? err.message : String(err));
          }
        });
      }
    });

    // A host that hangs up should take the server with it, but a bare CLI launch has no
    // stdin pipe to hold open — it must stay up as a ws endpoint.
    process.stdin.on('end', () => {
      void this.onStdinEnd();
    });
  }

  private async onStdinEnd(): Promise<void> {
    if (!this.hostSeen) {
      this.opts.log('stdio 未接入宿主（独立启动），继续提供 ws 服务');
      return;
    }
    // A call can still be in flight (proxy mode is an HTTP round trip to the incumbent);
    // exiting on the same tick would drop its answer.
    for (let i = 0; i < 50 && this.opts.getInflight() > 0; i += 1) await sleep(100);
    this.opts.log('宿主已关闭 stdio，服务端退出');
    process.exit(0);
  }

  private reply(id: unknown, result: unknown): void {
    this.hostSeen = true;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private replyError(id: unknown, code: number, message: string): void {
    this.hostSeen = true;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  private async handle(msg: RpcRequest): Promise<void> {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;

    if (method === 'initialize') {
      const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined;
      this.reply(id, {
        protocolVersion: asked && PROTOCOL_KNOWN.has(asked) ? asked : PROTOCOL_LATEST,
        capabilities: { tools: {} },
        serverInfo: { name: this.opts.serviceName, version: this.opts.version }
      });
      return;
    }
    if (method === 'ping') {
      this.reply(id, {});
      return;
    }
    if (!isRequest && (method === 'notifications/initialized' || method === 'notifications/cancelled')) return;

    if (method === 'tools/list') {
      this.reply(id, {
        tools: this.opts.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            readOnlyHint: !!tool.readOnly,
            destructiveHint: tool.kind === 'write' || tool.kind === 'import'
          }
        }))
      });
      return;
    }

    if (method === 'tools/call') {
      const name = typeof params?.name === 'string' ? params.name : undefined;
      // Unknown tool stays a protocol-level -32602 rather than a tool error.
      if (!this.opts.tools.some((tool) => tool.name === name)) {
        this.replyError(id, -32602, `未知工具 ${String(name)}`);
        return;
      }
      const args = (params?.arguments as ToolArgs | undefined) || {};
      const { payload, isError } = await this.opts.call(name as string, args);
      this.reply(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError });
      return;
    }

    if (isRequest) this.replyError(id, -32601, `未实现的方法 ${String(method)}`);
  }
}
