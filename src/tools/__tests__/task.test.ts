import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { taskTool } from '../task.js';
import { loadTasks, saveTasks, paths } from '../../memory/memory.js';

// Use a temp dir so tests don't touch real project state
const TEST_DIR = join(tmpdir(), `ag-task-test-${Date.now()}`);
let task: ReturnType<typeof taskTool>;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Clear any leftover tasks from previous test
  const tasksPath = paths(TEST_DIR).tasks;
  if (existsSync(tasksPath)) unlinkSync(tasksPath);
  task = taskTool(TEST_DIR);
});

afterEach(() => {
  // Clean up tasks file
  const tasksPath = paths(TEST_DIR).tasks;
  if (existsSync(tasksPath)) unlinkSync(tasksPath);
});

describe('task tool', () => {
  it('creates a task with pending status and auto-incremented ID', () => {
    const result = task.execute({ action: 'create', title: 'Set up DB' });
    expect(result).toContain('Task #1 created');
    expect(result).toContain('Set up DB');

    const result2 = task.execute({ action: 'create', title: 'Write tests' });
    expect(result2).toContain('Task #2');
  });

  it('lists tasks grouped by status', () => {
    task.execute({ action: 'create', title: 'First' });
    task.execute({ action: 'create', title: 'Second' });
    task.execute({ action: 'update', id: 1, status: 'done' });

    const list = task.execute({ action: 'list' });
    expect(list).toContain('Pending:');
    expect(list).toContain('Done:');
    expect(list).toContain('Second');
    expect(list).toContain('First');
  });

  it('returns "No tasks" when empty', () => {
    const list = task.execute({ action: 'list' });
    expect(list).toBe('No tasks.');
  });

  it('updates task status', () => {
    task.execute({ action: 'create', title: 'Do thing' });
    const result = task.execute({ action: 'update', id: 1, status: 'in_progress' });
    expect(result).toContain('[in_progress]');
    expect(result).toContain('Do thing');

    const tasks = loadTasks(TEST_DIR);
    expect(tasks[0].status).toBe('in_progress');
  });

  it('returns error for invalid ID on update', () => {
    const result = task.execute({ action: 'update', id: 99, status: 'done' });
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });

  it('returns error for invalid status', () => {
    task.execute({ action: 'create', title: 'X' });
    const result = task.execute({ action: 'update', id: 1, status: 'invalid' });
    expect(result).toContain('Error');
    expect(result).toContain('invalid status');
  });

  it('reads task details', () => {
    task.execute({ action: 'create', title: 'Build API' });
    const result = task.execute({ action: 'read', id: 1 });
    expect(result).toContain('Build API');
    expect(result).toContain('[pending]');
  });

  it('returns error for invalid ID on read', () => {
    const result = task.execute({ action: 'read', id: 42 });
    expect(result).toContain('Error');
  });

  it('removes a task', () => {
    task.execute({ action: 'create', title: 'Temp task' });
    const result = task.execute({ action: 'remove', id: 1 });
    expect(result).toContain('removed');

    const tasks = loadTasks(TEST_DIR);
    expect(tasks).toHaveLength(0);
  });

  it('clears done tasks, keeps pending/in_progress', () => {
    task.execute({ action: 'create', title: 'A' });
    task.execute({ action: 'create', title: 'B' });
    task.execute({ action: 'create', title: 'C' });
    task.execute({ action: 'update', id: 1, status: 'done' });
    task.execute({ action: 'update', id: 2, status: 'in_progress' });

    const result = task.execute({ action: 'clear' });
    expect(result).toContain('Cleared 1 done task(s)');
    expect(result).toContain('2 remaining');

    const tasks = loadTasks(TEST_DIR);
    expect(tasks).toHaveLength(2);
    expect(tasks.every(t => t.status !== 'done')).toBe(true);
  });

  it('persists tasks to disk', () => {
    task.execute({ action: 'create', title: 'Persistent task' });

    // Reload from disk
    const tasks = loadTasks(TEST_DIR);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Persistent task');
    expect(tasks[0].status).toBe('pending');
    expect(tasks[0].id).toBe(1);
  });

  it('returns error for missing required params', () => {
    expect(task.execute({ action: 'create' })).toContain('Error: title is required');
    expect(task.execute({ action: 'update' })).toContain('Error: id is required');
    expect(task.execute({ action: 'update', id: 1 })).toContain('Error: status is required');
    expect(task.execute({ action: 'read' })).toContain('Error: id is required');
    expect(task.execute({ action: 'remove' })).toContain('Error: id is required');
  });

  it('returns error for unknown action', () => {
    const result = task.execute({ action: 'bogus' });
    expect(result).toContain('Error: unknown action');
  });
});
