/**
 * Checkpoint store — snapshot conversation + file state for rewind.
 * Uses a shadow git repo to capture the full working tree at each checkpoint.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { ShadowGit } from './shadow-git.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  timestamp: string;
  messageIndex: number;
  turnNumber: number;
  sessionId: string;
  label?: string;
  snapshotSha: string | null;
}

// ── Locking (same pattern as results.ts / memory.ts) ───────────────────────

const LOCK_TIMEOUT = 5000;
const LOCK_POLL = 10;

function acquireLock(lockDir: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT;
  while (true) {
    try {
      mkdirSync(lockDir);
      return;
    } catch {
      if (Date.now() > deadline) {
        try { rmdirSync(lockDir); } catch { /* ignore */ }
        try { mkdirSync(lockDir); return; } catch { /* fall through */ }
        throw new Error('Checkpoint lock timeout');
      }
      const wait = Math.min(LOCK_POLL, deadline - Date.now());
      if (wait > 0) { const end = Date.now() + wait; while (Date.now() < end) { /* spin */ } }
    }
  }
}

// ── CheckpointStore ────────────────────────────────────────────────────────

const MAX_CHECKPOINTS = 20;

export class CheckpointStore {
  private checkpoints: Checkpoint[] = [];
  private nextId = 1;
  private readonly checkpointsDir: string;
  private readonly indexPath: string;
  private shadowGit: ShadowGit;

  /** Check if git is available (required for checkpoints). */
  static isAvailable(): Promise<boolean> {
    return ShadowGit.isAvailable();
  }

  constructor(private projectDir: string, private workTree: string) {
    this.checkpointsDir = join(projectDir, 'checkpoints');
    this.indexPath = join(this.checkpointsDir, 'index.json');
    this.shadowGit = new ShadowGit(join(projectDir, 'shadow-git'), workTree);
    this.load();
  }

  /** Initialize the shadow git repo. Must be called before create/restore. */
  async init(): Promise<void> {
    await this.shadowGit.init();
  }

  /** Create a new checkpoint, snapshotting the current working tree. */
  async create(messageIndex: number, turnNumber: number, label?: string, sessionId?: string): Promise<Checkpoint> {
    const id = String(this.nextId++);
    const snapshotSha = await this.shadowGit.snapshot(`checkpoint ${id}: ${label || `turn ${turnNumber}`}`);

    const checkpoint: Checkpoint = {
      id,
      timestamp: new Date().toISOString(),
      messageIndex,
      turnNumber,
      sessionId: sessionId || '',
      label: label || `turn ${turnNumber}`,
      snapshotSha,
    };
    this.checkpoints.push(checkpoint);
    this.save();

    // Prune old checkpoints
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.pruneOldest(this.checkpoints.length - MAX_CHECKPOINTS);
    }

    return checkpoint;
  }

  /** Restore the working tree to the state at the given checkpoint. */
  async restoreFiles(checkpointId: string): Promise<void> {
    const checkpoint = this.checkpoints.find(cp => cp.id === checkpointId);
    if (!checkpoint?.snapshotSha) return;
    await this.shadowGit.restore(checkpoint.snapshotSha);
  }

  /** List all checkpoints, oldest first. */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** Get the most recent checkpoint. */
  latest(): Checkpoint | undefined {
    return this.checkpoints.length > 0
      ? this.checkpoints[this.checkpoints.length - 1]
      : undefined;
  }

  /** Get a checkpoint by ID. */
  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find(cp => cp.id === id);
  }

  /** Remove checkpoint and all after it (for rewind — the restored checkpoint is consumed). */
  pruneFrom(checkpointId: string): void {
    const idx = this.checkpoints.findIndex(cp => cp.id === checkpointId);
    if (idx < 0) return;
    this.checkpoints.splice(idx);
    this.save();
  }

  /** Remove all checkpoint data and reinitialize the shadow git repo. */
  async clear(): Promise<void> {
    if (existsSync(this.checkpointsDir)) {
      rmSync(this.checkpointsDir, { recursive: true });
    }
    const shadowDir = join(this.projectDir, 'shadow-git');
    if (existsSync(shadowDir)) {
      rmSync(shadowDir, { recursive: true });
    }
    this.checkpoints = [];
    this.nextId = 1;
    await this.shadowGit.init();
  }

  /** Get the underlying ShadowGit instance (for diff, etc). */
  getShadowGit(): ShadowGit {
    return this.shadowGit;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.indexPath, 'utf-8'));
      if (Array.isArray(data.checkpoints)) this.checkpoints = data.checkpoints;
      if (typeof data.nextId === 'number') this.nextId = data.nextId;
    } catch { /* corrupt index — start fresh */ }
  }

  private save(): void {
    mkdirSync(this.checkpointsDir, { recursive: true });
    const lockDir = `${this.indexPath}.lock`;
    acquireLock(lockDir);
    try {
      const data = { nextId: this.nextId, checkpoints: this.checkpoints };
      writeFileSync(this.indexPath, JSON.stringify(data, null, 2) + '\n');
    } finally {
      try { rmdirSync(lockDir); } catch { /* ignore */ }
    }
  }

  private pruneOldest(count: number): void {
    this.checkpoints.splice(0, count);
    this.save();
    // Let shadow git gc handle object cleanup
    this.shadowGit.prune(MAX_CHECKPOINTS).catch(() => { /* non-fatal */ });
  }
}
