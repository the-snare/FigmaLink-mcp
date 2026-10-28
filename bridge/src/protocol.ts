// Wire formats. Both faces are line/datagram JSON; keeping the shapes in one module is
// what stops the extension client and the MCP host from agreeing only by accident.

export interface WsCallMessage {
  type: 'call';
  id: string;
  op: string;
  arg: unknown;
  timeoutMs: number;
  tabId: number | null;
  fileKey: string | null;
  strict: boolean;
}

export interface WsHelloMessage {
  type: 'hello';
  token?: string;
  version?: string;
  bridgeVersion?: string;
  bootId?: string;
}

export interface WsResultMessage {
  type: 'result';
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  target?: unknown;
}

export interface WsEventMessage {
  type: 'event';
  name?: string;
  detail?: unknown;
}

export interface WsUnknownMessage {
  type: string;
  [key: string]: unknown;
}

export type WsInbound = WsHelloMessage | WsResultMessage | WsEventMessage | WsUnknownMessage;

export interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface RpcError {
  code: number;
  message: string;
}

export interface TargetSelection {
  tabId: number | null;
  fileKey: string | null;
  strict: boolean;
}

export interface ExtensionOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  target?: unknown;
  /** Only present on "no client": the pairing instruction sheet. */
  pairing?: unknown;
}
