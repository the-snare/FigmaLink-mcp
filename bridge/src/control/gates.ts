// Gates for the calls that cannot be made revert-safe. Each one either hands back the
// arguments to forward (with its own control keys stripped) or a payload explaining why.
import type { Logger } from '../log.js';

export type GateOutcome =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; extra: Record<string, unknown> };

export function runCodeGate(
  args: Record<string, unknown>,
  enableRunCode: boolean,
  log: Logger
): GateOutcome {
  // The escape hatch is off by default: one script can do anything the other tools refuse
  // to do (destroy nodes, bypass confirm/revert), so enabling it has to be an explicit
  // choice of the process that owns the socket. `.remove(` is blocked separately because
  // it is the one call whose damage no tool result can undo.
  if (!enableRunCode) {
    return {
      ok: false,
      extra: {
        error:
          'run_code 默认关闭：它能绕过所有 revert/confirm 语义。要启用，在启动 bridge 的环境里设 FIGMALINK_ENABLE_RUN_CODE=1（MCP 配置的 env 里加，或 FIGMALINK_ENABLE_RUN_CODE=1 node dist/cli.js），然后重连。',
        enabled: false
      }
    };
  }
  const code = typeof args.code === 'string' ? args.code : '';
  if (!code.trim()) return { ok: false, extra: { error: '需要 code（async 函数体）' } };
  if (code.length > 200000) return { ok: false, extra: { error: `code ${code.length} 字符超过上限 200000` } };
  if (/\.remove\s*\(/.test(code) && args.allowRemove !== true) {
    return {
      ok: false,
      extra: {
        error:
          '代码里出现 .remove( ：这会销毁节点，工具无法自动还原。确认要删就传 allowRemove:true；能用 figma_delete_node 的场合优先用它（它有 hide 模式与 confirm 门控）。',
        needsAllowRemove: true
      }
    };
  }
  log(`figma_run_code 执行 ${code.length} 字符${args.allowRemove === true ? '（allowRemove）' : ''}`);
  const rest: Record<string, unknown> = { ...args };
  delete rest.allowRemove;
  return { ok: true, args: { ...rest, code } };
}

export function pageEvalGate(args: Record<string, unknown>, enablePageEval: boolean): GateOutcome {
  if (!enablePageEval) {
    return {
      ok: false,
      extra: {
        enabled: false,
        error:
          'page_eval 默认关闭：它能在 figma.com 页面里跑任意 JS（含带登录态的 fetch）。要启用，在启动 bridge 的环境里设 FIGMALINK_ENABLE_PAGE_EVAL=1 再重连。'
      }
    };
  }
  const expression = typeof args.expression === 'string' ? args.expression : '';
  if (!expression.trim()) return { ok: false, extra: { error: '需要 expression' } };
  if (expression.length > 200000) {
    return { ok: false, extra: { error: `expression ${expression.length} 字符过长` } };
  }
  return { ok: true, args };
}

export function createFileGate(args: Record<string, unknown>): GateOutcome {
  // Same shape as mode:"remove": the side effect is permanent as far as this bridge is
  // concerned, so it is gated instead of revert-able.
  if (args.confirm !== true) {
    return {
      ok: false,
      extra: {
        needsConfirm: true,
        error: '新建文件会在你的 Drafts 里落一个真文件，而 bridge 删不掉文件。确认请传 confirm:true（撤销只能自己去 Drafts 删）'
      }
    };
  }
  const rest: Record<string, unknown> = { ...args };
  delete rest.confirm;
  return { ok: true, args: rest };
}
