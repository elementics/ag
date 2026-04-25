import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, renameSync, rmdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Message } from '../core/types.js';
import { AG_DIR } from '../core/constants.js';
import { stripResolvedBlocks, clearContentCache, getAllContentRefs } from '../core/content.js';
import { clearResultCache, getAllResultRefs } from '../core/results.js';

function projectId(cwd: string): string {
  return createHash('md5').update(cwd).digest('hex').slice(0, 12);
}

function ensure(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function paths(cwd: string = process.cwd()) {
  const proj = join(AG_DIR, 'projects', projectId(cwd));
  ensure(proj);
  ensure(AG_DIR);
  const plansDir = join(proj, 'plans');
  ensure(plansDir);
  return {
    globalMemory: join(AG_DIR, 'memory.md'),
    projectMemory: join(proj, 'memory.md'),
    plansDir,
    history: join(proj, 'history.jsonl'),
    tasks: join(proj, 'tasks.json'),
    contentDir: join(proj, 'content'),
    resultsDir: join(proj, 'results'),
    sessionState: join(proj, 'session-state.json'),
    projectDir: proj,
  };
}

// ── Read ────────────────────────────────────────────────────────────────────

export function loadGlobalMemory(cwd?: string): string { return read(paths(cwd).globalMemory); }
export function loadProjectMemory(cwd?: string): string { return read(paths(cwd).projectMemory); }
export function loadPlan(cwd?: string): string {
  const active = explicitPlanPath(cwd);
  return active ? read(active) : '';
}

/** List all plan files sorted newest first */
export function listPlans(cwd?: string): { name: string; path: string }[] {
  const dir = paths(cwd).plansDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && statSync(join(dir, f)).size > 0)
    .sort()
    .reverse()
    .map(f => ({ name: f.replace('.md', ''), path: join(dir, f) }));
}

/** Load a specific plan by name */
export function loadPlanByName(name: string, cwd?: string): string {
  const dir = resolve(paths(cwd).plansDir);
  const file = resolve(dir, `${name}.md`);
  // Prevent path traversal — ensure resolved path stays within plans dir
  const rel = relative(dir, file);
  if (rel.startsWith('..') || resolve(dir, rel) !== file) return '';
  return read(file);
}

function currentPointerPath(cwd?: string): string {
  return join(paths(cwd).plansDir, '.current');
}

/** Returns the explicitly activated plan path, or null if no .current pointer. */
function explicitPlanPath(cwd?: string): string | null {
  const pointer = currentPointerPath(cwd);
  if (!existsSync(pointer)) return null;
  const name = readFileSync(pointer, 'utf-8').trim();
  if (!name) return null;
  const target = join(paths(cwd).plansDir, name);
  return existsSync(target) && statSync(target).size > 0 ? target : null;
}

/** Build a system prompt prefix from all memory tiers (capped to avoid context bloat) */
// ── Tasks ──────────────────────────────────────────────────────────────────

export interface Task {
  id: number;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'done';
  plan?: string;
  created: string;
}

export function loadTasks(cwd?: string): Task[] {
  const raw = read(paths(cwd).tasks);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export function saveTasks(tasks: Task[], cwd?: string): void {
  const file = paths(cwd).tasks;
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf-8');
  renameSync(tmp, file);
}

const LOCK_TIMEOUT = 5000;
const LOCK_POLL = 10;

function acquireTaskLock(lockDir: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT;
  while (true) {
    try {
      mkdirSync(lockDir);
      return;
    } catch {
      if (Date.now() > deadline) {
        // Stale lock from a crashed process — force remove and retry once
        try { rmdirSync(lockDir); } catch { /* ignore */ }
        try { mkdirSync(lockDir); return; } catch { /* fall through */ }
        throw new Error('Task lock timeout — another process may be updating tasks');
      }
      // Spin-wait (sub-millisecond hold times make this fine for CLI)
      const wait = Math.min(LOCK_POLL, deadline - Date.now());
      if (wait > 0) { const end = Date.now() + wait; while (Date.now() < end) { /* spin */ } }
    }
  }
}

/**
 * Atomic read-modify-write for tasks. Acquires a file lock, reads fresh state,
 * calls the mutator, and writes back atomically. Use for all task mutations
 * to prevent lost updates when parallel sub-agents update concurrently.
 */
export function withTasks<T>(cwd: string | undefined, mutator: (tasks: Task[]) => T): T {
  const taskPath = paths(cwd).tasks;
  const lockDir = `${taskPath}.lock`;
  acquireTaskLock(lockDir);
  try {
    const tasks = loadTasks(cwd);
    const result = mutator(tasks);
    saveTasks(tasks, cwd);
    return result;
  } finally {
    try { rmdirSync(lockDir); } catch { /* ignore */ }
  }
}

const TASK_EXPIRY_DAYS = 30;

/** Startup cleanup: reset orphaned in_progress → pending, remove done tasks older than 30 days */
export function cleanupTasks(cwd?: string): void {
  const tasks = loadTasks(cwd);
  if (tasks.length === 0) return;

  const cutoff = Date.now() - TASK_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let changed = false;

  for (const t of tasks) {
    if (t.status === 'in_progress') {
      t.status = 'pending';
      changed = true;
    }
  }

  const kept = tasks.filter(t => {
    if (t.status !== 'done') return true;
    const created = new Date(t.created).getTime();
    return isNaN(created) || created > cutoff;
  });

  if (kept.length < tasks.length || changed) {
    saveTasks(kept, cwd);
  }
}

export function loadContext(cwd?: string, options?: { skipTasks?: boolean; messages?: Array<{ role: string; content: unknown; _steer?: boolean }> }): string {
  const cap = (s: string, limit = 4000) => {
    if (s.length <= limit) return s;
    // Truncate at the last newline before the limit to avoid mid-sentence cuts
    const cut = s.lastIndexOf('\n', limit);
    return s.slice(0, cut > 0 ? cut : limit) + '\n[truncated]';
  };

  const global = cap(loadGlobalMemory(cwd));
  const project = cap(loadProjectMemory(cwd));
  const plan = cap(loadPlan(cwd));

  const parts: string[] = [];
  if (global) parts.push(`<global-memory>\n${global}\n</global-memory>`);
  if (project) parts.push(`<project-memory>\n${project}\n</project-memory>`);
  if (plan) {
    const plans = listPlans(cwd);
    const activeName = getActivePlanName(cwd);
    const header = plans.length > 1 ? `(${plans.length} plans total, showing active)` : '';
    const nameAttr = activeName ? ` name="${activeName}"` : '';
    parts.push(`<current-plan${nameAttr}>${header}\n${plan}\n</current-plan>`);
  }

  if (!options?.skipTasks) {
    const tasks = loadTasks(cwd);
    const active = tasks.filter(t => t.status !== 'done');
    if (active.length > 0) {
      const activePlan = getActivePlanName(cwd);
      const lines = active.map(t => `${t.id}. [${t.status}] ${t.title}`);
      const planAttr = activePlan ? ` plan="${activePlan}"` : '';
      const taskBlock = cap(lines.join('\n'));
      parts.push(`<tasks${planAttr}>\n${taskBlock}\n</tasks>`);
    }
  }

  // Expose history file path so the agent can grep it for older context
  const historyPath = paths(cwd).history;
  if (existsSync(historyPath)) {
    parts.push(`<history-file>${historyPath}</history-file>`);
  }

  // Rolling window of recent user messages from history + live messages (skip synthetic ones)
  const isRealUserMsg = (role: string, content: unknown, steer?: boolean): content is string =>
    role === 'user' && !steer
    && typeof content === 'string'
    && !content.startsWith('Resuming previous session')
    && !content.startsWith('[Conversation compacted')
    && !content.startsWith('[Context reconstructed');

  // Pull from history.jsonl (covers prior sessions)
  const historyMsgs = readTailLines(paths(cwd).history, 60);
  const fromHistory: string[] = [];
  for (const line of historyMsgs) {
    try {
      const m = JSON.parse(line);
      if (isRealUserMsg(m.role, m.content)) fromHistory.push((m.content as string).slice(0, 500));
    } catch { /* skip corrupt lines */ }
  }

  // Pull from live messages (current session, may include very recent input not yet in history)
  const fromLive: string[] = [];
  if (options?.messages) {
    for (const m of options.messages) {
      if (isRealUserMsg(m.role, m.content, m._steer)) fromLive.push((m.content as string).slice(0, 500));
    }
  }

  // Merge: history first, then live, deduplicate, take last 10
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const msg of [...fromHistory, ...fromLive]) {
    if (!seen.has(msg)) { seen.add(msg); merged.push(msg); }
  }
  const recent = merged.slice(-10);
  if (recent.length > 0) {
    parts.push(`<recent-user-messages>\n${recent.join('\n---\n')}\n</recent-user-messages>`);
  }

  return parts.join('\n\n');
}

/** Read the last N lines from a file by seeking backwards from EOF. */
export function readTailLines(path: string, count: number): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];

    const CHUNK = 8192;
    let pos = size;
    let tail = '';
    let newlines = 0;

    while (pos > 0 && newlines <= count) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, pos);
      const chunk = buf.toString('utf-8');
      tail = chunk + tail;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk.charCodeAt(i) === 10) newlines++;
      }
    }

    const lines = tail.split('\n').filter(Boolean);
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}

/** Load recent user/assistant messages from history (for session continuity) */
export function loadHistory(cwd?: string, limit = 20): Message[] {
  const historyPath = paths(cwd).history;
  const lines = readTailLines(historyPath, limit * 3);
  const messages: Message[] = [];
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool') {
        messages.push(msg);
      }
    } catch { /* skip corrupt lines */ }
  }
  const sliced = messages.slice(-limit);

  // Trim from start until we hit a user message — avoids orphaned tool results
  while (sliced.length > 0 && sliced[0].role !== 'user') {
    sliced.shift();
  }

  // Validate tool call integrity: every assistant message with tool_calls must
  // have ALL corresponding tool results, and every tool result must have a
  // matching tool_calls entry. Remove incomplete exchanges from the end.
  while (sliced.length > 0) {
    const last = sliced[sliced.length - 1];
    // Trailing tool result without its full set
    if (last.role === 'tool') { sliced.pop(); continue; }
    // Trailing assistant with tool_calls but missing tool results
    if (last.role === 'assistant' && last.tool_calls?.length) { sliced.pop(); continue; }
    break;
  }

  return sliced;
}

// ── Write ───────────────────────────────────────────────────────────────────

export function saveGlobalMemory(content: string, cwd?: string): void {
  writeFileSync(paths(cwd).globalMemory, content);
}

export function appendGlobalMemory(content: string, cwd?: string): void {
  const p = paths(cwd).globalMemory;
  const prefix = existsSync(p) && readFileSync(p, 'utf-8').trim().length > 0 ? '\n' : '';
  appendFileSync(p, prefix + content);
}

export function saveProjectMemory(content: string, cwd?: string): void {
  writeFileSync(paths(cwd).projectMemory, content);
}

export function appendProjectMemory(content: string, cwd?: string): void {
  const p = paths(cwd).projectMemory;
  const prefix = existsSync(p) && readFileSync(p, 'utf-8').trim().length > 0 ? '\n' : '';
  appendFileSync(p, prefix + content);
}

export function setActivePlan(name: string, cwd?: string): void {
  const fileName = name.endsWith('.md') ? name : `${name}.md`;
  writeFileSync(currentPointerPath(cwd), fileName);
}

export function getActivePlanName(cwd?: string): string | null {
  const active = explicitPlanPath(cwd);
  if (!active) return null;
  return active.split('/').pop()!.replace('.md', '');
}

function deriveNameFromContent(content: string): string {
  const first = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim() || 'plan';
  return first.slice(0, 50).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function savePlan(content: string, name?: string, cwd?: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = (name || deriveNameFromContent(content)).replace(/[^a-zA-Z0-9_-]/g, '-');
  const fileName = `${ts}-${safeName}.md`;
  const filePath = join(paths(cwd).plansDir, fileName);
  writeFileSync(filePath, content);
  setActivePlan(fileName, cwd);
  return filePath;
}

export function appendPlan(content: string, cwd?: string): string {
  const existing = explicitPlanPath(cwd);
  if (existing) {
    const prefix = readFileSync(existing, 'utf-8').trim().length > 0 ? '\n' : '';
    appendFileSync(existing, prefix + content);
    return existing;
  }
  return savePlan(content, undefined, cwd);
}

export function appendHistory(message: Message, cwd?: string): void {
  const p = paths(cwd).history;
  const cleaned = stripResolvedBlocks(message);
  appendFileSync(p, JSON.stringify({ ...cleaned, ts: new Date().toISOString() }) + '\n');
  // Rotate if over 1MB
  const stat = statSync(p, { throwIfNoEntry: false });
  if (stat && stat.size > 1_000_000) {
    const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    writeFileSync(p, lines.slice(-500).join('\n') + '\n');
  }
}

/** Rewrite history.jsonl with the given messages (used after rewind) */
export function rewriteHistory(messages: Message[], cwd?: string): void {
  const p = paths(cwd).history;
  const lines = messages.map(msg => {
    const cleaned = stripResolvedBlocks(msg);
    return JSON.stringify({ ...cleaned, ts: new Date().toISOString() });
  });
  writeFileSync(p, lines.join('\n') + '\n');
}

// ── Session state ──────────────────────────────────────────────────────────

export interface SessionState {
  sessionId: string;
  timestamp: string;
  turnNumber: number;
  summary: string;
  recentFileOps: { read: string[]; modified: string[] };
  activePlan: string | null;
  turnStatus?: string;
  workingState?: string;
}

export function saveSessionState(state: SessionState, cwd?: string): void {
  const p = paths(cwd).sessionState;
  writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
}

export function loadSessionState(cwd?: string): SessionState | null {
  const p = paths(cwd).sessionState;
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SessionState;
  } catch { return null; }
}

// ── Stats ───────────────────────────────────────────────────────────────────

export interface MemoryStats {
  globalMemory: boolean;
  projectMemory: boolean;
  planCount: number;
  taskCount: number;
  pendingTaskCount: number;
  historyLines: number;
  contentCount: number;
  resultCount: number;
}

export function getStats(cwd?: string): MemoryStats {
  const p = paths(cwd);
  const historyRaw = read(p.history);
  const contentCount = getAllContentRefs().length;
  const resultCount = getAllResultRefs().length;
  const tasks = loadTasks(cwd);
  return {
    globalMemory: existsSync(p.globalMemory) && read(p.globalMemory).length > 0,
    projectMemory: existsSync(p.projectMemory) && read(p.projectMemory).length > 0,
    planCount: listPlans(cwd).length,
    taskCount: tasks.length,
    pendingTaskCount: tasks.filter(t => t.status === 'pending').length,
    historyLines: historyRaw ? historyRaw.trim().split('\n').filter(Boolean).length : 0,
    contentCount,
    resultCount,
  };
}

// ── Clear ───────────────────────────────────────────────────────────────────

export function clearProject(cwd?: string): void {
  const p = paths(cwd);
  for (const f of [p.projectMemory, p.history, p.tasks]) {
    if (existsSync(f)) writeFileSync(f, '');
  }
  for (const plan of listPlans(cwd)) {
    unlinkSync(plan.path);
  }
  const pointer = currentPointerPath(cwd);
  if (existsSync(pointer)) unlinkSync(pointer);
  // Clear content cache, index, and in-memory refs
  clearContentCache(cwd || process.cwd());
  // Clear result cache, index, and in-memory refs
  clearResultCache(cwd || process.cwd());
  // Checkpoints are cleared by agent.clearProject() via checkpointStore.clear()
  // Clear session state
  if (existsSync(p.sessionState)) unlinkSync(p.sessionState);
}

export function clearSession(cwd?: string): void {
  const p = paths(cwd);
  const pointer = currentPointerPath(cwd);
  if (existsSync(pointer)) unlinkSync(pointer);
  if (existsSync(p.sessionState)) unlinkSync(p.sessionState);
}

export function clearAll(cwd?: string): void {
  clearProject(cwd);
  const p = paths(cwd);
  if (existsSync(p.globalMemory)) writeFileSync(p.globalMemory, '');
}
