import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import {
  paths, loadGlobalMemory, saveGlobalMemory, appendGlobalMemory,
  loadProjectMemory, saveProjectMemory, appendProjectMemory,
  savePlan, loadPlan, listPlans, loadPlanByName, appendPlan,
  setActivePlan, getActivePlanName,
  loadContext, loadHistory, appendHistory, getStats,
  clearProject, clearAll,
  loadTasks, saveTasks, cleanupTasks,
  type Task,
} from '../memory.js';

// memory.ts uses AG_DIR (~/.ag) internally keyed by md5(cwd).
// We use a unique fake cwd per test run so each test gets isolated project dirs.
const fakeCwd = `/tmp/__ag_test_${randomBytes(8).toString('hex')}__`;
let projectDir: string;

// Global memory (~/.ag/memory.md) is shared across all tests.
// Save/restore it around the entire test suite to avoid cross-test contamination.
let savedGlobalMemory: string;

beforeEach(() => {
  // Ensure the fake cwd "exists" enough for paths() to derive a project dir
  mkdirSync(fakeCwd, { recursive: true });
  const p = paths(fakeCwd);
  projectDir = p.projectDir;
  // Snapshot global memory before each test, then clear it for isolation
  savedGlobalMemory = loadGlobalMemory(fakeCwd);
  saveGlobalMemory('', fakeCwd);
});

afterEach(() => {
  // Restore global memory to pre-test state
  saveGlobalMemory(savedGlobalMemory, fakeCwd);
  // Clean up the project dir under ~/.ag/projects/
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true });
  if (existsSync(fakeCwd)) rmSync(fakeCwd, { recursive: true });
});

describe('paths', () => {
  it('returns expected structure', () => {
    const p = paths(fakeCwd);
    expect(p.globalMemory).toContain('.ag/memory.md');
    expect(p.projectMemory).toContain('memory.md');
    expect(p.plansDir).toContain('plans');
    expect(p.history).toContain('history.jsonl');
    expect(existsSync(p.plansDir)).toBe(true);
  });
});

describe('global memory', () => {
  it('roundtrips save/load', () => {
    saveGlobalMemory('test global content', fakeCwd);
    expect(loadGlobalMemory(fakeCwd)).toBe('test global content');
  });

  it('appends with newline separator', () => {
    saveGlobalMemory('line1', fakeCwd);
    appendGlobalMemory('line2', fakeCwd);
    expect(loadGlobalMemory(fakeCwd)).toBe('line1\nline2');
  });
});

describe('project memory', () => {
  it('roundtrips save/load', () => {
    saveProjectMemory('project stuff', fakeCwd);
    expect(loadProjectMemory(fakeCwd)).toBe('project stuff');
  });

  it('appends with newline separator', () => {
    saveProjectMemory('first', fakeCwd);
    appendProjectMemory('second', fakeCwd);
    expect(loadProjectMemory(fakeCwd)).toBe('first\nsecond');
  });
});

describe('plans', () => {
  it('saves and lists plans', () => {
    savePlan('Plan A content', 'plan-a', fakeCwd);
    savePlan('Plan B content', 'plan-b', fakeCwd);
    const plans = listPlans(fakeCwd);
    expect(plans.length).toBe(2);
    // Newest first
    expect(plans[0].name).toContain('plan-b');
  });

  it('loads latest plan', () => {
    savePlan('old plan', 'old', fakeCwd);
    savePlan('new plan', 'new', fakeCwd);
    expect(loadPlan(fakeCwd)).toBe('new plan');
  });

  it('loads plan by name', () => {
    const filePath = savePlan('specific plan', 'specific', fakeCwd);
    const name = filePath.split('/').pop()!.replace('.md', '');
    expect(loadPlanByName(name, fakeCwd)).toBe('specific plan');
  });

  it('blocks path traversal in loadPlanByName', () => {
    expect(loadPlanByName('../../etc/passwd', fakeCwd)).toBe('');
  });

  it('appends to latest plan', () => {
    savePlan('base', 'append-test', fakeCwd);
    appendPlan('\nmore content', fakeCwd);
    expect(loadPlan(fakeCwd)).toContain('more content');
  });

  it('appendPlan creates new plan if none exist', () => {
    appendPlan('first plan via append', fakeCwd);
    expect(listPlans(fakeCwd).length).toBe(1);
    expect(loadPlan(fakeCwd)).toContain('first plan via append');
  });

  it('setActivePlan switches current plan', () => {
    savePlan('plan X', 'x', fakeCwd);
    const planY = savePlan('plan Y', 'y', fakeCwd);
    const plans = listPlans(fakeCwd);
    const planXName = plans.find(p => p.name.includes('x'))!.name;

    setActivePlan(planXName, fakeCwd);
    expect(loadPlan(fakeCwd)).toBe('plan X');
    expect(getActivePlanName(fakeCwd)).toBe(planXName);
  });
});

describe('loadContext', () => {
  it('builds system prompt with XML tags', () => {
    saveGlobalMemory('global fact', fakeCwd);
    saveProjectMemory('project fact', fakeCwd);
    savePlan('the plan', 'ctx-test', fakeCwd);

    const ctx = loadContext(fakeCwd);
    expect(ctx).toContain('<global-memory>');
    expect(ctx).toContain('global fact');
    expect(ctx).toContain('<project-memory>');
    expect(ctx).toContain('project fact');
    expect(ctx).toContain('<current-plan name="');
    expect(ctx).toContain('the plan');
  });

  it('truncates at 4000 chars with [truncated] marker', () => {
    const long = 'x'.repeat(5000);
    saveProjectMemory(long, fakeCwd);
    const ctx = loadContext(fakeCwd);
    expect(ctx).toContain('[truncated]');
    expect(ctx.length).toBeLessThan(long.length + 200);
  });

  it('returns empty string when no memory exists', () => {
    expect(loadContext(fakeCwd)).toBe('');
  });
});

describe('history', () => {
  it('roundtrips append/load for user and assistant messages', () => {
    appendHistory({ role: 'user', content: 'hello' }, fakeCwd);
    appendHistory({ role: 'assistant', content: 'hi there' }, fakeCwd);

    const history = loadHistory(fakeCwd);
    expect(history.length).toBe(2);
    expect(history[0].content).toBe('hello');
    expect(history[1].content).toBe('hi there');
  });

  it('includes tool messages in history', () => {
    appendHistory({ role: 'user', content: 'do something' }, fakeCwd);
    appendHistory({ role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'bash', arguments: '{}' } }] }, fakeCwd);
    appendHistory({ role: 'tool', content: 'tool result', tool_call_id: '1' }, fakeCwd);
    appendHistory({ role: 'assistant', content: 'done' }, fakeCwd);

    const history = loadHistory(fakeCwd);
    expect(history.length).toBe(4);
    expect(history[0].content).toBe('do something');
    expect(history[1].tool_calls).toBeDefined();
    expect(history[2].content).toBe('tool result');
    expect(history[3].content).toBe('done');
  });

  it('trims orphaned tool results from start of history', () => {
    // Simulate a history slice that starts with orphaned tool results
    appendHistory({ role: 'tool', content: 'orphan result', tool_call_id: 'old_1' }, fakeCwd);
    appendHistory({ role: 'assistant', content: 'old response' }, fakeCwd);
    appendHistory({ role: 'user', content: 'new question' }, fakeCwd);
    appendHistory({ role: 'assistant', content: 'new answer' }, fakeCwd);

    const history = loadHistory(fakeCwd);
    expect(history.length).toBe(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('new question');
  });

  it('trims trailing assistant with tool_calls missing results', () => {
    appendHistory({ role: 'user', content: 'do something' }, fakeCwd);
    appendHistory({ role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'bash', arguments: '{}' } }] }, fakeCwd);

    const history = loadHistory(fakeCwd);
    // The assistant with tool_calls has no tool results — should be trimmed
    expect(history.length).toBe(1);
    expect(history[0].role).toBe('user');
  });

  it('trims trailing orphaned tool results', () => {
    appendHistory({ role: 'user', content: 'hello' }, fakeCwd);
    appendHistory({ role: 'assistant', content: 'hi' }, fakeCwd);
    appendHistory({ role: 'tool', content: 'stray result', tool_call_id: 'x' }, fakeCwd);

    const history = loadHistory(fakeCwd);
    expect(history.length).toBe(2);
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('hi');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 20; i++) {
      appendHistory({ role: 'user', content: `msg ${i}` }, fakeCwd);
    }
    const history = loadHistory(fakeCwd, 5);
    expect(history.length).toBe(5);
    expect(history[4].content).toBe('msg 19');
  });

  it('returns empty array when no history', () => {
    expect(loadHistory(fakeCwd)).toEqual([]);
  });
});

describe('appendHistory with content blocks', () => {
  it('serializes ContentRef blocks as-is', () => {
    const ref = {
      type: 'content_ref' as const, id: 1, hash: 'abc', media_type: 'image/png',
      filename: 'test.png', width: 800, height: 600,
      size_bytes: 1000, cache_path: '/tmp/x.png', introduced_turn: 1,
    };
    appendHistory({ role: 'user', content: [{ type: 'text', text: 'look' }, ref] }, fakeCwd);
    const history = loadHistory(fakeCwd);
    expect(history.length).toBe(1);
    const blocks = history[0].content as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0]).toEqual({ type: 'text', text: 'look' });
    expect(blocks[1]).toHaveProperty('type', 'content_ref');
    expect(blocks[1]).toHaveProperty('hash', 'abc');
  });

  it('strips ImageUrlBlock base64 data before writing', () => {
    appendHistory({
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }, fakeCwd);
    const raw = readFileSync(paths(fakeCwd).history, 'utf-8');
    expect(raw).not.toContain('AAAA');
    expect(raw).toContain('resolved content block');
  });

  it('strips FileBlock data before writing', () => {
    appendHistory({
      role: 'user',
      content: [
        { type: 'text', text: 'check this' },
        { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,BBBB' } },
      ],
    }, fakeCwd);
    const raw = readFileSync(paths(fakeCwd).history, 'utf-8');
    expect(raw).not.toContain('BBBB');
  });

  it('preserves plain string messages', () => {
    appendHistory({ role: 'user', content: 'just text' }, fakeCwd);
    const history = loadHistory(fakeCwd);
    expect(history[0].content).toBe('just text');
  });
});

describe('getStats', () => {
  it('returns correct counts', () => {
    const stats = getStats(fakeCwd);
    expect(stats.globalMemory).toBe(false);
    expect(stats.projectMemory).toBe(false);
    expect(stats.planCount).toBe(0);
    expect(stats.historyLines).toBe(0);
  });

  it('reflects saved data', () => {
    saveProjectMemory('data', fakeCwd);
    savePlan('plan', 'stat-test', fakeCwd);
    appendHistory({ role: 'user', content: 'hi' }, fakeCwd);

    const stats = getStats(fakeCwd);
    expect(stats.projectMemory).toBe(true);
    expect(stats.planCount).toBe(1);
    expect(stats.historyLines).toBe(1);
  });
});

describe('clearProject', () => {
  it('clears project memory, plans, and history', () => {
    saveProjectMemory('data', fakeCwd);
    savePlan('plan', 'clear-test', fakeCwd);
    appendHistory({ role: 'user', content: 'hi' }, fakeCwd);

    clearProject(fakeCwd);

    expect(loadProjectMemory(fakeCwd)).toBe('');
    expect(listPlans(fakeCwd).length).toBe(0);
    expect(loadHistory(fakeCwd)).toEqual([]);
  });
});

describe('clearAll', () => {
  it('clears everything including global memory', () => {
    saveGlobalMemory('global', fakeCwd);
    saveProjectMemory('project', fakeCwd);

    clearAll(fakeCwd);

    expect(loadGlobalMemory(fakeCwd)).toBe('');
    expect(loadProjectMemory(fakeCwd)).toBe('');
  });
});

describe('cleanupTasks', () => {
  function makeTask(overrides: Partial<Task> & { id: number; title: string }): Task {
    return { status: 'pending', created: new Date().toISOString(), ...overrides };
  }

  it('resets in_progress tasks to pending', () => {
    saveTasks([
      makeTask({ id: 1, title: 'A', status: 'in_progress' }),
      makeTask({ id: 2, title: 'B', status: 'pending' }),
    ], fakeCwd);

    cleanupTasks(fakeCwd);
    const tasks = loadTasks(fakeCwd);

    expect(tasks[0].status).toBe('pending');
    expect(tasks[1].status).toBe('pending');
  });

  it('removes done tasks older than 30 days', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    saveTasks([
      makeTask({ id: 1, title: 'old done', status: 'done', created: old }),
      makeTask({ id: 2, title: 'recent done', status: 'done', created: recent }),
      makeTask({ id: 3, title: 'pending', status: 'pending', created: old }),
    ], fakeCwd);

    cleanupTasks(fakeCwd);
    const tasks = loadTasks(fakeCwd);

    expect(tasks.length).toBe(2);
    expect(tasks.map(t => t.id)).toEqual([2, 3]);
  });

  it('does not write if nothing changed', () => {
    saveTasks([
      makeTask({ id: 1, title: 'pending', status: 'pending' }),
    ], fakeCwd);
    const before = readFileSync(paths(fakeCwd).tasks, 'utf-8');

    cleanupTasks(fakeCwd);
    const after = readFileSync(paths(fakeCwd).tasks, 'utf-8');

    expect(after).toBe(before);
  });

  it('handles empty tasks file', () => {
    saveTasks([], fakeCwd);
    cleanupTasks(fakeCwd); // should not throw
    expect(loadTasks(fakeCwd)).toEqual([]);
  });

  it('handles missing tasks file', () => {
    cleanupTasks(fakeCwd); // should not throw
  });
});
