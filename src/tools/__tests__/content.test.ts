import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { contentTool } from '../content.js';
import { resetContentStore, ingestContent, consumeRequestedRefs } from '../../core/content.js';

const cwd = process.cwd();
const suffix = randomBytes(4).toString('hex');
const testDirName = `__test_content_tool_${suffix}__`;
const testDir = join(cwd, testDirName);

/** Minimal valid PNG */
function createMinimalPNG(width = 2, height = 3): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 2;
  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', Buffer.from([0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01]));
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeB, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

let content: ReturnType<typeof contentTool>;

beforeEach(() => {
  resetContentStore();
  content = contentTool(cwd);
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

describe('content tool - get', () => {
  it('returns content description for valid ref', async () => {
    const pngPath = join(testDir, 'test.png');
    writeFileSync(pngPath, createMinimalPNG(800, 600));
    ingestContent(pngPath, cwd);

    const result = await content.execute({ action: 'get', ref: 1 });
    expect(result).toContain('800');
    expect(result).toContain('600');
    expect(result).toContain('PNG');
  });

  it('returns error for unknown ref', async () => {
    const result = await content.execute({ action: 'get', ref: 999 });
    expect(result).toMatch(/not found/i);
  });

  it('requires ref parameter', async () => {
    const result = await content.execute({ action: 'get' });
    expect(result).toMatch(/ref is required/i);
  });

  it('marks ref as requested for re-injection', async () => {
    const pngPath = join(testDir, 'mark.png');
    writeFileSync(pngPath, createMinimalPNG(100, 100));
    ingestContent(pngPath, cwd);

    // Clear any prior state
    consumeRequestedRefs();

    await content.execute({ action: 'get', ref: 1 });
    const requested = consumeRequestedRefs();
    expect(requested.has(1)).toBe(true);
  });

  it('does not mark ref on info action', async () => {
    const pngPath = join(testDir, 'nomark.png');
    writeFileSync(pngPath, createMinimalPNG(100, 100));
    ingestContent(pngPath, cwd);

    consumeRequestedRefs();

    await content.execute({ action: 'info', ref: 1 });
    const requested = consumeRequestedRefs();
    expect(requested.size).toBe(0);
  });
});

describe('content tool - info', () => {
  it('returns metadata for valid ref', async () => {
    const pngPath = join(testDir, 'info.png');
    writeFileSync(pngPath, createMinimalPNG(1024, 768));
    ingestContent(pngPath, cwd);

    const result = await content.execute({ action: 'info', ref: 1 });
    expect(result).toContain('1024');
    expect(result).toContain('768');
    expect(result).toContain('image/png');
  });

  it('returns error for unknown ref', async () => {
    const result = await content.execute({ action: 'info', ref: 42 });
    expect(result).toMatch(/not found/i);
  });
});

describe('content tool - action validation', () => {
  it('returns error for unknown action', async () => {
    const result = await content.execute({ action: 'delete', ref: 1 });
    expect(result).toMatch(/Unknown action/);
    expect(result).toContain('get');
    expect(result).toContain('info');
  });
});
