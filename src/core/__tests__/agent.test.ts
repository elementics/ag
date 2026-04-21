import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { truncateToolResult, raceAll, fetchWithRetry, Agent, parseToolArguments } from '../agent.js';

describe('truncateToolResult', () => {
  it('returns short results unchanged', () => {
    const result = 'hello world';
    expect(truncateToolResult(result)).toBe('hello world');
  });

  it('returns results at exactly the limit unchanged', () => {
    const result = 'x'.repeat(32768);
    expect(truncateToolResult(result)).toBe(result);
  });

  it('truncates results exceeding the character limit', () => {
    // Generate 400 lines, each long enough to exceed 32KB total
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}: ${'x'.repeat(120)}`);
    const result = lines.join('\n');
    expect(result.length).toBeGreaterThan(32768);

    const truncated = truncateToolResult(result);
    expect(truncated).toContain('line 1:');
    expect(truncated).toContain('line 100:');
    expect(truncated).toContain('lines truncated');
    expect(truncated).toContain('line 400:');
    expect(truncated).not.toContain('line 101:');
    expect(truncated).not.toContain('line 200:');
  });

  it('preserves head and tail lines', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i + 1}-${'y'.repeat(100)}`);
    const result = lines.join('\n');
    const truncated = truncateToolResult(result);

    // First 100 lines preserved
    expect(truncated).toContain('line-1-');
    expect(truncated).toContain('line-100-');
    // Last 100 lines preserved
    expect(truncated).toContain('line-401-');
    expect(truncated).toContain('line-500-');
    // Middle lines omitted
    expect(truncated).toContain('[300 lines truncated]');
  });

  it('does not truncate when few lines even if chars exceed limit', () => {
    // 150 lines with very long content — under the line threshold (100+100=200)
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i}: ${'z'.repeat(300)}`);
    const result = lines.join('\n');
    expect(result.length).toBeGreaterThan(32768);
    // Under 200 total lines (head + tail), so no truncation
    expect(truncateToolResult(result)).toBe(result);
  });

  it('handles empty string', () => {
    expect(truncateToolResult('')).toBe('');
  });

  it('handles single line', () => {
    expect(truncateToolResult('single line')).toBe('single line');
  });
});

describe('parseToolArguments', () => {
  it('parses valid JSON unchanged', () => {
    expect(parseToolArguments('{"action":"search","query":"test"}')).toEqual({ action: 'search', query: 'test' });
  });

  it('repairs code fences and trailing commas', () => {
    expect(parseToolArguments('```json\n{"action":"fetch","url":"https://example.com",}\n```')).toEqual({
      action: 'fetch',
      url: 'https://example.com',
    });
  });

  it('repairs truncated closing braces', () => {
    expect(parseToolArguments('{"action":"search","query":"latest status"')).toEqual({
      action: 'search',
      query: 'latest status',
    });
  });

  it('returns null for non-object JSON', () => {
    expect(parseToolArguments('["not","an","object"]')).toBeNull();
  });

  it('returns null when repair cannot recover valid JSON', () => {
    expect(parseToolArguments('action=search query=test')).toBeNull();
  });
});

describe('raceAll', () => {
  it('yields all results', async () => {
    const promises = [
      Promise.resolve('a'),
      Promise.resolve('b'),
      Promise.resolve('c'),
    ];
    const results: string[] = [];
    for await (const v of raceAll(promises)) {
      results.push(v);
    }
    expect(results.sort()).toEqual(['a', 'b', 'c']);
  });

  it('yields in resolution order not creation order', async () => {
    const delay = (ms: number, val: string) => new Promise<string>(r => setTimeout(() => r(val), ms));
    const promises = [
      delay(30, 'slow'),
      delay(10, 'fast'),
      delay(20, 'mid'),
    ];
    const results: string[] = [];
    for await (const v of raceAll(promises)) {
      results.push(v);
    }
    expect(results).toEqual(['fast', 'mid', 'slow']);
  });

  it('handles empty array', async () => {
    const results: string[] = [];
    for await (const v of raceAll<string>([])) {
      results.push(v);
    }
    expect(results).toEqual([]);
  });

  it('handles single promise', async () => {
    const results: number[] = [];
    for await (const v of raceAll([Promise.resolve(42)])) {
      results.push(v);
    }
    expect(results).toEqual([42]);
  });
});

// ── fetchWithRetry ──────────────────────────────────────────────────────────

describe('fetchWithRetry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(...responses: Array<{ status: number; ok?: boolean; headers?: Record<string, string>; body?: string }>): void {
    let callIndex = 0;
    globalThis.fetch = vi.fn(async () => {
      const resp = responses[Math.min(callIndex++, responses.length - 1)];
      return new Response(resp.body ?? '', {
        status: resp.status,
        headers: resp.headers,
      });
    }) as unknown as typeof fetch;
  }

  it('returns on first success without retry', async () => {
    mockFetch({ status: 200, ok: true });
    const res = await fetchWithRetry('http://test.com', {}, 3);
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 and succeeds on second attempt', async () => {
    mockFetch(
      { status: 503 },
      { status: 200, ok: true }
    );
    const res = await fetchWithRetry('http://test.com', {}, 3);
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 and 500', async () => {
    mockFetch(
      { status: 429 },
      { status: 500 },
      { status: 200, ok: true }
    );
    const res = await fetchWithRetry('http://test.com', {}, 3);
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 400 (non-retryable)', async () => {
    mockFetch({ status: 400 });
    const res = await fetchWithRetry('http://test.com', {}, 3);
    expect(res.status).toBe(400);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 401 (non-retryable)', async () => {
    mockFetch({ status: 401 });
    const res = await fetchWithRetry('http://test.com', {}, 3);
    expect(res.status).toBe(401);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 404 (non-retryable)', async () => {
    mockFetch({ status: 404 });
    const res = await fetchWithRetry('http://test.com', {}, 3);
    expect(res.status).toBe(404);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns last retryable response after exhausting retries', async () => {
    mockFetch(
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 }
    );
    const res = await fetchWithRetry('http://test.com', {}, 3);
    expect(res.status).toBe(503);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('throws AbortError without retrying', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    }) as unknown as typeof fetch;

    await expect(fetchWithRetry('http://test.com', {}, 3))
      .rejects.toThrow('Aborted');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on network error and succeeds', async () => {
    let callIndex = 0;
    globalThis.fetch = vi.fn(async () => {
      if (callIndex++ === 0) throw new TypeError('fetch failed');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry('http://test.com', {}, 3);
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on network errors', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await expect(fetchWithRetry('http://test.com', {}, 2))
      .rejects.toThrow('fetch failed');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('respects Retry-After header', async () => {
    mockFetch(
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 200, ok: true }
    );
    const start = Date.now();
    const res = await fetchWithRetry('http://test.com', {}, 3);
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    // Should have waited ~1000ms for the Retry-After
    expect(elapsed).toBeGreaterThanOrEqual(800);
  });

  it('works with maxRetries=0 (no retries)', async () => {
    mockFetch({ status: 503 });
    const res = await fetchWithRetry('http://test.com', {}, 0);
    expect(res.status).toBe(503);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// ── Local model support ─────────────────────────────────────────────────────

describe('local model support', () => {
  const origEnv = process.env.OPENROUTER_API_KEY;

  beforeEach(() => { delete process.env.OPENROUTER_API_KEY; });
  afterEach(() => {
    if (origEnv !== undefined) process.env.OPENROUTER_API_KEY = origEnv;
    else delete process.env.OPENROUTER_API_KEY;
  });

  it('accepts no API key when custom baseURL is set', () => {
    expect(() => new Agent({
      baseURL: 'http://localhost:11434/v1',
      model: 'gemma4',
      noHistory: true,
    })).not.toThrow();
  });

  it('accepts empty API key with custom baseURL', () => {
    expect(() => new Agent({
      baseURL: 'http://localhost:11434/v1',
      model: 'gemma4',
      apiKey: '',
      noHistory: true,
    })).not.toThrow();
  });

  it('still requires API key for default OpenRouter baseURL', () => {
    expect(() => new Agent({
      model: 'anthropic/claude-sonnet-4.6',
      noHistory: true,
    })).toThrow(/No API key/);
  });

  it('applies contextLength config to tracker', () => {
    const agent = new Agent({
      baseURL: 'http://localhost:11434/v1',
      model: 'gemma4',
      contextLength: 131072,
      noHistory: true,
    });
    expect(agent.getContextTracker().getContextLength()).toBe(131072);
  });

  it('has null context length for unknown model without contextLength', () => {
    const agent = new Agent({
      baseURL: 'http://localhost:11434/v1',
      model: 'gemma4',
      noHistory: true,
    });
    expect(agent.getContextTracker().getContextLength()).toBeNull();
  });
});

describe('result ref caching in agent loop', () => {
  const origFetch = globalThis.fetch;
  const fakeHome = `/tmp/__ag_test_home_${Math.random().toString(16).slice(2)}__`;
  const fakeCwd = `/tmp/__ag_test_agent_results_${Math.random().toString(16).slice(2)}__`;

  afterEach(async () => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('node:os');
    const { existsSync, rmSync } = await import('node:fs');
    if (existsSync(fakeHome)) rmSync(fakeHome, { recursive: true });
    if (existsSync(fakeCwd)) rmSync(fakeCwd, { recursive: true });
  });

  it('caches raw tool output while streaming the truncated preview and result ref id', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeCwd, { recursive: true });

    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => fakeHome };
    });

    const memory = await import('../../memory/memory.js');
    vi.spyOn(memory, 'loadContext').mockReturnValue('');

    const [{ Agent: IsolatedAgent, truncateToolResult: isolatedTruncate }, results] = await Promise.all([
      import('../agent.js'),
      import('../results.js'),
    ]);
    const { getResultRef, resolveResult, clearResultCache, resetResultStore } = results;

    resetResultStore();
    clearResultCache(fakeCwd);

    const rawLines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}: ${'x'.repeat(120)}`);
    const rawOutput = rawLines.join('\n');
    const previewOutput = isolatedTruncate(rawOutput);
    const bigTool = {
      type: 'function' as const,
      function: {
        name: 'bigtool',
        description: 'Returns a large payload.',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
      execute: async () => rawOutput,
    };

    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bigtool","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    globalThis.fetch = vi.fn(async () => new Response(sse, { status: 200 })) as unknown as typeof fetch;

    const agent = new IsolatedAgent({
      baseURL: 'http://localhost:11434/v1',
      model: 'gemma4',
      cwd: fakeCwd,
      noHistory: true,
      noSubAgents: true,
      maxIterations: 1,
      extraTools: [bigTool],
      interactionMode: 'auto',
    });

    const chunks = [];
    for await (const chunk of agent.chatStream('run bigtool')) {
      chunks.push(chunk);
    }

    const toolEnd = chunks.find(chunk => chunk.type === 'tool_end');
    expect(toolEnd).toBeDefined();
    expect(toolEnd?.content).toBe(previewOutput);
    expect(toolEnd?.resultRefId).toBe(1);

    const ref = getResultRef(1);
    expect(ref).toBeDefined();
    expect(ref?.size_chars).toBe(rawOutput.length);
    expect(resolveResult(ref!)).toBe(rawOutput);
    expect(resolveResult(ref!)).not.toBe(previewOutput);
  });
});
