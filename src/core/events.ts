import type { Message, Usage } from './types.js';

// ── Event payloads ──

export interface TurnStartEvent {
  iteration: number;
  maxIterations: number;
  messageCount: number;
}

export interface TurnEndEvent {
  iteration: number;
  hadToolCalls: boolean;
  toolCallCount: number;
}

export interface BeforeRequestEvent {
  messages: Message[];
  systemPrompt: string;
  model: string;
  stream: boolean;
  baseURL?: string;
  provider?: string;
  maskedKey?: string;
  compacted?: boolean;
}

export interface AfterResponseEvent {
  message: Message;
  usage?: Usage;
  finishReason?: string | null;
  model?: string;
  baseURL?: string;
  provider?: string;
}

export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
}

export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  content: string;
  isError: boolean;
}

export interface BeforeCompactEvent {
  messageCount: number;
  cancel?: boolean;
  customSummary?: string;
}

export interface InputEvent {
  content: string;
  skip?: boolean;
}

export interface CheckpointCreateEvent {
  id: string;
  label?: string;
  messageIndex: number;
  turnNumber: number;
}

export interface CheckpointRestoreEvent {
  id: string;
  mode: 'code' | 'conversation' | 'both' | 'summarize';
  cancel?: boolean;
}

export interface AfterCompactEvent {
  messagesRemoved: number;
  newMessageCount: number;
  summaryPreview: string;
}

/** Fired after the request body is fully resolved (refs expanded, messages sanitized, tools included) but before fetch. Read-only. */
export interface RequestReadyEvent {
  url: string;
  body: Record<string, unknown>;
}

// ── Helpers ──

/** Derive the provider name from the model string or base URL. */
export function deriveProvider(model: string, baseURL: string): string {
  const slash = model.indexOf('/');
  if (slash > 0) return model.slice(0, slash);
  try {
    const host = new URL(baseURL).hostname;
    if (host.includes('openai')) return 'openai';
    if (host.includes('anthropic')) return 'anthropic';
    if (host.includes('openrouter')) return 'openrouter';
    return host.split('.')[0];
  } catch {
    return 'unknown';
  }
}

// ── Event map ──

export type EventMap = {
  turn_start: TurnStartEvent;
  turn_end: TurnEndEvent;
  before_request: BeforeRequestEvent;
  after_response: AfterResponseEvent;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  before_compact: BeforeCompactEvent;
  input: InputEvent;
  checkpoint_create: CheckpointCreateEvent;
  checkpoint_restore: CheckpointRestoreEvent;
  after_compact: AfterCompactEvent;
  request_ready: RequestReadyEvent;
};

export type EventName = keyof EventMap;
export type EventHandler<E extends EventName> = (event: EventMap[E]) => void | Promise<void>;

// ── Emitter ──

export class AgentEventEmitter {
  private handlers = new Map<string, Array<(event: unknown) => void | Promise<void>>>();

  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
    const list = this.handlers.get(event) || [];
    list.push(handler as (event: unknown) => void | Promise<void>);
    this.handlers.set(event, list);
    return () => {
      const idx = list.indexOf(handler as (event: unknown) => void | Promise<void>);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  async emit<E extends EventName>(event: E, data: EventMap[E]): Promise<void> {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const handler of list) {
      try {
        await handler(data);
      } catch (err) {
        process.stderr.write(`[ag] extension error in "${event}" handler: ${err instanceof Error ? err.message : err}\n`);
      }
    }
  }
}
