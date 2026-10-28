# figmalink-mcp

MCP (stdio) server that reads and writes a **live Figma canvas** through the FigmaLink
Chrome extension. It does not use the Figma REST API and needs no Figma token; the
extension drives the already-open editor tab over `chrome.debugger`, and this server
pairs with that extension on `ws://127.0.0.1:1210`.

The extension, the full tool reference and the protocol notes live in the main repo:
**https://github.com/the-snare/FigmaLink-mcp**

## Requirements

- Node.js **>= 20.11**
- Chrome / Chromium with the FigmaLink extension installed
- A Figma design file open in an editor tab

## Quick start

```bash
npx figmalink-mcp
```

The server speaks MCP on stdin/stdout and listens on the loopback control port. Nothing
human-readable is ever written to stdout — the pairing URL and token go to stderr.

Register it with an MCP host (pi, Claude Desktop, …):

```json
{
  "mcpServers": {
    "figmalink": {
      "command": "npx",
      "args": ["-y", "figmalink-mcp"]
    }
  }
}
```

Then open the extension popup and paste:

- **URL** — `ws://127.0.0.1:1210`
- **Token** — the value printed next to `配对 token` in the server log
  (also stored in the state directory)

Click the plug icon (*Save and reconnect*). Once the badge shows connected, every
`figma_*` tool works.

## Configuration

Precedence is always **CLI flag > environment variable > default**.

| Knob | CLI | Environment | Default |
| --- | --- | --- | --- |
| Port | `--port`, `-p` | `FIGMALINK_PORT` | `1210` |
| Pairing token | `--token`, `-t` | `FIGMALINK_TOKEN` | generated once, then persisted |
| State directory | — | `FIGMALINK_PAIRING_FILE`, `FIGMALINK_OUT_DIR` | `~/.figmalink` |
| Call timeout | — | `FIGMALINK_TIMEOUT_MS` | `25000` |
| Result budget | — | `FIGMALINK_RESULT_LIMIT_KB`, `FIGMALINK_MAX_NODES` | `40 KB`, `120` nodes |
| Image import root | — | `FIGMALINK_IMPORT_ROOT` | current working directory |
| Image size cap | — | `FIGMALINK_IO_MAX_KB` | `4096` |
| `figma_run_code` | — | `FIGMALINK_ENABLE_RUN_CODE=1` | off |
| `figma_page_eval` | — | `FIGMALINK_ENABLE_PAGE_EVAL=1` | off |

Runtime state (pairing token, oversized tool results, exported images) is written to
`~/.figmalink`, never inside the installed package. Set `FIGMALINK_*` overrides if that
location is not appropriate.

An invalid port or token exits with code `64` instead of silently falling back to a
default — otherwise a mismatched popup looks like a broken bridge.

## Two processes, one port

If the port is already taken by another instance, this process becomes an **MCP proxy**
and forwards `tools/call` over HTTP to the owner. That is what makes it safe to register
the connector while also running the server manually. If the owner dies, the next call
takes the port over.

## Security notes

- Binds `127.0.0.1` only, and pins the first paired extension origin.
- The `POST /call` control face requires the pairing token, rejects requests carrying an
  `Origin` header, and rejects non-loopback peers.
- Write tools default to revert-after-read; irreversible operations require explicit
  `confirm: true`.
- The two escape hatches (`figma_run_code`, `figma_page_eval`) are opt-in via env.

## License

Apache-2.0. See [LICENSE](./LICENSE).
