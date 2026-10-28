#!/usr/bin/env node
// Entry point for both faces: the MCP host spawns this via stdio, and an operator can run
// it directly to serve the ws control face.
import { createBridge } from './app.js';
import { ConfigError, loadConfig, usage } from './config.js';
import { log } from './log.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(usage());
  process.exit(0);
}

try {
  createBridge(loadConfig(argv, process.env)).start();
} catch (err) {
  if (err instanceof ConfigError) {
    log(err.message);
    process.exit(err.exitCode);
  }
  log(`启动失败：${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
}
