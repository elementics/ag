import { describe, it, expect } from 'vitest';
import { StreamChunk } from '../types.js';

/**
 * StreamChunk type contract tests — ensures the streaming interface
 * is well-defined and types are correct.
 */
describe('StreamChunk types', () => {
  it('text chunk has correct shape', () => {
    const chunk: StreamChunk = { type: 'text', content: 'hello' };
    expect(chunk.type).toBe('text');
    expect(chunk.content).toBe('hello');
  });

  it('tool_start chunk has correct shape', () => {
    const chunk: StreamChunk = { type: 'tool_start', toolName: 'bash', toolCallId: 'call_123' };
    expect(chunk.type).toBe('tool_start');
    expect(chunk.toolName).toBe('bash');
    expect(chunk.toolCallId).toBe('call_123');
  });

  it('tool_end chunk has correct shape', () => {
    const chunk: StreamChunk = { type: 'tool_end', toolName: 'file', toolCallId: 'call_456', content: 'result', resultRefId: 3, success: true };
    expect(chunk.type).toBe('tool_end');
    expect(chunk.toolName).toBe('file');
    expect(chunk.toolCallId).toBe('call_456');
    expect(chunk.success).toBe(true);
    expect(chunk.content).toBe('result');
    expect(chunk.resultRefId).toBe(3);
  });

  it('done chunk has correct shape', () => {
    const chunk: StreamChunk = { type: 'done', content: 'final response' };
    expect(chunk.type).toBe('done');
    expect(chunk.content).toBe('final response');
  });

  it('max_iterations chunk has correct shape', () => {
    const chunk: StreamChunk = { type: 'max_iterations' };
    expect(chunk.type).toBe('max_iterations');
    expect(chunk.content).toBeUndefined();
  });

  it('thinking chunk has correct shape', () => {
    const chunk: StreamChunk = { type: 'thinking', content: 'thinking [1/25]' };
    expect(chunk.type).toBe('thinking');
    expect(chunk.content).toBe('thinking [1/25]');
  });

  it('interrupted chunk has correct shape', () => {
    const chunk: StreamChunk = { type: 'interrupted', content: '2 completed, 1 cancelled' };
    expect(chunk.type).toBe('interrupted');
    expect(chunk.content).toBe('2 completed, 1 cancelled');
  });

  it('all chunk types are covered', () => {
    const validTypes = ['thinking', 'text', 'tool_start', 'tool_end', 'done', 'max_iterations', 'interrupted', 'steer'];
    const chunks: StreamChunk[] = [
      { type: 'thinking', content: 'thinking' },
      { type: 'text', content: 'a' },
      { type: 'tool_start', toolName: 'x' },
      { type: 'tool_end', toolName: 'x', success: true },
      { type: 'done' },
      { type: 'max_iterations' },
      { type: 'interrupted', content: 'stopped' },
      { type: 'steer', content: 'use JWT not sessions' },
    ];
    for (const chunk of chunks) {
      expect(validTypes).toContain(chunk.type);
    }
    expect(chunks.length).toBe(validTypes.length);
  });
});
