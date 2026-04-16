import { describe, it, expect } from 'vitest';
import { formatMessagesForCompaction, COMPACT_MSG_CHARS } from '../compaction.js';
import type { Message, ContentRef } from '../types.js';

describe('formatMessagesForCompaction', () => {
  it('formats string content messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const result = formatMessagesForCompaction(messages);
    expect(result).toEqual(['[user]: hello', '[assistant]: hi there']);
  });

  it('formats tool call messages', () => {
    const messages: Message[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'file', arguments: '{}' } }] },
    ];
    const result = formatMessagesForCompaction(messages);
    expect(result).toEqual(['[assistant]: (tool call: file)']);
  });

  it('formats tool result messages', () => {
    const messages: Message[] = [
      { role: 'tool', content: 'file contents here', tool_call_id: '1' },
    ];
    const result = formatMessagesForCompaction(messages);
    expect(result[0]).toBe('[tool result]: file contents here');
  });

  it('truncates long string content', () => {
    const longContent = 'x'.repeat(1000);
    const messages: Message[] = [{ role: 'user', content: longContent }];
    const result = formatMessagesForCompaction(messages);
    expect(result[0].length).toBeLessThanOrEqual('[user]: '.length + COMPACT_MSG_CHARS);
  });

  it('formats ContentBlock messages, extracting text', () => {
    const messages: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'look at this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    }];
    const result = formatMessagesForCompaction(messages);
    expect(result[0]).toContain('look at this image');
    // Should not contain raw base64 data
    expect(result[0]).not.toContain('data:image/png;base64');
  });

  it('replaces content refs with text descriptions', () => {
    const ref: ContentRef = {
      type: 'content_ref', id: 1, hash: 'abc123', media_type: 'image/png',
      filename: 'screenshot.png', width: 1200, height: 800,
      size_bytes: 450000, cache_path: '/tmp/x.png', introduced_turn: 1,
    };
    const messages: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'check this' },
        ref,
      ],
    }];
    const result = formatMessagesForCompaction(messages);
    expect(result[0]).toContain('check this');
    expect(result[0]).toContain('content #1');
  });

  it('handles null content gracefully', () => {
    const messages: Message[] = [{ role: 'assistant', content: null }];
    const result = formatMessagesForCompaction(messages);
    expect(result[0]).toBe('[assistant]: ');
  });
});
