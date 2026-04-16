import { describe, it, expect } from 'vitest';
import { truncateToolResult, raceAll } from '../agent.js';

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
