import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { log } from './log.js';

export interface PairingData {
  token: string;
  pinnedOrigin?: string;
}

export class PairingStore {
  private data: PairingData;

  constructor(
    readonly file: string,
    tokenOverride: string | null
  ) {
    this.data = this.load();
    if (tokenOverride !== null && this.data.token !== tokenOverride) {
      // Keeps pinnedOrigin intact: rotating the token must not also re-open pairing to
      // whatever extension id asks first.
      this.data.token = tokenOverride;
      this.save();
      log(`已按启动参数覆盖配对 token，并写回 ${this.file}`);
    }
  }

  get token(): string {
    return this.data.token;
  }

  get pinnedOrigin(): string | null {
    return this.data.pinnedOrigin ?? null;
  }

  pin(origin: string): void {
    this.data.pinnedOrigin = origin;
    this.save();
  }

  /**
   * A proxy process may have started before the leader wrote its pairing file, so a
   * 401 is answered by re-reading the same file once instead of failing the call.
   */
  reloadToken(): string {
    const fresh = this.load();
    this.data.token = fresh.token;
    if (fresh.pinnedOrigin !== undefined) this.data.pinnedOrigin = fresh.pinnedOrigin;
    return this.data.token;
  }

  private load(): PairingData {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PairingData>;
        if (typeof parsed.token === 'string' && parsed.token) {
          return { token: parsed.token, ...(parsed.pinnedOrigin ? { pinnedOrigin: parsed.pinnedOrigin } : {}) };
        }
      } catch {
        // Rewritten below.
      }
    }
    const fresh: PairingData = { token: randomUUID().replace(/-/g, '').slice(0, 20) };
    this.data = fresh;
    this.save();
    return fresh;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

/**
 * The extension is not an MCP client and the agent cannot see the popup, so "扩展未连接"
 * on its own leaves the operator to guess three things: which port this bridge listens
 * on, which token it wants, and where to paste them. Handing over exactly those three
 * (plus the pin) turns a dead end into one instruction. The token only guards a loopback
 * port against local processes, and it is the one value the user has to type, so it has
 * to travel in the error rather than stay a secret the agent cannot name.
 */
export function pairingGuide(store: PairingStore, port: number, note?: string): Record<string, unknown> {
  const url = `ws://127.0.0.1:${port}`;
  const steps = [
    '在 Chrome 工具栏点 FigmaLink 图标打开 popup（没装过就先安装扩展）',
    `URL 一栏填 ${url} —— 端口必须和 bridge 一致：本进程这次监听 ${port}`,
    `Token 一栏粘 ${store.token}（同一份也保存在 ${store.file}，重启不变）`,
    '点最左边那个插头图标「Save and reconnect」，状态显示已连接后重试这条工具'
  ];
  if (store.pinnedOrigin) {
    steps.push(
      `这个 token 已经钉住 ${store.pinnedOrigin}。配对来源变了（换了浏览器、换了 Chrome 配置，或装了第二份扩展）会被拒（4003）：用原来那份；确实换掉了就在 ${store.file} 里删掉 pinnedOrigin 再重启 bridge，让新的来源重新钉住`
    );
  }
  return {
    url,
    token: store.token,
    pairingFile: store.file,
    pinnedOrigin: store.pinnedOrigin,
    steps,
    ...(note ? { note } : {})
  };
}
