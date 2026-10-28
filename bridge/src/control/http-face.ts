// The loopback control face. Two jobs on one port:
//   GET  /health  -> "can the browser reach this port at all" (a configured proxy can
//                    break the ws handshake while plain HTTP still works)
//   POST /call    -> the same tool implementation the MCP face uses, gated by the pairing
//                    token, so a driver never has to stop the connector to talk to it.
// It also owns the leader/proxy role switch: not exiting on EADDRINUSE is what makes
// "register this as an MCP connector" safe.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import type { Logger } from '../log.js';
import { HEADER_TOKEN } from '../meta.js';
import type { PairingStore } from '../pairing.js';
import type { CallHandler } from '../tools/types.js';
import type { ExtensionHub } from './hub.js';

export type Role = 'leader' | 'proxy';

export interface OwnerHealth {
  role?: string;
  uptimeSec?: number;
  clients?: number;
  clientKey?: string | null;
}

export interface HttpFaceOptions {
  port: number;
  serviceName: string;
  pairing: PairingStore;
  health: () => Record<string, unknown>;
  log: Logger;
}

export class HttpFace {
  readonly server: Server;
  readonly wss: WebSocketServer;
  private role: Role = 'leader';
  private proxyBase: string | null = null;
  private callHandler: CallHandler | null = null;

  constructor(private readonly opts: HttpFaceOptions) {
    this.server = createServer((req, res) => this.route(req, res));
    // ws stores an auto-created server on a symbol, so the http.Server is explicit here.
    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: 8 * 1024 * 1024,
      handleProtocols: () => false
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        if (this.role === 'proxy') return;
        void this.becomeProxy(`端口 ${this.opts.port} 已被占用`);
        return;
      }
      this.opts.log(`http 服务端错误：${err.message}`);
    });
    // EADDRINUSE is already handled above by the role switch; logging it twice reads like
    // a second, unrelated failure.
    this.wss.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') this.opts.log(`ws 服务端错误：${err.message}`);
    });
  }

  get isProxy(): boolean {
    return this.role === 'proxy';
  }

  get currentRole(): Role {
    return this.role;
  }

  get ownerBase(): string | null {
    return this.proxyBase;
  }

  get port(): number {
    return this.opts.port;
  }

  attachHub(hub: ExtensionHub): void {
    hub.attach(this.wss);
  }

  setCallHandler(handler: CallHandler): void {
    this.callHandler = handler;
  }

  listen(): void {
    this.server.listen(this.opts.port, '127.0.0.1');
  }

  address(): AddressInfo | null {
    const address = this.server.address();
    return address && typeof address === 'object' ? address : null;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async ownerHealth(base: string): Promise<OwnerHealth | null> {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      return (await response.json()) as OwnerHealth;
    } catch {
      return null;
    }
  }

  async becomeProxy(reason: string): Promise<void> {
    this.role = 'proxy';
    this.proxyBase = `http://127.0.0.1:${this.opts.port}`;
    this.opts.log(`${reason}：本进程转为 MCP 代理，tools/call 转发给已在跑的实例`);
    const health = await this.ownerHealth(this.proxyBase);
    if (health && health.role === this.opts.serviceName) {
      this.opts.log(
        `占用者是同一个 bridge · uptime=${String(health.uptimeSec)}s · clients=${String(health.clients)} · 扩展=${health.clientKey || '(无)'}`
      );
    } else if (health) {
      this.opts.log(
        `警告：${this.opts.port} 上的服务不是 ${this.opts.serviceName}（role=${String(health.role)}），调用可能会被它误解`
      );
    } else {
      this.opts.log('/health 暂时不通，占用者可能正在启动；后续调用失败时会再尝试接管');
    }
  }

  /**
   * Takeover on demand: with nothing listening, the only moment taking over matters is a
   * pending call. Same effect as an election loop, without a timer that would keep an
   * otherwise idle MCP process awake.
   */
  async tryTakeover(reason: string): Promise<boolean> {
    if (this.role !== 'proxy' || !this.proxyBase) return false;
    if (await this.ownerHealth(this.proxyBase)) return false;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          this.server.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          this.server.off('error', onError);
          resolve();
        };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen(this.opts.port, '127.0.0.1');
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`接管 ${this.opts.port} 失败（${message}），继续代理`);
      return false;
    }

    const old = this.proxyBase;
    this.proxyBase = null;
    this.role = 'leader';
    this.opts.log(`原实例 ${old} 已不可达（${reason}），本进程接管 ${this.opts.port} 转为在线服务端，等扩展重连`);
    return true;
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '';
    if (url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(this.opts.health()));
      return;
    }
    if (url === '/call' && req.method === 'POST') {
      void this.postCall(req, res);
      return;
    }
    res.writeHead(404).end();
  }

  // HTTP face for the same tool calls, so a driver can use the already-running server
  // instead of spawning a second one that would fight it for the port. Gated by the
  // pairing token: an unauthenticated loopback endpoint would let any web page trigger
  // writes into the signed-in Figma session.
  private async postCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj, null, 2));
    };

    // Browsers attach Origin to every POST; a local driver (Node fetch, curl) sends none.
    // Together with the peer-address check this means an arbitrary web page cannot reach
    // the control face even if it somehow learns the token.
    if (req.headers.origin !== undefined) {
      json(403, { ok: false, error: '带 Origin 的请求被拒：/call 只接受本机进程直连' });
      return;
    }
    const peer = req.socket.remoteAddress || '';
    if (!/^(127\.|::1$|::ffff:127\.)/.test(peer)) {
      json(403, { ok: false, error: `只接受回环地址，收到 ${peer}` });
      return;
    }
    const presented = req.headers[HEADER_TOKEN];
    if (presented !== this.opts.pairing.token) {
      json(401, { ok: false, error: `缺少或错误的 ${HEADER_TOKEN}` });
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > 12 * 1024 * 1024) {
        json(413, { ok: false, error: 'body 超过 12MB' });
        req.destroy();
      }
    });
    req.on('end', () => {
      void (async () => {
        let parsed: { tool?: string; args?: Record<string, unknown> };
        try {
          parsed = JSON.parse(body || '{}') as { tool?: string; args?: Record<string, unknown> };
        } catch {
          json(400, { ok: false, error: 'body 不是 JSON' });
          return;
        }
        if (!parsed.tool) {
          json(400, { ok: false, error: '需要 {tool, args}' });
          return;
        }
        if (!this.callHandler) {
          json(503, { ok: false, error: 'bridge 尚未完成启动' });
          return;
        }
        const { payload } = await this.callHandler(parsed.tool, parsed.args || {});
        json(200, payload);
      })().catch((err: unknown) => {
        json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    });
  }
}
