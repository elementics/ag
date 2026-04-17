import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Message, ContentRef, ContentBlock, TextBlock, ImageUrlBlock, FileBlock } from '../types.js';

// Lazy imports — content.ts will be implemented next
let getTextContent: (msg: Message) => string;
let hasContent: (msg: Message) => boolean;
let ingestContent: (source: string, cwd: string) => ContentRef;
let resolveContent: (ref: ContentRef) => ImageUrlBlock | FileBlock;
let resolveMessagesForAPI: (messages: Message[], currentTurn: number) => Message[];
let describeContent: (ref: ContentRef) => string;
let estimateContentTokens: (ref: ContentRef) => number;
let estimateMessageContentChars: (msg: Message, currentTurn: number) => number;
let resetContentStore: () => void;
let markRefRequested: (id: number) => void;
let consumeRequestedRefs: () => Set<number>;
let restoreContentFromHistory: (messages: Message[]) => void;
let getAllContentRefs: () => ContentRef[];
let saveContentIndex: (cwd: string) => void;
let restoreContentIndex: (cwd: string, fallbackMessages?: Message[]) => void;
let clearContentCache: (cwd: string) => void;
let pruneContentCache: (cwd: string, maxAgeDays?: number) => void;

beforeEach(async () => {
  const mod = await import('../content.js');
  getTextContent = mod.getTextContent;
  hasContent = mod.hasContent;
  ingestContent = mod.ingestContent;
  resolveContent = mod.resolveContent;
  resolveMessagesForAPI = mod.resolveMessagesForAPI;
  describeContent = mod.describeContent;
  estimateContentTokens = mod.estimateContentTokens;
  estimateMessageContentChars = mod.estimateMessageContentChars;
  resetContentStore = mod.resetContentStore;
  markRefRequested = mod.markRefRequested;
  consumeRequestedRefs = mod.consumeRequestedRefs;
  restoreContentFromHistory = mod.restoreContentFromHistory;
  getAllContentRefs = mod.getAllContentRefs;
  saveContentIndex = mod.saveContentIndex;
  restoreContentIndex = mod.restoreContentIndex;
  clearContentCache = mod.clearContentCache;
  pruneContentCache = mod.pruneContentCache;
  resetContentStore();
});

// ── Test fixtures ───────────────────────────────────────────────────────────

const suffix = randomBytes(4).toString('hex');
const testDirName = `__test_content_${suffix}__`;
const cwd = process.cwd();
const testDir = join(cwd, testDirName);

/** Minimal valid PNG: 2x3 pixels, RGBA */
function createMinimalPNG(width = 2, height = 3): Buffer {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR chunk: width(4) + height(4) + bitDepth(1) + colorType(1) + compression(1) + filter(1) + interlace(1) = 13 bytes
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type: RGB
  const ihdr = makeChunk('IHDR', ihdrData);
  // IDAT chunk: minimal deflate (empty, just a valid zlib stream)
  const idat = makeChunk('IDAT', Buffer.from([0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01]));
  // IEND chunk
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
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Minimal valid JPEG: 4x2 pixels */
function createMinimalJPEG(width = 4, height = 2): Buffer {
  // SOI + SOF0 (Start of Frame) + SOS (Start of Scan) + EOI
  const soi = Buffer.from([0xFF, 0xD8]);
  // SOF0 marker
  const sof = Buffer.alloc(19);
  sof[0] = 0xFF; sof[1] = 0xC0;       // SOF0 marker
  sof[2] = 0x00; sof[3] = 17;          // length: 17 bytes
  sof[4] = 8;                            // precision: 8 bits
  sof.writeUInt16BE(height, 5);          // height
  sof.writeUInt16BE(width, 7);           // width
  sof[9] = 3;                            // num components
  // Component 1 (Y): id=1, sampling=0x11, quant=0
  sof[10] = 1; sof[11] = 0x11; sof[12] = 0;
  // Component 2 (Cb)
  sof[13] = 2; sof[14] = 0x11; sof[15] = 0;
  // Component 3 (Cr)
  sof[16] = 3; sof[17] = 0x11; sof[18] = 0;
  const eoi = Buffer.from([0xFF, 0xD9]);
  return Buffer.concat([soi, sof, eoi]);
}

/** Minimal PDF (1 page) */
function createMinimalPDF(pages = 1): Buffer {
  const lines = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[' + Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ') + `]/Count ${pages}>>endobj`,
  ];
  for (let i = 0; i < pages; i++) {
    lines.push(`${3 + i} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj`);
  }
  lines.push('%%EOF');
  return Buffer.from(lines.join('\n'));
}

beforeEach(() => { mkdirSync(testDir, { recursive: true }); });
afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

// ── getTextContent ──────────────────────────────────────────────────────────

describe('getTextContent', () => {
  it('returns empty string for null content', () => {
    const msg: Message = { role: 'user', content: null };
    expect(getTextContent(msg)).toBe('');
  });

  it('returns string content as-is', () => {
    const msg: Message = { role: 'user', content: 'hello world' };
    expect(getTextContent(msg)).toBe('hello world');
  });

  it('extracts text from ContentBlock array', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'text', text: ' image' },
      ],
    };
    expect(getTextContent(msg)).toBe('look at this image');
  });

  it('ignores non-text blocks', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        { type: 'text', text: ' world' },
      ],
    };
    expect(getTextContent(msg)).toBe('hello world');
  });
});

// ── hasContent ──────────────────────────────────────────────────────────────

describe('hasContent', () => {
  it('returns false for string content', () => {
    expect(hasContent({ role: 'user', content: 'hello' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(hasContent({ role: 'user', content: null })).toBe(false);
  });

  it('returns true when content_ref present', () => {
    const ref: ContentRef = {
      type: 'content_ref', id: 1, hash: 'abc', media_type: 'image/png',
      size_bytes: 100, cache_path: '/tmp/x.png', introduced_turn: 0,
    };
    expect(hasContent({ role: 'user', content: [{ type: 'text', text: 'hi' }, ref] })).toBe(true);
  });

  it('returns true when image_url present', () => {
    expect(hasContent({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }],
    })).toBe(true);
  });

  it('returns false when only text blocks', () => {
    expect(hasContent({
      role: 'user',
      content: [{ type: 'text', text: 'just text' }],
    })).toBe(false);
  });
});

// ── ingestContent ───────────────────────────────────────────────────────────

describe('ingestContent', () => {
  it('ingests PNG file, returns ContentRef with dimensions', () => {
    const pngPath = join(testDir, 'test.png');
    writeFileSync(pngPath, createMinimalPNG(800, 600));
    const ref = ingestContent(pngPath, cwd);
    expect(ref.type).toBe('content_ref');
    expect(ref.id).toBe(1);
    expect(ref.media_type).toBe('image/png');
    expect(ref.width).toBe(800);
    expect(ref.height).toBe(600);
    expect(ref.size_bytes).toBeGreaterThan(0);
    expect(ref.cache_path).toMatch(/\.png$/);
    expect(existsSync(ref.cache_path)).toBe(true);
  });

  it('ingests JPEG file, returns ContentRef with dimensions', () => {
    const jpgPath = join(testDir, 'test.jpg');
    writeFileSync(jpgPath, createMinimalJPEG(1024, 768));
    const ref = ingestContent(jpgPath, cwd);
    expect(ref.media_type).toBe('image/jpeg');
    expect(ref.width).toBe(1024);
    expect(ref.height).toBe(768);
  });

  it('ingests PDF file, returns ContentRef with page_count', () => {
    const pdfPath = join(testDir, 'test.pdf');
    writeFileSync(pdfPath, createMinimalPDF(3));
    const ref = ingestContent(pdfPath, cwd);
    expect(ref.media_type).toBe('application/pdf');
    expect(ref.page_count).toBe(3);
    expect(ref.width).toBeUndefined();
  });

  it('deduplicates by SHA-256 hash', () => {
    const pngPath1 = join(testDir, 'a.png');
    const pngPath2 = join(testDir, 'b.png');
    const data = createMinimalPNG(10, 10);
    writeFileSync(pngPath1, data);
    writeFileSync(pngPath2, data);
    const ref1 = ingestContent(pngPath1, cwd);
    const ref2 = ingestContent(pngPath2, cwd);
    expect(ref1.hash).toBe(ref2.hash);
    expect(ref1.id).not.toBe(ref2.id); // different IDs even if same content
  });

  it('assigns sequential IDs', () => {
    const p1 = join(testDir, 'one.png');
    const p2 = join(testDir, 'two.png');
    writeFileSync(p1, createMinimalPNG(1, 1));
    writeFileSync(p2, createMinimalPNG(2, 2));
    const ref1 = ingestContent(p1, cwd);
    const ref2 = ingestContent(p2, cwd);
    expect(ref1.id).toBe(1);
    expect(ref2.id).toBe(2);
  });

  it('caches file to project-scoped content dir', () => {
    const pngPath = join(testDir, 'cached.png');
    writeFileSync(pngPath, createMinimalPNG());
    const ref = ingestContent(pngPath, cwd);
    expect(ref.cache_path).toContain('/content/');
    expect(ref.cache_path).toContain('.ag/projects/');
    expect(existsSync(ref.cache_path)).toBe(true);
  });

  it('errors for nonexistent file', () => {
    expect(() => ingestContent(join(testDir, 'nope.png'), cwd)).toThrow(/not found/i);
  });

  it('errors for unsupported file type', () => {
    const txtPath = join(testDir, 'test.txt');
    writeFileSync(txtPath, 'hello');
    expect(() => ingestContent(txtPath, cwd)).toThrow(/unsupported/i);
  });
});

// ── resolveContent ──────────────────────────────────────────────────────────

describe('resolveContent', () => {
  it('resolves image ref to ImageUrlBlock with data URI', () => {
    const pngPath = join(testDir, 'resolve.png');
    writeFileSync(pngPath, createMinimalPNG());
    const ref = ingestContent(pngPath, cwd);
    const block = resolveContent(ref);
    expect(block.type).toBe('image_url');
    const img = block as ImageUrlBlock;
    expect(img.image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('resolves PDF ref to FileBlock with data URI', () => {
    const pdfPath = join(testDir, 'resolve.pdf');
    writeFileSync(pdfPath, createMinimalPDF());
    const ref = ingestContent(pdfPath, cwd);
    const block = resolveContent(ref);
    expect(block.type).toBe('file');
    const file = block as FileBlock;
    expect(file.file.file_data).toMatch(/^data:application\/pdf;base64,/);
    expect(file.file.filename).toMatch(/\.pdf$/);
  });

  it('errors for missing cache file', () => {
    const ref: ContentRef = {
      type: 'content_ref', id: 99, hash: 'deadbeef', media_type: 'image/png',
      size_bytes: 100, cache_path: '/tmp/nonexistent-cache-file.png', introduced_turn: 0,
    };
    expect(() => resolveContent(ref)).toThrow();
  });
});

// ── resolveMessagesForAPI ───────────────────────────────────────────────────

describe('resolveMessagesForAPI', () => {
  it('resolves content_ref on introduction turn to full block', () => {
    const pngPath = join(testDir, 'api.png');
    writeFileSync(pngPath, createMinimalPNG());
    const ref = ingestContent(pngPath, cwd);
    ref.introduced_turn = 3;

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, ref] },
    ];
    const resolved = resolveMessagesForAPI(messages, 3);
    const blocks = resolved[0].content as ContentBlock[];
    expect(blocks[1].type).toBe('image_url');
  });

  it('replaces content_ref on older turns with text pointer', () => {
    const pngPath = join(testDir, 'old.png');
    writeFileSync(pngPath, createMinimalPNG(100, 200));
    const ref = ingestContent(pngPath, cwd);
    ref.introduced_turn = 1;

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, ref] },
    ];
    const resolved = resolveMessagesForAPI(messages, 5);
    const blocks = resolved[0].content as ContentBlock[];
    expect(blocks[1].type).toBe('text');
    expect((blocks[1] as TextBlock).text).toMatch(/content #/);
  });

  it('preserves plain string messages unchanged', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const resolved = resolveMessagesForAPI(messages, 1);
    expect(resolved[0].content).toBe('hello');
    expect(resolved[1].content).toBe('hi there');
  });

  it('preserves messages with no content refs', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'just text' }] },
    ];
    const resolved = resolveMessagesForAPI(messages, 1);
    const blocks = resolved[0].content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
  });
});

// ── requestedRefs tracking ───────────────────────────────────────────────────

describe('requestedRefs tracking', () => {
  it('markRefRequested adds to set, consumeRequestedRefs returns and clears', () => {
    markRefRequested(1);
    markRefRequested(3);
    const refs = consumeRequestedRefs();
    expect(refs.has(1)).toBe(true);
    expect(refs.has(3)).toBe(true);
    // Second call returns empty
    expect(consumeRequestedRefs().size).toBe(0);
  });

  it('resolveMessagesForAPI resolves re-requested refs even on old turns', () => {
    const pngPath = join(testDir, 'rerequested.png');
    writeFileSync(pngPath, createMinimalPNG(400, 300));
    const ref = ingestContent(pngPath, cwd);
    ref.introduced_turn = 1; // old turn

    markRefRequested(ref.id);

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'check again' }, ref] },
    ];
    const resolved = resolveMessagesForAPI(messages, 10); // current turn is 10, but ref was requested
    const blocks = resolved[0].content as ContentBlock[];
    expect(blocks[1].type).toBe('image_url'); // resolved, not text pointer
  });
});

// ── restoreContentFromHistory ────────────────────────────────────────────────

describe('restoreContentFromHistory', () => {
  it('restores content refs from messages with content_ref blocks', () => {
    const pngPath = join(testDir, 'restore.png');
    writeFileSync(pngPath, createMinimalPNG(640, 480));
    const ref = ingestContent(pngPath, cwd);
    const cachePath = ref.cache_path;

    // Reset store — simulates new session
    resetContentStore();
    expect(getAllContentRefs()).toHaveLength(0);

    // Restore from history
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { ...ref }] },
    ];
    restoreContentFromHistory(messages);
    expect(getAllContentRefs()).toHaveLength(1);
    expect(getAllContentRefs()[0].id).toBe(ref.id);
  });

  it('skips refs where cache file no longer exists', () => {
    const fakeRef: ContentRef = {
      type: 'content_ref', id: 99, hash: 'deadbeef', media_type: 'image/png',
      size_bytes: 100, cache_path: '/tmp/nonexistent-restore-test.png', introduced_turn: 1,
    };
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, fakeRef] },
    ];
    restoreContentFromHistory(messages);
    expect(getAllContentRefs()).toHaveLength(0);
  });

  it('updates nextId to avoid ID collisions', () => {
    const pngPath = join(testDir, 'collision.png');
    writeFileSync(pngPath, createMinimalPNG(10, 10));
    const ref = ingestContent(pngPath, cwd);

    resetContentStore();
    const messages: Message[] = [
      { role: 'user', content: [{ ...ref, id: 5 }] },
    ];
    restoreContentFromHistory(messages);

    // Next ingest should get id > 5
    const pngPath2 = join(testDir, 'collision2.png');
    writeFileSync(pngPath2, createMinimalPNG(20, 20));
    const ref2 = ingestContent(pngPath2, cwd);
    expect(ref2.id).toBe(6);
  });

  it('ignores messages with string content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'just text' },
      { role: 'assistant', content: 'reply' },
    ];
    restoreContentFromHistory(messages);
    expect(getAllContentRefs()).toHaveLength(0);
  });
});

// ── describeContent ─────────────────────────────────────────────────────────

describe('describeContent', () => {
  it('describes image with dimensions', () => {
    const pngPath = join(testDir, 'desc.png');
    writeFileSync(pngPath, createMinimalPNG(1920, 1080));
    const ref = ingestContent(pngPath, cwd);
    const desc = describeContent(ref);
    expect(desc).toContain('1920');
    expect(desc).toContain('1080');
    expect(desc).toContain('PNG');
  });

  it('describes PDF with page count', () => {
    const pdfPath = join(testDir, 'desc.pdf');
    writeFileSync(pdfPath, createMinimalPDF(5));
    const ref = ingestContent(pdfPath, cwd);
    const desc = describeContent(ref);
    expect(desc).toContain('5');
    expect(desc).toContain('page');
  });
});

// ── estimateContentTokens ───────────────────────────────────────────────────

describe('estimateContentTokens', () => {
  it('estimates image tokens based on dimensions', () => {
    const ref: ContentRef = {
      type: 'content_ref', id: 1, hash: 'x', media_type: 'image/png',
      width: 1568, height: 1568, size_bytes: 1000, cache_path: '/tmp/x.png', introduced_turn: 0,
    };
    const tokens = estimateContentTokens(ref);
    // 1568x1568 → 2x2 tiles of 768 → 4 tiles × 768 = 3072
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10000);
  });

  it('estimates PDF tokens based on page count', () => {
    const ref: ContentRef = {
      type: 'content_ref', id: 1, hash: 'x', media_type: 'application/pdf',
      page_count: 10, size_bytes: 50000, cache_path: '/tmp/x.pdf', introduced_turn: 0,
    };
    const tokens = estimateContentTokens(ref);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ── estimateMessageContentChars ─────────────────────────────────────────────

describe('estimateMessageContentChars', () => {
  it('returns full image token estimate for current-turn refs', () => {
    const ref: ContentRef = {
      type: 'content_ref', id: 1, hash: 'x', media_type: 'image/png',
      width: 1568, height: 1568, size_bytes: 1000, cache_path: '/tmp/x.png', introduced_turn: 5,
    };
    const msg: Message = { role: 'user', content: [{ type: 'text', text: 'look' }, ref] };
    const chars = estimateMessageContentChars(msg, 5); // same turn
    // Should be large — full image tokens × 4
    expect(chars).toBeGreaterThan(1000);
  });

  it('returns small text pointer estimate for old-turn refs', () => {
    const ref: ContentRef = {
      type: 'content_ref', id: 1, hash: 'x', media_type: 'image/png',
      width: 1568, height: 1568, size_bytes: 1000, cache_path: '/tmp/x.png', introduced_turn: 1,
    };
    const msg: Message = { role: 'user', content: [{ type: 'text', text: 'look' }, ref] };
    const chars = estimateMessageContentChars(msg, 5); // different turn
    // Should be small — just a text pointer (~100 chars)
    expect(chars).toBeLessThan(200);
  });

  it('returns 0 for string content messages', () => {
    const msg: Message = { role: 'user', content: 'hello' };
    expect(estimateMessageContentChars(msg, 1)).toBe(0);
  });

  it('returns 0 for messages with only text blocks', () => {
    const msg: Message = { role: 'user', content: [{ type: 'text', text: 'just text' }] };
    expect(estimateMessageContentChars(msg, 1)).toBe(0);
  });
});

// ── saveContentIndex / restoreContentIndex ─────────────────────────────────

describe('content index persistence', () => {
  beforeEach(() => { mkdirSync(testDir, { recursive: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  it('saveContentIndex writes valid JSON with refs and nextId', () => {
    const pngPath = join(testDir, 'idx.png');
    writeFileSync(pngPath, createMinimalPNG());
    ingestContent(pngPath, testDir);
    // ingestContent auto-saves — verify the index file exists
    const { createHash } = require('node:crypto');
    const projId = createHash('md5').update(testDir).digest('hex').slice(0, 12);
    const indexPath = join(process.env.HOME || '', '.ag', 'projects', projId, 'content-refs.json');
    expect(existsSync(indexPath)).toBe(true);
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(data.nextId).toBeGreaterThan(0);
    expect(Array.isArray(data.refs)).toBe(true);
    expect(data.refs.length).toBe(1);
    expect(data.refs[0].media_type).toBe('image/png');
  });

  it('restoreContentIndex populates store from saved index', () => {
    const pngPath = join(testDir, 'restore.png');
    writeFileSync(pngPath, createMinimalPNG());
    const ref = ingestContent(pngPath, testDir);
    const refId = ref.id;

    // Reset store, then restore from index
    resetContentStore();
    expect(getAllContentRefs().length).toBe(0);
    restoreContentIndex(testDir);
    expect(getAllContentRefs().length).toBe(1);
    expect(getAllContentRefs()[0].id).toBe(refId);
  });

  it('restoreContentIndex filters out refs with missing cache files', () => {
    const pngPath = join(testDir, 'missing.png');
    writeFileSync(pngPath, createMinimalPNG());
    ingestContent(pngPath, testDir);

    // Delete the cached file
    const refs = getAllContentRefs();
    if (existsSync(refs[0].cache_path)) rmSync(refs[0].cache_path);

    resetContentStore();
    restoreContentIndex(testDir);
    expect(getAllContentRefs().length).toBe(0);
  });

  it('restoreContentIndex falls back to history scan when no index exists', () => {
    const pngPath = join(testDir, 'fallback.png');
    writeFileSync(pngPath, createMinimalPNG());
    const ref = ingestContent(pngPath, testDir);

    // Delete the index file
    const { createHash } = require('node:crypto');
    const projId = createHash('md5').update(testDir).digest('hex').slice(0, 12);
    const indexPath = join(process.env.HOME || '', '.ag', 'projects', projId, 'content-refs.json');
    if (existsSync(indexPath)) rmSync(indexPath);

    resetContentStore();
    const messages: Message[] = [{ role: 'user', content: [ref] }];
    restoreContentIndex(testDir, messages);
    expect(getAllContentRefs().length).toBe(1);
  });

  it('ingestContent auto-saves the index', () => {
    const pngPath = join(testDir, 'autosave.png');
    writeFileSync(pngPath, createMinimalPNG());
    ingestContent(pngPath, testDir);

    const { createHash } = require('node:crypto');
    const projId = createHash('md5').update(testDir).digest('hex').slice(0, 12);
    const indexPath = join(process.env.HOME || '', '.ag', 'projects', projId, 'content-refs.json');
    expect(existsSync(indexPath)).toBe(true);
  });
});

// ── clearContentCache ──────────────────────────────────────────────────────

describe('clearContentCache', () => {
  beforeEach(() => { mkdirSync(testDir, { recursive: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  it('deletes content dir, index file, and resets store', () => {
    const pngPath = join(testDir, 'clear.png');
    writeFileSync(pngPath, createMinimalPNG());
    const ref = ingestContent(pngPath, testDir);

    // Verify files exist before clear
    expect(existsSync(ref.cache_path)).toBe(true);
    expect(getAllContentRefs().length).toBe(1);

    clearContentCache(testDir);

    expect(getAllContentRefs().length).toBe(0);
    expect(existsSync(ref.cache_path)).toBe(false);

    const { createHash } = require('node:crypto');
    const projId = createHash('md5').update(testDir).digest('hex').slice(0, 12);
    const indexPath = join(process.env.HOME || '', '.ag', 'projects', projId, 'content-refs.json');
    expect(existsSync(indexPath)).toBe(false);
  });
});

// ── pruneContentCache (index-driven) ───────────────────────────────────────

describe('pruneContentCache', () => {
  beforeEach(() => { mkdirSync(testDir, { recursive: true }); });
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  it('removes expired refs from index and deletes their files', () => {
    const pngPath = join(testDir, 'expire.png');
    writeFileSync(pngPath, createMinimalPNG());
    const ref = ingestContent(pngPath, testDir);

    // Backdate the cached file so it's definitely expired
    const { utimesSync } = require('node:fs');
    const oldTime = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago
    utimesSync(ref.cache_path, oldTime, oldTime);

    // Prune with 30 days max age — file is 90 days old, should be pruned
    pruneContentCache(testDir, 30);

    expect(existsSync(ref.cache_path)).toBe(false);

    const { createHash } = require('node:crypto');
    const projId = createHash('md5').update(testDir).digest('hex').slice(0, 12);
    const indexPath = join(process.env.HOME || '', '.ag', 'projects', projId, 'content-refs.json');
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(data.refs.length).toBe(0);
  });

  it('keeps non-expired refs intact', () => {
    const pngPath = join(testDir, 'keep.png');
    writeFileSync(pngPath, createMinimalPNG());
    const ref = ingestContent(pngPath, testDir);

    // Prune with 30 days — just-created file should survive
    pruneContentCache(testDir, 30);

    expect(existsSync(ref.cache_path)).toBe(true);

    const { createHash } = require('node:crypto');
    const projId = createHash('md5').update(testDir).digest('hex').slice(0, 12);
    const indexPath = join(process.env.HOME || '', '.ag', 'projects', projId, 'content-refs.json');
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(data.refs.length).toBe(1);
  });
});
