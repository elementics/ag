/**
 * Content store — ingest, cache, resolve, and describe multimodal content (images, PDFs).
 * Send-once pattern: full content sent on introduction turn, text pointers on subsequent turns.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { AG_DIR } from './constants.js';
import type { Message, ContentRef, ResultRef, TextBlock, ImageUrlBlock, FileBlock } from './types.js';

// ── Project-scoped content cache dir ────────────────────────────────────────

function projectId(cwd: string): string {
  return createHash('md5').update(cwd).digest('hex').slice(0, 12);
}

function contentCacheDir(cwd: string): string {
  return join(AG_DIR, 'projects', projectId(cwd), 'content');
}

function contentIndexPath(cwd: string): string {
  return join(AG_DIR, 'projects', projectId(cwd), 'content-refs.json');
}

// ── Constants ───────────────────────────────────────────────────────────────
const CONTENT_EXPIRY_DAYS = 30;
const TOKENS_PER_PDF_PAGE = 1500;

const SUPPORTED_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// ── Store state (session-scoped) ────────────────────────────────────────────

let nextId = 1;
const refs = new Map<number, ContentRef>();
const requestedRefs = new Set<number>();

export function resetContentStore(): void {
  nextId = 1;
  refs.clear();
  requestedRefs.clear();
}

export function markRefRequested(id: number): void {
  requestedRefs.add(id);
}

export function consumeRequestedRefs(): Set<number> {
  const result = new Set(requestedRefs);
  requestedRefs.clear();
  return result;
}

/** Restore content refs from loaded conversation history (migration fallback) */
export function restoreContentFromHistory(messages: Message[]): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'content_ref') {
        const ref = block as ContentRef;
        if (existsSync(ref.cache_path)) {
          refs.set(ref.id, ref);
          if (ref.id >= nextId) nextId = ref.id + 1;
        }
      }
    }
  }
}

// ── Content index persistence ──────────────────────────────────────────────

/** Save the in-memory content ref map to disk */
export function saveContentIndex(cwd: string): void {
  const data = { nextId, refs: [...refs.values()] };
  const dir = join(AG_DIR, 'projects', projectId(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(contentIndexPath(cwd), JSON.stringify(data) + '\n');
}

/** Restore content refs from the persisted index. Falls back to history scan if no index exists. */
export function restoreContentIndex(cwd: string, fallbackMessages?: Message[]): void {
  const indexPath = contentIndexPath(cwd);
  if (existsSync(indexPath)) {
    try {
      const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
      if (Array.isArray(data.refs)) {
        for (const ref of data.refs as ContentRef[]) {
          if (existsSync(ref.cache_path)) {
            refs.set(ref.id, ref);
          }
        }
      }
      if (typeof data.nextId === 'number' && data.nextId > nextId) {
        nextId = data.nextId;
      }
      return;
    } catch { /* corrupt index — fall through to migration */ }
  }
  // Migration: no index file yet, scan history messages
  if (fallbackMessages) restoreContentFromHistory(fallbackMessages);
}

/** Delete all cached content files, the index, and reset the in-memory store. */
export function clearContentCache(cwd: string): void {
  const dir = contentCacheDir(cwd);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  const idx = contentIndexPath(cwd);
  if (existsSync(idx)) unlinkSync(idx);
  resetContentStore();
}

export function getContentRef(id: number): ContentRef | undefined {
  return refs.get(id);
}

export function getAllContentRefs(): ContentRef[] {
  return [...refs.values()];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getTextContent(msg: Message): string {
  if (msg.content === null) return '';
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
}

export function hasContent(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(b => b.type === 'content_ref' || b.type === 'image_url' || b.type === 'file');
}

// ── Dimension extraction ────────────────────────────────────────────────────

function getPNGDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG IHDR chunk starts at byte 16: width(4) + height(4)
  if (buf.length < 24) return null;
  if (buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function getJPEGDimensions(buf: Buffer): { width: number; height: number } | null {
  // Scan for SOF0 (0xFFC0) through SOF3 (0xFFC3) markers
  let i = 2; // skip SOI
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xC0 && marker <= 0xC3) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height };
    }
    // Skip to next marker using segment length
    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
    if (i + 3 >= buf.length) break;
    const segLen = buf.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  return null;
}

function getPDFPageCount(buf: Buffer): number {
  const text = buf.toString('utf-8', 0, Math.min(buf.length, 64 * 1024));
  // Match /Count N in the Pages dictionary
  const match = text.match(/\/Count\s+(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

// ── Ingest ──────────────────────────────────────────────────────────────────

export function ingestContent(source: string, cwd: string): ContentRef {
  if (!existsSync(source)) {
    throw new Error(`Content not found: ${source}`);
  }

  const ext = extname(source).toLowerCase();
  const mediaType = SUPPORTED_TYPES[ext];
  if (!mediaType) {
    throw new Error(`Unsupported content type: ${ext}. Supported: ${Object.keys(SUPPORTED_TYPES).join(', ')}`);
  }

  const buf = readFileSync(source);
  const hash = createHash('sha256').update(buf).digest('hex');
  const cacheDir = contentCacheDir(cwd);
  const cachePath = join(cacheDir, `${hash}${ext}`);

  // Cache the file if not already present
  if (!existsSync(cachePath)) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, buf);
  }

  // Extract metadata
  let width: number | undefined;
  let height: number | undefined;
  let page_count: number | undefined;

  if (mediaType === 'image/png') {
    const dims = getPNGDimensions(buf);
    if (dims) { width = dims.width; height = dims.height; }
  } else if (mediaType === 'image/jpeg') {
    const dims = getJPEGDimensions(buf);
    if (dims) { width = dims.width; height = dims.height; }
  } else if (mediaType === 'application/pdf') {
    page_count = getPDFPageCount(buf);
  }

  const id = nextId++;
  const ref: ContentRef = {
    type: 'content_ref',
    id,
    hash,
    media_type: mediaType,
    filename: basename(source),
    width,
    height,
    page_count,
    size_bytes: buf.length,
    cache_path: cachePath,
    introduced_turn: 0, // set by caller when attaching to a message
  };

  refs.set(id, ref);
  saveContentIndex(cwd);
  return ref;
}

// ── Resolve ─────────────────────────────────────────────────────────────────

export function resolveContent(ref: ContentRef): ImageUrlBlock | FileBlock {
  if (!existsSync(ref.cache_path)) {
    throw new Error(`Cached content missing: ${ref.cache_path}`);
  }

  const buf = readFileSync(ref.cache_path);
  const b64 = buf.toString('base64');

  if (IMAGE_TYPES.has(ref.media_type)) {
    return {
      type: 'image_url',
      image_url: { url: `data:${ref.media_type};base64,${b64}` },
    };
  }

  return {
    type: 'file',
    file: {
      filename: ref.filename || basename(ref.cache_path),
      file_data: `data:${ref.media_type};base64,${b64}`,
    },
  };
}

// ── Resolve messages for API ────────────────────────────────────────────────

/** Threshold for collapsing large tool call arguments (reuse from results) */
const ARG_COLLAPSE_THRESHOLD = 2048;

/** Generate a concise summary of tool call arguments */
function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const action = args.action as string | undefined;
  const path = (args.path || args.file_path) as string | undefined;
  const content = args.content as string | undefined;
  const oldString = args.old_string as string | undefined;
  const newString = args.new_string as string | undefined;

  if (toolName === 'file' && action === 'write' && content) {
    return `write ${path || 'file'} (${content.length} chars — use file(action=read) to view)`;
  }
  if (toolName === 'file' && action === 'edit' && (oldString || newString)) {
    const totalChars = (oldString?.length || 0) + (newString?.length || 0);
    return `edit ${path || 'file'} (${totalChars} chars of changes — use file(action=read) to view)`;
  }
  if (toolName === 'bash' && args.command) {
    const cmd = String(args.command);
    return cmd.length > 200 ? cmd.slice(0, 200) + '...' : cmd;
  }
  return `${toolName}(${action || '...'}) — large arguments`;
}

export function resolveMessagesForAPI(messages: Message[], currentTurn: number): Message[] {
  const reRequested = consumeRequestedRefs();

  // Find the last assistant message with tool_calls — that's the current turn, don't collapse it
  let lastToolAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      lastToolAssistantIdx = i;
      break;
    }
  }

  return messages.map((msg, msgIdx) => {
    // ── Collapse large tool call arguments on older turns ──
    if (msg.role === 'assistant' && msg.tool_calls?.length && msgIdx < lastToolAssistantIdx) {
      const hasLargeArgs = msg.tool_calls.some(tc => tc.function.arguments.length > ARG_COLLAPSE_THRESHOLD);
      if (hasLargeArgs) {
        const collapsed = msg.tool_calls.map(tc => {
          if (tc.function.arguments.length <= ARG_COLLAPSE_THRESHOLD) return tc;
          let args: Record<string, unknown>;
          try { args = JSON.parse(tc.function.arguments); } catch { return tc; }
          const summary = summarizeArgs(tc.function.name, args);
          // Preserve key fields for context, drop large content
          const slim: Record<string, unknown> = { _collapsed: true, _summary: summary };
          if (args.action) slim.action = args.action;
          if (args.path) slim.path = args.path;
          if (args.file_path) slim.file_path = args.file_path;
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(slim) } };
        });
        msg = { ...msg, tool_calls: collapsed };
      }
    }

    // ── Content/Result ref handling ──
    if (!Array.isArray(msg.content)) return msg;

    const hasRefs = msg.content.some(b => b.type === 'content_ref' || b.type === 'result_ref');
    if (!hasRefs) return msg;

    const resultRef = msg.content.find(b => b.type === 'result_ref') as ResultRef | undefined;
    const isResultIntroTurn = resultRef && resultRef.introduced_turn === currentTurn;

    const resolved = msg.content.flatMap(block => {
      if (block.type === 'content_ref') {
        const ref = block as ContentRef;
        if (ref.introduced_turn === currentTurn || reRequested.has(ref.id)) {
          return resolveContent(ref);
        }
        return {
          type: 'text' as const,
          text: `[content #${ref.id}: ${ref.filename || 'unknown'} — ${describeContent(ref)} — not in current context. Call content(action=get, ref=${ref.id}) to view it.]`,
        };
      }

      if (block.type === 'result_ref') {
        const ref = block as ResultRef;
        if (isResultIntroTurn) {
          return [];
        }
        return {
          type: 'text' as const,
          text: `[result #${ref.id} from ${ref.tool_name}: ${ref.summary} — use result(action=get, ref=${ref.id}) for full content]`,
        };
      }

      if (block.type === 'text' && resultRef && !isResultIntroTurn) {
        return [];
      }

      return block;
    });

    return { ...msg, content: resolved };
  });
}

// ── Describe ────────────────────────────────────────────────────────────────

export function describeContent(ref: ContentRef): string {
  const parts: string[] = [];

  if (ref.width && ref.height) {
    parts.push(`${ref.width}×${ref.height}`);
  }

  const ext = extname(ref.cache_path).replace('.', '').toUpperCase();
  if (ext) parts.push(ext);

  if (ref.page_count) {
    parts.push(`${ref.page_count} page${ref.page_count > 1 ? 's' : ''}`);
  }

  const size = ref.size_bytes < 1024 ? `${ref.size_bytes}B`
    : ref.size_bytes < 1024 * 1024 ? `${(ref.size_bytes / 1024).toFixed(1)}KB`
    : `${(ref.size_bytes / (1024 * 1024)).toFixed(1)}MB`;
  parts.push(size);

  return parts.join(', ');
}

// ── Token estimation ────────────────────────────────────────────────────────

export function estimateContentTokens(ref: ContentRef): number {
  if (IMAGE_TYPES.has(ref.media_type) && ref.width && ref.height) {
    // Claude resizes to fit 1568px bounding box, then tiles into 768×768 blocks
    const scale = Math.min(1, 1568 / Math.max(ref.width, ref.height));
    const w = Math.ceil(ref.width * scale);
    const h = Math.ceil(ref.height * scale);
    const tiles = Math.ceil(w / 768) * Math.ceil(h / 768);
    return tiles * 768;
  }

  if (ref.media_type === 'application/pdf') {
    return (ref.page_count || 1) * TOKENS_PER_PDF_PAGE;
  }

  return 1000; // fallback estimate
}

const TEXT_POINTER_CHARS = 100; // approximate length of "[content #N: ... — not in current context. Call ...]"

/** Estimate total content chars for a message, considering which turn refs will be resolved on */
export function estimateMessageContentChars(msg: Message, currentTurn: number): number {
  if (!Array.isArray(msg.content)) return 0;
  let chars = 0;
  for (const block of msg.content) {
    if (block.type === 'content_ref') {
      const ref = block as ContentRef;
      if (ref.introduced_turn === currentTurn) {
        chars += estimateContentTokens(ref) * 4; // tokens → chars
      } else {
        chars += TEXT_POINTER_CHARS;
      }
    }
  }
  return chars;
}

// ── Display (terminal rendering) ────────────────────────────────────────────

let terminalType: 'iterm2' | 'kitty' | 'text' | null = null;

function detectTerminal(): 'iterm2' | 'kitty' | 'text' {
  if (terminalType) return terminalType;
  if (process.env.TERM_PROGRAM === 'iTerm.app') terminalType = 'iterm2';
  else if (process.env.KITTY_WINDOW_ID) terminalType = 'kitty';
  else terminalType = 'text';
  return terminalType;
}

export function displayContent(ref: ContentRef): string {
  const desc = describeContent(ref);
  const label = `[content #${ref.id}] ${ref.filename || 'unknown'} — ${desc}`;
  const terminal = detectTerminal();

  if (terminal === 'iterm2' && IMAGE_TYPES.has(ref.media_type) && existsSync(ref.cache_path)) {
    const b64 = readFileSync(ref.cache_path).toString('base64');
    const osc = `\x1b]1337;File=inline=1;width=40;preserveAspectRatio=1:${b64}\x07`;
    return `${label}\n${osc}`;
  }

  if (terminal === 'kitty' && IMAGE_TYPES.has(ref.media_type) && existsSync(ref.cache_path)) {
    const b64 = readFileSync(ref.cache_path).toString('base64');
    // Kitty: send in chunks of 4096
    const chunks: string[] = [];
    for (let i = 0; i < b64.length; i += 4096) {
      const chunk = b64.slice(i, i + 4096);
      const more = i + 4096 < b64.length ? 1 : 0;
      if (i === 0) {
        chunks.push(`\x1b_Gf=100,a=T,m=${more};${chunk}\x1b\\`);
      } else {
        chunks.push(`\x1b_Gm=${more};${chunk}\x1b\\`);
      }
    }
    return `${label}\n${chunks.join('')}`;
  }

  return label;
}

// ── Cache pruning ───────────────────────────────────────────────────────────

export function pruneContentCache(cwd: string, maxAgeDays = CONTENT_EXPIRY_DAYS): void {
  const dir = contentCacheDir(cwd);
  const now = Date.now();
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
  let indexDirty = false;

  // Prune expired refs from the index
  const indexPath = contentIndexPath(cwd);
  if (existsSync(indexPath)) {
    try {
      const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
      if (Array.isArray(data.refs)) {
        const kept: ContentRef[] = [];
        for (const ref of data.refs as ContentRef[]) {
          try {
            if (!existsSync(ref.cache_path)) { indexDirty = true; continue; }
            const stat = statSync(ref.cache_path);
            if (now - stat.mtimeMs > maxAge) {
              unlinkSync(ref.cache_path);
              indexDirty = true;
            } else {
              kept.push(ref);
            }
          } catch { indexDirty = true; }
        }
        if (indexDirty) {
          writeFileSync(indexPath, JSON.stringify({ nextId: data.nextId, refs: kept }) + '\n');
        }
      }
    } catch { /* corrupt index — fall through to directory sweep */ }
  }

  // Safety sweep: remove any orphaned files not tracked by the index
  if (!existsSync(dir)) return;
  const indexedPaths = new Set<string>();
  try {
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
    if (Array.isArray(data.refs)) {
      for (const ref of data.refs) indexedPaths.add(ref.cache_path);
    }
  } catch { /* no index or corrupt — sweep all expired files */ }

  try {
    for (const file of readdirSync(dir)) {
      const filePath = join(dir, file);
      if (indexedPaths.has(filePath)) continue; // tracked by index, already handled
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAge) unlinkSync(filePath);
      } catch { /* ignore */ }
    }
  } catch { /* directory read error */ }
}

// ── Strip resolved blocks for history serialization ─────────────────────────

export function stripResolvedBlocks(msg: Message): Message {
  // Strip internal _turn field — not persisted to history
  if (msg._turn != null) {
    const { _turn: _, ...rest } = msg;
    msg = rest as Message;
  }

  // ── Collapse large tool call arguments for history ──
  if (msg.role === 'assistant' && msg.tool_calls?.length) {
    const hasLargeArgs = msg.tool_calls.some(tc => tc.function.arguments.length > ARG_COLLAPSE_THRESHOLD);
    if (hasLargeArgs) {
      const collapsed = msg.tool_calls.map(tc => {
        if (tc.function.arguments.length <= ARG_COLLAPSE_THRESHOLD) return tc;
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.function.arguments); } catch { return tc; }
        const summary = summarizeArgs(tc.function.name, args);
        const slim: Record<string, unknown> = { _collapsed: true, _summary: summary };
        if (args.action) slim.action = args.action;
        if (args.path) slim.path = args.path;
        if (args.file_path) slim.file_path = args.file_path;
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify(slim) } };
      });
      msg = { ...msg, tool_calls: collapsed };
    }
  }

  if (!Array.isArray(msg.content)) return msg;

  const hasResultRef = msg.content.some(b => b.type === 'result_ref');

  const stripped = msg.content.flatMap(block => {
    if (block.type === 'image_url' || block.type === 'file') {
      return { type: 'text' as const, text: '[resolved content block — stripped from history]' };
    }
    if (block.type === 'text' && hasResultRef) {
      return [];
    }
    return block;
  });

  return { ...msg, content: stripped };
}
