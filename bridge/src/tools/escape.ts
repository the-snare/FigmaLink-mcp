import type { ToolDef } from './types.js';

export const runCodeTool: ToolDef = {
  name: 'figma_run_code',
  op: 'runCode',
  kind: 'write',
  timeoutMs: 120000,
  readOnly: false,
  pack: true,
  description:
    'Escape hatch: run JavaScript in the Figma plugin sandbox with the real `figma` object in scope (top-level await and return work, console.log is captured). OFF unless the bridge was started with FIGMALINK_ENABLE_RUN_CODE=1, because one call can bypass every revert/confirm rule here. Code containing .remove( is rejected unless allowRemove:true. Use it for one-off batch work that would otherwise need a new tool, not for anything a dedicated tool already does.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'async 函数体；`return` 的值必须能 JSON 序列化' },
      allowRemove: { type: 'boolean', description: '允许代码里出现 .remove(（默认拒绝，因为这会毁掉节点且无法自动还原）' }
    },
    required: ['code'],
    additionalProperties: false
  }
};

export const pageEvalTool: ToolDef = {
  name: 'figma_page_eval',
  op: '__pageEval',
  kind: 'write',
  timeoutMs: 60000,
  readOnly: false,
  pack: true,
  description:
    'Run JavaScript in the figma.com page itself (main world: real DOM, and fetch carries the signed-in session). This is the seam for things the canvas API cannot do — the file browser, dialogs, deleting a file. OFF unless the bridge was started with FIGMALINK_ENABLE_PAGE_EVAL=1, because it can do anything the user could do in that tab. The expression is evaluated as an async function body, so top-level await/return work. Prefer the canvas tools whenever they can do the job.',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'async 函数体；return 值必须可 JSON 序列化' }
    },
    required: ['expression'],
    additionalProperties: false
  }
};
