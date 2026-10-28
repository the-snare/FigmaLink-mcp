# FigmaLink（`figmalink-mcp`）

通过 MCP 读写**实时打开的 Figma 画布**：不依赖 Figma REST API，也不需要 Figma token，Free plan 账号即可用。

项目由两部分组成：

- `bridge/`：MCP server（TypeScript，npm 包名 `figmalink-mcp`），对 Agent 提供 stdio MCP，对浏览器扩展提供本机 WebSocket 控制面。
- `extension/`：MV3 Chrome 扩展，用 `chrome.debugger` 在已打开的 Figma 编辑器里执行插件 API。

## 工作原理

```
Agent ⇄ stdio MCP ⇄ figmalink-mcp ⇄ ws://127.0.0.1:1210 ⇄ Chrome 扩展 ⇄ chrome.debugger ⇄ 页内桥 ⇄ window.figma
```

WebSocket 只是扩展的私有控制通道，不是 MCP 传输层；扩展也不实现 MCP，只应答 `{id, op, arg} → {id, ok, result}`。

`window.figma` 在 Figma 页面里带调用栈侦测（调用帧含 `chrome-extension://` 会被拒），所以执行端必须留在 `chrome.debugger` 的 `Runtime.evaluate` 里，content script 拿不到插件 API。

## 快速开始

### 1. 添加 MCP Server

```json
{
  "mcpServers": {
    "figmalink": {
      "command": "npx",
      "args": ["-y", "figmalink-mcp", "--port", "1210", "--token", "my-token-1234"]
    }
  }
}
```

`--port` 省略时用 `1210`；`--token` 省略时首次启动自动生成并保存在 `~/.figmalink/pairing.json`。改完配置后重启 Agent 或重连 MCP。

### 2. 安装浏览器扩展

下载扩展目录（仓库里的 `extension/`），通过开发者模式加载：

```text
chrome://extensions → 打开「开发者模式」 → 加载已解压的扩展程序 → 选择 extension/
```

改完扩展代码后，在扩展卡片上点「重新加载」。

### 3. 配对

打开扩展 popup：

- **URL**：`ws://127.0.0.1:1210`（与 `--port` 一致）
- **Token**：与 `--token` 或 `~/.figmalink/pairing.json` 一致（示例里是 `my-token-1234`）
- 点最左侧的插头图标（Save and reconnect）

然后在 Agent 里调用 `figma_status` 验证。连不上时，工具报错会带 `pairing` 块，照着填即可。

本仓库源码运行方式见「开发」。

## MCP 工具

共 28 个，全部接受可选参数 `tabId` / `fileKey`，用于把调用定向到某个标签页（详见下文「多标签定向」）。

### 读取

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `figma_status` | 检查扩展链路、页面可用性与 `window.figma` 成员 | — |
| `figma_get_selection` | 读取当前选中节点 | — |
| `figma_read_tree` | 浏览场景树 | `nodeId`、`depth`(1–6)、`offset`、`limit` |
| `figma_get_node` | 单个节点的精确属性快照 | `nodeId` / `useSelection` |
| `figma_find` | 按类型和/或名字正则搜索 | `nodeId`、`wholeDocument`、`types`、`name`、`icase`、`limit` |
| `figma_variables` | 列出本地变量集合与变量值 | — |
| `figma_get_styles` | 列出 paint / text / effect / grid 样式 | `limit` |
| `figma_get_prototype` | 读取原型连线、起点或跳转路径 | `mode`(connections/flows/trace)、`nodeId`、`depth`、`limit`、`maxDepth` |
| `figma_tabs` | 列出扩展可见的 Figma 标签页 | — |

### 导航与选择

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `figma_open` | 按链接或 fileKey 打开/聚焦文件并等编辑器就绪 | `url`、`fileKey`、`nodeId`、`raw`、`reuse`、`newTab`、`activate`、`waitMs` |
| `figma_create_file` | 新建空草稿文件 | `confirm`（必须 `true`）、`activate`、`waitMs` |
| `figma_set_selection` | 选中节点并缩放视图 | `nodeIds` / `nodeId`、`scrollToFit` |

### 创建与修改

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `figma_create_node` | 创建单个节点 | `kind`、`props`、`parentId`、`revert` |
| `figma_build` | 一次调用建整棵嵌套树 | `spec`、`parentId`、`maxNodes`、`revert` |
| `figma_patch_node` | 修改一个或多个节点的属性 | `nodeId`+`patch` 或 `patches[]`、`revert` |
| `figma_move_node` | 重新挂载父级或调整顺序 | `nodeId`、`parentId`、`index`、`revert` |
| `figma_group` | 把 2 个以上同级节点成组 | `nodeIds`、`name`、`revert` |
| `figma_boolean` | 并集/差集/交集/排除 | `op`、`nodeIds`、`name`、`confirm`（必须 `true`） |
| `figma_instance` | 创建组件实例或分离实例 | `action`、`nodeId`、`parentId`、`props`、`confirm`、`revert` |
| `figma_delete_node` | 隐藏（可逆）或删除（不可逆）节点 | `nodeId`、`mode`(hide/remove)、`confirm`、`revert` |
| `figma_duplicate` | 复制节点并按偏移级联 | `nodeId`/`nodeIds`、`count`、`dx`/`dy` 或 `offset`、`parentId`、`revert` |
| `figma_arrange` | 对齐、分布、栅格、相对放置、fit、ungroup | `op` 及对应参数（`axis`/`edge`/`relativeTo`/`side`/`gap`/`align`/`size`/`padding`/`x`/`y`）、`revert` |
| `figma_pages` | 页面 list / create / switch / rename / delete | `action`、`name`、`page`、`from`、`to`、`confirm`、`revert` |

### 图片与矢量

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `figma_export_image` | 导出节点为 PNG/JPG/SVG/PDF 并落盘 | `nodeId`/`nodeIds`、`format`、`scale`、`clip`、`maxBytes` |
| `figma_import_image` | 导入本地图片 | `path`、`nodeId`、`x`/`y`/`width`/`height`、`scaleMode`、`revert` |
| `figma_import_svg` | 导入 SVG 为真实矢量图层 | `svg` 或 `path`、`parentId`、`x`/`y`/`width`/`height`、`revert` |

### 逃生口（默认关闭）

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `figma_run_code` | 在 Figma 插件沙箱执行 JS | `code`、`allowRemove` |
| `figma_page_eval` | 在 figma.com 页面主世界执行 JS | `expression` |

这两个工具分别需要 `FIGMALINK_ENABLE_RUN_CODE=1` / `FIGMALINK_ENABLE_PAGE_EVAL=1` 才能使用。

### 写操作的撤销语义

- **默认改完回滚（`revert:true`）**：`figma_create_node`、`figma_patch_node`、`figma_move_node`、`figma_group`、`figma_instance`（create）、`figma_delete_node`（hide）、`figma_duplicate`、`figma_import_image`、`figma_import_svg`。适合探针式操作，不会在文件里留东西。
- **默认保留（`revert:false`）**：`figma_build`、`figma_arrange`。整屏搭建和布局调整是目的本身，撤销靠 Figma 的 Ctrl+Z。
- **不可自动撤销，必须 `confirm:true`**：`figma_boolean`、`figma_delete_node`（remove）、`figma_instance`（detach）、`figma_pages`（delete）、`figma_create_file`。
- 修改类结果会带 `before` / `after` / `settled` 或审计字段，便于确认回滚是否真的落地。

### 结果过大时

读操作的结果超过 40KB 或 120 个节点时，完整内容会写到 `~/.figmalink/out/`，回包只给路径 + 裁剪后的树（截断处标 `omittedChildren`）。之后可按 `nodeId` 查子树，或调大 `FIGMALINK_MAX_NODES` / `FIGMALINK_RESULT_LIMIT_KB`。

### 多标签定向

同时开着多个 Figma 文件时，「当前活动标签」未必是你想改的那个。所以：

| 传参 | 行为 |
|---|---|
| `fileKey: "abc123"`（或链接） | 解析到正在显示该文件的标签页，找不到直接报错 |
| `tabId: 123` | 必须存在，不会静默换成别的标签页 |
| 都不传 | 读操作选最像编辑器的标签页，并在 `target.matchedBy` 标成 `heuristic` |

写操作不接受猜测：多标签时要么给 `tabId`，要么给 `fileKey`，否则扩展会拒绝。

## 配置

优先级：**命令行参数 > 环境变量 > 默认值**。

| 项目 | 命令行 | 环境变量 | 默认 |
|---|---|---|---|
| 端口 | `--port` / `-p` | `FIGMALINK_PORT` | `1210` |
| 配对 token | `--token` / `-t` | `FIGMALINK_TOKEN` | 首次启动自动生成并持久化 |
| 状态目录 | — | `FIGMALINK_PAIRING_FILE`、`FIGMALINK_OUT_DIR` | `~/.figmalink/` |
| 调用超时 | — | `FIGMALINK_TIMEOUT_MS` | `25000` |
| 结果预算 | — | `FIGMALINK_RESULT_LIMIT_KB`、`FIGMALINK_MAX_NODES` | `40` KB / `120` 节点 |
| 图片导入根目录 | — | `FIGMALINK_IMPORT_ROOT` | 当前工作目录 |
| 单次导入上限 | — | `FIGMALINK_IO_MAX_KB` | `4096` KB |
| `figma_run_code` | — | `FIGMALINK_ENABLE_RUN_CODE=1` | 关闭 |
| `figma_page_eval` | — | `FIGMALINK_ENABLE_PAGE_EVAL=1` | 关闭 |

也可以把参数写成环境变量（与 `--port` / `--token` 等价，命令行优先）：

```json
{
  "mcpServers": {
    "figmalink": {
      "command": "npx",
      "args": ["-y", "figmalink-mcp"],
      "env": {
        "FIGMALINK_PORT": "1210",
        "FIGMALINK_TOKEN": "my-token-1234",
        "FIGMALINK_IMPORT_ROOT": "path/to/your/project",
        "FIGMALINK_PAIRING_FILE": "path/to/.figmalink/pairing.json",
        "FIGMALINK_OUT_DIR": "path/to/.figmalink/out"
      }
    }
  }
}
```

- 不写 `FIGMALINK_TOKEN` 时用 `pairing.json` 里的值；写了会覆盖并写回该文件，要和扩展 popup 里填的一致。
- `FIGMALINK_PAIRING_FILE` 和 `FIGMALINK_OUT_DIR` 建议成对修改；状态目录默认是 `~/.figmalink/`。
- `FIGMALINK_IMPORT_ROOT` 限定 `figma_import_image` / `figma_import_svg` 能读取哪些本地路径；不写就是宿主进程的 cwd。
- 两个逃生口默认关闭，需要时再加对应的 `FIGMALINK_ENABLE_*`。

自定义 token 要 8–128 个可打印 ASCII 字符（不含空白）。端口或 token 非法时进程以 exit 64 退出并打印原因，不会静默退回默认值。

图片字节只在 server 和页面之间传递，不会进入模型上下文。

## 安全

- 只监听 `127.0.0.1`，首个配对的扩展来源会被钉住（`pinnedOrigin`），之后来源不一致会被拒。
- `POST /call` 控制面需要配对 token，并拒绝带 `Origin` 的请求和非回环来源。
- 写操作默认无痕；不可逆操作强制 `confirm:true` 并明确报告是否可撤销。
- 两个逃生口默认关闭，开启后可以绕过上述所有规则。

## 已知边界

- 变量只读，不支持写入。
- `figma.createImage` 导入的图片资源无法删除，即使节点被回滚。
- 一个标签页同时只能有一个 `chrome.debugger` 持有者，与其他 CDP 自动化工具互斥。
- 未覆盖 `layoutMode: GRID`、`layoutWrap` / `counterAxisSpacing`。

## 开发

```bash
cd bridge
npm install
npm run typecheck
npm test                 # 构建 + 桩回归 + 纯函数单测
npm run build
npm start                # = node dist/cli.js
npm run drive -- figma_read_tree '{"depth":2}'   # 直接调用在线 server
```

## License

Apache-2.0，见 [LICENSE](LICENSE)。

仓库：https://github.com/the-snare/FigmaLink-mcp
