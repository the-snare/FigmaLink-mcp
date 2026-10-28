English | [中文](README.md)

# FigmaLink (`figmalink-mcp`)

Read and write a **live Figma canvas** over MCP: no Figma REST API, no Figma token, and it
works on a Free plan account.

The project has two parts:

- `bridge/` — the MCP server (TypeScript, npm package `figmalink-mcp`). It exposes stdio
  MCP to the agent and a local WebSocket control face to the browser extension.
- `extension/` — an MV3 Chrome extension that runs plugin API calls in the already-open
  Figma editor through `chrome.debugger`.

## How it works

```
Agent ⇄ stdio MCP ⇄ figmalink-mcp ⇄ ws://127.0.0.1:1210 ⇄ Chrome extension ⇄ chrome.debugger ⇄ page bridge ⇄ window.figma
```

The WebSocket is a private control channel for the extension, not the MCP transport. The
extension does not implement MCP; it only answers `{id, op, arg} → {id, ok, result}`.

`window.figma` is guarded by a stack check in the Figma page (a call frame containing
`chrome-extension://` is rejected), so plugin API calls must run through
`chrome.debugger`'s `Runtime.evaluate`; a content script cannot reach the API.

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

`--port` defaults to `1210`. If `--token` is omitted, a token is generated on first start
and stored in `~/.figmalink/pairing.json`. Restart the agent or reconnect MCP after
changing the config.

### 2. Install the browser extension

Download the latest extension zip from [Releases](https://github.com/the-snare/FigmaLink-mcp/releases), unzip it, and load it with
developer mode:

```text
chrome://extensions → enable Developer mode → Load unpacked → select extension/
```

Click **Reload** on the extension card after changing extension code.

### 3. Pair

Open the extension popup:

- **URL** — `ws://127.0.0.1:1210` (must match `--port`)
- **Token** — the same value as `--token`, or the one in `~/.figmalink/pairing.json`
  (the example uses `my-token-1234`)
- Click the plug icon (*Save and reconnect*)

Then call `figma_status` from the agent. If the link is down, tool errors include a
`pairing` block with the values to paste into the popup.

For running from source, see **Development**.

## MCP tools

There are 28 tools. Every tool also accepts optional `tabId` / `fileKey` arguments to
target a specific tab (see **Multi-tab targeting** below).

### Read

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `figma_status` | Check the link, the page and live `window.figma` members | — |
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
| `figma_create_file` | Create a new draft file | `confirm` (must be `true`), `activate`, `waitMs` |
| `figma_set_selection` | Select nodes and zoom the viewport | `nodeIds` / `nodeId`, `scrollToFit` |

### Create and modify

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `figma_create_node` | Create one node | `kind`, `props`, `parentId`, `revert` |
| `figma_build` | Build a nested tree in one call | `spec`, `parentId`, `maxNodes`, `revert` |
| `figma_patch_node` | Change properties on one or many nodes | `nodeId` + `patch` or `patches[]`, `revert` |
| `figma_move_node` | Re-parent or reorder a node | `nodeId`, `parentId`, `index`, `revert` |
| `figma_group` | Group 2+ sibling nodes | `nodeIds`, `name`, `revert` |
| `figma_boolean` | Union / subtract / intersect / exclude | `op`, `nodeIds`, `name`, `confirm` (must be `true`) |
| `figma_instance` | Create or detach a component instance | `action`, `nodeId`, `parentId`, `props`, `confirm`, `revert` |
| `figma_delete_node` | Hide (reversible) or remove (permanent) a node | `nodeId`, `mode` (hide/remove), `confirm`, `revert` |
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

These require `FIGMALINK_ENABLE_RUN_CODE=1` / `FIGMALINK_ENABLE_PAGE_EVAL=1`.

### Revert semantics

- **Revert after the call (`revert:true`)** by default: `figma_create_node`,
  `figma_patch_node`, `figma_move_node`, `figma_group`, `figma_instance` (create),
  `figma_delete_node` (hide), `figma_duplicate`, `figma_import_image`,
  `figma_import_svg`. Good for probe-style operations that must leave no trace.
- **Keep the change (`revert:false`)** by default: `figma_build`, `figma_arrange`.
  Building a screen and adjusting layout are the point; undo with Figma's Ctrl+Z.
- **Permanent, requires `confirm:true`**: `figma_boolean`, `figma_delete_node` (remove),
  `figma_instance` (detach), `figma_pages` (delete), `figma_create_file`.
- Write results include `before` / `after` / `settled` or audit fields so the caller can
  verify that a restore actually landed.

### Large results

Read results larger than 40 KB or 120 nodes are written to `~/.figmalink/out/`; the reply
contains the path plus a trimmed tree (`omittedChildren` marks truncated branches). Query
a subtree by `nodeId` or raise `FIGMALINK_MAX_NODES` / `FIGMALINK_RESULT_LIMIT_KB`.

### Multi-tab targeting

With several Figma files open, "the active tab" is not necessarily the one you want:

| Argument | Behavior |
| --- | --- |
| `fileKey: "abc123"` (or a link) | Resolve the tab showing that file; fail if none |
| `tabId: 123` | Must exist; never silently switch to another tab |
| Neither | Reads pick the most editor-like tab and report `target.matchedBy: "heuristic"` |

Writes do not guess: with multiple tabs, pass `tabId` or `fileKey` or the extension
refuses the call.

## Configuration

Precedence: **CLI flag > environment variable > default**.

| Knob | CLI | Environment | Default |
| --- | --- | --- | --- |
| Port | `--port` / `-p` | `FIGMALINK_PORT` | `1210` |
| Pairing token | `--token` / `-t` | `FIGMALINK_TOKEN` | generated on first start, then persisted |
| State directory | — | `FIGMALINK_PAIRING_FILE`, `FIGMALINK_OUT_DIR` | `~/.figmalink/` |
| Call timeout | — | `FIGMALINK_TIMEOUT_MS` | `25000` |
| Result budget | — | `FIGMALINK_RESULT_LIMIT_KB`, `FIGMALINK_MAX_NODES` | `40` KB / `120` nodes |
| Image import root | — | `FIGMALINK_IMPORT_ROOT` | current working directory |
| Image size cap | — | `FIGMALINK_IO_MAX_KB` | `4096` KB |
| `figma_run_code` | — | `FIGMALINK_ENABLE_RUN_CODE=1` | off |
| `figma_page_eval` | — | `FIGMALINK_ENABLE_PAGE_EVAL=1` | off |

The same values can be supplied as environment variables (equivalent to `--port` /
`--token`; CLI wins):

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

- If `FIGMALINK_TOKEN` is omitted, the value in `pairing.json` is used. If set, it
  overwrites the token and writes it back to that file; the extension popup must use the
  same value.
- Change `FIGMALINK_PAIRING_FILE` and `FIGMALINK_OUT_DIR` together; the default state
  directory is `~/.figmalink/`.
- `FIGMALINK_IMPORT_ROOT` limits which local paths `figma_import_image` /
  `figma_import_svg` may read; the default is the host process cwd.
- The two escape hatches are off by default; add the corresponding
  `FIGMALINK_ENABLE_*` when needed.

A custom token must be 8–128 printable ASCII characters without whitespace. An invalid
port or token exits with code `64` and prints the reason instead of silently falling back
to a default.

Image bytes only travel between the server and the page; they never enter the model
context.

## Security

- Binds `127.0.0.1` only; the first paired extension origin is pinned (`pinnedOrigin`) and
  later origins are rejected.
- The `POST /call` control face requires the pairing token, rejects requests with an
  `Origin` header, and rejects non-loopback peers.
- Writes leave no trace by default; irreversible operations require `confirm:true` and
  report whether undo is available.
- The two escape hatches are off by default; enabling them bypasses the rules above.

## Limitations

- Variables are read-only.
- `figma.createImage` keeps imported image resources in the file even after the node is
  reverted.
- Only one `chrome.debugger` client can attach to a tab, so this conflicts with other CDP
  automation.
- `layoutMode: GRID` and `layoutWrap` / `counterAxisSpacing` are not covered.

## Development

```bash
cd bridge
npm install
npm run typecheck
npm test                 # build + stub regression + pure unit tests
npm run build
npm start                # = node dist/cli.js
npm run drive -- figma_read_tree '{"depth":2}'   # call the live server directly
```

## License

Apache-2.0. See [LICENSE](LICENSE).

Repository: https://github.com/the-snare/FigmaLink-mcp
