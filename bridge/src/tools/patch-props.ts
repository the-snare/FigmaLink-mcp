// One property vocabulary shared by create/patch. Keeping it in one place means the
// page bridge and the MCP schema cannot drift apart silently.
import type { JsonSchema } from './types.js';

export const PATCH_PROPS: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number', description: '与 height 一起走 resize()' },
    height: { type: 'number' },
    opacity: { type: 'number', minimum: 0, maximum: 1 },
    visible: { type: 'boolean' },
    locked: { type: 'boolean' },
    cornerRadius: { type: 'number', minimum: 0 },
    characters: {
      type: 'string',
      description: '仅文本节点。桥会自动 loadFontAsync；字体为 mixed 的多段文本会明确报错'
    },
    fontName: {
      type: 'object',
      properties: { family: { type: 'string' }, style: { type: 'string' } },
      required: ['family', 'style'],
      additionalProperties: false,
      description: '先 loadFontAsync 再切；常见 {family:"Inter", style:"Bold"|"Regular"|"Medium"}'
    },
    fontSize: { type: 'number', minimum: 1 },
    textAlignHorizontal: { type: 'string', enum: ['LEFT', 'RIGHT', 'CENTER', 'JUSTIFIED'] },
    textAutoResize: {
      type: 'string',
      enum: ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'],
      description: '多行正文要先给 HEIGHT 再给 width，否则 resize() 会抛错'
    },
    lineHeight: {
      type: 'object',
      properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['PIXELS', 'PERCENT', 'AUTO'] } },
      required: ['value', 'unit'],
      additionalProperties: false
    },
    strokeColor: { description: '描边色，同 fillColor' },
    strokeWeight: { type: 'number', minimum: 0 },
    padding: { type: 'number', minimum: 0, description: '四边同值简写，展开成 padding* 四项' },
    layoutMode: { type: 'string', enum: ['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID'] },
    primaryAxisSizingMode: {
      type: 'string',
      enum: ['FIXED', 'AUTO'],
      description: '开 auto-layout 后必须显式 FIXED，否则 frame 会 hug 内容、宽度被吸走'
    },
    counterAxisSizingMode: { type: 'string', enum: ['FIXED', 'AUTO'] },
    itemSpacing: { type: 'number', description: 'auto-layout 子项间距' },
    primaryAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] },
    counterAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX'] },
    layoutWrap: { type: 'string', enum: ['NO_WRAP', 'WRAP'] },
    fillColor: {
      description: '写进第一个填充：#RRGGBB / #RRGGBBAA 或 {r,g,b,a}（通道 0–1）',
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { r: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' } },
          required: ['r', 'g', 'b'],
          additionalProperties: false
        }
      ]
    },
    fillGradient: {
      description:
        '写进第一个填充的渐变（替换那里的纯色）：色标 position 0–1，颜色同 fillColor，transform 是 2×3 矩阵，省略等于 Figma 默认方向',
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'LINEAR',
            'RADIAL',
            'ANGULAR',
            'DIAMOND',
            'GRADIENT_LINEAR',
            'GRADIENT_RADIAL',
            'GRADIENT_ANGULAR',
            'GRADIENT_DIAMOND'
          ]
        },
        stops: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: {
              position: { type: 'number', minimum: 0, maximum: 1 },
              color: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      r: { type: 'number' },
                      g: { type: 'number' },
                      b: { type: 'number' },
                      a: { type: 'number' }
                    },
                    required: ['r', 'g', 'b'],
                    additionalProperties: false
                  }
                ]
              }
            },
            required: ['position', 'color'],
            additionalProperties: false
          }
        },
        transform: {
          type: 'array',
          items: { type: 'array', items: { type: 'number' } },
          description: '[[a,b,c],[d,e,f]]'
        },
        opacity: { type: 'number', minimum: 0, maximum: 1 }
      },
      required: ['stops'],
      additionalProperties: false
    },
    effects: {
      description:
        '整体替换 effects 列表（传 [] 清空）。阴影：{type:"DROP_SHADOW"|"INNER_SHADOW", color, x, y, radius, spread}；模糊：{type:"LAYER_BLUR"|"BACKGROUND_BLUR", radius}',
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'] },
          color: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  r: { type: 'number' },
                  g: { type: 'number' },
                  b: { type: 'number' },
                  a: { type: 'number' }
                },
                required: ['r', 'g', 'b'],
                additionalProperties: false
              }
            ]
          },
          x: { type: 'number', description: '阴影偏移 x，等效于 offset.x' },
          y: { type: 'number' },
          radius: { type: 'number', minimum: 0 },
          spread: { type: 'number' },
          visible: { type: 'boolean' },
          blendMode: { type: 'string' }
        },
        required: ['type', 'radius'],
        additionalProperties: false
      }
    },
    fillStyleId: {
      type: 'string',
      description: '套用图层面板里的 paint style（id 来自 figma_get_styles）；传 "" 解除绑定并保留当前颜色'
    },
    strokeStyleId: { type: 'string' },
    effectStyleId: { type: 'string' },
    textStyleId: { type: 'string' },
    gridStyleId: { type: 'string' },
    strokeAlign: { type: 'string', enum: ['INSIDE', 'OUTSIDE', 'CENTER'] },
    strokeCap: {
      type: 'string',
      enum: [
        'NONE',
        'ROUND',
        'SQUARE',
        'ARROW_LINES',
        'ARROW_EQUILATERAL',
        'DIAMOND_FILLED',
        'TRIANGLE_FILLED',
        'CIRCLE_FILLED'
      ]
    },
    strokeJoin: { type: 'string', enum: ['MITER', 'BEVEL', 'ROUND'] },
    dashPattern: { type: 'array', items: { type: 'number' }, description: '虚线样式，如 [8,4]；传 [] 恢复实线' }
  },
  additionalProperties: false
};
