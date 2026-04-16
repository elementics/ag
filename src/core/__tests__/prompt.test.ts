import { describe, it, expect, beforeEach } from 'vitest';
import { isReadOnlyToolCall, buildRequestBody } from '../prompt.js';
import { resetContentStore, ingestContent } from '../content.js';
import type { Message, ContentRef, ContentBlock, TextBlock, ImageUrlBlock } from '../types.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ── content tool read-only ──────────────────────────────────────────────────

describe('isReadOnlyToolCall — content tool', () => {
  it('content tool is always read-only', () => {
    expect(isReadOnlyToolCall('content', { action: 'get', ref: 1 })).toBe(true);
    expect(isReadOnlyToolCall('content', { action: 'info', ref: 1 })).toBe(true);
  });
});

// ── buildRequestBody with content ───────────────────────────────────────────

const cwd = process.cwd();
const suffix = randomBytes(4).toString('hex');
const testDirName = `__test_prompt_${suffix}__`;
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeB, data, crc]);
}
function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

beforeEach(() => {
  resetContentStore();
  mkdirSync(testDir, { recursive: true });
  return () => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); };
});

describe('buildRequestBody with content', () => {
  const baseOptions = {
    model: 'anthropic/claude-sonnet-4-6',
    systemPrompt: 'You are helpful.',
    tools: [],
    stream: false,
  };

  it('resolves content refs on current turn to image_url blocks', () => {
    const pngPath = join(testDir, 'test.png');
    writeFileSync(pngPath, createMinimalPNG());
    const ref = ingestContent(pngPath, cwd);
    ref.introduced_turn = 1;

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, ref] },
    ];

    const body = buildRequestBody({ ...baseOptions, messages, currentTurn: 1 });
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    // First message is system, second is the user message
    const userMsg = msgs[1];
    const blocks = userMsg.content as ContentBlock[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[1].type).toBe('image_url');
  });

  it('replaces older content refs with text pointers', () => {
    const pngPath = join(testDir, 'old.png');
    writeFileSync(pngPath, createMinimalPNG(100, 200));
    const ref = ingestContent(pngPath, cwd);
    ref.introduced_turn = 1;

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, ref] },
    ];

    const body = buildRequestBody({ ...baseOptions, messages, currentTurn: 5 });
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    const userMsg = msgs[1];
    const blocks = userMsg.content as ContentBlock[];
    expect(blocks[1].type).toBe('text');
    expect((blocks[1] as TextBlock).text).toContain('content #');
  });

  it('passes through plain string messages unchanged', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    const body = buildRequestBody({ ...baseOptions, messages, currentTurn: 1 });
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[1].content).toBe('hello');
    expect(msgs[2].content).toBe('hi');
  });
});
