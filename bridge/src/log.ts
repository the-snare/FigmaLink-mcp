// stdout is reserved for MCP frames; every human-readable line goes to stderr.
export type Logger = (message: string) => void;

export const log: Logger = (message) => {
  process.stderr.write(`[figmalink] ${message}\n`);
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
