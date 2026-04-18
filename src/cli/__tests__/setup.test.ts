import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Structural tests ───────────────────────────────────────────────────────

describe('setup.ts structural invariants', () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '..', 'setup.ts'),
    'utf-8',
  );

  it('does not import from cli/repl.ts', () => {
    expect(src).not.toMatch(/from\s+['"].*repl/);
  });

  it('uses promptInput from core/utils', () => {
    expect(src).toMatch(/promptInput/);
  });
});

// ── needsSetup tests ──────────────────────────────────────────────────────

describe('needsSetup', () => {
  let originalIsTTY: boolean | undefined;
  let originalEnvKey: string | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    originalEnvKey = process.env.OPENROUTER_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    (process.stdin as any).isTTY = originalIsTTY;
    if (originalEnvKey !== undefined) {
      process.env.OPENROUTER_API_KEY = originalEnvKey;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('returns true when config is empty and stdin is TTY', async () => {
    (process.stdin as any).isTTY = true;
    delete process.env.OPENROUTER_API_KEY;
    vi.doMock('../../core/config.js', () => ({
      loadConfig: () => ({}),
      saveConfig: vi.fn(),
      configPath: () => '~/.ag/config.json',
    }));
    const { needsSetup } = await import('../setup.js');
    expect(needsSetup()).toBe(true);
    vi.doUnmock('../../core/config.js');
  });

  it('returns false when apiKey is configured', async () => {
    (process.stdin as any).isTTY = true;
    delete process.env.OPENROUTER_API_KEY;
    vi.doMock('../../core/config.js', () => ({
      loadConfig: () => ({ apiKey: 'sk-test' }),
      saveConfig: vi.fn(),
      configPath: () => '~/.ag/config.json',
    }));
    const { needsSetup } = await import('../setup.js');
    expect(needsSetup()).toBe(false);
    vi.doUnmock('../../core/config.js');
  });

  it('returns false when baseURL is configured', async () => {
    (process.stdin as any).isTTY = true;
    delete process.env.OPENROUTER_API_KEY;
    vi.doMock('../../core/config.js', () => ({
      loadConfig: () => ({ baseURL: 'http://localhost:11434/v1' }),
      saveConfig: vi.fn(),
      configPath: () => '~/.ag/config.json',
    }));
    const { needsSetup } = await import('../setup.js');
    expect(needsSetup()).toBe(false);
    vi.doUnmock('../../core/config.js');
  });

  it('returns false when OPENROUTER_API_KEY env var is set', async () => {
    (process.stdin as any).isTTY = true;
    process.env.OPENROUTER_API_KEY = 'sk-env';
    vi.doMock('../../core/config.js', () => ({
      loadConfig: () => ({}),
      saveConfig: vi.fn(),
      configPath: () => '~/.ag/config.json',
    }));
    const { needsSetup } = await import('../setup.js');
    expect(needsSetup()).toBe(false);
    vi.doUnmock('../../core/config.js');
  });

  it('returns false when stdin is not TTY', async () => {
    (process.stdin as any).isTTY = false;
    delete process.env.OPENROUTER_API_KEY;
    vi.doMock('../../core/config.js', () => ({
      loadConfig: () => ({}),
      saveConfig: vi.fn(),
      configPath: () => '~/.ag/config.json',
    }));
    const { needsSetup } = await import('../setup.js');
    expect(needsSetup()).toBe(false);
    vi.doUnmock('../../core/config.js');
  });
});

// ── runSetupWizard tests ───────────────────────────────────────────────────

describe('runSetupWizard', () => {
  let saveCalls: Record<string, unknown>[];
  let promptResponses: string[];
  let promptIndex: number;

  beforeEach(() => {
    saveCalls = [];
    promptIndex = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setupWizard(responses: string[]) {
    promptResponses = responses;
    promptIndex = 0;

    vi.doMock('../../core/config.js', () => ({
      loadConfig: () => ({}),
      saveConfig: (partial: Record<string, unknown>) => { saveCalls.push({ ...partial }); },
      configPath: () => '~/.ag/config.json',
    }));

    vi.doMock('../../core/utils.js', () => ({
      promptInput: async () => {
        const r = promptResponses[promptIndex] ?? '';
        promptIndex++;
        return r;
      },
    }));

    // Suppress stderr output during tests
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { runSetupWizard } = await import('../setup.js');
    await runSetupWizard();

    vi.doUnmock('../../core/config.js');
    vi.doUnmock('../../core/utils.js');
  }

  it('OpenRouter path: saves apiKey and baseURL', async () => {
    await setupWizard(['1', 'sk-test-key', '']);

    expect(saveCalls).toContainEqual({ apiKey: 'sk-test-key' });
    expect(saveCalls).toContainEqual({ baseURL: 'https://openrouter.ai/api/v1' });
    // No tavilyApiKey (skipped)
    expect(saveCalls.find(c => 'tavilyApiKey' in c)).toBeUndefined();
  });

  it('Local path: saves baseURL and model', async () => {
    await setupWizard(['2', 'http://localhost:11434/v1', 'llama3.2', '']);

    expect(saveCalls).toContainEqual({ baseURL: 'http://localhost:11434/v1', model: 'llama3.2' });
    // No apiKey saved
    expect(saveCalls.find(c => 'apiKey' in c)).toBeUndefined();
  });

  it('saves tavilyApiKey when provided', async () => {
    await setupWizard(['1', 'sk-key', 'tvly-test-key']);

    expect(saveCalls).toContainEqual({ tavilyApiKey: 'tvly-test-key' });
  });

  it('invalid choice re-prompts until valid', async () => {
    // "3" is invalid, then "0", then "1" is valid
    await setupWizard(['3', '0', '1', 'sk-key', '']);

    expect(saveCalls).toContainEqual({ apiKey: 'sk-key' });
  });

  it('empty required fields re-prompt', async () => {
    // Empty key, then valid key
    await setupWizard(['1', '', 'sk-key', '']);

    expect(saveCalls).toContainEqual({ apiKey: 'sk-key' });
  });
});
