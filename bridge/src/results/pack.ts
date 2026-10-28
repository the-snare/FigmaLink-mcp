// Result budgeting for the bridge. Scene-graph dumps are large and every byte of a
// tool result lands in the agent's context, so anything over the limit is written to
// disk in full and only a trimmed tree travels back over MCP.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackInput {
  outDir: string;
  toolName: string;
  result: unknown;
  limitBytes: number;
  maxNodes: number;
}

export interface PackedResult {
  packed: boolean;
  savedTo?: string;
  bytes: number;
  nodeCount: number;
  returnedNodes?: number;
  result: unknown;
  hint?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function isNode(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string' && typeof value.type === 'string';
}

export function countNodes(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((total, child) => total + countNodes(child), 0);
  const record = asRecord(node);
  if (!record) return 0;
  let count = isNode(record) ? 1 : 0;
  if (Array.isArray(record.children)) count += countNodes(record.children);
  return count;
}

// Depth-first with a hard global cap, so the worst case is bounded no matter how wide
// the page is. Truncated branches are marked instead of silently dropped.
export function trimTree(root: unknown, maxNodes: number): { tree: unknown; kept: number } {
  let used = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    const record = asRecord(node);
    if (!record) return node;
    const copy: Record<string, unknown> = { ...record };
    used += 1;
    if (Array.isArray(record.children)) {
      const kept: unknown[] = [];
      for (const child of record.children) {
        if (used >= maxNodes) break;
        kept.push(walk(child));
      }
      const dropped = record.children.length - kept.length;
      copy.children = kept;
      if (dropped > 0) copy.omittedChildren = dropped;
    }
    return copy;
  };
  return { tree: walk(root), kept: used };
}

export function packResult({ outDir, toolName, result, limitBytes, maxNodes }: PackInput): PackedResult {
  const text = JSON.stringify(result, null, 2);
  const bytes = Buffer.byteLength(text, 'utf8');
  const nodeCount = countNodes(result);

  if (bytes <= limitBytes && nodeCount <= maxNodes) {
    return { packed: false, bytes, nodeCount, result };
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const savedTo = join(outDir, `${toolName}-${stamp}.json`);
  writeFileSync(savedTo, text);
  const trimmed = trimTree(result, maxNodes);
  return {
    packed: true,
    savedTo,
    bytes,
    nodeCount,
    returnedNodes: trimmed.kept,
    result: trimmed.tree,
    hint:
      '完整结果在 savedTo 里；要更细的层就按 nodeId 子树重查，或调 FIGMALINK_MAX_NODES / FIGMALINK_RESULT_LIMIT_KB。'
  };
}
