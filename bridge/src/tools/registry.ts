import { pageEvalTool, runCodeTool } from './escape.js';
import { exportImageTool, importImageTool, importSvgTool } from './io.js';
import { createFileTool, openTool, pagesTool, setSelectionTool, tabsTool } from './navigation.js';
import {
  findTool,
  getNodeTool,
  getSelectionTool,
  getStylesTool,
  prototypeTool,
  readTreeTool,
  statusTool,
  variablesTool
} from './read.js';
import type { JsonSchema, ToolDef } from './types.js';
import {
  arrangeTool,
  booleanTool,
  buildTool,
  createNodeTool,
  deleteNodeTool,
  duplicateTool,
  groupTool,
  instanceTool,
  moveNodeTool,
  patchNodeTool
} from './write.js';

const TAB_ID: JsonSchema = {
  type: 'integer',
  description:
    '定向到 figma_tabs 返回的某个 tabId。传了就必须存在——不会再静默换成别的标签页（多标签时那等于写错文件）'
};

const FILE_KEY: JsonSchema = {
  type: 'string',
  description:
    '按文件定向：解析到当前打开该 fileKey 的标签页（可传 key 或链接）。找不到直接报错；与同时传的 tabId 取交集'
};

// Order is the order the agent sees in tools/list, so keep it grouped by what a caller
// would reach for: inspect -> navigate -> mutate -> media -> escape hatches.
const BASE_TOOLS: readonly ToolDef[] = [
  statusTool,
  getSelectionTool,
  readTreeTool,
  getNodeTool,
  findTool,
  variablesTool,
  pagesTool,
  tabsTool,
  openTool,
  setSelectionTool,
  createNodeTool,
  buildTool,
  patchNodeTool,
  moveNodeTool,
  groupTool,
  booleanTool,
  instanceTool,
  deleteNodeTool,
  exportImageTool,
  importImageTool,
  importSvgTool,
  duplicateTool,
  arrangeTool,
  getStylesTool,
  runCodeTool,
  createFileTool,
  pageEvalTool,
  prototypeTool
];

function withTargeting(tool: ToolDef): ToolDef {
  const properties: Record<string, JsonSchema> = { ...(tool.inputSchema.properties ?? {}) };
  properties.tabId = TAB_ID;
  // figma_open takes a fileKey as "which file to open", so it must not get the
  // "which tab is showing this file" meaning.
  if (tool.op !== '__open') properties.fileKey = FILE_KEY;
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

export function buildTools(): ToolDef[] {
  return BASE_TOOLS.map(withTargeting);
}

export function findToolByName(tools: readonly ToolDef[], name: string): ToolDef | undefined {
  return tools.find((tool) => tool.name === name);
}
