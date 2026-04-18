/**
 * Shared utilities — spinner, retry, truncation, and promise helpers
 */

import { C } from './colors.js';

// ── Spinner ─────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function startSpinner(label: string): () => void {
  if (!process.stderr.isTTY) {
    // Non-TTY fallback: static status line
    process.stderr.write(`  ... ${label}\n`);
    return () => {};
  }
  let i = 0;
  process.stderr.write(`  ${C.dim}${SPINNER_FRAMES[0]} ${label}${C.reset}\n`);
  const id = setInterval(() => {
    process.stderr.write(`\x1b[A\x1b[K  ${C.dim}${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${label}${C.reset}\n`);
  }, 80);
  return () => {
    clearInterval(id);
    process.stderr.write('\x1b[A\x1b[K');
  };
}

// ── Fetch with retry ────────────────────────────────────────────────────────

// Retryable HTTP status codes (transient server/rate-limit errors)
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Fetch with exponential backoff for transient failures. */
export async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt === maxRetries) return res;
      // Respect Retry-After header if present
      const retryAfter = res.headers.get('retry-after');
      const delay = retryAfter && !isNaN(Number(retryAfter))
        ? Math.min(Number(retryAfter) * 1000, 30_000)
        : Math.min(1000 * 2 ** attempt, 16_000);
      if (!init.signal?.aborted) await new Promise(r => setTimeout(r, delay));
    } catch (e: unknown) {
      // Don't retry user aborts
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      lastError = e;
      if (attempt === maxRetries) throw lastError;
      const delay = Math.min(1000 * 2 ** attempt, 16_000);
      if (!init.signal?.aborted) await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ── Tool result truncation ──────────────────────────────────────────────────

export const MAX_TOOL_RESULT_CHARS = 32768;
const TRUNCATION_HEAD_LINES = 100;
const TRUNCATION_TAIL_LINES = 100;

export function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  const lines = result.split('\n');
  if (lines.length <= TRUNCATION_HEAD_LINES + TRUNCATION_TAIL_LINES) return result;
  const head = lines.slice(0, TRUNCATION_HEAD_LINES);
  const tail = lines.slice(-TRUNCATION_TAIL_LINES);
  const omitted = lines.length - TRUNCATION_HEAD_LINES - TRUNCATION_TAIL_LINES;
  return [...head, `\n... [${omitted} lines truncated] ...\n`, ...tail].join('\n');
}

// ── Promise racing ──────────────────────────────────────────────────────────

/** Yield promise results as they resolve (like Promise.all but streaming) */
export async function* raceAll<T>(promises: Promise<T>[]): AsyncGenerator<T> {
  type Indexed = { i: number; v: T };
  type Settled = Indexed & { error?: unknown };
  // Catch rejections so they don't become unhandled when the caller breaks early (e.g. on abort)
  const wrapped = promises.map((p, i) =>
    p.then(v => ({ i, v } as Settled)).catch(e => ({ i, v: undefined as unknown, error: e } as Settled))
  );
  const settled = new Set<number>();
  while (settled.size < promises.length) {
    const result = await Promise.race(wrapped.filter((_, idx) => !settled.has(idx)));
    settled.add(result.i);
    if ('error' in result && result.error !== undefined) continue;
    yield result.v as T;
  }
}

// ── Prompt serialization ────────────────────────────────────────────────────

let _lockChain: Promise<void> = Promise.resolve();

/** Async mutex — callers execute one at a time, in request order. */
export async function acquirePromptLock(): Promise<() => void> {
  let release!: () => void;
  const prev = _lockChain;
  _lockChain = new Promise<void>(resolve => { release = resolve; });
  await prev;
  return release;
}

let _beforePromptHook: (() => void | Promise<void>) | null = null;

/** Register a hook called before any promptInput (e.g. to pause spinner/wait for steer) */
export function setBeforePromptHook(hook: (() => void | Promise<void>) | null): void {
  _beforePromptHook = hook;
}

// ── Raw-mode-safe readline prompt ───────────────────────────────────────────

/** Prompt the user for input, safely toggling raw mode off/on around readline.
 *  Acquires the prompt lock so concurrent tool prompts are serialized.
 *  Calls the before-prompt hook so the spinner/steer can be paused first. */
export async function promptInput(prompt: string): Promise<string> {
  const release = await acquirePromptLock();
  try {
    await _beforePromptHook?.();
    const { createInterface } = await import('node:readline');
    const wasRaw = process.stdin.isTTY && (process.stdin as any).isRaw;
    if (wasRaw) process.stdin.setRawMode(false);
    return await new Promise<string>(resolve => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(prompt, answer => { rl.close(); resolve(answer); });
    }).finally(() => { if (wasRaw) process.stdin.setRawMode(true); });
  } finally {
    release();
  }
}
