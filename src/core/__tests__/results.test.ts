import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  resetResultStore, cacheResult, getResultRef, resolveResult,
  markResultRequested, consumeRequestedResults, getAllResultRefs,
  generateResultSummary, saveResultIndex, restoreResultIndex,
  clearResultCache, RESULT_REF_THRESHOLD,
} from '../results.js';

const fakeCwd = `/tmp/__ag_test_results_${randomBytes(8).toString('hex')}__`;

beforeEach(() => {
  resetResultStore();
  clearResultCache(fakeCwd);  // Clean disk state from prior test
  mkdirSync(fakeCwd, { recursive: true });
});

afterEach(() => {
  clearResultCache(fakeCwd);
  if (existsSync(fakeCwd)) rmSync(fakeCwd, { recursive: true });
});

describe('cacheResult', () => {
  it('caches result to disk and returns ResultRef', () => {
    const content = 'x'.repeat(3000);
    const ref = cacheResult('file', content, 1, fakeCwd, { action: 'read', path: '/src/foo.ts' });

    expect(ref.type).toBe('result_ref');
    expect(ref.id).toBe(1);
    expect(ref.tool_name).toBe('file');
    expect(ref.size_chars).toBe(3000);
    expect(ref.introduced_turn).toBe(1);
    expect(ref.summary).toContain('/src/foo.ts');
    expect(existsSync(ref.cache_path)).toBe(true);
  });

  it('increments IDs across calls', () => {
    const ref1 = cacheResult('bash', 'output1', 1, fakeCwd);
    const ref2 = cacheResult('bash', 'output2', 1, fakeCwd);
    expect(ref1.id).toBe(1);
    expect(ref2.id).toBe(2);
  });

  it('stores in resultRefs map', () => {
    cacheResult('file', 'content', 1, fakeCwd);
    expect(getResultRef(1)).toBeDefined();
    expect(getResultRef(1)!.tool_name).toBe('file');
  });
});

describe('resolveResult', () => {
  it('reads cached file from disk', () => {
    const content = 'full tool output here';
    const ref = cacheResult('bash', content, 1, fakeCwd);
    expect(resolveResult(ref)).toBe(content);
  });

  it('returns error for missing cache file', () => {
    const ref = cacheResult('bash', 'temp', 1, fakeCwd);
    rmSync(ref.cache_path);
    expect(resolveResult(ref)).toMatch(/not found/i);
  });
});

describe('generateResultSummary', () => {
  it('summarizes file read with path and line count', () => {
    const content = 'line1\nline2\nline3\n';
    const summary = generateResultSummary('file', content, { action: 'read', path: '/src/agent.ts' });
    expect(summary).toContain('/src/agent.ts');
    expect(summary).toMatch(/\d+ lines/);
  });

  it('summarizes file write/edit with path', () => {
    const summary = generateResultSummary('file', 'OK', { action: 'write', path: '/src/foo.ts' });
    expect(summary).toContain('Wrote/edited /src/foo.ts');
  });

  it('summarizes bash with first line + last 3 lines + exit code', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`);
    lines.push('EXIT 0');
    const summary = generateResultSummary('bash', lines.join('\n'));
    expect(summary).toContain('output line 1');
    expect(summary).toContain('output line 18');
    expect(summary).toContain('output line 19');
    expect(summary).toContain('output line 20');
    expect(summary).toContain('[exit 0]');
  });

  it('summarizes bash with short output verbatim', () => {
    const summary = generateResultSummary('bash', 'hello world\nEXIT 0');
    expect(summary).toBe('hello world [exit 0]');
  });

  it('summarizes grep with match count and preview', () => {
    const lines = [
      'src/a.ts:10:const foo = 1',
      'src/b.ts:20:const bar = 2',
      'src/c.ts:30:const baz = 3',
      'src/d.ts:40:const qux = 4',
    ];
    const summary = generateResultSummary('grep', lines.join('\n'));
    expect(summary).toContain('src/a.ts');
    expect(summary).toContain('src/b.ts');
    expect(summary).toContain('src/c.ts');
    expect(summary).toContain('4 matches');
    expect(summary).toContain('4 file(s)');
  });

  it('summarizes grep with no matches', () => {
    const summary = generateResultSummary('grep', '');
    expect(summary).toContain('No matches');
  });

  it('summarizes default with truncation', () => {
    const content = 'x'.repeat(500);
    const summary = generateResultSummary('unknown_tool', content);
    expect(summary.length).toBeLessThan(300);
    expect(summary).toContain('500 chars');
  });

  it('keeps short default results verbatim', () => {
    const summary = generateResultSummary('unknown_tool', 'short result');
    expect(summary).toBe('short result');
  });

  it('handles empty result string', () => {
    const summary = generateResultSummary('bash', '');
    expect(typeof summary).toBe('string');
  });
});

describe('markResultRequested / consumeRequestedResults', () => {
  it('marks and consumes correctly', () => {
    markResultRequested(1);
    markResultRequested(2);
    const requested = consumeRequestedResults();
    expect(requested.has(1)).toBe(true);
    expect(requested.has(2)).toBe(true);
    expect(requested.size).toBe(2);
  });

  it('consume clears the set', () => {
    markResultRequested(1);
    consumeRequestedResults();
    const second = consumeRequestedResults();
    expect(second.size).toBe(0);
  });
});

describe('getAllResultRefs', () => {
  it('returns all cached refs', () => {
    cacheResult('file', 'content1', 1, fakeCwd);
    cacheResult('bash', 'content2', 2, fakeCwd);
    const all = getAllResultRefs();
    expect(all.length).toBe(2);
    expect(all[0].tool_name).toBe('file');
    expect(all[1].tool_name).toBe('bash');
  });
});

describe('saveResultIndex / restoreResultIndex', () => {
  it('roundtrips save and restore', () => {
    cacheResult('file', 'content', 1, fakeCwd);
    cacheResult('bash', 'output', 2, fakeCwd);
    saveResultIndex(fakeCwd);

    // Reset in-memory state and restore
    resetResultStore();
    expect(getAllResultRefs().length).toBe(0);

    restoreResultIndex(fakeCwd);
    expect(getAllResultRefs().length).toBe(2);
    expect(getResultRef(1)!.tool_name).toBe('file');
    expect(getResultRef(2)!.tool_name).toBe('bash');
  });

  it('restores nextId correctly', () => {
    cacheResult('file', 'a', 1, fakeCwd);
    cacheResult('file', 'b', 1, fakeCwd);
    saveResultIndex(fakeCwd);

    resetResultStore();
    restoreResultIndex(fakeCwd);

    // Next cached result should get id=3, not id=1
    const ref = cacheResult('file', 'c', 2, fakeCwd);
    expect(ref.id).toBe(3);
  });

  it('handles missing index file gracefully', () => {
    restoreResultIndex(fakeCwd); // Should not throw
    expect(getAllResultRefs().length).toBe(0);
  });

  it('handles corrupt index file gracefully', () => {
    const dir = join(fakeCwd, '.ag-test-corrupt');
    mkdirSync(dir, { recursive: true });
    // Write corrupt JSON to the expected path — we need to use the actual path
    cacheResult('file', 'content', 1, fakeCwd);
    saveResultIndex(fakeCwd);
    // Corrupt the index
    const indexPath = getAllResultRefs()[0].cache_path.replace(/\/\d+\.txt$/, '/index.json');
    writeFileSync(indexPath, '{{not json}}');

    resetResultStore();
    restoreResultIndex(fakeCwd); // Should not throw
    expect(getAllResultRefs().length).toBe(0);
  });

  it('skips refs with missing cache files', () => {
    const ref = cacheResult('file', 'content', 1, fakeCwd);
    saveResultIndex(fakeCwd);

    // Delete the cached file but keep the index
    rmSync(ref.cache_path);

    resetResultStore();
    restoreResultIndex(fakeCwd);
    expect(getAllResultRefs().length).toBe(0);
  });
});

describe('resetResultStore', () => {
  it('clears all in-memory state', () => {
    cacheResult('file', 'content', 1, fakeCwd);
    markResultRequested(1);
    resetResultStore();

    expect(getAllResultRefs().length).toBe(0);
    expect(getResultRef(1)).toBeUndefined();
    expect(consumeRequestedResults().size).toBe(0);
  });

  it('resets ID counter', () => {
    cacheResult('file', 'a', 1, fakeCwd);
    cacheResult('file', 'b', 1, fakeCwd);
    resetResultStore();

    const ref = cacheResult('file', 'c', 1, fakeCwd);
    expect(ref.id).toBe(1);
  });
});

describe('clearResultCache', () => {
  it('removes results directory and resets store', () => {
    const ref = cacheResult('file', 'content', 1, fakeCwd);
    const dir = ref.cache_path.replace(/\/\d+\.txt$/, '');
    saveResultIndex(fakeCwd);

    expect(existsSync(dir)).toBe(true);
    clearResultCache(fakeCwd);

    expect(existsSync(dir)).toBe(false);
    expect(getAllResultRefs().length).toBe(0);
    expect(getResultRef(1)).toBeUndefined();
  });

  it('handles missing directory gracefully', () => {
    clearResultCache(fakeCwd); // Should not throw
  });
});

describe('RESULT_REF_THRESHOLD', () => {
  it('is 2048 chars', () => {
    expect(RESULT_REF_THRESHOLD).toBe(2048);
  });
});
