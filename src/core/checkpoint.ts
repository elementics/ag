/**
 * Checkpoint store — snapshot conversation + file state for rewind.
 * File copies (not shadow git) — simple, matches existing storage patterns.
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, rmSync, rmdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ── Types ──────────────────────────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  timestamp: string;
  messageIndex: number;
  turnNumber: number;
  label?: string;
  fileBackups: FileBackup[];
}

export interface FileBackup {
  originalPath: string;
  backupPath: string;
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

export class CheckpointStore {
  private checkpoints: Checkpoint[] = [];
  private nextId = 1;
  private readonly checkpointsDir: string;
  private readonly indexPath: string;

  constructor(private projectDir: string) {
    this.checkpointsDir = join(projectDir, 'checkpoints');
    this.indexPath = join(this.checkpointsDir, 'index.json');
    this.load();
  }

  /** Create a new checkpoint */
  create(messageIndex: number, turnNumber: number, label?: string): Checkpoint {
    const id = String(this.nextId++);
    const checkpoint: Checkpoint = {
      id,
      timestamp: new Date().toISOString(),
      messageIndex,
      turnNumber,
      label: label || `turn ${turnNumber}`,
      fileBackups: [],
    };
    this.checkpoints.push(checkpoint);
    mkdirSync(join(this.checkpointsDir, id, 'files'), { recursive: true });
    this.save();
    return checkpoint;
  }

  /** Back up a file before it gets modified. Skips if already backed up in this checkpoint. */
  backupFile(checkpointId: string, filePath: string): void {
    const checkpoint = this.checkpoints.find(cp => cp.id === checkpointId);
    if (!checkpoint) return;

    // Skip if already backed up in this checkpoint
    if (checkpoint.fileBackups.some(fb => fb.originalPath === filePath)) return;

    if (!existsSync(filePath)) return;

    const hash = createHash('md5').update(filePath).digest('hex').slice(0, 12);
    const backupPath = join(this.checkpointsDir, checkpointId, 'files', hash);

    try {
      copyFileSync(filePath, backupPath);
      checkpoint.fileBackups.push({ originalPath: filePath, backupPath });
      this.save();
    } catch { /* backup failure is non-fatal */ }
  }

  /** Restore files from a checkpoint to their original paths */
  restoreFiles(checkpointId: string): { restored: string[]; failed: string[] } {
    const checkpoint = this.checkpoints.find(cp => cp.id === checkpointId);
    if (!checkpoint) return { restored: [], failed: [] };

    const restored: string[] = [];
    const failed: string[] = [];

    for (const fb of checkpoint.fileBackups) {
      try {
        if (existsSync(fb.backupPath)) {
          // Ensure parent directory exists
          const dir = fb.originalPath.replace(/\/[^/]+$/, '');
          if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
          copyFileSync(fb.backupPath, fb.originalPath);
          restored.push(fb.originalPath);
        } else {
          failed.push(fb.originalPath);
        }
      } catch {
        failed.push(fb.originalPath);
      }
    }

    return { restored, failed };
  }

  /** List all checkpoints, oldest first */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** Get the most recent checkpoint */
  latest(): Checkpoint | undefined {
    return this.checkpoints.length > 0
      ? this.checkpoints[this.checkpoints.length - 1]
      : undefined;
  }

  /** Get a checkpoint by ID */
  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find(cp => cp.id === id);
  }

  /** Remove all checkpoint data */
  clear(): void {
    if (existsSync(this.checkpointsDir)) {
      rmSync(this.checkpointsDir, { recursive: true });
    }
    this.checkpoints = [];
    this.nextId = 1;
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
}
