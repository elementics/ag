import { describe, it, expect } from 'vitest';
import { extractFileOps, TURN_SUMMARY_THRESHOLD } from '../summarization.js';
import type { Message } from '../types.js';

describe('extractFileOps', () => {
  it('extracts file read paths from file tool calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant', content: null,
        tool_calls: [{
          id: '1', type: 'function',
          function: { name: 'file', arguments: '{"action":"read","path":"/src/agent.ts"}' },
        }],
      },
    ];
    const ops = extractFileOps(messages);
    expect(ops.read).toEqual(['/src/agent.ts']);
    expect(ops.modified).toEqual([]);
  });

  it('extracts file write/edit paths', () => {
    const messages: Message[] = [
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'file', arguments: '{"action":"write","path":"/src/new.ts"}' } },
          { id: '2', type: 'function', function: { name: 'file', arguments: '{"action":"edit","path":"/src/old.ts"}' } },
        ],
      },
    ];
    const ops = extractFileOps(messages);
    expect(ops.read).toEqual([]);
    expect(ops.modified).toEqual(['/src/new.ts', '/src/old.ts']);
  });

  it('deduplicates paths', () => {
    const messages: Message[] = [
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'file', arguments: '{"action":"read","path":"/src/a.ts"}' } },
          { id: '2', type: 'function', function: { name: 'file', arguments: '{"action":"read","path":"/src/a.ts"}' } },
        ],
      },
    ];
    const ops = extractFileOps(messages);
    expect(ops.read).toEqual(['/src/a.ts']);
  });

  it('handles messages with no tool calls', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const ops = extractFileOps(messages);
    expect(ops.read).toEqual([]);
    expect(ops.modified).toEqual([]);
  });

  it('handles malformed tool call arguments', () => {
    const messages: Message[] = [
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'file', arguments: '{{invalid json' } },
        ],
      },
    ];
    const ops = extractFileOps(messages);
    expect(ops.read).toEqual([]);
    expect(ops.modified).toEqual([]);
  });

  it('extracts from multiple messages', () => {
    const messages: Message[] = [
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'file', arguments: '{"action":"read","path":"/src/a.ts"}' } },
        ],
      },
      { role: 'tool', content: 'file content', tool_call_id: '1' },
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: '2', type: 'function', function: { name: 'file', arguments: '{"action":"write","path":"/src/b.ts"}' } },
        ],
      },
    ];
    const ops = extractFileOps(messages);
    expect(ops.read).toEqual(['/src/a.ts']);
    expect(ops.modified).toEqual(['/src/b.ts']);
  });

  it('ignores non-file tools', () => {
    const messages: Message[] = [
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'bash', arguments: '{"command":"cat /src/a.ts"}' } },
          { id: '2', type: 'function', function: { name: 'grep', arguments: '{"action":"search","pattern":"foo"}' } },
        ],
      },
    ];
    const ops = extractFileOps(messages);
    expect(ops.read).toEqual([]);
    expect(ops.modified).toEqual([]);
  });

  it('handles file list action as read', () => {
    const messages: Message[] = [
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'file', arguments: '{"action":"list","path":"/src"}' } },
        ],
      },
    ];
    const ops = extractFileOps(messages);
    expect(ops.read).toEqual(['/src']);
  });
});

describe('TURN_SUMMARY_THRESHOLD', () => {
  it('is 3 tool calls', () => {
    expect(TURN_SUMMARY_THRESHOLD).toBe(3);
  });
});
