import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { maskApiKey } from '../utils.js';

// ── maskApiKey ─────────────────────────────────────────────────────────────

describe('maskApiKey', () => {
  it('masks a normal key showing first 4 and last 4 chars', () => {
    expect(maskApiKey('sk-or-v1-abc123def456ghi789')).toBe('sk-o...i789');
  });

  it('fully masks a short key (< 12 chars)', () => {
    expect(maskApiKey('short-key')).toBe('****');
  });

  it('fully masks an empty string', () => {
    expect(maskApiKey('')).toBe('****');
  });

  it('masks a key of exactly 12 chars', () => {
    expect(maskApiKey('123456789012')).toBe('1234...9012');
  });
});

// ── Structural tests ───────────────────────────────────────────────────────

describe('promptInput consolidation', () => {
  const webSrc = readFileSync(
    resolve(import.meta.dirname, '..', '..', 'tools', 'web.ts'),
    'utf-8',
  );
  const cliSrc = readFileSync(
    resolve(import.meta.dirname, '..', '..', 'cli.ts'),
    'utf-8',
  );

  it('web.ts does not import createInterface directly', () => {
    expect(webSrc).not.toMatch(/from\s+['"]node:readline['"]/);
  });

  it('cli.ts does not import createInterface directly', () => {
    expect(cliSrc).not.toMatch(/from\s+['"]node:readline['"]/);
  });

  it('web.ts uses promptInput', () => {
    expect(webSrc).toMatch(/promptInput/);
  });

  it('cli.ts uses promptInput', () => {
    expect(cliSrc).toMatch(/promptInput/);
  });
});

// ── Unit tests for promptInput ─────────────────────────────────────────────

describe('promptInput', () => {
  let originalIsTTY: boolean | undefined;
  let originalIsRaw: boolean | undefined;
  let setRawModeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    originalIsRaw = (process.stdin as any).isRaw;
    setRawModeSpy = vi.fn();
    (process.stdin as any).setRawMode = setRawModeSpy;
  });

  afterEach(() => {
    (process.stdin as any).isTTY = originalIsTTY;
    (process.stdin as any).isRaw = originalIsRaw;
    vi.restoreAllMocks();
  });

  it('toggles raw mode off then on when stdin is in raw mode', async () => {
    (process.stdin as any).isTTY = true;
    (process.stdin as any).isRaw = true;

    // Mock readline to auto-answer
    const mockRl = { question: vi.fn((_p: string, cb: (a: string) => void) => cb('test-answer')), close: vi.fn() };
    vi.doMock('node:readline', () => ({
      createInterface: () => mockRl,
    }));

    // Re-import to pick up mock
    const { promptInput } = await import('../utils.js');
    const result = await promptInput('Enter: ');

    expect(result).toBe('test-answer');
    expect(setRawModeSpy).toHaveBeenCalledWith(false);
    expect(setRawModeSpy).toHaveBeenCalledWith(true);
    // false is called before true
    const calls = setRawModeSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toEqual([false, true]);

    vi.doUnmock('node:readline');
  });

  it('does not touch raw mode when stdin is not raw', async () => {
    (process.stdin as any).isTTY = true;
    (process.stdin as any).isRaw = false;

    const mockRl = { question: vi.fn((_p: string, cb: (a: string) => void) => cb('answer')), close: vi.fn() };
    vi.doMock('node:readline', () => ({
      createInterface: () => mockRl,
    }));

    const { promptInput } = await import('../utils.js');
    await promptInput('Enter: ');

    expect(setRawModeSpy).not.toHaveBeenCalled();

    vi.doUnmock('node:readline');
  });
});
