import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { paths } from '../memory/memory.js';

const TRACE_KEEP_FILES = 20;
const TRACE_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const TRACE_ROTATE_BYTES = 10 * 1024 * 1024;

export class TraceWriter {
  private readonly dir: string;
  private file: string;

  constructor(cwd: string, private readonly sessionId: string) {
    this.dir = join(paths(cwd).projectDir, 'traces');
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, `session-${sessionId}.jsonl`);
    TraceWriter.cleanup(cwd, sessionId);
  }

  write(event: string, payload: Record<string, unknown> = {}): void {
    try {
      this.rotateIfNeeded();
      const line = JSON.stringify(redactSecrets({
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        event,
        ...payload,
      }));
      appendFileSync(this.file, line + '\n');
    } catch {
      // Tracing must never break the agent loop.
    }
  }

  static cleanup(cwd: string, activeSessionId?: string): void {
    const dir = join(paths(cwd).projectDir, 'traces');
    if (!existsSync(dir)) return;
    const now = Date.now();
    const files = readdirSync(dir)
      .filter(name => name.startsWith('session-') && name.endsWith('.jsonl'))
      .map(name => {
        const file = join(dir, name);
        const stat = statSync(file, { throwIfNoEntry: false });
        return stat ? { name, file, mtimeMs: stat.mtimeMs } : null;
      })
      .filter((entry): entry is { name: string; file: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const activePrefix = activeSessionId ? `session-${activeSessionId}` : '';
    for (const entry of files) {
      if (activePrefix && entry.name.startsWith(activePrefix)) continue;
      if (now - entry.mtimeMs > TRACE_KEEP_MS) safeRemove(entry.file);
    }

    const remaining = files.filter(entry => existsSync(entry.file));
    for (const entry of remaining.slice(TRACE_KEEP_FILES)) {
      if (activePrefix && entry.name.startsWith(activePrefix)) continue;
      safeRemove(entry.file);
    }
  }

  private rotateIfNeeded(): void {
    const stat = statSync(this.file, { throwIfNoEntry: false });
    if (!stat || stat.size < TRACE_ROTATE_BYTES) return;
    this.file = join(this.dir, `session-${this.sessionId}-${Date.now()}.jsonl`);
  }
}

function safeRemove(file: string): void {
  try { rmSync(file); } catch { /* ignore */ }
}

function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/token|secret|password|api[_-]?key|authorization/i.test(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = redactSecrets(nested);
      }
    }
    return output;
  }
  return value;
}

function redactString(value: string): string {
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted-api-key]')
    .replace(/\b([A-Za-z0-9_]{20,}\.[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{20,})\b/g, '[redacted-token]');
  const homeBase = basename(process.env.HOME ?? '');
  return homeBase ? redacted.replace(new RegExp(homeBase, 'g'), '[home]') : redacted;
}
