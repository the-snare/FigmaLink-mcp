// Two roles in one process: the leader owns the ws socket to the extension and does the
// work; a proxy forwards tools/call to the process that owns the port. The role is
// resolved at run time so an owner that dies can be replaced instead of leaving every
// follower pointed at a dead port forever.
import type { Logger } from '../log.js';
import { HEADER_TOKEN } from '../meta.js';
import type { PairingStore } from '../pairing.js';
import type { CallOutcome, CallPayload, CallHandler, ToolArgs } from '../tools/types.js';
import type { HttpFace } from './http-face.js';

export class SwitchableDispatcher {
  constructor(
    private readonly deps: {
      local: { call: CallHandler };
      http: HttpFace;
      pairing: PairingStore;
      timeoutFor: (toolName: string) => number;
      log: Logger;
    }
  ) {}

  async call(name: string, args: ToolArgs): Promise<CallOutcome> {
    if (this.deps.http.isProxy) return this.forward(name, args);
    return this.deps.local.call(name, args);
  }

  private async forward(name: string, args: ToolArgs): Promise<CallOutcome> {
    const base = this.deps.http.ownerBase;
    if (!base) return this.deps.local.call(name, args);

    const post = (token: string): Promise<Response> =>
      fetch(`${base}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER_TOKEN]: token },
        body: JSON.stringify({ tool: name, args: args || {} }),
        signal: AbortSignal.timeout(this.deps.timeoutFor(name) + 15000)
      });

    try {
      let response = await post(this.deps.pairing.token);
      if (response.status === 401) {
        // The incumbent may have created the pairing file after this process started.
        const before = this.deps.pairing.token;
        const fresh = this.deps.pairing.reloadToken();
        if (fresh !== before) response = await post(fresh);
      }
      const payload = (await response.json()) as CallPayload;
      return { payload, isError: response.status !== 200 || payload.ok === false };
    } catch (err) {
      // The owner died or stopped listening: take the port over and serve this call
      // locally. A follower stuck on a dead port is the failure this prevents.
      const message = err instanceof Error ? err.message : String(err);
      if (!(await this.deps.http.tryTakeover(`代理请求失败：${message}`))) {
        this.deps.log(`代理到 ${base} 失败：${message}`);
        return { payload: { ok: false, tool: name, error: `代理到 ${base} 失败：${message}` }, isError: true };
      }
    }

    return this.deps.local.call(name, args);
  }
}
