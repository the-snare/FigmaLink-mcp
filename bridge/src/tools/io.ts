import type { ToolDef } from './types.js';

export const exportImageTool: ToolDef = {
  name: 'figma_export_image',
  op: 'exportImage',
  timeoutMs: 60000,
  kind: 'export',
  readOnly: true,
  description:
    'Export one node as PNG/JPG/SVG/PDF. The server decodes the bytes into the out directory and returns the path plus dimensions — the image itself never enters the conversation. Read the returned path to look at it.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Omit to export the first selected node.' },
      nodeIds: { type: 'array', items: { type: 'string' }, description: '批量：一次导出多个节点，每个写一个文件（上限 40）' },
      clip: {
        type: 'boolean',
        description: 'true = 只导出节点自身范围内的内容（contentsOnly + useAbsoluteBounds），不把阴影/溢出部分算进画布'
      },
      format: { type: 'string', enum: ['PNG', 'JPG', 'SVG', 'PDF'] },
      scale: { type: 'number', minimum: 0.1, maximum: 4, description: '仅 PNG/JPG 生效，默认 1' },
      maxBytes: { type: 'integer', description: '导出体积上限，默认 4MB；超限会先报错而不是回传巨串' }
    },
    additionalProperties: false
  }
};

export const importImageTool: ToolDef = {
  name: 'figma_import_image',
  op: 'importImage',
  timeoutMs: 60000,
  kind: 'import',
  readOnly: false,
  description:
    "Import a local image into the design. Pass a file path inside FIGMALINK_IMPORT_ROOT; the server reads it and only base64 crosses the socket. With nodeId it replaces that node's fills; without it, it creates a rectangle at x/y sized width/height. Caveat reported honestly: figma.createImage keeps the image resource in the file even when revert removes the node.",
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '本机图片绝对路径（png/jpg/jpeg/webp/gif）' },
      nodeId: { type: 'string', description: '给已有节点填图；省略则新建一个矩形' },
      x: { type: 'number' },
      y: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
      name: { type: 'string' },
      scaleMode: { type: 'string', enum: ['FILL', 'FIT', 'CROP', 'TILE', 'STRETCH'] },
      revert: { type: 'boolean' }
    },
    required: ['path'],
    additionalProperties: false
  }
};

export const importSvgTool: ToolDef = {
  name: 'figma_import_svg',
  op: 'importSvg',
  kind: 'importText',
  timeoutMs: 60000,
  readOnly: false,
  description:
    'Import SVG as REAL vector layers (not a bitmap). Pass the markup in svg, or a local .svg path that the server reads for you. Unlike raster import this leaves nothing behind when reverted — the node and its vectors go away cleanly, so revert defaults to true like the atomic probe tools. width/height rescale the artwork (uniform only; rescale scales the vectors with the frame).',
  inputSchema: {
    type: 'object',
    properties: {
      svg: { type: 'string', description: '完整 SVG 标记，必须以 <svg 开头；≤2MB；不能含 <script>/on*/javascript:' },
      path: {
        type: 'string',
        description: '本机 .svg 文件绝对路径（必须在 FIGMALINK_IMPORT_ROOT 内）；与 svg 二选一'
      },
      parentId: { type: 'string', description: '挂到哪个节点里；省略则当前页' },
      x: { type: 'number' },
      y: { type: 'number' },
      width: { type: 'number', description: '等比缩放到这个宽度' },
      height: { type: 'number', description: '只给 height 时按它等比缩放' },
      name: { type: 'string' },
      revert: { type: 'boolean', description: '默认 true：建完就删（探针用）。要留下就传 false。' }
    },
    additionalProperties: false
  }
};
