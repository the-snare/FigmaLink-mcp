// The extension is the only side that can reach a Figma tab (chrome.debugger), and it is
// not an MCP client: it answers {id, op, arg} with {id, ok, ...}. This hub owns the pair
// of roles that has to be decided here — which socket is *the* client, and which calls
// are still in flight on it.
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';

import WebSocket, { WebSocketServer } from 'ws';

import type { Logger } from '../log.js';
import { pairingGuide, type PairingStore } from '../pairing.js';
import type {
  ExtensionOutcome,
  TargetSelection,
  WsEventMessage,
  WsHelloMessage,
  WsInbound,
  WsResultMessage
} from '../protocol.js';

interface TrackedSocket extends WebSocket {
  lastSeen?: number;
}

interface PendingCall {
  socket: WebSocket;
  settle: (msg: WsResultMessage) => void;
}

export interface ClientInfo {
  origin: string;
  version?: string;
  bridgeVersion?: string;
  bootId: string | null;
  key: string;
  at: number;
}

// "0 clients" is ambiguous: either nothing was ever connected (retrying just wastes the
// agent's time) or the extension is mid-reconnect (retrying is exactly right). A client
// seen in the last minute means the second case.
export const RECONNECT_GRACE_MS = 60000;

const NO_TARGET = /没有打开的 figma.com 标签页|非编辑器页面/;
const STALE_AFTER_MS = 60000;

function nextId(): string {
  return randomUUID().slice(0, 8);
}

// Instances that just proved they cannot see a usable Figma tab. Keyed so a second
// profile's copy cannot win the slot back on every reconnect. Older client builds do
// not send a bootId at all, so fall back to their reported version — without this the
// marking path silently never fires for exactly the instances that need it.
function clientKey(msg: Pick<WsHelloMessage, 'bootId' | 'version'>): string {
  return msg.bootId || (msg.version ? `v:${msg.version}` : 'anon');
}

// Comparing builds matters because the same unpacked extension can be loaded by two
// Chrome profiles: one profile keeps a stale worker alive forever and would otherwise
// hold the slot against a freshly reloaded one, which is exactly the build the agent
// needs to talk to.
export function cmpVersion(a: string | undefined | null, b: string | undefined | null): number {
  const parse = (v: string | undefined | null): number[] =>
    String(v ?? '')
      .replace(/^v:/, '')
      .split(/[.\-+]/)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export class ExtensionHub {
  private readonly sockets = new Set<WebSocket>();
  private readonly pending = new Map<string, PendingCall>();
  private client: WebSocket | null = null;
  private clientInfo: ClientInfo | null = null;
  private lastClientAt = 0;
  private readonly incapable = new Set<string>();

  constructor(
    private readonly opts: {
      pairing: PairingStore;
      port: number;
      log: Logger;
    }
  ) {}

  attach(wss: WebSocketServer): void {
    wss.on('connection', (socket, req) => this.onConnection(socket as TrackedSocket, req));
  }

  get connected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  get lastClientAtMs(): number {
    return this.lastClientAt;
  }

  get info(): Readonly<ClientInfo> | null {
    return this.clientInfo;
  }

  snapshot(): Record<string, unknown> {
    return {
      clients: this.client ? 1 : 0,
      liveSockets: this.sockets.size,
      clientOrigin: this.clientInfo?.origin ?? null,
      clientBoot: this.clientInfo?.bootId ?? null,
      clientKey: this.clientInfo?.key ?? null,
      pendingCalls: this.pending.size,
      blindInstances: this.incapable.size
    };
  }

  async send(
    op: string,
    arg: unknown,
    timeoutMs: number,
    target: TargetSelection
  ): Promise<ExtensionOutcome> {
    const client = this.client;
    if (!client || client.readyState !== WebSocket.OPEN) {
      return {
        ok: false,
        error: '扩展未连接：ws 服务端当前 0 个客户端。检查 Chrome 是否开着、扩展是否已配对、offscreen 是否在重连。',
        pairing: pairingGuide(
          this.opts.pairing,
          this.opts.port,
          '把 url 和 token 交给用户填进扩展 popup，然后重试同一个工具'
        )
      };
    }

    const id = nextId();
    const sentOn = client;
    return new Promise<ExtensionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: `扩展 ${timeoutMs}ms 未回包（op=${op}）。可能是页面内求值卡住、标签页被别的调试器占用，或文件不可编辑。`
        });
      }, timeoutMs);

      this.pending.set(id, {
        socket: sentOn,
        settle: (msg) => {
          clearTimeout(timer);
          this.pending.delete(id);
          const out: ExtensionOutcome = {
            ok: msg.ok !== false,
            result: msg.result,
            error: msg.error,
            target: msg.target
          };
          // The same extension id can be loaded in two Chrome profiles, and only one of
          // them has the Figma tab. "Prefer the incumbent" made that deadlock permanent, so
          // an instance that cannot see a target yields the slot instead of keeping it.
          if (!out.ok && NO_TARGET.test(out.error || '')) {
            // Mark it, but do NOT hang up: dropping it here just makes it reconnect in a loop
            // and leaves the caller with nothing to talk to. A newcomer wins the slot anyway
            // because `incapable` makes it take over.
            const key = this.clientInfo?.key;
            if (key) this.incapable.add(key);
            this.opts.log(`这个实例看不到可用的 Figma 标签页（${String(key)}），已标记`);
            out.error += `；已让该实例让位${key ? `（${key} 已标记）` : ''}，另一个实例连上来会立刻接管`;
          } else if (out.ok && out.target && this.clientInfo?.key) {
            this.incapable.delete(this.clientInfo.key);
          }
          resolve(out);
        }
      });

      sentOn.send(
        JSON.stringify({
          type: 'call',
          id,
          op,
          arg: arg ?? null,
          timeoutMs,
          tabId: target.tabId,
          fileKey: target.fileKey,
          strict: target.strict
        })
      );
    });
  }

  private onConnection(socket: TrackedSocket, req: IncomingMessage): void {
    const origin = req.headers.origin || '(none)';
    let alive = false;
    socket.lastSeen = Date.now();
    this.sockets.add(socket);

    socket.on('message', (raw) => {
      socket.lastSeen = Date.now();
      let msg: WsInbound;
      try {
        msg = JSON.parse(raw.toString()) as WsInbound;
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        const hello = msg as WsHelloMessage;
        if (hello.token !== this.opts.pairing.token) {
          this.opts.log(`配对失败，来源 ${origin}（token 不匹配）`);
          socket.close(4001, 'bad token');
          return;
        }
        // First paired origin is pinned; a second extension id with the same token
        // would otherwise inherit access silently.
        if (!this.opts.pairing.pinnedOrigin) {
          this.opts.pairing.pin(origin);
          this.opts.log(`已钉住扩展来源 ${origin}`);
        } else if (this.opts.pairing.pinnedOrigin !== origin) {
          this.opts.log(`拒绝 ${origin}：已配对的是 ${this.opts.pairing.pinnedOrigin}`);
          socket.close(4003, 'origin not pinned');
          return;
        }

        // Two sockets from one origin used to fight: each new hello closed the previous
        // one, whose client immediately reconnected and closed the other, killing whatever
        // call was in flight. Prefer a healthy incumbent; only take over a silent one.
        const incumbentSocket = this.client;
        if (incumbentSocket && incumbentSocket !== socket && incumbentSocket.readyState === WebSocket.OPEN) {
          const idle = Date.now() - ((incumbentSocket as TrackedSocket).lastSeen || 0);
          const incumbent = this.clientInfo ? this.clientInfo.key : null;
          const newcomerKey = clientKey(hello);
          const newcomerBlind = this.incapable.has(newcomerKey);
          const incumbentBlind = incumbent ? this.incapable.has(incumbent) : false;
          const incumbentVersion = this.clientInfo
            ? this.clientInfo.bridgeVersion || this.clientInfo.version
            : null;
          const newcomerVersion = hello.bridgeVersion || hello.version;
          const newer =
            !newcomerBlind &&
            !!incumbentVersion &&
            !!newcomerVersion &&
            cmpVersion(newcomerVersion, incumbentVersion) > 0;

          if (idle < STALE_AFTER_MS && !incumbentBlind && !newer) {
            this.opts.log(
              `${origin} 的重复连接被拒绝（新 ${newcomerKey}${newcomerBlind ? ' · 已知看不到标签页' : ''}，在任 ${incumbent || 'none'}，${idle}ms 前还在活动）`
            );
            socket.close(4009, 'already connected');
            return;
          }
          if (newer && !incumbentBlind && idle < STALE_AFTER_MS) {
            this.opts.log(
              `${origin} 接管：新实例 ${newcomerVersion}（${newcomerKey}）比在任 ${String(incumbentVersion)}（${incumbent || 'none'}）新，旧构建让位`
            );
          } else {
            this.opts.log(
              `${origin} 接管：在任 ${incumbent || 'none'} ${
                idle < STALE_AFTER_MS ? '已被标记看不到标签页' : `已静默 ${Math.round(idle / 1000)}s`
              }`
            );
          }
          try {
            incumbentSocket.close(4002, 'stale');
          } catch {
            // Already gone.
          }
        }

        this.client = socket;
        this.lastClientAt = Date.now();
        this.clientInfo = {
          origin,
          version: hello.version,
          bridgeVersion: hello.bridgeVersion,
          bootId: hello.bootId || null,
          key: clientKey(hello),
          at: Date.now()
        };
        alive = true;
        this.opts.log(`扩展已配对 ${origin} v${String(hello.version)} boot=${hello.bootId || 'none'}`);
        return;
      }

      if (msg.type === 'result') {
        const result = msg as WsResultMessage;
        this.pending.get(result.id)?.settle(result);
        return;
      }

      if (msg.type === 'event') {
        const event = msg as WsEventMessage;
        this.opts.log(`事件 ${String(event.name)}${event.detail ? ' · ' + JSON.stringify(event.detail) : ''}`);
      }
    });

    socket.on('close', () => {
      this.sockets.delete(socket);
      if (alive) {
        if (this.client === socket) {
          this.client = null;
          this.clientInfo = null;
        }
        this.opts.log('扩展连接已断开');
      }
      // Only the calls that actually went out on THIS socket. A replaced socket must not
      // fail requests that already moved to its successor.
      for (const [id, entry] of this.pending) {
        if (entry.socket !== socket) continue;
        this.pending.delete(id);
        entry.settle({ type: 'result', id, ok: false, error: '扩展连接在回包前断开' });
      }
    });

    socket.on('error', (err) => this.opts.log(`ws 错误：${err.message}`));
  }
}
