import { describe, it, expect, afterEach } from 'vitest';
import { AG_DIR, DEFAULT_IGNORE, isBinary } from '../constants.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const tmpDir = join(process.cwd(), `__test_tmp_const_${randomBytes(4).toString('hex')}__`);

describe('AG_DIR', () => {
  it('points to ~/.ag', () => {
    expect(AG_DIR).toBe(join(homedir(), '.ag'));
  });
});

describe('DEFAULT_IGNORE', () => {
  it('includes common ignore patterns', () => {
    expect(DEFAULT_IGNORE.has('.git')).toBe(true);
    expect(DEFAULT_IGNORE.has('node_modules')).toBe(true);
    expect(DEFAULT_IGNORE.has('dist')).toBe(true);
    expect(DEFAULT_IGNORE.has('__pycache__')).toBe(true);
  });
});

describe('isBinary', () => {
  afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true }); });

  it('detects text files as non-binary', () => {
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'text.txt');
    writeFileSync(tmpFile, 'Hello, world!\nThis is text.\n');
    expect(isBinary(tmpFile)).toBe(false);
  });

  it('detects files with null bytes as binary', () => {
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'binary.bin');
    writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
    expect(isBinary(tmpFile)).toBe(true);
  });

  it('treats nonexistent files as binary', () => {
    expect(isBinary('/nonexistent/file/path')).toBe(true);
  });
});
