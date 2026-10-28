// One implementation behind both faces (MCP tools/call and POST /call) so a driver over
// HTTP cannot behave differently from the agent over stdio.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from '../config.js';
import { prepareImageImport } from '../import/image.js';
import { prepareSvgImport } from '../import/svg.js';
import type { Logger } from '../log.js';
import { sleep } from '../log.js';
import type { PairingStore } from '../pairing.js';
import type { TargetSelection } from '../protocol.js';
import { saveExport } from '../results/export-writer.js';
import { packResult } from '../results/pack.js';
import type { CallOutcome, ToolArgs, ToolDef } from '../tools/types.js';
import { createFileGate, pageEvalGate, runCodeGate } from './gates.js';
import { RECONNECT_GRACE_MS, type ExtensionHub } from './hub.js';

// The socket carrying a call dies when the extension is reloaded or its offscreen
// document is recycled — an unavoidable event here, since reloading the extension is
// part of the normal edit loop. Reads and navigation can be replayed; writes cannot.
const RETRYABLE_DROP = /回包前断开/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export class LocalCall {
  constructor(
    private readonly deps: {
      config: Config;
      pairing: PairingStore;
      hub: ExtensionHub;
      tools: readonly ToolDef[];
      log: Logger;
    }
  ) {}

  async call(name: string, rawArgs: ToolArgs): Promise<CallOutcome> {
    const { config, hub, log, tools } = this.deps;
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) return { payload: { ok: false, error: `未知工具 ${name}` }, isError: true };

    let args: ToolArgs = rawArgs || {};
    let io: Record<string, unknown> | null = null;

    // Bytes must never travel through the model: read the file here and only send base64
    // (or the SVG markup) across the socket.
    if (tool.kind === 'importText') {
      const prepared = prepareSvgImport(args, config.importRoot);
      if (!prepared.ok) return this.fail(tool, '读 SVG', prepared.error);
      args = prepared.args;
      io = prepared.inline
        ? { inline: true, bytes: prepared.bytes }
        : { readFrom: prepared.abs, bytes: prepared.bytes, type: 'svg' };
      log(
        `${tool.name} ${
          prepared.inline ? `内联 SVG ${prepared.bytes} 字节` : `读入 ${String(prepared.abs)}（${prepared.bytes} 字节）`
        }`
      );
    }
    if (tool.kind === 'import') {
      const prepared = prepareImageImport(args, config.importRoot, config.ioMaxBytes);
      if (!prepared.ok) return this.fail(tool, '读本地文件', prepared.error);
      args = prepared.args;
      io = { readFrom: prepared.abs, bytes: prepared.size, type: prepared.kind };
      log(`${tool.name} 读入 ${prepared.abs}（${prepared.size} 字节）`);
    }

    // tabId is understood by every tool: it pins the call to one browser tab instead of
    // letting the worker pick the most editor-like one.
    let tabId: number | null = null;
    if (args.tabId !== undefined) {
      tabId = Number(args.tabId);
      args = { ...args };
      delete args.tabId;
    }
    let fileKey: string | null = null;
    if (args.fileKey !== undefined && tool.op !== '__open') {
      fileKey = String(args.fileKey).trim() || null;
      args = { ...args };
      delete args.fileKey;
    }
    // Writes must not be aimed by a heuristic: with several Figma tabs open, "the active
    // one" can be a different file, and a patch there is not something a tool result can
    // undo. The worker refuses such a call instead of guessing.
    // __open/__createFile are browser-level and already explicit about their target.
    const strict =
      (tool.kind === 'write' || tool.kind === 'import' || tool.kind === 'importText') &&
      tool.op !== '__open' &&
      tool.op !== '__createFile' &&
      tool.op !== '__pageEval';

    if (tool.op === 'runCode') {
      const gate = runCodeGate(args, config.enableRunCode, log);
      if (!gate.ok) return { payload: { ok: false, tool: tool.name, ...gate.extra }, isError: true };
      args = gate.args;
    }
    if (tool.op === '__pageEval') {
      const gate = pageEvalGate(args, config.enablePageEval);
      if (!gate.ok) return { payload: { ok: false, tool: tool.name, ...gate.extra }, isError: true };
      args = gate.args;
    }
    if (tool.op === '__createFile') {
      const gate = createFileGate(args);
      if (!gate.ok) return { payload: { ok: false, tool: tool.name, ...gate.extra }, isError: true };
      args = gate.args;
    }

    const timeoutMs = tool.timeoutMs || config.callTimeoutMs;
    const target: TargetSelection = { tabId, fileKey, strict };
    let out = await hub.send(tool.op, args, timeoutMs, target);

    const transportDown =
      RETRYABLE_DROP.test(out.error || '') ||
      (/扩展未连接/.test(out.error || '') && Date.now() - hub.lastClientAtMs < RECONNECT_GRACE_MS);
    if (out.ok !== true && transportDown && (tool.readOnly || tool.kind === 'control')) {
      // Wait for the reconnected extension instead of failing a call the agent can do
      // nothing about. newTab:true is excluded because replay would open a second tab.
      const replayable = !(tool.op === '__open' && args.newTab === true);
      if (replayable) {
        for (let i = 0; i < 8 && !hub.connected; i += 1) await sleep(600);
        if (hub.connected) {
          log(`${tool.name} 在扩展重连后重试一次（连接在回包前断开）`);
          out = await hub.send(tool.op, args, timeoutMs, target);
        }
      }
    }
    if (out.ok !== true) return { payload: { ...out, ok: false, tool: tool.name }, isError: true };

    let result = out.result;
    if (tool.kind === 'export') {
      const written = this.writeExport(tool, result);
      if ('outcome' in written) return written.outcome;
      result = written.result;
      io = written.io;
    }

    if (tool.op === 'runCode') {
      result = this.flattenRunCode(result);
      const flattened = asRecord(result);
      if (flattened && flattened.scriptOk === false) {
        return {
          payload: {
            ok: false,
            tool: tool.name,
            stage: '脚本抛错',
            error: flattened.error,
            console: flattened.console
          },
          isError: true
        };
      }
      result = this.capRunCodeResult(tool, result);
    }

    // Only reads get budgeted: write results are small and their value is exactly the
    // before/after/settled triple, which must arrive whole.
    const packed: { packed: boolean; result: unknown; savedTo?: string; nodeCount?: number; bytes?: number } =
      tool.kind === 'read' || !tool.kind
        ? packResult({
            outDir: config.outDir,
            toolName: tool.name,
            result,
            limitBytes: config.resultLimitBytes,
            maxNodes: config.maxNodes
          })
        : { packed: false, result };
    if (packed.packed && packed.savedTo) {
      log(
        `${tool.name} 超预算已落文件：${packed.savedTo}（${String(packed.nodeCount)} 节点 / ${String(packed.bytes)} 字节）`
      );
    }

    const audit = this.buildAudit(tool, args, result);
    if (audit) {
      log(
        `${tool.name} fileKey=${String(audit.fileKey)} revert=${String(audit.revertRequested)} 恢复=${JSON.stringify(audit.restoreOutcome)}`
      );
    }

    const info = this.deps.hub.info;
    return {
      payload: {
        ok: true,
        tool: tool.name,
        ...packed,
        io,
        audit,
        target: out.target || null,
        // Which loopback port answered, so "popup 里填的端口和 bridge 不一致" is checkable
        // without reading logs. The token stays out of here on purpose: it only appears in
        // the no-client error, where the user has to type it.
        bridge: {
          port: config.port,
          wsUrl: `ws://127.0.0.1:${config.port}`,
          pinnedOrigin: this.deps.pairing.pinnedOrigin || null
        },
        client: info
          ? { origin: info.origin, bridgeVersion: info.bridgeVersion, bootId: info.bootId, key: info.key }
          : null
      },
      isError: false
    };
  }

  private fail(tool: ToolDef, stage: string, error: string): CallOutcome {
    return { payload: { ok: false, tool: tool.name, stage, error }, isError: true };
  }

  private writeExport(
    tool: ToolDef,
    result: unknown
  ): { result: unknown; io: Record<string, unknown> | null } | { outcome: CallOutcome } {
    const { config, log } = this.deps;
    const record = asRecord(result);

    // Batch: the page sends one {files:[{base64,…}]} payload, the server writes one file
    // per node and never lets the bytes near the model.
    if (record && Array.isArray(record.files)) {
      const written: Record<string, unknown>[] = [];
      const failed: unknown[] = Array.isArray(record.failed) ? [...record.failed] : [];
      for (const file of record.files) {
        const payload = asRecord(file);
        const saved = saveExport(payload, config.outDir);
        if (!saved.ok) {
          failed.push({ nodeId: payload?.nodeId, error: saved.error });
          continue;
        }
        written.push({ ...saved.io, nodeId: payload?.nodeId, name: payload?.name, nodeSize: payload?.nodeSize });
        log(`${tool.name} 写出 ${saved.io.savedTo}（${saved.io.bytes} 字节）`);
      }
      if (!written.length) {
        return {
          outcome: {
            payload: {
              ok: false,
              tool: tool.name,
              stage: '落盘',
              failed,
              error: '批量导出没有成功任何一个'
            },
            isError: true
          }
        };
      }
      return {
        result: {
          files: written,
          failed,
          count: written.length,
          clip: record.clip === true
        },
        io: { count: written.length, files: written.map((entry) => entry.savedTo) }
      };
    }

    const saved = saveExport(record, config.outDir);
    if (!saved.ok) {
      return {
        outcome: {
          payload: { ok: false, tool: tool.name, stage: '落盘', nodeId: record?.nodeId, error: saved.error },
          isError: true
        }
      };
    }
    log(`${tool.name} 写出 ${saved.io.savedTo}（${saved.io.bytes} 字节）`);
    return { result: saved.result, io: { ...saved.io } };
  }

  private flattenRunCode(result: unknown): unknown {
    const record = asRecord(result);
    // The page op answers {ok, result, console}; flatten it so the caller does not have to
    // read result.result. A script that threw is a failed call, not a successful one.
    if (!record || !('ok' in record)) return result;
    return {
      scriptOk: record.ok !== false,
      value: record.result === undefined ? null : record.result,
      console: record.console || [],
      error: record.error || null
    };
  }

  private capRunCodeResult(tool: ToolDef, result: unknown): unknown {
    const { config, log } = this.deps;
    // A script can return anything; a 2MB JSON dump in the transcript helps nobody.
    const text = JSON.stringify(result) ?? '';
    if (text.length <= config.resultLimitBytes) return result;
    mkdirSync(config.outDir, { recursive: true });
    const savedTo = join(config.outDir, `run_code-${stamp()}.json`);
    writeFileSync(savedTo, text);
    log(`${tool.name} 结果 ${text.length} 字节已落盘：${savedTo}`);
    return { savedTo, bytes: text.length, preview: text.slice(0, 4000), truncated: true };
  }

  private buildAudit(
    tool: ToolDef,
    args: ToolArgs,
    result: unknown
  ): { fileKey: unknown; revertRequested: boolean; restoreOutcome: unknown } | null {
    if (tool.kind !== 'write' && tool.kind !== 'import' && tool.kind !== 'importText') return null;
    const record = asRecord(result);
    let restoreOutcome: unknown = null;
    if (record) {
      restoreOutcome =
        record.batch !== undefined
          ? record.failedCount === 0
            ? `批量 ${String(record.batch)} 全部落地`
            : `批量 ${String(record.batch)} 中 ${String(record.failedCount)} 个失败`
          : record.reverted !== undefined
            ? record.reverted
            : record.removed !== undefined
              ? record.removed
              : record.restored !== undefined
                ? record.restored
                : null;
    }
    return {
      fileKey: (record && record.fileKey) || null,
      // createTree keeps by default; every other writer reverts by default.
      revertRequested: tool.op === 'createTree' ? args.revert === true : args.revert !== false,
      restoreOutcome
    };
  }
}
