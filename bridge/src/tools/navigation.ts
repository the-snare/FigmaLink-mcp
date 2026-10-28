import type { ToolDef } from './types.js';

export const pagesTool: ToolDef = {
  name: 'figma_pages',
  op: 'mutatePage',
  kind: 'write',
  readOnly: false,
  description:
    'action list|create|switch|rename|delete on file pages. create/switch/rename are reversible by default; delete destroys a whole page so it needs confirm:true plus revert:false, and refuses to delete the current or last page.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'switch', 'rename', 'delete'] },
      name: { type: 'string', description: 'create 用的新页名' },
      page: { type: 'string', description: 'switch/delete 目标：页名或页 id' },
      from: { type: 'string', description: 'rename 源页名' },
      to: { type: 'string', description: 'rename 新页名' },
      confirm: { type: 'boolean' },
      revert: { type: 'boolean' }
    },
    additionalProperties: false
  }
};

export const tabsTool: ToolDef = {
  name: 'figma_tabs',
  op: '__tabs',
  kind: 'control',
  readOnly: true,
  description:
    'List the Figma tabs the extension can see, with tabId / route / whether it is an editor route. Answered by the service worker without touching any page. Use the returned tabId as the tabId argument on other tools to target one window.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
};

export const openTool: ToolDef = {
  name: 'figma_open',
  op: '__open',
  timeoutMs: 120000,
  kind: 'control',
  readOnly: false,
  description:
    'Take a figma.com link (or a bare fileKey) and make the browser show that file. If the file is already open, the existing tab is reused and focused; if not, a new tab is opened (a current tab is only navigated when reuse:true). Optional nodeId / node-id in the link selects that layer (in place via setSelection when the file is already open, otherwise through the URL). It then waits for the editor to actually be ready and reports ready / canEdit, so the next tool call does not fail on a still-booting page. This is the tool to use when there is no Figma tab at all — every other tool needs one.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'figma.com 链接，可带 ?node-id=1-2；也接受不带协议（raw:true 时按原样导航，不做编辑器路由校验）'
      },
      raw: {
        type: 'boolean',
        description:
          'true = 原样打开这个 figma.com URL（新标签、不校验编辑器路由），用于文件浏览器/新建文件这类页面；默认 false'
      },
      fileKey: { type: 'string', description: '只给文件 key 时的简写，等价于 /design/<key>/' },
      nodeId: { type: 'string', description: '要选中的节点，1:2 或 1-2 都行' },
      reuse: {
        type: 'boolean',
        description: 'true 时把已有的 Figma 标签页导航到目标文件，而不是新开一个（默认不劫持别人的标签）'
      },
      newTab: { type: 'boolean', description: 'true 时即使这个文件已经开着也再开一个标签' },
      activate: { type: 'boolean', description: '默认 true：切到该标签并聚焦窗口' },
      waitMs: { type: 'integer', minimum: 3000, maximum: 110000, description: '等编辑器就绪的上限，默认 45s' }
    },
    additionalProperties: false
  }
};

export const setSelectionTool: ToolDef = {
  name: 'figma_set_selection',
  op: 'setSelection',
  kind: 'control',
  readOnly: true,
  description:
    'Select nodes on the page (and optionally zoom the viewport to them). Selection is transient — nothing in the document changes, so there is nothing to revert.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeIds: { type: 'array', items: { type: 'string' } },
      nodeId: { type: 'string' },
      scrollToFit: { type: 'boolean', description: '默认 true，调用后视图会框住选中项' }
    },
    additionalProperties: false
  }
};

export const createFileTool: ToolDef = {
  name: 'figma_create_file',
  op: '__createFile',
  kind: 'write',
  timeoutMs: 90000,
  readOnly: false,
  description:
    'Create a NEW empty design file in the account by opening Figma’s /design/new route, then wait until it is editable. Returns fileKey + url + ready/canEdit, so you can immediately figma_build into it. Needs confirm:true: the file is a real draft, and this bridge has no way to delete it — undo means removing it from Drafts yourself. The name stays "Untitled" (renaming is a UI action). Use this when you want a clean canvas instead of adding pages to somebody else’s file.',
  inputSchema: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', description: '必须传 true：会在 Drafts 里落一个真文件' },
      activate: { type: 'boolean', description: '默认 true：切到新标签并聚焦窗口' },
      waitMs: { type: 'integer', minimum: 8000, maximum: 120000, description: '等编辑器就绪的上限，默认 45s' }
    },
    required: ['confirm'],
    additionalProperties: false
  }
};
