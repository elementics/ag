import { describe, it, expect } from 'vitest';
import { renderFooter, contextTokenColorKey } from '../../editor/render.js';

describe('contextTokenColorKey thresholds', () => {
  it('returns green below 30K', () => {
    expect(contextTokenColorKey(0)).toBe('green');
    expect(contextTokenColorKey(29_999)).toBe('green');
  });

  it('returns yellow from 30K up to 50K', () => {
    expect(contextTokenColorKey(30_000)).toBe('yellow');
    expect(contextTokenColorKey(49_999)).toBe('yellow');
  });

  it('returns orange from 50K up to 90K', () => {
    expect(contextTokenColorKey(50_000)).toBe('orange');
    expect(contextTokenColorKey(89_999)).toBe('orange');
  });

  it('returns red at 90K and above', () => {
    expect(contextTokenColorKey(90_000)).toBe('red');
    expect(contextTokenColorKey(200_000)).toBe('red');
  });
});

describe('renderFooter', () => {
  it('shows plan mode badge before the model name', () => {
    const footer = renderFooter({
      mode: 'plan',
      model: 'anthropic/claude-sonnet-4.6',
      contextPct: 25,
      contextUsed: 1000,
      contextMax: 4000,
      currentTokens: 1000,
      inputTokens: 100,
      outputTokens: 50,
      cost: null,
      turn: 3,
    }, 120);
    expect(footer.indexOf('plan')).toBeGreaterThan(-1);
    expect(footer.indexOf('plan')).toBeLessThan(footer.indexOf('anthropic/claude-sonnet-4.6'));
  });

  it('shows auto mode badge before the model name', () => {
    const footer = renderFooter({
      mode: 'auto',
      model: 'anthropic/claude-sonnet-4.6',
      contextPct: 25,
      contextUsed: 1000,
      contextMax: 4000,
      currentTokens: 1000,
      inputTokens: 100,
      outputTokens: 50,
      cost: null,
      turn: 3,
    }, 120);
    expect(footer.indexOf('auto')).toBeGreaterThan(-1);
    expect(footer.indexOf('auto')).toBeLessThan(footer.indexOf('anthropic/claude-sonnet-4.6'));
  });
});
