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
}

export interface AfterResponseEvent {
  message: Message;
  usage?: Usage;
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
