import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'editor', 'read.ts'),
  'utf-8',
);

describe('editor Shift-Tab mode toggle', () => {
  it('updates only the footer when toggling mode', () => {
    expect(readSource).toMatch(/function updateFooter\(\)/);
    expect(readSource).toMatch(/options\?\.onShiftTab && !state\.completionState\?\.showing/);
    expect(readSource).toMatch(/options\.onShiftTab\(\);\s*updateFooter\(\);/);
  });
});
