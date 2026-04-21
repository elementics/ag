import { describe, it, expect } from 'vitest';
import { renderFooter } from '../../editor/render.js';

describe('renderFooter', () => {
  it('shows plan mode badge before the model name', () => {
    const footer = renderFooter({
      mode: 'plan',
      model: 'anthropic/claude-sonnet-4.6',
      contextPct: 25,
      contextUsed: 1000,
      contextMax: 4000,
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
      inputTokens: 100,
      outputTokens: 50,
      cost: null,
      turn: 3,
    }, 120);
    expect(footer.indexOf('auto')).toBeGreaterThan(-1);
    expect(footer.indexOf('auto')).toBeLessThan(footer.indexOf('anthropic/claude-sonnet-4.6'));
  });
});
