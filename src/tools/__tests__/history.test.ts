import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { historyTool } from '../history.js';
import { appendHistory, paths } from '../../memory/memory.js';

const fakeCwd = `/tmp/__ag_test_history_tool_${randomBytes(8).toString('hex')}__`;

let history: ReturnType<typeof historyTool>;

beforeEach(() => {
  mkdirSync(fakeCwd, { recursive: true });
  // Ensure project dir exists
  paths(fakeCwd);
  history = historyTool(fakeCwd);
});

afterEach(() => {
  // Clean up project dir under ~/.ag
  const p = paths(fakeCwd);
  if (existsSync(p.projectDir)) rmSync(p.projectDir, { recursive: true });
  if (existsSync(fakeCwd)) rmSync(fakeCwd, { recursive: true });
});

describe('history tool - search', () => {
  it('finds user messages by keyword', async () => {
    appendHistory({ role: 'user', content: 'tell me about pragmata fonts' }, fakeCwd);
    appendHistory({ role: 'assistant', content: 'PragmataPro is a coding font.' }, fakeCwd);

    const result = await history.execute({ action: 'search', query: 'pragmata' });
    expect(result).toContain('pragmata');
    expect(result).toContain('USER');
  });

  it('finds assistant messages by keyword', async () => {
    appendHistory({ role: 'user', content: 'hello' }, fakeCwd);
    appendHistory({ role: 'assistant', content: 'The refactoring is complete.' }, fakeCwd);

    const result = await history.execute({ action: 'search', query: 'refactoring' });
    expect(result).toContain('refactoring');
    expect(result).toContain('ASSISTANT');
  });

  it('searches tool call names', async () => {
    appendHistory({
      role: 'assistant', content: null,
      tool_calls: [{ id: '1', type: 'function', function: { name: 'web', arguments: '{"action":"search","query":"React hooks"}' } }],
    }, fakeCwd);

    const result = await history.execute({ action: 'search', query: 'web' });
    expect(result).toContain('tools: web');
  });

  it('searches tool call arguments (paths)', async () => {
    appendHistory({
      role: 'assistant', content: null,
      tool_calls: [{ id: '1', type: 'function', function: { name: 'file', arguments: '{"action":"read","path":"/src/agent.ts"}' } }],
    }, fakeCwd);

    const result = await history.execute({ action: 'search', query: 'agent.ts' });
    expect(result).toContain('agent.ts');
  });

  it('searches result ref summaries', async () => {
    appendHistory({
      role: 'tool', tool_call_id: '1',
      content: [{ type: 'result_ref', id: 1, tool_name: 'web', summary: 'Title: PragmataPro Review', size_chars: 5000, cache_path: '/tmp/r.txt', introduced_turn: 1 }] as any,
    }, fakeCwd);

    const result = await history.execute({ action: 'search', query: 'PragmataPro' });
    expect(result).toContain('PragmataPro');
  });

  it('returns no matches message when nothing found', async () => {
    appendHistory({ role: 'user', content: 'hello world' }, fakeCwd);

    const result = await history.execute({ action: 'search', query: 'nonexistent-xyz' });
    expect(result).toContain('No matches');
  });

  it('returns error when query is empty', async () => {
    const result = await history.execute({ action: 'search' });
    expect(result).toMatch(/query is required/i);
  });

  it('is case-insensitive', async () => {
    appendHistory({ role: 'user', content: 'Tell me about PRAGMATA' }, fakeCwd);

    const result = await history.execute({ action: 'search', query: 'pragmata' });
    expect(result).toContain('PRAGMATA');
  });

  it('returns empty history message when no history exists', async () => {
    const result = await history.execute({ action: 'search', query: 'anything' });
    expect(result).toContain('No conversation history');
  });
});

describe('history tool - recent', () => {
  it('shows last N entries', async () => {
    appendHistory({ role: 'user', content: 'message one' }, fakeCwd);
    appendHistory({ role: 'assistant', content: 'reply one' }, fakeCwd);
    appendHistory({ role: 'user', content: 'message two' }, fakeCwd);
    appendHistory({ role: 'assistant', content: 'reply two' }, fakeCwd);

    const result = await history.execute({ action: 'recent', limit: 2 });
    expect(result).toContain('message two');
    expect(result).toContain('reply two');
    expect(result).not.toContain('message one');
  });

  it('defaults to 10 entries', async () => {
    for (let i = 0; i < 15; i++) {
      appendHistory({ role: 'user', content: `msg-${i}` }, fakeCwd);
    }

    const result = await history.execute({ action: 'recent' });
    expect(result).toContain('msg-14');
    expect(result).toContain('msg-5');
    expect(result).not.toContain('msg-4');
  });

  it('handles empty history', async () => {
    const result = await history.execute({ action: 'recent' });
    expect(result).toContain('No conversation history');
  });
});

describe('history tool - action validation', () => {
  it('returns error for unknown action', async () => {
    const result = await history.execute({ action: 'delete' });
    expect(result).toMatch(/Unknown action/);
    expect(result).toContain('search');
    expect(result).toContain('recent');
  });
});
