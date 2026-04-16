import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isReadOnlyToolCall, fetchWithRetry } from '../agent.js';

// ── isReadOnlyToolCall ──────────────────────────────────────────────────────

describe('isReadOnlyToolCall', () => {
  it('grep is always read-only', () => {
    expect(isReadOnlyToolCall('grep', { action: 'search' })).toBe(true);
    expect(isReadOnlyToolCall('grep', { action: 'find' })).toBe(true);
    expect(isReadOnlyToolCall('grep', {})).toBe(true);
  });

  it('memory is always read-only', () => {
    expect(isReadOnlyToolCall('memory', { action: 'save' })).toBe(true);
  });

  it('task is always read-only', () => {
    expect(isReadOnlyToolCall('task', { action: 'create' })).toBe(true);
    expect(isReadOnlyToolCall('task', { action: 'update' })).toBe(true);
  });

  it('agent is always read-only', () => {
    expect(isReadOnlyToolCall('agent', { prompt: 'do stuff' })).toBe(true);
  });

  it('file read/list are read-only, write/edit are not', () => {
    expect(isReadOnlyToolCall('file', { action: 'read' })).toBe(true);
    expect(isReadOnlyToolCall('file', { action: 'list' })).toBe(true);
    expect(isReadOnlyToolCall('file', { action: 'write' })).toBe(false);
    expect(isReadOnlyToolCall('file', { action: 'edit' })).toBe(false);
  });

  it('git status is read-only, other git actions are not', () => {
    expect(isReadOnlyToolCall('git', { action: 'status' })).toBe(true);
    expect(isReadOnlyToolCall('git', { action: 'commit' })).toBe(false);
    expect(isReadOnlyToolCall('git', { action: 'push' })).toBe(false);
  });

  it('web search is read-only, fetch is not', () => {
    expect(isReadOnlyToolCall('web', { action: 'search' })).toBe(true);
    expect(isReadOnlyToolCall('web', { action: 'fetch' })).toBe(false);
  });

  it('bash is never read-only', () => {
    expect(isReadOnlyToolCall('bash', { command: 'ls' })).toBe(false);
  });

  it('unknown tools are not read-only', () => {
    expect(isReadOnlyToolCall('custom_tool', {})).toBe(false);
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
