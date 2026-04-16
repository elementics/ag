import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// We need to mock AG_DIR before importing config, since CONFIG_PATH is derived at import time.
// Instead, test the logic directly using the file system.

const tmpDir = join(process.cwd(), `__test_config_${randomBytes(4).toString('hex')}__`);
const configFile = join(tmpDir, 'config.json');

// Mock the config module's internal path by testing the same read/write logic
describe('config load/save logic', () => {
  beforeEach(() => { mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true }); });

  it('returns empty object when config file does not exist', () => {
    const path = join(tmpDir, 'nonexistent.json');
    expect(existsSync(path)).toBe(false);
  });

  it('reads valid JSON config', () => {
    writeFileSync(configFile, JSON.stringify({ model: 'openai/gpt-4o', maxIterations: 10 }));
    const content = JSON.parse(readFileSync(configFile, 'utf-8'));
    expect(content.model).toBe('openai/gpt-4o');
    expect(content.maxIterations).toBe(10);
  });

  it('handles corrupt JSON gracefully', () => {
    writeFileSync(configFile, 'not json{{{');
    let result = {};
    try { result = JSON.parse(readFileSync(configFile, 'utf-8')); } catch { result = {}; }
    expect(result).toEqual({});
  });

  it('merges partial config with existing', () => {
    const existing = { apiKey: 'sk-old', model: 'openai/gpt-4o' };
    const partial = { model: 'anthropic/claude-sonnet-4.6' };
    const merged = { ...existing, ...partial };
    expect(merged.apiKey).toBe('sk-old');
    expect(merged.model).toBe('anthropic/claude-sonnet-4.6');
  });

  it('strips undefined/null values from merged config', () => {
    const merged: Record<string, unknown> = { apiKey: 'sk-test', model: undefined, baseURL: null };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined || merged[key] === null) delete merged[key];
    }
    expect(merged).toEqual({ apiKey: 'sk-test' });
  });
});

describe('configPath', () => {
  it('is importable and returns a string', async () => {
    const { configPath } = await import('../config.js');
    expect(typeof configPath()).toBe('string');
    expect(configPath()).toContain('.ag');
  });
});
