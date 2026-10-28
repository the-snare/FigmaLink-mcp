English | [中文](README.zh-CN.md)

# figmalink-mcp

MCP (stdio) server that reads and writes a **live Figma canvas** through the FigmaLink
Chrome extension. It does not use the Figma REST API and needs no Figma token, so it
works on a Free plan account.

The npm package contains the MCP server only. The browser extension is published as a
zip on GitHub Releases:
**https://github.com/the-snare/FigmaLink-mcp/releases**

## Requirements

- Node.js **>= 20.11**
- Chrome / Chromium with the FigmaLink extension loaded
- A Figma design file open in an editor tab

## How it works

```
Agent ⇄ stdio MCP ⇄ figmalink-mcp ⇄ ws://127.0.0.1:1210 ⇄ Chrome extension ⇄ chrome.debugger ⇄ window.figma
```

The WebSocket is a private control channel for the extension, not the MCP transport.
`window.figma` is guarded by a stack check in the Figma page, so the extension executes
plugin API calls through `chrome.debugger` (`Runtime.evaluate`) rather than a content
script.

## Quick start

### 1. Add the MCP server

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

- `--port` defaults to `1210`.
- `--token` is optional. When omitted, a token is generated on first start and stored in
  `~/.figmalink/pairing.json`.
- A custom token must be 8–128 printable ASCII characters without whitespace.
- stdout carries MCP frames only; logs and the pairing token go to stderr.

### 2. Install the browser extension

Download the extension zip from [Releases](https://github.com/the-snare/FigmaLink-mcp/releases), unzip it, then load it with Chrome
developer mode:

```text
chrome://extensions → Developer mode → Load unpacked → select the extension/ directory
```

Official Chrome only accepts extensions from the Chrome Web Store, so a self-signed CRX
cannot be installed by double-clicking or dragging; `--load-extension` is ignored on
recent stable builds. Keep using the unpacked directory.

### 3. Pair

Open the extension popup:

- **URL** — `ws://127.0.0.1:1210` (must match `--port`)
- **Token** — the same value as `--token`, or the one in `~/.figmalink/pairing.json`
- Click the plug icon (*Save and reconnect*)

Then call `figma_status` from the agent. If the bridge is not reachable, tool errors
include a `pairing` block with the URL, token and popup steps.

## MCP tools

Every tool also accepts optional `tabId` / `fileKey` arguments to target a specific
browser tab.

### Read

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `figma_status` | Check the link, page and live `window.figma` members | — |
| `figma_get_selection` | Read the current selection | — |
| `figma_read_tree` | Walk the scene graph | `nodeId`, `depth` (1–6), `offset`, `limit` |
| `figma_get_node` | Exact property snapshot of one node | `nodeId` / `useSelection` |
| `figma_find` | Find nodes by type and/or name regex | `nodeId`, `wholeDocument`, `types`, `name`, `icase`, `limit` |
| `figma_variables` | List local variable collections and values | — |
| `figma_get_styles` | List paint / text / effect / grid styles | `limit` |
| `figma_get_prototype` | Read prototype connections, flows or a trace | `mode` (connections/flows/trace), `nodeId`, `depth`, `limit`, `maxDepth` |
| `figma_tabs` | List visible Figma tabs | — |

### Navigate and select

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `figma_open` | Open or focus a file and wait until the editor is ready | `url`, `fileKey`, `nodeId`, `raw`, `reuse`, `newTab`, `activate`, `waitMs` |
| `figma_create_file` | Create a new draft file | `confirm` (required), `activate`, `waitMs` |
| `figma_set_selection` | Select nodes and zoom the viewport | `nodeIds` / `nodeId`, `scrollToFit` |

### Create and modify

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `figma_create_node` | Create one node | `kind`, `props`, `parentId`, `revert` |
| `figma_build` | Build a nested tree in one call | `spec`, `parentId`, `maxNodes`, `revert` |
| `figma_patch_node` | Change one or many nodes | `nodeId` + `patch` or `patches[]`, `revert` |
| `figma_move_node` | Re-parent or reorder a node | `nodeId`, `parentId`, `index`, `revert` |
| `figma_group` | Group 2+ sibling nodes | `nodeIds`, `name`, `revert` |
| `figma_boolean` | Union / subtract / intersect / exclude | `op`, `nodeIds`, `name`, `confirm` (required) |
| `figma_instance` | Create or detach a component instance | `action`, `nodeId`, `parentId`, `props`, `confirm`, `revert` |
| `figma_delete_node` | Hide (reversible) or remove (permanent) | `nodeId`, `mode` (hide/remove), `confirm`, `revert` |
| `figma_duplicate` | Duplicate nodes with per-copy offsets | `nodeId` / `nodeIds`, `count`, `dx` / `dy` or `offset`, `parentId`, `revert` |
| `figma_arrange` | Align, distribute, grid, place, fit, ungroup | `op` plus `axis` / `edge` / `relativeTo` / `side` / `gap` / `align` / `size` / `padding` / `x` / `y`, `revert` |
| `figma_pages` | Page list / create / switch / rename / delete | `action`, `name`, `page`, `from`, `to`, `confirm`, `revert` |

### Images and vectors

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `figma_export_image` | Export nodes to PNG/JPG/SVG/PDF on disk | `nodeId` / `nodeIds`, `format`, `scale`, `clip`, `maxBytes` |
| `figma_import_image` | Import a local image | `path`, `nodeId`, `x` / `y` / `width` / `height`, `scaleMode`, `revert` |
| `figma_import_svg` | Import SVG as real vector layers | `svg` or `path`, `parentId`, `x` / `y` / `width` / `height`, `revert` |

### Escape hatches (off by default)

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `figma_run_code` | Run JS in the Figma plugin sandbox | `code`, `allowRemove` |
| `figma_page_eval` | Run JS in the figma.com page main world | `expression` |

Enable them with `FIGMALINK_ENABLE_RUN_CODE=1` / `FIGMALINK_ENABLE_PAGE_EVAL=1`.

### Revert and confirm semantics

- **Revert after read (`revert:true`)** by default: `figma_create_node`,
  `figma_patch_node`, `figma_move_node`, `figma_group`, `figma_instance` (create),
  `figma_delete_node` (hide), `figma_duplicate`, `figma_import_image`,
  `figma_import_svg`.
- **Keep the change (`revert:false`)** by default: `figma_build`, `figma_arrange`.
- **Permanent, requires `confirm:true`**: `figma_boolean`, `figma_delete_node` (remove),
  `figma_instance` (detach), `figma_pages` (delete), `figma_create_file`.

### Large results

Read results larger than 40 KB or 120 nodes are written to `~/.figmalink/out/`; the tool
returns the path plus a trimmed tree with `omittedChildren` markers. Query a subtree by
`nodeId` or raise `FIGMALINK_MAX_NODES` / `FIGMALINK_RESULT_LIMIT_KB`.

### Multi-tab targeting

With several Figma tabs open, reads may pick the most editor-like tab and report
`target.matchedBy: "heuristic"`. Writes do not guess: pass `tabId` or `fileKey`, or the
extension refuses the call.

## Configuration

Precedence: **CLI flag > environment variable > default**.

| Knob | CLI | Environment | Default |
| --- | --- | --- | --- |
| Port | `--port`, `-p` | `FIGMALINK_PORT` | `1210` |
| Pairing token | `--token`, `-t` | `FIGMALINK_TOKEN` | generated and persisted |
| State files | — | `FIGMALINK_PAIRING_FILE`, `FIGMALINK_OUT_DIR` | `~/.figmalink/` |
| Call timeout | — | `FIGMALINK_TIMEOUT_MS` | `25000` |
| Result budget | — | `FIGMALINK_RESULT_LIMIT_KB`, `FIGMALINK_MAX_NODES` | `40` KB / `120` nodes |
| Image import root | — | `FIGMALINK_IMPORT_ROOT` | current working directory |
| Image size cap | — | `FIGMALINK_IO_MAX_KB` | `4096` KB |
| `figma_run_code` | — | `FIGMALINK_ENABLE_RUN_CODE=1` | off |
| `figma_page_eval` | — | `FIGMALINK_ENABLE_PAGE_EVAL=1` | off |

The same values can be supplied through the MCP `env` block:

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

`path/...` is a placeholder; use absolute paths. If `FIGMALINK_TOKEN` is omitted, the
value in `pairing.json` is used. If it is set, it overwrites the token and writes it back
to that file, so the extension popup must use the same value.

An invalid port or token exits with code `64` instead of falling back to a default.

## Two processes, one port

If another instance already owns the port, this process becomes an **MCP proxy** and
forwards `tools/call` over HTTP to the owner. If the owner dies, the next call takes the
port over. This makes it safe to register the connector while also running the server
manually.

## Security

- Binds `127.0.0.1` only and pins the first paired extension origin.
- The `POST /call` control face requires the pairing token, rejects requests with an
  `Origin` header, and rejects non-loopback peers.
- Write tools default to revert-after-read; irreversible operations require
  `confirm:true`.
- The two escape hatches are opt-in.

## Limitations

- Variables are read-only.
- `figma.createImage` keeps imported image resources in the file even after the node is
  reverted.
- Only one `chrome.debugger` client can attach to a tab, so this conflicts with other
  CDP automation.
- `layoutMode: GRID` and `layoutWrap` / `counterAxisSpacing` are not covered.

## License

Apache-2.0. See [LICENSE](./LICENSE).
