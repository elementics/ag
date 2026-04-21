import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCompletionEngine } from '../../editor/completion.js';
import type { Agent } from '../../../core/agent.js';

// Minimal mock agent
function mockAgent(
  models: Array<{ id: string; name: string }> = [],
  plans: Array<{ name: string; path: string }> = [],
): Agent {
  return {
    fetchModels: vi.fn().mockResolvedValue(
      models.map(m => ({ ...m, context_length: 128000, pricing: {} })),
    ),
    getPlans: vi.fn().mockReturnValue(plans),
  } as unknown as Agent;
}

describe('CompletionEngine', () => {
  let engine: ReturnType<typeof createCompletionEngine>;

  beforeEach(() => {
    engine = createCompletionEngine(mockAgent());
  });

  // ── Slash commands ─────────────────────────────────────────────────────

  describe('slash commands', () => {
    it('completes /mo to /model', () => {
      const results = engine.complete('/mo') as any[];
      expect(results.some(c => c.text === '/model')).toBe(true);
    });

    it('returns all commands for bare /', () => {
      const results = engine.complete('/') as any[];
      expect(results.length).toBeGreaterThan(10);
    });

    it('completes /he to /help', () => {
      const results = engine.complete('/he') as any[];
      expect(results).toEqual([{ text: '/help', display: '/help' }]);
    });

    it('completes /per to both permissions and perms', () => {
      const results = engine.complete('/per') as any[];
      const texts = results.map(c => c.text);
      expect(texts).toContain('/permissions');
      expect(texts).toContain('/perms');
    });

    it('returns empty for non-matching prefix', () => {
      const results = engine.complete('/xyz') as any[];
      expect(results).toEqual([]);
    });
  });

  // ── Subcommands ────────────────────────────────────────────────────────

  describe('subcommands', () => {
    it('completes /config s to set', () => {
      const results = engine.complete('/config s') as any[];
      expect(results.some(c => c.text === 'set')).toBe(true);
    });

    it('completes /skill se to search', () => {
      const results = engine.complete('/skill se') as any[];
      expect(results).toEqual([{ text: 'search', display: 'search' }]);
    });

    it('lists all memory subcommands', () => {
      const results = engine.complete('/memory ') as any[];
      expect(results.map(c => c.text).sort()).toEqual(['clear', 'global', 'project']);
    });

    it('completes memory clear scopes in safer order', () => {
      const results = engine.complete('/memory clear ') as any[];
      expect(results.map(c => c.text)).toEqual(['session', 'project', 'all']);
    });

    it('completes clear alias scopes in safer order', () => {
      const results = engine.complete('/clear ') as any[];
      expect(results.map(c => c.text)).toEqual(['session', 'project', 'all']);
    });

    it('lists content subcommands', () => {
      const results = engine.complete('/content ') as any[];
      expect(results.map(c => c.text).sort()).toEqual(['add', 'clear', 'list', 'paste', 'screenshot']);
    });
  });

  // ── Plan use ───────────────────────────────────────────────────────────

  describe('plan use completion', () => {
    it('lists all plans for /plan use ', () => {
      const plans = [
        { name: '2026-04-21T11-40-59-bbc-news-fetch', path: '/plans/bbc.md' },
        { name: '2026-04-21T11-04-30-snippet-note', path: '/plans/snippet.md' },
      ];
      const eng = createCompletionEngine(mockAgent([], plans));
      const results = eng.complete('/plan use ') as any[];
      expect(results.map(c => c.text)).toEqual([plans[0].name, plans[1].name]);
    });

    it('filters plans by substring match', () => {
      const plans = [
        { name: '2026-04-21T11-40-59-bbc-news-fetch', path: '/plans/bbc.md' },
        { name: '2026-04-21T11-04-30-snippet-note', path: '/plans/snippet.md' },
      ];
      const eng = createCompletionEngine(mockAgent([], plans));
      const results = eng.complete('/plan use bbc') as any[];
      expect(results).toEqual([{ text: plans[0].name, display: plans[0].name }]);
    });

    it('returns empty when no plans match', () => {
      const eng = createCompletionEngine(mockAgent([], [{ name: 'some-plan', path: '/p.md' }]));
      const results = eng.complete('/plan use xyz') as any[];
      expect(results).toEqual([]);
    });
  });

  // ── Config keys ────────────────────────────────────────────────────────

  describe('config keys', () => {
    it('completes /config set ba to baseURL', () => {
      const results = engine.complete('/config set ba') as any[];
      expect(results.some(c => c.text === 'baseURL')).toBe(true);
    });

    it('completes /config unset api to apiKey only (no aliases)', () => {
      const results = engine.complete('/config unset api') as any[];
      const texts = results.map(c => c.text);
      expect(texts).toContain('apiKey');
      expect(texts).not.toContain('api_key');
    });

    it('includes only canonical keys for empty partial', () => {
      const results = engine.complete('/config set ') as any[];
      expect(results.length).toBeGreaterThanOrEqual(8);
      expect(results.every(c => !c.text.includes('_'))).toBe(true);
    });
  });

  // ── Model names ────────────────────────────────────────────────────────

  describe('model names', () => {
    it('returns empty before cache is populated', () => {
      const results = engine.complete('/model cla') as any[];
      expect(results).toEqual([]);
    });

    it('returns models after cache is populated', async () => {
      const models = [
        { id: 'claude-3-opus', name: 'Claude 3 Opus' },
        { id: 'claude-3-sonnet', name: 'Claude 3 Sonnet' },
        { id: 'gpt-4', name: 'GPT-4' },
      ];
      const agent = mockAgent(models);
      const eng = createCompletionEngine(agent);

      // First call triggers background fetch, returns empty
      const initial = eng.complete('/model cla') as any[];
      expect(initial).toEqual([]);

      // Grab the fetch promise before it's cleared
      const fetchPromise = (eng as any)._waitForModelFetch();
      await fetchPromise;

      // Verify fetchModels was called
      expect(agent.fetchModels).toHaveBeenCalledTimes(1);

      const results = eng.complete('/model cla') as any[];
      expect(results.length).toBe(2);
      expect(results.every(c => c.text.includes('claude'))).toBe(true);
    });

    it('does not match /model search', () => {
      const results = engine.complete('/model search ') as any[];
      // Should be empty since "search" subcommand doesn't trigger model completion
      expect(results).toEqual([]);
    });

    it('invalidateModelCache clears the cache', async () => {
      const models = [{ id: 'test-model', name: 'Test' }];
      const agent = mockAgent(models);
      const eng = createCompletionEngine(agent);

      eng.complete('/model t');
      await (eng as any)._waitForModelFetch();
      expect((eng.complete('/model t') as any[]).length).toBe(1);

      eng.invalidateModelCache();
      // After invalidation, cache is empty again
      expect((eng.complete('/model t') as any[])).toEqual([]);
    });
  });

  // ── File paths ─────────────────────────────────────────────────────────

  describe('file paths', () => {
    it('completes src/ directory listing', () => {
      const results = engine.complete('src/') as any[];
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(c => c.text.startsWith('src/'))).toBe(true);
    });

    it('completes partial file names', () => {
      const results = engine.complete('src/cli/re') as any[];
      expect(results.some(c => c.text.includes('repl'))).toBe(true);
    });

    it('returns empty for non-existent directory', () => {
      const results = engine.complete('/nonexistent/path/') as any[];
      expect(results).toEqual([]);
    });

    it('does not trigger for plain words', () => {
      const results = engine.complete('hello world') as any[];
      expect(results).toEqual([]);
    });
  });
});
