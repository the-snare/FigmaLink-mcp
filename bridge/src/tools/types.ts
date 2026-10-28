export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';

export interface JsonSchema {
  type?: JsonSchemaType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: string[];
  oneOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
}

export type ToolKind = 'read' | 'write' | 'import' | 'importText' | 'export' | 'control';

/**
 * `kind` is what the call pipeline branches on; `readOnly` is the MCP annotation and
 * deliberately does not follow `kind` (selection and tabs are read-only but are routed
 * as control messages).
 */
export interface ToolDef {
  name: string;
  op: string;
  kind?: ToolKind;
  readOnly: boolean;
  description: string;
  timeoutMs?: number;
  /** Always keep the full payload for this tool instead of trimming the tree. */
  pack?: boolean;
  inputSchema: JsonSchema;
}

export type ToolArgs = Record<string, unknown>;

export interface CallPayload {
  ok: boolean;
  tool?: string;
  error?: unknown;
  [key: string]: unknown;
}

export interface CallOutcome {
  payload: CallPayload;
  isError: boolean;
}

export type CallHandler = (name: string, args: ToolArgs) => Promise<CallOutcome>;
