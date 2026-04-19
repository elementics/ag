import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CheckpointStore } from '../checkpoint.js';

const base = `/tmp/__ag_test_checkpoint_${randomBytes(8).toString('hex')}__`;
const projectDir = join(base, '.ag');
const workTree = base;

let store: CheckpointStore;

beforeEach(async () => {
  mkdirSync(projectDir, { recursive: true });
  store = new CheckpointStore(projectDir, workTree);
  await store.init();
});

afterEach(() => {
  if (existsSync(base)) rmSync(base, { recursive: true });
});

describe('CheckpointStore - create', () => {
  it('creates checkpoint with correct metadata', async () => {
    writeFileSync(join(workTree, 'file.txt'), 'content');
    const cp = await store.create(5, 3, 'before refactor');
    expect(cp.id).toBe('1');
    expect(cp.messageIndex).toBe(5);
    expect(cp.turnNumber).toBe(3);
    expect(cp.label).toBe('before refactor');
    expect(cp.snapshotSha).toBeTruthy();
    expect(cp.timestamp).toBeTruthy();
  });

  it('auto-labels with turn number', async () => {
    writeFileSync(join(workTree, 'file.txt'), 'content');
    const cp = await store.create(0, 7);
    expect(cp.label).toBe('turn 7');
  });

  it('increments IDs', async () => {
    writeFileSync(join(workTree, 'a.txt'), 'a');
    const cp1 = await store.create(0, 1);
    writeFileSync(join(workTree, 'a.txt'), 'b');
    const cp2 = await store.create(5, 2);
    expect(cp1.id).toBe('1');
    expect(cp2.id).toBe('2');
  });

  it('returns null snapshotSha when no files changed', async () => {
    writeFileSync(join(workTree, 'file.txt'), 'static');
    await store.create(0, 1);
    // No changes between checkpoints
    const cp2 = await store.create(5, 2);
    expect(cp2.snapshotSha).toBeNull();
  });
});

describe('CheckpointStore - restoreFiles', () => {
  it('restores modified files', async () => {
    writeFileSync(join(workTree, 'file.txt'), 'original');
    const cp = await store.create(0, 1);

    writeFileSync(join(workTree, 'file.txt'), 'modified');
    await store.restoreFiles(cp.id);
    expect(readFileSync(join(workTree, 'file.txt'), 'utf-8')).toBe('original');
  });

  it('deletes files created after checkpoint', async () => {
    writeFileSync(join(workTree, 'existing.txt'), 'keep');
    const cp = await store.create(0, 1);

    writeFileSync(join(workTree, 'new-file.txt'), 'should vanish');
    await store.restoreFiles(cp.id);
    expect(existsSync(join(workTree, 'new-file.txt'))).toBe(false);
    expect(readFileSync(join(workTree, 'existing.txt'), 'utf-8')).toBe('keep');
  });

  it('restores deleted files', async () => {
    writeFileSync(join(workTree, 'will-delete.txt'), 'restore me');
    const cp = await store.create(0, 1);

    unlinkSync(join(workTree, 'will-delete.txt'));
    await store.restoreFiles(cp.id);
    expect(readFileSync(join(workTree, 'will-delete.txt'), 'utf-8')).toBe('restore me');
  });

  it('handles unknown checkpoint gracefully', async () => {
    await store.restoreFiles('999'); // Should not throw
  });

  it('handles checkpoint with null snapshotSha', async () => {
    writeFileSync(join(workTree, 'file.txt'), 'static');
    await store.create(0, 1);
    const cp2 = await store.create(5, 2); // null sha — no changes
    await store.restoreFiles(cp2.id); // Should not throw
  });
});

describe('CheckpointStore - pruneFrom', () => {
  it('removes the target checkpoint and all after it', async () => {
    writeFileSync(join(workTree, 'f.txt'), 'v1');
    await store.create(0, 1, 'first');
    writeFileSync(join(workTree, 'f.txt'), 'v2');
    await store.create(5, 2, 'second');
    writeFileSync(join(workTree, 'f.txt'), 'v3');
    await store.create(10, 3, 'third');

    store.pruneFrom('2');
    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0].label).toBe('first');
  });

  it('removes the only checkpoint', async () => {
    writeFileSync(join(workTree, 'f.txt'), 'v1');
    await store.create(0, 1, 'only');
    store.pruneFrom('1');
    expect(store.list().length).toBe(0);
  });

  it('handles unknown ID gracefully', () => {
    store.pruneFrom('999'); // Should not throw
  });
});

describe('CheckpointStore - list', () => {
  it('returns checkpoints in chronological order', async () => {
    writeFileSync(join(workTree, 'f.txt'), 'v1');
    await store.create(0, 1, 'first');
    writeFileSync(join(workTree, 'f.txt'), 'v2');
    await store.create(5, 2, 'second');
    writeFileSync(join(workTree, 'f.txt'), 'v3');
    await store.create(10, 3, 'third');

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
  it('returns most recent checkpoint', async () => {
    writeFileSync(join(workTree, 'f.txt'), 'v1');
    await store.create(0, 1, 'first');
    writeFileSync(join(workTree, 'f.txt'), 'v2');
    await store.create(5, 2, 'latest');
    expect(store.latest()!.label).toBe('latest');
  });

  it('returns undefined when empty', () => {
    expect(store.latest()).toBeUndefined();
  });
});

describe('CheckpointStore - clear', () => {
  it('removes all checkpoint data and reinitializes shadow repo', async () => {
    writeFileSync(join(workTree, 'f.txt'), 'data');
    await store.create(0, 1);
    await store.clear();

    expect(store.list()).toEqual([]);
    expect(existsSync(join(projectDir, 'checkpoints'))).toBe(false);
    // Shadow repo should be reinitialized (exists again)
    expect(existsSync(join(projectDir, 'shadow-git', 'HEAD'))).toBe(true);
  });

  it('handles missing directory gracefully', async () => {
    await store.clear(); // Should not throw on empty store
  });

  it('can create checkpoints after clear', async () => {
    writeFileSync(join(workTree, 'f.txt'), 'before');
    await store.create(0, 1);
    await store.clear();

    writeFileSync(join(workTree, 'f.txt'), 'after');
    const cp = await store.create(0, 1, 'post-clear');
    expect(cp.snapshotSha).toBeTruthy();
  });
});

describe('CheckpointStore - persistence', () => {
  it('persists and restores metadata across instances', async () => {
    writeFileSync(join(workTree, 'f.txt'), 'data');
    await store.create(0, 1, 'persisted');

    const store2 = new CheckpointStore(projectDir, workTree);
    const list = store2.list();
    expect(list.length).toBe(1);
    expect(list[0].label).toBe('persisted');
    expect(list[0].snapshotSha).toBeTruthy();
  });

  it('handles corrupt index gracefully', () => {
    mkdirSync(join(projectDir, 'checkpoints'), { recursive: true });
    writeFileSync(join(projectDir, 'checkpoints', 'index.json'), '{{broken}}');

    const store2 = new CheckpointStore(projectDir, workTree);
    expect(store2.list()).toEqual([]);
  });
});
