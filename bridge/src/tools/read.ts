import type { ToolDef } from './types.js';

export const statusTool: ToolDef = {
  name: 'figma_status',
  op: 'env',
  readOnly: true,
  description:
    'Report whether the Figma tab is reachable, how many Rspack modules were found, and which window.figma Plugin API members are live.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
};

export const getSelectionTool: ToolDef = {
  name: 'figma_get_selection',
  op: 'readSelection',
  readOnly: true,
  description: 'Read the nodes currently selected on the Figma page (id, name, type, geometry, fills).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
};

export const readTreeTool: ToolDef = {
  name: 'figma_read_tree',
  op: 'readTree',
  readOnly: true,
  description: 'Walk the scene graph from the page root, or from nodeId when given. depth defaults to 2.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Figma node id like "4311:2". Omit for the current page.' },
      depth: { type: 'integer', minimum: 1, maximum: 6, description: 'Levels to descend.' },
      offset: { type: 'integer', minimum: 0, description: '每层跳过多少个孩子，用于看宽页面的尾部' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: '每层最多取多少个孩子，默认 25' }
    },
    additionalProperties: false
  }
};

export const getNodeTool: ToolDef = {
  name: 'figma_get_node',
  op: 'getNode',
  kind: 'read',
  readOnly: true,
  description:
    'Exact property snapshot of one node (geometry, opacity, visible, locked, cornerRadius, fills incl. image hashes, text characters), plus its parent and child ids. Prefer this over figma_read_tree when you need truth about a single layer.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node id like "1:234". Omit to use the current selection.' },
      useSelection: { type: 'boolean', description: 'Explicitly take currentPage.selection[0].' }
    },
    additionalProperties: false
  }
};

export const findTool: ToolDef = {
  name: 'figma_find',
  op: 'find',
  kind: 'read',
  readOnly: true,
  description:
    'Search the scene graph by type and/or name regex, under nodeId / the current page / the whole document. This is how you locate layers on a big file without dumping the whole tree.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: '限定在这个子树里找' },
      wholeDocument: { type: 'boolean', description: '从 figma.root 开始，跨所有页面' },
      types: { type: 'array', items: { type: 'string' }, description: '如 ["TEXT","FRAME"]，大小写不敏感' },
      name: { type: 'string', description: '名字正则（默认忽略大小写）' },
      icase: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 300 }
    },
    additionalProperties: false
  }
};

export const variablesTool: ToolDef = {
  name: 'figma_variables',
  op: 'variables',
  kind: 'read',
  readOnly: true,
  description:
    'List local variable collections and variables with their modes and values. Read-only: writing variables is not exposed.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
};

export const getStylesTool: ToolDef = {
  name: 'figma_get_styles',
  op: 'styles',
  kind: 'read',
  readOnly: true,
  description:
    'List local styles the way the file itself encodes its design system: paint / text / effect / grid styles, each with id, name and payload (paint types, font name+size+line height+letter spacing, effect types, grid patterns). Different from figma_variables: variables are tokens, styles are what a layer actually points at. Apply one by setting paintStyleId / textStyleId / effectStyleId / strokeStyleId / gridStyleId through figma_patch_node.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500, description: '每类最多返回多少个，默认 100' }
    },
    additionalProperties: false
  }
};

export const prototypeTool: ToolDef = {
  name: 'figma_get_prototype',
  op: 'prototype',
  kind: 'read',
  readOnly: true,
  timeoutMs: 60000,
  description:
    'Read the prototype wiring, with every id resolved to a name. mode:"connections" walks a subtree (nodeId, else the current selection, else the page) and lists each layer that has reactions; mode:"flows" lists the prototype starting points of this page; mode:"trace" follows destinations breadth-first from nodeId (or the first starting point) up to maxDepth and returns the screen graph as edges. Triggers, navigation, transitions, conditional branches and SET_VARIABLE targets (resolved to variable + collection + mode names) are included. AFTER_TIMEOUT values are in seconds.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['connections', 'flows', 'trace'], description: '默认 connections' },
      nodeId: {
        type: 'string',
        description: 'connections 的子树根 / trace 的起点；省略则用当前选中或页面上第一个原型起点'
      },
      depth: { type: 'integer', minimum: 0, maximum: 6, description: 'connections 往下走几层，默认 2' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'connections 最多返回多少个带交互的图层，默认 60' },
      maxDepth: { type: 'integer', minimum: 1, maximum: 12, description: 'trace 最多跟几跳，默认 4' }
    },
    additionalProperties: false
  }
};
