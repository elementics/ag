import { describe, it, expect } from 'vitest';
import { ContextTracker } from '../context.js';

describe('ContextTracker', () => {
  describe('constructor', () => {
    it('resolves known model context length', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      expect(t.getContextLength()).toBe(200000);
    });

    it('resolves prefix match for model variants', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6:beta');
      expect(t.getContextLength()).toBe(200000);
    });

    it('returns null for unknown models', () => {
      const t = new ContextTracker('unknown/model');
      expect(t.getContextLength()).toBeNull();
    });
  });

  describe('setContextLength', () => {
    it('overrides context length', () => {
      const t = new ContextTracker('unknown/model');
      t.setContextLength(500000);
      expect(t.getContextLength()).toBe(500000);
    });
  });

  describe('update', () => {
    it('stores usage from API response', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
      expect(t.getUsedTokens()).toBe(1000);
    });
  });

  describe('estimateFromChars', () => {
    it('estimates tokens at 4 chars per token', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.estimateFromChars(8000);
      // estimated tokens = ceil(8000/4) = 2000
      // format should show estimated
      const output = t.format();
      expect(output).toContain('~');
      expect(output).toContain('2.0K');
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
      t.reset();
      expect(t.getUsedTokens()).toBeNull();
      expect(t.format()).toBe('');
    });
  });

  describe('shouldCompact', () => {
    it('returns false when no usage data', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      expect(t.shouldCompact()).toBe(false);
    });

    it('returns false when context length unknown', () => {
      const t = new ContextTracker('unknown/model');
      t.update({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
      expect(t.shouldCompact()).toBe(false);
    });

    it('returns false when below threshold', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({ prompt_tokens: 100000, completion_tokens: 200, total_tokens: 100200 });
      expect(t.shouldCompact()).toBe(false); // 50% < 90%
    });

    it('returns true when at or above threshold', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({ prompt_tokens: 180000, completion_tokens: 200, total_tokens: 180200 });
      expect(t.shouldCompact()).toBe(true); // 90% >= 90%
    });

    it('supports custom threshold', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({ prompt_tokens: 160000, completion_tokens: 200, total_tokens: 160200 });
      expect(t.shouldCompact(0.8)).toBe(true);  // 80% >= 80%
      expect(t.shouldCompact(0.9)).toBe(false);  // 80% < 90%
    });

    it('uses estimate when available (no prior API data)', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      // 800000 chars / 4 = 200000 tokens = 100% of 200K context
      t.estimateFromChars(800000);
      expect(t.shouldCompact()).toBe(true);
    });

    it('prefers estimate over stale API data', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      // API says 50% used
      t.update({ prompt_tokens: 100000, completion_tokens: 200, total_tokens: 100200 });
      expect(t.shouldCompact()).toBe(false);
      // Estimate says 95% used (e.g. after large tool results added)
      t.estimateFromChars(760000); // 760000/4 = 190000 tokens = 95%
      expect(t.shouldCompact()).toBe(true);
    });

    it('reverts to API data after update() clears estimate', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      // Estimate says 95% used
      t.estimateFromChars(760000);
      expect(t.shouldCompact()).toBe(true);
      // API responds with actual 50% usage (estimate was too high)
      t.update({ prompt_tokens: 100000, completion_tokens: 200, total_tokens: 100200 });
      expect(t.shouldCompact()).toBe(false);
    });
  });

  describe('format', () => {
    it('returns empty string when no context length', () => {
      const t = new ContextTracker('unknown/model');
      expect(t.format()).toBe('');
    });

    it('returns empty string when no usage data and no estimate', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      expect(t.format()).toBe('');
    });

    it('includes progress bar and percentage with real usage', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({ prompt_tokens: 100000, completion_tokens: 200, total_tokens: 100200 });
      const output = t.format();
      expect(output).toContain('50%');
      expect(output).toContain('Context');
    });
  });

  describe('formatDetailed', () => {
    it('shows no-data message initially', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      expect(t.formatDetailed()).toContain('No usage data');
    });

    it('shows estimated tokens', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.estimateFromChars(4000);
      expect(t.formatDetailed()).toContain('Estimated');
    });

    it('shows prompt/completion/total breakdown', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({ prompt_tokens: 5000, completion_tokens: 1000, total_tokens: 6000 });
      const output = t.formatDetailed();
      expect(output).toContain('Prompt');
      expect(output).toContain('Completion');
      expect(output).toContain('Total');
    });

    it('shows unknown window when context length not set', () => {
      const t = new ContextTracker('unknown/model');
      expect(t.formatDetailed()).toContain('unknown');
    });

    it('shows cache hit rate when cached_tokens present', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({
        prompt_tokens: 10000, completion_tokens: 200, total_tokens: 10200,
        prompt_tokens_details: { cached_tokens: 9000 },
      });
      const output = t.formatDetailed();
      expect(output).toContain('Cached');
      expect(output).toContain('90%');
    });

    it('shows cache write info on first request', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({
        prompt_tokens: 5000, completion_tokens: 200, total_tokens: 5200,
        prompt_tokens_details: { cache_write_tokens: 3000 },
      });
      const output = t.formatDetailed();
      expect(output).toContain('Cache write');
    });
  });

  describe('format with cache', () => {
    it('shows cached tokens in context bar', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({
        prompt_tokens: 10000, completion_tokens: 200, total_tokens: 10200,
        prompt_tokens_details: { cached_tokens: 8000 },
      });
      const output = t.format();
      expect(output).toContain('cached');
      expect(output).toContain('80%');
    });

    it('does not show cache info when no cached tokens', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({ prompt_tokens: 10000, completion_tokens: 200, total_tokens: 10200 });
      const output = t.format();
      expect(output).not.toContain('cached');
    });

    it('shows 99% instead of 100% when nearly all tokens are cached', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({
        prompt_tokens: 28000, completion_tokens: 200, total_tokens: 28200,
        prompt_tokens_details: { cached_tokens: 27995 },
      });
      const output = t.format();
      expect(output).toContain('99%');
      expect(output).not.toContain('100%');
      expect(output).toContain('+5');
      expect(output).toContain('new');
    });

    it('shows 100% only when all prompt tokens are cached', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({
        prompt_tokens: 28000, completion_tokens: 200, total_tokens: 28200,
        prompt_tokens_details: { cached_tokens: 28000 },
      });
      const output = t.format();
      expect(output).toContain('100%');
    });
  });

  describe('formatDetailed cache rounding', () => {
    it('shows 99% hit rate when nearly all tokens are cached', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({
        prompt_tokens: 28000, completion_tokens: 200, total_tokens: 28200,
        prompt_tokens_details: { cached_tokens: 27995 },
      });
      const output = t.formatDetailed();
      expect(output).toContain('99%');
      expect(output).not.toContain('100%');
      expect(output).toContain('uncached');
    });

    it('shows both cached and written when both present', () => {
      const t = new ContextTracker('anthropic/claude-sonnet-4.6');
      t.update({
        prompt_tokens: 10000, completion_tokens: 200, total_tokens: 10200,
        prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 1500 },
      });
      const output = t.formatDetailed();
      expect(output).toContain('Cached');
      expect(output).toContain('Cache write');
    });
  });
});
