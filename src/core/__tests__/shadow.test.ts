import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Shadow } from '../shadow.js';

const testDir = `/tmp/__ag_test_shadow_${randomBytes(8).toString('hex')}__`;
let shadow: Shadow;

beforeEach(async () => {
  mkdirSync(testDir, { recursive: true });
  shadow = new Shadow(join(testDir, '.ag', 'shadow'), testDir);
  await shadow.init();
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ── isAvailable ─────────────────────────────────────────────────────────────

describe('Shadow.isAvailable', () => {
  it('returns true when git is installed', async () => {
    expect(await Shadow.isAvailable()).toBe(true);
  });
});

// ── init ────────────────────────────────────────────────────────────────────

describe('Shadow.init', () => {
  it('creates a bare git repo in the shadow directory', () => {
    expect(existsSync(join(testDir, '.ag', 'shadow', 'HEAD'))).toBe(true);
  });

  it('writes exclusion patterns', () => {
    const exclude = readFileSync(join(testDir, '.ag', 'shadow', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.git');
    expect(exclude).toContain('node_modules');
    expect(exclude).toContain('.ag');
  });

  it('is idempotent — safe to call on an existing repo', async () => {
    await shadow.init(); // second call should not throw
    expect(existsSync(join(testDir, '.ag', 'shadow', 'HEAD'))).toBe(true);
  });
});

// ── snapshot ────────────────────────────────────────────────────────────────

describe('Shadow.snapshot', () => {
  it('captures a file and returns a commit SHA', async () => {
    writeFileSync(join(testDir, 'hello.txt'), 'world');
    const sha = await shadow.snapshot('first checkpoint');
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('captures multiple files', async () => {
    writeFileSync(join(testDir, 'a.txt'), 'aaa');
    writeFileSync(join(testDir, 'b.txt'), 'bbb');
    const sha = await shadow.snapshot('two files');
    expect(sha).toBeTruthy();
  });

  it('returns null when there are no changes to snapshot', async () => {
    writeFileSync(join(testDir, 'file.txt'), 'content');
    await shadow.snapshot('initial');
    // No changes since last snapshot
    const sha = await shadow.snapshot('no changes');
    expect(sha).toBeNull();
  });

  it('captures nested directory structures', async () => {
    mkdirSync(join(testDir, 'src', 'deep'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'deep', 'nested.ts'), 'export const x = 1;');
    const sha = await shadow.snapshot('nested');
    expect(sha).toBeTruthy();
  });

  it('excludes .git directory', async () => {
    // Simulate a .git dir in the work tree
    mkdirSync(join(testDir, '.git'), { recursive: true });
    writeFileSync(join(testDir, '.git', 'config'), 'fake git config');
    writeFileSync(join(testDir, 'real.txt'), 'real file');

    const sha = await shadow.snapshot('with .git');
    expect(sha).toBeTruthy();

    // Verify .git content is not in the snapshot by checking listed files
    const files = await shadow.listFiles(sha!);
    expect(files).toContain('real.txt');
    expect(files.some(f => f.startsWith('.git/'))).toBe(false);
  });

  it('excludes node_modules', async () => {
    mkdirSync(join(testDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(testDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}');
    writeFileSync(join(testDir, 'app.js'), 'require("pkg")');

    const sha = await shadow.snapshot('with node_modules');
    const files = await shadow.listFiles(sha!);
    expect(files).toContain('app.js');
    expect(files.some(f => f.startsWith('node_modules/'))).toBe(false);
  });
});

// ── restore ─────────────────────────────────────────────────────────────────

describe('Shadow.restore', () => {
  it('restores modified files to their checkpoint state', async () => {
    writeFileSync(join(testDir, 'file.txt'), 'original');
    const sha = await shadow.snapshot('baseline');

    writeFileSync(join(testDir, 'file.txt'), 'modified');
    expect(readFileSync(join(testDir, 'file.txt'), 'utf-8')).toBe('modified');

    await shadow.restore(sha!);
    expect(readFileSync(join(testDir, 'file.txt'), 'utf-8')).toBe('original');
  });

  it('deletes files created after the checkpoint', async () => {
    writeFileSync(join(testDir, 'existing.txt'), 'keep me');
    const sha = await shadow.snapshot('baseline');

    writeFileSync(join(testDir, 'new-file.txt'), 'should be deleted');
    expect(existsSync(join(testDir, 'new-file.txt'))).toBe(true);

    await shadow.restore(sha!);
    expect(existsSync(join(testDir, 'new-file.txt'))).toBe(false);
    expect(readFileSync(join(testDir, 'existing.txt'), 'utf-8')).toBe('keep me');
  });

  it('restores files that were deleted after the checkpoint', async () => {
    writeFileSync(join(testDir, 'will-delete.txt'), 'restore me');
    const sha = await shadow.snapshot('baseline');

    unlinkSync(join(testDir, 'will-delete.txt'));
    expect(existsSync(join(testDir, 'will-delete.txt'))).toBe(false);

    await shadow.restore(sha!);
    expect(readFileSync(join(testDir, 'will-delete.txt'), 'utf-8')).toBe('restore me');
  });

  it('handles a mix of modifications, additions, and deletions', async () => {
    writeFileSync(join(testDir, 'modify.txt'), 'v1');
    writeFileSync(join(testDir, 'delete.txt'), 'exists');
    const sha = await shadow.snapshot('baseline');

    writeFileSync(join(testDir, 'modify.txt'), 'v2');
    unlinkSync(join(testDir, 'delete.txt'));
    writeFileSync(join(testDir, 'added.txt'), 'new');

    await shadow.restore(sha!);
    expect(readFileSync(join(testDir, 'modify.txt'), 'utf-8')).toBe('v1');
    expect(readFileSync(join(testDir, 'delete.txt'), 'utf-8')).toBe('exists');
    expect(existsSync(join(testDir, 'added.txt'))).toBe(false);
  });

  it('restores nested directories', async () => {
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'index.ts'), 'original');
    const sha = await shadow.snapshot('baseline');

    writeFileSync(join(testDir, 'src', 'index.ts'), 'changed');

    await shadow.restore(sha!);
    expect(readFileSync(join(testDir, 'src', 'index.ts'), 'utf-8')).toBe('original');
  });
});

// ── diff ────────────────────────────────────────────────────────────────────

describe('Shadow.diff', () => {
  it('returns diff between two snapshots', async () => {
    writeFileSync(join(testDir, 'file.txt'), 'version 1');
    const sha1 = await shadow.snapshot('v1');

    writeFileSync(join(testDir, 'file.txt'), 'version 2');
    const sha2 = await shadow.snapshot('v2');

    const diff = await shadow.diff(sha1!, sha2!);
    expect(diff).toContain('version 1');
    expect(diff).toContain('version 2');
  });
});

// ── prune ───────────────────────────────────────────────────────────────────

describe('Shadow.prune', () => {
  it('keeps only the last N snapshots', async () => {
    const shas: string[] = [];
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(testDir, 'file.txt'), `v${i}`);
      const sha = await shadow.snapshot(`checkpoint ${i}`);
      if (sha) shas.push(sha);
    }
    expect(shas.length).toBe(5);

    await shadow.prune(3);
    const remaining = await shadow.getSnapshots();
    expect(remaining.length).toBe(3);
    // Should keep the 3 most recent
    expect(remaining.map(s => s.sha)).toEqual(shas.slice(2));
  });
});

// ── corruption recovery ─────────────────────────────────────────────────────

describe('Shadow - corruption recovery', () => {
  it('reinitializes if shadow repo is corrupted', async () => {
    writeFileSync(join(testDir, '.ag', 'shadow', 'HEAD'), 'corrupted');

    // Create a fresh instance — init should recover
    const fresh = new Shadow(join(testDir, '.ag', 'shadow'), testDir);
    await fresh.init();

    writeFileSync(join(testDir, 'test.txt'), 'after recovery');
    const sha = await fresh.snapshot('recovered');
    expect(sha).toBeTruthy();
  });
});
