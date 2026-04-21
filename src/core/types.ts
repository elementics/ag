// ── Content block types (multimodal support) ────────────────────────────────

export interface TextBlock {
  type: 'text';
  text: string;
}

/** OpenRouter-native image format — works across Claude, GPT-4o, Gemini, etc. */
export interface ImageUrlBlock {
  type: 'image_url';
  image_url: { url: string };
}

/** OpenRouter-native file format — auto-parsed for non-native models */
export interface FileBlock {
  type: 'file';
  file: { filename: string; file_data: string };
}

/** Lightweight pointer stored in messages instead of full content data */
export interface ContentRef {
  type: 'content_ref';
  id: number;
  hash: string;
  media_type: string;
  filename?: string;
  width?: number;
  height?: number;
  page_count?: number;
  size_bytes: number;
  cache_path: string;
  introduced_turn: number;
}

/** Lightweight pointer to a cached tool result — full content sent on introduction turn only */
export interface ResultRef {
  type: 'result_ref';
  id: number;
  tool_name: string;
  summary: string;
  size_chars: number;
  cache_path: string;
  introduced_turn: number;
}

export type ContentBlock = TextBlock | ImageUrlBlock | FileBlock | ContentRef | ResultRef;

// ── Message ─────────────────────────────────────────────────────────────────

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Internal turn number — used for turn collapsing, stripped before API send and history write */
  _turn?: number;
  /** Internal flag — marks injected steer messages */
  _steer?: boolean;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Declares which tool args map to permission pattern qualifier/value for custom tools */
export interface PermissionKey {
  /** Arg name whose value becomes the pattern qualifier (e.g. "target" → deploy(staging)) */
  qualifier: string;
  /** Arg name whose value is matched by the glob portion (optional) */
  value?: string;
}

export interface Tool {
  type: 'function';
  function: ToolDefinition;
  permissionKey?: PermissionKey;
  /** Mark tool as plan-mode safe. `true` = all actions; `string[]` = only listed action values. */
  readOnly?: true | string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tools destructure their own typed params from parsed JSON
  execute: (args: any) => Promise<string> | string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

export type InteractionMode = 'plan' | 'auto';

/** Return 'allow' to proceed, 'deny' to skip the tool call */
export type ConfirmToolCall = (toolName: string, args: Record<string, unknown>, permissionKey?: PermissionKey) => Promise<'allow' | 'deny'>;

export interface ToolLoadFailure {
  file: string;
  name?: string;
  reason: string;
}

export interface AgentConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  systemPrompt?: string;
  systemPromptSuffix?: string;
  maxIterations?: number;
  cwd?: string;
  extraTools?: Tool[];
  toolFailures?: ToolLoadFailure[];
  stream?: boolean;
  confirmToolCall?: ConfirmToolCall;
  noHistory?: boolean;
  noSubAgents?: boolean;
  silent?: boolean;
  contextLength?: number;
  interactionMode?: InteractionMode;
}

export interface StreamChunk {
  type: 'thinking' | 'text' | 'tool_start' | 'tool_end' | 'done' | 'max_iterations' | 'interrupted' | 'steer';
  content?: string;
  toolName?: string;
  toolCallId?: string;
  resultRefId?: number;
  success?: boolean;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  cost?: number;  // Provider-reported cost (e.g. OpenRouter)
}

export interface CLIOptions {
  model?: string;
  key?: string;
  system?: string;
  baseURL?: string;
  maxIterations?: number;
  help?: boolean;
  stats?: boolean;
  yes?: boolean;
  contentPaths?: string[];
}
