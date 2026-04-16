import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileTool } from '../file.js';
import { resolve, join, basename } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resetContentStore } from '../../core/content.js';

const cwd = resolve(process.cwd());
const file = fileTool(cwd);
const suffix = randomBytes(4).toString('hex');
const testDirName = `__test_tmp_${suffix}__`;
const testDir = join(cwd, testDirName);

describe('file tool - path boundary validation', () => {
  it('blocks reading files outside project directory', async () => {
    const result = await file.execute({ action: 'read', path: '../../../etc/passwd' });
    expect(result).toMatch(/outside the project directory/);
  });

  it('blocks listing directories outside project directory', async () => {
    const result = await file.execute({ action: 'list', path: '../../..' });
    expect(result).toMatch(/outside the project directory/);
  });

  it('blocks absolute paths outside project', async () => {
    const result = await file.execute({ action: 'read', path: '/etc/passwd' });
    expect(result).toMatch(/outside the project directory/);
  });

  it('allows reading files inside project', async () => {
    const result = await file.execute({ action: 'read', path: 'package.json' });
    expect(result).not.toMatch(/outside the project directory/);
    expect(result).toContain('@elementics/ag');
  });

  it('allows listing project root', async () => {
    const result = await file.execute({ action: 'list', path: '.' });
    expect(result).not.toMatch(/outside the project directory/);
    expect(result).toContain('package.json');
  });

  it('blocks path where cwd is a prefix of a different directory name', async () => {
    // If cwd is /path/to/ag, then /path/to/ag-evil should be blocked
    const cwdName = basename(cwd);
    const result = await file.execute({ action: 'read', path: `../${cwdName}-evil/etc/passwd` });
    expect(result).toMatch(/outside the project directory/);
  });

  it('returns error for nonexistent files', async () => {
    const result = await file.execute({ action: 'read', path: 'nonexistent-file.xyz' });
    expect(result).toMatch(/file not found/);
  });
});

describe('file tool - read', () => {
  it('reads file with line numbers', async () => {
    const result = await file.execute({ action: 'read', path: 'package.json' });
    expect(result).toMatch(/^\s+1\t/); // first line numbered
  });

  it('supports offset and limit', async () => {
    const result = await file.execute({ action: 'read', path: 'package.json', offset: 2, limit: 3 });
    const lines = result.split('\n');
    expect(lines.length).toBeLessThanOrEqual(3);
  });
});

describe('file tool - write', () => {
  beforeEach(() => { mkdirSync(testDir, { recursive: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  it('creates a new file', async () => {
    const result = await file.execute({ action: 'write', path: `${testDirName}/hello.txt`, content: 'hello world' });
    expect(result).toMatch(/Wrote.*hello\.txt/);
    expect(existsSync(join(testDir, 'hello.txt'))).toBe(true);
  });

  it('creates nested directories', async () => {
    const result = await file.execute({ action: 'write', path: `${testDirName}/a/b/c.txt`, content: 'deep' });
    expect(result).toMatch(/Wrote/);
    expect(existsSync(join(testDir, 'a', 'b', 'c.txt'))).toBe(true);
  });

  it('overwrites existing file', async () => {
    writeFileSync(join(testDir, 'overwrite.txt'), 'old');
    const result = await file.execute({ action: 'write', path: `${testDirName}/overwrite.txt`, content: 'new' });
    expect(result).toMatch(/Wrote/);
    expect(readFileSync(join(testDir, 'overwrite.txt'), 'utf-8')).toBe('new');
  });

  it('blocks writing outside project', async () => {
    const result = await file.execute({ action: 'write', path: '../../../tmp/evil.txt', content: 'bad' });
    expect(result).toMatch(/outside the project directory/);
  });

  it('requires content parameter', async () => {
    const result = await file.execute({ action: 'write', path: `${testDirName}/no-content.txt` });
    expect(result).toMatch(/content is required/);
  });
});

describe('file tool - edit', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'edit-me.txt'), 'line one\nline two\nline three\n');
  });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  it('replaces a unique string', async () => {
    const result = await file.execute({ action: 'edit', path: `${testDirName}/edit-me.txt`, old_string: 'line two', new_string: 'line TWO' });
    expect(result).toMatch(/Edited/);
    expect(readFileSync(join(testDir, 'edit-me.txt'), 'utf-8')).toContain('line TWO');
  });

  it('errors when old_string not found', async () => {
    const result = await file.execute({ action: 'edit', path: `${testDirName}/edit-me.txt`, old_string: 'not here', new_string: 'x' });
    expect(result).toMatch(/old_string not found/);
  });

  it('errors when old_string matches multiple times', async () => {
    writeFileSync(join(testDir, 'dupes.txt'), 'aaa\naaa\naaa\n');
    const result = await file.execute({ action: 'edit', path: `${testDirName}/dupes.txt`, old_string: 'aaa', new_string: 'bbb' });
    expect(result).toMatch(/matches 3 times/);
  });

  it('errors on nonexistent file', async () => {
    const result = await file.execute({ action: 'edit', path: `${testDirName}/nope.txt`, old_string: 'a', new_string: 'b' });
    expect(result).toMatch(/file not found/);
  });

  it('blocks editing outside project', async () => {
    const result = await file.execute({ action: 'edit', path: '../../../etc/passwd', old_string: 'root', new_string: 'hacked' });
    expect(result).toMatch(/outside the project directory/);
  });

  it('requires old_string and new_string', async () => {
    const result1 = await file.execute({ action: 'edit', path: `${testDirName}/edit-me.txt` });
    expect(result1).toMatch(/old_string is required/);
    const result2 = await file.execute({ action: 'edit', path: `${testDirName}/edit-me.txt`, old_string: 'line one' });
    expect(result2).toMatch(/new_string is required/);
  });
});

// ── Content ingestion for binary files ──────────────────────────────────────

/** Minimal valid PNG */
function createMinimalPNG(width = 2, height = 3): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0); ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 2;
  const ihdr = mkChunk('IHDR', ihdrData);
  const idat = mkChunk('IDAT', Buffer.from([0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01]));
  const iend = mkChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}
function mkChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32png(crcInput), 0);
  return Buffer.concat([len, typeB, data, crc]);
}
function crc32png(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

describe('file tool - content ingestion', () => {
  beforeEach(() => {
    resetContentStore();
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  it('reading a PNG file returns content description with ref ID', async () => {
    writeFileSync(join(testDir, 'screenshot.png'), createMinimalPNG(800, 600));
    const result = await file.execute({ action: 'read', path: `${testDirName}/screenshot.png` });
    expect(result).toContain('content #');
    expect(result).toContain('800');
    expect(result).toContain('600');
  });

  it('reading a PDF file returns content description with ref ID', async () => {
    const pdfContent = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n%%EOF');
    writeFileSync(join(testDir, 'doc.pdf'), pdfContent);
    const result = await file.execute({ action: 'read', path: `${testDirName}/doc.pdf` });
    expect(result).toContain('content #');
    expect(result).toContain('PDF');
  });

  it('reading an unsupported binary file still returns binary rejection', async () => {
    writeFileSync(join(testDir, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const result = await file.execute({ action: 'read', path: `${testDirName}/data.bin` });
    expect(result).toContain('Binary file');
  });
});
