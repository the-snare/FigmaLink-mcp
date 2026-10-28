import { PATCH_PROPS } from './patch-props.js';
import type { JsonSchema, ToolDef } from './types.js';

const NODE_KIND: JsonSchema = {
  type: 'string',
  enum: ['rectangle', 'frame', 'ellipse', 'text', 'line', 'star', 'polygon', 'component', 'section']
};

export const createNodeTool: ToolDef = {
  name: 'figma_create_node',
  op: 'createNode',
  kind: 'write',
  readOnly: false,
  description:
    'Create one node with initial props. Default revert:true removes it again after reading it back, so a probe leaves nothing behind; pass revert:false to keep it. Give parentId to nest it (coordinates then become relative to that parent), otherwise it lands on the current page.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        ...NODE_KIND,
        description: 'section 只能挂在页面（或另一个 section）里，尺寸走 resizeWithoutConstraints'
      },
      props: PATCH_PROPS,
      parentId: { type: 'string', description: '挂到哪个节点里；省略则留在当前页顶层' },
      revert: { type: 'boolean', description: '默认 true：建完立刻删掉。要保留就传 false。' }
    },
    required: ['kind'],
    additionalProperties: false
  }
};

export const buildTool: ToolDef = {
  name: 'figma_build',
  op: 'createTree',
  timeoutMs: 90000,
  kind: 'write',
  readOnly: false,
  description:
    'Build a whole nested tree in ONE call from a declarative spec — this is how you lay out a screen without a round trip per node. spec is {kind, props?, children?} recursively; props uses the same vocabulary as figma_patch_node (name/x/y/width/height/fillColor/fontName/fontSize/characters/textAlignHorizontal/stroke...). Coordinates of children are relative to their parent frame. Unlike the atomic tools this KEEPS what it builds (revert defaults to false) and returns root id, subtreeSize and any rejected nodes; Ctrl+Z undoes the whole action.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        properties: {
          kind: { ...NODE_KIND },
          props: PATCH_PROPS,
          children: { type: 'array', items: { type: 'object' }, description: '同形状的嵌套节点数组' }
        },
        required: ['kind'],
        additionalProperties: false
      },
      parentId: { type: 'string', description: '省略则挂在当前页' },
      maxNodes: { type: 'integer', minimum: 1, maximum: 400, description: '默认 400，防止手滑建出巨树' },
      revert: { type: 'boolean', description: '默认 false（保留）。传 true 会在建完确认后删掉整棵。' }
    },
    required: ['spec'],
    additionalProperties: false
  }
};

export const patchNodeTool: ToolDef = {
  name: 'figma_patch_node',
  op: 'patchNode',
  kind: 'write',
  readOnly: false,
  description:
    'Change properties on one node (nodeId+patch) or many at once (patches[]). Snapshots before, applies, and by default restores the snapshot (revert:true). Each result carries before/after/settled so you can see whether the restore landed. Auto-layout keys: layoutMode, itemSpacing, padding, primaryAxisAlignItems (SPACE_BETWEEN spreads children edge to edge), counterAxisAlignItems.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string' },
      patch: PATCH_PROPS,
      patches: {
        type: 'array',
        items: {
          type: 'object',
          properties: { nodeId: { type: 'string' }, patch: PATCH_PROPS },
          required: ['nodeId', 'patch'],
          additionalProperties: false
        },
        description: '批量模式：一次改多个节点，布局调整时避免十几个往返'
      },
      revert: { type: 'boolean', description: '默认 true：改完把旧值写回。要留下改动就传 false。' }
    },
    additionalProperties: false
  }
};

export const moveNodeTool: ToolDef = {
  name: 'figma_move_node',
  op: 'moveNode',
  kind: 'write',
  readOnly: false,
  description:
    'Re-parent a node (and optionally reorder it with index). Unlike delete, moving is fully reversible, so revert defaults to true.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string' },
      parentId: { type: 'string', description: '目标父级；省略则当前页' },
      index: { type: 'integer', minimum: 0 },
      revert: { type: 'boolean' }
    },
    required: ['nodeId'],
    additionalProperties: false
  }
};

export const groupTool: ToolDef = {
  name: 'figma_group',
  op: 'group',
  kind: 'write',
  readOnly: false,
  description:
    'Wrap 2+ sibling nodes in a group. Reversible by default (it ungroups again after reading the result).',
  inputSchema: {
    type: 'object',
    properties: {
      nodeIds: { type: 'array', items: { type: 'string' }, minItems: 2 },
      name: { type: 'string' },
      revert: { type: 'boolean' }
    },
    required: ['nodeIds'],
    additionalProperties: false
  }
};

export const booleanTool: ToolDef = {
  name: 'figma_boolean',
  op: 'booleanOp',
  kind: 'write',
  readOnly: false,
  description:
    'union / subtract / intersect / exclude over 2+ nodes. NOT reversible: the boolean result absorbs the input nodes, so deleting the result would delete the originals. That means confirm:true is mandatory and recovery is Ctrl+Z in Figma only.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['union', 'subtract', 'intersect', 'exclude'] },
      nodeIds: { type: 'array', items: { type: 'string' }, minItems: 2, description: 'subtract 是第一个减去其余' },
      name: { type: 'string' },
      confirm: { type: 'boolean' }
    },
    required: ['op', 'nodeIds'],
    additionalProperties: false
  }
};

export const instanceTool: ToolDef = {
  name: 'figma_instance',
  op: 'instance',
  kind: 'write',
  readOnly: false,
  description:
    'action create: make an instance of a COMPONENT node (reversible by default — the instance is removed again, the component is untouched). action detach: replace an instance with a plain frame, which is NOT reversible and needs confirm:true.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'detach'] },
      nodeId: { type: 'string', description: 'create 时是 COMPONENT，detach 时是 INSTANCE' },
      parentId: { type: 'string' },
      props: {
        type: 'object',
        properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
        additionalProperties: false
      },
      confirm: { type: 'boolean' },
      revert: { type: 'boolean' }
    },
    required: ['nodeId'],
    additionalProperties: false
  }
};

export const deleteNodeTool: ToolDef = {
  name: 'figma_delete_node',
  op: 'deleteNode',
  kind: 'write',
  readOnly: false,
  description:
    'Two modes with different reversibility, verified against a real file. Default mode:"hide" flips visible=false and restores it under the default revert:true — fully undoable, good for probing. mode:"remove" calls node.remove(), which DESTROYS the node object (re-insert fails with "node does not exist"), so it demands confirm:true and revert:false, and recovery afterwards means Ctrl+Z in Figma rather than this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string' },
      mode: { type: 'string', enum: ['hide', 'remove'], description: '默认 hide（可逆）；remove 需 confirm:true 且 revert:false' },
      confirm: { type: 'boolean', description: 'mode:"remove" 的显式确认' },
      revert: { type: 'boolean', description: 'hide 模式默认回填可见性；remove 模式必须传 false' }
    },
    required: ['nodeId'],
    additionalProperties: false
  }
};

export const duplicateTool: ToolDef = {
  name: 'figma_duplicate',
  op: 'duplicate',
  kind: 'write',
  readOnly: false,
  description:
    'Copy nodes in place: count copies per node, each one offset by (dx,dy)*i so they cascade instead of stacking exactly on top. Default revert:true removes the copies again (probe semantics, like figma_create_node) — pass revert:false to keep them. The result carries the coordinates of the copies themselves, so they can be fed straight into figma_arrange.',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string' },
      nodeIds: { type: 'array', items: { type: 'string' }, description: '一次复制多个节点' },
      count: { type: 'integer', minimum: 1, maximum: 50, description: '每个源节点复制几份，默认 1' },
      dx: { type: 'number', description: '每份相对上一份的位移（第 i 份 = 源 + i*dx）' },
      dy: { type: 'number' },
      offset: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        additionalProperties: false,
        description: 'dx/dy 的等价写法'
      },
      parentId: { type: 'string', description: '复制到哪个父级；省略则留在源节点原来的父级' },
      revert: { type: 'boolean', description: '默认 true：复制完再删掉。要留下副本传 false。' }
    },
    additionalProperties: false
  }
};

export const arrangeTool: ToolDef = {
  name: 'figma_arrange',
  op: 'arrange',
  kind: 'write',
  readOnly: false,
  timeoutMs: 60000,
  description:
    'Layout operations that would otherwise be N round trips of coordinate maths: distribute (equal gaps, first/last fixed), align (left/right/hcenter/top/bottom/vcenter to the parent or a relativeTo node), grid (snap to size), place (below/above/right/left of another node with gap + start/center/end alignment), ungroup (GROUP only). All distances are absolute document pixels, computed from absoluteBoundingBox, so nesting depth does not matter. Unlike the atomic tools this KEEPS the layout (revert defaults to false, like figma_build) — Ctrl+Z undoes a whole arrange; pass revert:true for a dry run that restores every x/y it moved (not available for ungroup).',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['distribute', 'align', 'grid', 'place', 'fit', 'ungroup'] },
      nodeIds: { type: 'array', items: { type: 'string' }, description: 'distribute/align/grid 作用的对象' },
      nodeId: { type: 'string', description: 'place（要移动的节点）/ ungroup（要拆的 GROUP）' },
      axis: { type: 'string', enum: ['horizontal', 'vertical'], description: 'distribute 的轴，默认 horizontal' },
      edge: {
        type: 'string',
        enum: ['left', 'right', 'hcenter', 'top', 'bottom', 'vcenter'],
        description: 'align 的边，默认 left'
      },
      relativeTo: { type: 'string', description: 'align 的基准节点 / place 的参照节点' },
      side: { type: 'string', enum: ['below', 'above', 'right', 'left'], description: 'place 的方向，默认 below' },
      gap: { type: 'number', description: 'place 的间距，默认 0' },
      align: { type: 'string', enum: ['start', 'center', 'end'], description: 'place 沿另一轴的校准，默认 start' },
      size: { type: 'number', description: 'grid 的栅格尺寸，默认 8' },
      padding: { type: 'number', minimum: 0, description: 'fit 的四周留白，默认 0（只对 SECTION 生效）' },
      x: { type: 'number', description: 'grid 的原点 x，默认 0' },
      y: { type: 'number' },
      revert: { type: 'boolean', description: '默认 false（保留布局）。true 会把这次移动的 x/y 全部还原，当干跑用。' }
    },
    required: ['op'],
    additionalProperties: false
  }
};
