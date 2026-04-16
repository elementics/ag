import { describe, it, expect, vi } from 'vitest';
import { AgentEventEmitter } from '../events.js';
import type { TurnStartEvent, ToolCallEvent, InputEvent } from '../events.js';

describe('AgentEventEmitter', () => {
  it('on() registers handler and returns unsubscribe function', async () => {
    const emitter = new AgentEventEmitter();
    const handler = vi.fn();
    const unsub = emitter.on('turn_start', handler);

    await emitter.emit('turn_start', { iteration: 0, maxIterations: 25, messageCount: 1 });
    expect(handler).toHaveBeenCalledOnce();

    unsub();
    await emitter.emit('turn_start', { iteration: 1, maxIterations: 25, messageCount: 2 });
    expect(handler).toHaveBeenCalledOnce(); // still 1 — unsubscribed
  });

  it('emit() calls handlers sequentially in registration order', async () => {
    const emitter = new AgentEventEmitter();
    const order: number[] = [];

    emitter.on('turn_start', async () => { order.push(1); });
    emitter.on('turn_start', async () => { order.push(2); });
    emitter.on('turn_start', async () => { order.push(3); });

    await emitter.emit('turn_start', { iteration: 0, maxIterations: 25, messageCount: 1 });
    expect(order).toEqual([1, 2, 3]);
  });

  it('handlers can mutate event data and subsequent handlers see mutations', async () => {
    const emitter = new AgentEventEmitter();

    emitter.on('input', (event: InputEvent) => {
      event.content = event.content.toUpperCase();
    });
    emitter.on('input', (event: InputEvent) => {
      event.content += '!';
    });

    const data: InputEvent = { content: 'hello' };
    await emitter.emit('input', data);
    expect(data.content).toBe('HELLO!');
  });

  it('async handlers are awaited before next handler runs', async () => {
    const emitter = new AgentEventEmitter();
    const order: string[] = [];

    emitter.on('turn_start', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push('slow');
    });
    emitter.on('turn_start', () => {
      order.push('fast');
    });

    await emitter.emit('turn_start', { iteration: 0, maxIterations: 25, messageCount: 1 });
    expect(order).toEqual(['slow', 'fast']); // slow finishes before fast starts
  });

  it('unsubscribe removes only that handler', async () => {
    const emitter = new AgentEventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('turn_start', h1);
    const unsub2 = emitter.on('turn_start', h2);

    unsub2();
    await emitter.emit('turn_start', { iteration: 0, maxIterations: 25, messageCount: 1 });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).not.toHaveBeenCalled();
  });

  it('emitting event with no handlers is a no-op', async () => {
    const emitter = new AgentEventEmitter();
    // Should not throw
    await emitter.emit('turn_start', { iteration: 0, maxIterations: 25, messageCount: 1 });
  });

  it('multiple events do not interfere with each other', async () => {
    const emitter = new AgentEventEmitter();
    const turnHandler = vi.fn();
    const inputHandler = vi.fn();

    emitter.on('turn_start', turnHandler);
    emitter.on('input', inputHandler);

    await emitter.emit('turn_start', { iteration: 0, maxIterations: 25, messageCount: 1 });
    expect(turnHandler).toHaveBeenCalledOnce();
    expect(inputHandler).not.toHaveBeenCalled();

    await emitter.emit('input', { content: 'test' });
    expect(turnHandler).toHaveBeenCalledOnce();
    expect(inputHandler).toHaveBeenCalledOnce();
  });

  it('tool_call block flag prevents execution when set', async () => {
    const emitter = new AgentEventEmitter();

    emitter.on('tool_call', (event: ToolCallEvent) => {
      if (event.toolName === 'bash' && String(event.args.command).includes('rm -rf')) {
        event.block = true;
        event.blockReason = 'Dangerous command blocked';
      }
    });

    const safeEvent: ToolCallEvent = { toolName: 'bash', toolCallId: '1', args: { command: 'ls' } };
    await emitter.emit('tool_call', safeEvent);
    expect(safeEvent.block).toBeUndefined();

    const dangerEvent: ToolCallEvent = { toolName: 'bash', toolCallId: '2', args: { command: 'rm -rf /' } };
    await emitter.emit('tool_call', dangerEvent);
    expect(dangerEvent.block).toBe(true);
    expect(dangerEvent.blockReason).toBe('Dangerous command blocked');
  });

  it('tool_result content can be mutated', async () => {
    const emitter = new AgentEventEmitter();

    emitter.on('tool_result', (event) => {
      event.content = event.content.replace(/secret/g, '[REDACTED]');
    });

    const data = { toolName: 'file', toolCallId: '1', args: {}, content: 'found secret key', isError: false };
    await emitter.emit('tool_result', data);
    expect(data.content).toBe('found [REDACTED] key');
  });

  it('before_compact cancel prevents compaction', async () => {
    const emitter = new AgentEventEmitter();

    emitter.on('before_compact', (event) => {
      event.cancel = true;
    });

    const data = { messageCount: 100, cancel: false, customSummary: undefined as string | undefined };
    await emitter.emit('before_compact', data);
    expect(data.cancel).toBe(true);
  });

  it('before_request messages can be filtered by handler', async () => {
    const emitter = new AgentEventEmitter();

    emitter.on('before_request', (event) => {
      event.messages = event.messages.filter(m => m.role !== 'tool');
    });

    const data = {
      messages: [
        { role: 'user' as const, content: 'hi' },
        { role: 'tool' as const, content: 'result', tool_call_id: '1' },
        { role: 'assistant' as const, content: 'hello' },
      ],
      systemPrompt: 'test',
      model: 'test',
      stream: true,
    };
    await emitter.emit('before_request', data);
    expect(data.messages).toHaveLength(2);
    expect(data.messages.every(m => m.role !== 'tool')).toBe(true);
  });
});
