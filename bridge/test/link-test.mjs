// Unit test for the link/id parsing that figma_open depends on. Runs in Node with no
// Chrome: executor.js guards its only top-level chrome.* listener so the pure helpers
// can be imported here. The round trip matters most — a node id accepted as "1-2" has
// to come back as "1:2" for the API and "1-2" again inside the URL.
import { parseFigmaLink, normalizeNodeId, isFigmaEditor } from '../../extension/lib/executor.js';

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${label}${detail ? ' · ' + detail : ''}`);
};

const eq = (label, actual, expected) => check(label, actual === expected, `得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);

// node ids
eq('node id 冒号形式原样保留', normalizeNodeId('12:34'), '12:34');
eq('node id 连字符形式转成 API 形式', normalizeNodeId('12-34'), '12:34');
eq('实例内部节点 id 也转', normalizeNodeId('I12-34;56-78'), 'I12:34;56:78');
eq('非法 node id 返回 null', normalizeNodeId('page-1'), null);
eq('空 node id 返回 null', normalizeNodeId(''), null);

// links
{
  const p = parseFigmaLink('https://www.figma.com/design/AbC123XyZ/Name?node-id=1-2&t=abc');
  eq('带 www 的设计链接取到 fileKey', p.fileKey, 'AbC123XyZ');
  eq('编辑器类型为 design', p.editorType, 'design');
  eq('node-id 归一成 API 形式', p.nodeId, '1:2');
  eq('重建的 URL 只保留 node-id（丢掉 t= 会话参数）', p.url, 'https://www.figma.com/design/AbC123XyZ/Name?node-id=1-2');
}
{
  const p = parseFigmaLink('figma.com/file/AbC123XyZ/legacy');
  eq('无协议、无 www 的 /file 链接也认', p.fileKey, 'AbC123XyZ');
  eq('无 node-id 时为 null', p.nodeId, null);
}
eq('裸 fileKey 当作 design 文件', parseFigmaLink('AbC123XyZ').url, 'https://www.figma.com/design/AbC123XyZ/');
eq('/slides 路由保留原编辑器类型', parseFigmaLink('https://figma.com/slides/AbC123XyZ/x').editorType, 'slides');
eq('node-id 用 URL 编码的 %3A 也认', parseFigmaLink('https://www.figma.com/design/AbC123XyZ/n?node-id=1%3A2').nodeId, '1:2');

// rejections — every one of these must fail before a tab is opened
eq('非 figma 域名被拒', !!parseFigmaLink('https://example.com/design/AbC123XyZ/x').error, true);
eq('非编辑器路由被拒', !!parseFigmaLink('https://www.figma.com/files/team/123').error, true);
eq('空输入被拒', !!parseFigmaLink('').error, true);
eq('乱字符串被拒', !!parseFigmaLink('not a url at all').error, true);

// isFigmaEditor stays the mirror of the routes the SW will attach to
eq('isFigmaEditor 认 /design', isFigmaEditor('https://www.figma.com/design/AbC123XyZ/n'), true);
eq('isFigmaEditor 不认文件浏览器', isFigmaEditor('https://www.figma.com/files/team/1'), false);
eq('isFigmaEditor 不认空值', isFigmaEditor(null), false);

const failed = results.filter((r) => !r.pass);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项。`);
process.exit(failed.length ? 1 : 0);
