import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resultTool } from '../result.js';
import { resetResultStore, cacheResult, consumeRequestedResults, clearResultCache } from '../../core/results.js';

const fakeCwd = `/tmp/__ag_test_result_tool_${randomBytes(8).toString('hex')}__`;

let result: ReturnType<typeof resultTool>;

beforeEach(() => {
  resetResultStore();
  clearResultCache(fakeCwd);
  mkdirSync(fakeCwd, { recursive: true });
  result = resultTool(fakeCwd);
});

afterEach(() => {
  clearResultCache(fakeCwd);
  if (existsSync(fakeCwd)) rmSync(fakeCwd, { recursive: true });
});

describe('result tool - get', () => {
  it('returns content description for valid ref', async () => {
    cacheResult('file', 'full file content here\nline 2\nline 3', 1, fakeCwd, { action: 'read', path: '/src/foo.ts' });

    const output = await result.execute({ action: 'get', ref: 1 });
    expect(output).toContain('result #1');
    expect(output).toContain('file');
  });

  it('returns error for unknown ref', async () => {
    const output = await result.execute({ action: 'get', ref: 999 });
    expect(output).toMatch(/not found/i);
  });

  it('requires ref parameter', async () => {
    const output = await result.execute({ action: 'get' });
    expect(output).toMatch(/ref is required/i);
  });

  it('marks ref as requested for re-injection', async () => {
    cacheResult('bash', 'output', 1, fakeCwd);
    consumeRequestedResults(); // Clear prior state

    await result.execute({ action: 'get', ref: 1 });
    const requested = consumeRequestedResults();
    expect(requested.has(1)).toBe(true);
  });
});

describe('result tool - info', () => {
  it('returns metadata for valid ref', async () => {
    cacheResult('bash', 'x'.repeat(3000), 2, fakeCwd);

    const output = await result.execute({ action: 'info', ref: 1 });
    expect(output).toContain('Result #1');
    expect(output).toContain('Tool: bash');
    expect(output).toContain('3000 chars');
    expect(output).toContain('Turn introduced: 2');
  });

  it('returns error for unknown ref', async () => {
    const output = await result.execute({ action: 'info', ref: 42 });
    expect(output).toMatch(/not found/i);
  });

  it('does not mark ref as requested', async () => {
    cacheResult('file', 'content', 1, fakeCwd);
    consumeRequestedResults();

    await result.execute({ action: 'info', ref: 1 });
    const requested = consumeRequestedResults();
    expect(requested.size).toBe(0);
  });
});

describe('result tool - action validation', () => {
  it('returns error for unknown action', async () => {
    const output = await result.execute({ action: 'delete', ref: 1 });
    expect(output).toMatch(/Unknown action/);
    expect(output).toContain('get');
    expect(output).toContain('info');
  });
});
