import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CheckpointStore } from '../checkpoint.js';

const projectDir = `/tmp/__ag_test_checkpoint_${randomBytes(8).toString('hex')}__`;

let store: CheckpointStore;

beforeEach(() => {
  mkdirSync(projectDir, { recursive: true });
  store = new CheckpointStore(projectDir);
});

afterEach(() => {
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true });
});

describe('CheckpointStore - create', () => {
  it('creates checkpoint with correct metadata', () => {
    const cp = store.create(5, 3, 'before refactor');
    expect(cp.id).toBe('1');
    expect(cp.messageIndex).toBe(5);
    expect(cp.turnNumber).toBe(3);
    expect(cp.label).toBe('before refactor');
    expect(cp.fileBackups).toEqual([]);
    expect(cp.timestamp).toBeTruthy();
  });

  it('auto-labels with turn number', () => {
    const cp = store.create(0, 7);
    expect(cp.label).toBe('turn 7');
  });

  it('increments IDs', () => {
    const cp1 = store.create(0, 1);
    const cp2 = store.create(5, 2);
    expect(cp1.id).toBe('1');
    expect(cp2.id).toBe('2');
  });

  it('stores in checkpoints directory', () => {
    const cp = store.create(0, 1);
    expect(existsSync(join(projectDir, 'checkpoints', cp.id, 'files'))).toBe(true);
  });
});

describe('CheckpointStore - backupFile', () => {
  it('copies file content to checkpoint directory', () => {
    const testFile = join(projectDir, 'test.txt');
    writeFileSync(testFile, 'original content');

    const cp = store.create(0, 1);
    store.backupFile(cp.id, testFile);

    expect(cp.fileBackups.length).toBe(1);
    expect(cp.fileBackups[0].originalPath).toBe(testFile);
    expect(readFileSync(cp.fileBackups[0].backupPath, 'utf-8')).toBe('original content');
  });

  it('skips if file already backed up in this checkpoint', () => {
    const testFile = join(projectDir, 'test.txt');
    writeFileSync(testFile, 'original');

    const cp = store.create(0, 1);
    store.backupFile(cp.id, testFile);
    store.backupFile(cp.id, testFile); // Second call — should skip

    expect(cp.fileBackups.length).toBe(1);
  });

  it('handles missing source file gracefully', () => {
    const cp = store.create(0, 1);
    store.backupFile(cp.id, '/nonexistent/file.txt'); // Should not throw
    expect(cp.fileBackups.length).toBe(0);
  });

  it('handles unknown checkpoint ID gracefully', () => {
    store.backupFile('999', '/some/file.txt'); // Should not throw
  });
});

describe('CheckpointStore - restoreFiles', () => {
  it('restores backed up files to original paths', () => {
    const testFile = join(projectDir, 'restore-test.txt');
    writeFileSync(testFile, 'original');

    const cp = store.create(0, 1);
    store.backupFile(cp.id, testFile);

    // Modify the file
    writeFileSync(testFile, 'modified');
    expect(readFileSync(testFile, 'utf-8')).toBe('modified');

    // Restore
    const result = store.restoreFiles(cp.id);
    expect(result.restored).toEqual([testFile]);
    expect(result.failed).toEqual([]);
    expect(readFileSync(testFile, 'utf-8')).toBe('original');
  });

  it('handles missing backup file', () => {
    const testFile = join(projectDir, 'missing-backup.txt');
    writeFileSync(testFile, 'content');

    const cp = store.create(0, 1);
    store.backupFile(cp.id, testFile);

    // Delete the backup
    rmSync(cp.fileBackups[0].backupPath);

    const result = store.restoreFiles(cp.id);
    expect(result.failed).toEqual([testFile]);
  });

  it('returns empty for unknown checkpoint', () => {
    const result = store.restoreFiles('999');
    expect(result.restored).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

describe('CheckpointStore - list', () => {
  it('returns checkpoints in chronological order', () => {
    store.create(0, 1, 'first');
    store.create(5, 2, 'second');
    store.create(10, 3, 'third');

    const list = store.list();
    expect(list.length).toBe(3);
    expect(list[0].label).toBe('first');
    expect(list[2].label).toBe('third');
  });

  it('returns empty array when no checkpoints', () => {
    expect(store.list()).toEqual([]);
  });
});

describe('CheckpointStore - latest', () => {
  it('returns most recent checkpoint', () => {
    store.create(0, 1, 'first');
    store.create(5, 2, 'latest');
    expect(store.latest()!.label).toBe('latest');
  });

  it('returns undefined when empty', () => {
    expect(store.latest()).toBeUndefined();
  });
});

describe('CheckpointStore - clear', () => {
  it('removes all checkpoint data', () => {
    store.create(0, 1);
    store.create(5, 2);
    store.clear();

    expect(store.list()).toEqual([]);
    expect(existsSync(join(projectDir, 'checkpoints'))).toBe(false);
  });

  it('handles missing directory gracefully', () => {
    store.clear(); // Should not throw on empty store
  });
});

describe('CheckpointStore - persistence', () => {
  it('persists and restores across instances', () => {
    const testFile = join(projectDir, 'persist-test.txt');
    writeFileSync(testFile, 'data');

    store.create(0, 1, 'persisted');
    store.backupFile('1', testFile);

    // Create new instance — should load from disk
    const store2 = new CheckpointStore(projectDir);
    const list = store2.list();
    expect(list.length).toBe(1);
    expect(list[0].label).toBe('persisted');
    expect(list[0].fileBackups.length).toBe(1);
  });

  it('handles corrupt index gracefully', () => {
    mkdirSync(join(projectDir, 'checkpoints'), { recursive: true });
    writeFileSync(join(projectDir, 'checkpoints', 'index.json'), '{{broken}}');

    const store2 = new CheckpointStore(projectDir); // Should not throw
    expect(store2.list()).toEqual([]);
  });
});
