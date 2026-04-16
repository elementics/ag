import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverExtensions } from '../extensions.js';

const TEST_DIR = join(tmpdir(), `ag-ext-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('discoverExtensions', () => {
  it('discovers .ts files in .ag/extensions/', () => {
    const extDir = join(TEST_DIR, '.ag', 'extensions');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'my-ext.ts'), 'export default function() {}');
    writeFileSync(join(extDir, 'another.mjs'), 'export default function() {}');

    const found = discoverExtensions(TEST_DIR, join(TEST_DIR, 'nonexistent-global'));
    expect(found).toHaveLength(2);
    expect(found.some(f => f.endsWith('my-ext.ts'))).toBe(true);
    expect(found.some(f => f.endsWith('another.mjs'))).toBe(true);
  });

  it('discovers directory extensions with index.ts', () => {
    const extDir = join(TEST_DIR, '.ag', 'extensions', 'my-plugin');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'index.ts'), 'export default function() {}');

    const found = discoverExtensions(TEST_DIR, join(TEST_DIR, 'nonexistent-global'));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('my-plugin');
    expect(found[0]).toContain('index.ts');
  });

  it('returns empty array when no extensions directory exists', () => {
    const found = discoverExtensions(TEST_DIR, join(TEST_DIR, 'nonexistent-global'));
    expect(found).toEqual([]);
  });

  it('ignores non-extension files', () => {
    const extDir = join(TEST_DIR, '.ag', 'extensions');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'readme.md'), '# Not an extension');
    writeFileSync(join(extDir, 'data.json'), '{}');
    writeFileSync(join(extDir, 'valid.ts'), 'export default function() {}');

    const found = discoverExtensions(TEST_DIR, join(TEST_DIR, 'nonexistent-global'));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('valid.ts');
  });

  it('discovers from both project and global directories', () => {
    const projectExtDir = join(TEST_DIR, '.ag', 'extensions');
    const globalExtDir = join(TEST_DIR, 'global', 'extensions');
    mkdirSync(projectExtDir, { recursive: true });
    mkdirSync(globalExtDir, { recursive: true });
    writeFileSync(join(projectExtDir, 'proj.ts'), 'export default function() {}');
    writeFileSync(join(globalExtDir, 'global.ts'), 'export default function() {}');

    const found = discoverExtensions(TEST_DIR, join(TEST_DIR, 'global'));
    expect(found).toHaveLength(2);
  });
});
