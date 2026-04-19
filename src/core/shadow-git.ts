/**
 * Shadow git — bare git repo for checkpoint snapshots.
 *
 * Uses GIT_DIR / GIT_WORK_TREE to snapshot the project working tree
 * without touching the user's .git. Pattern used by Cline, Roo Code,
 * Gemini CLI, and Kiro.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const EXCLUDE_PATTERNS = [
  '.git',
  'node_modules',
  '.ag',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '*.pyc',
];

export interface SnapshotInfo {
  sha: string;
  message: string;
  timestamp: string;
}

export class ShadowGit {
  constructor(
    private readonly shadowDir: string,
    private readonly workTree: string,
  ) {}

  // ── Static ──────────────────────────────────────────────────────────────

  /** Check if the git binary is available. */
  static async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('git', ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────

  /** Initialize (or reinitialize) the shadow bare repo. Idempotent. */
  async init(): Promise<void> {
    // Verify existing repo is healthy, nuke if corrupted
    if (existsSync(this.shadowDir)) {
      try {
        await this.git(['rev-parse', '--git-dir']);
      } catch {
        rmSync(this.shadowDir, { recursive: true });
      }
    }

    if (!existsSync(this.shadowDir)) {
      mkdirSync(this.shadowDir, { recursive: true });
      await execFileAsync('git', ['init', '--bare', this.shadowDir], { timeout: 10_000 });
    }

    // Write exclusion patterns
    const infoDir = join(this.shadowDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    writeFileSync(join(infoDir, 'exclude'), EXCLUDE_PATTERNS.join('\n') + '\n');
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  /**
   * Snapshot the entire working tree. Returns the commit SHA, or null if
   * there are no changes since the last snapshot.
   */
  async snapshot(message: string): Promise<string | null> {
    // Stage everything (respects info/exclude)
    await this.git(['add', '-A']);

    // Check if there's anything to commit
    const status = await this.git(['status', '--porcelain']);
    if (!status.trim()) return null;

    // Commit with a synthetic author so we don't touch user's git config
    await this.git([
      'commit',
      '-m', message,
      '--author', 'ag-checkpoint <ag-checkpoint@local>',
      '--allow-empty-message',
    ]);

    // Return the commit SHA
    const sha = await this.git(['rev-parse', 'HEAD']);
    return sha.trim();
  }

  // ── Restore ─────────────────────────────────────────────────────────────

  /**
   * Restore the working tree to the state at the given commit SHA.
   * Handles modified, added, and deleted files.
   */
  async restore(sha: string): Promise<void> {
    // Get the set of files that exist in the target snapshot
    const snapshotFiles = new Set(await this.listFiles(sha));

    // Find files that exist now in the working tree (tracked + untracked)
    // but are NOT in the target snapshot — these need to be deleted
    await this.git(['add', '-A']); // stage current state so we can diff
    const currentFiles = await this.git(['diff', '--name-only', '--cached', sha]);
    if (currentFiles.trim()) {
      for (const file of currentFiles.trim().split('\n').filter(Boolean)) {
        if (!snapshotFiles.has(file)) {
          const fullPath = join(this.workTree, file);
          if (existsSync(fullPath)) {
            rmSync(fullPath, { force: true });
          }
        }
      }
    }

    // Restore all tracked files from the target commit
    await this.git(['checkout', sha, '--', '.']);

    // Reset the index to match the restored state so future snapshots are clean
    await this.git(['reset', sha]);
  }

  // ── Diff ────────────────────────────────────────────────────────────────

  /** Return a unified diff between two snapshot SHAs. */
  async diff(sha1: string, sha2: string): Promise<string> {
    return this.git(['diff', sha1, sha2]);
  }

  // ── List files in a snapshot ────────────────────────────────────────────

  /** List all files tracked in a given snapshot commit. */
  async listFiles(sha: string): Promise<string[]> {
    const output = await this.git(['ls-tree', '-r', '--name-only', sha]);
    return output.trim().split('\n').filter(Boolean);
  }

  // ── Snapshots / log ─────────────────────────────────────────────────────

  /** Get all snapshot commits, oldest first. */
  async getSnapshots(): Promise<SnapshotInfo[]> {
    try {
      const log = await this.git([
        'log', '--reverse', '--format=%H|%s|%aI',
      ]);
      return log.trim().split('\n').filter(Boolean).map(line => {
        const [sha, message, timestamp] = line.split('|');
        return { sha, message, timestamp };
      });
    } catch {
      return [];
    }
  }

  // ── Prune ───────────────────────────────────────────────────────────────

  /**
   * Keep only the last `keepCount` snapshots. Rewrites shadow history
   * and runs gc.
   */
  async prune(keepCount: number): Promise<void> {
    const snapshots = await this.getSnapshots();
    if (snapshots.length <= keepCount) return;

    // Orphan rebase: keep only the last keepCount commits
    const cutoff = snapshots[snapshots.length - keepCount];

    // Rewrite history: make the cutoff commit the new root
    // Use filter-branch alternative: reset to cutoff, then cherry-pick the rest
    // Simpler: just recreate the shadow repo from the kept snapshots
    // Actually simplest: use git replace + gc to prune

    // Most reliable approach: interactive rebase is not available in bare repos.
    // Instead: create a new orphan branch from the cutoff point.
    try {
      await this.git([
        'replace', '--graft', cutoff.sha,
      ]);
      await this.git([
        'reflog', 'expire', '--expire=now', '--all',
      ]);
      await this.git([
        'gc', '--prune=now',
      ]);
    } catch {
      // Prune failure is non-fatal — shadow repo just stays larger
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.workTree,
      encoding: 'utf-8',
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_DIR: this.shadowDir,
        GIT_WORK_TREE: this.workTree,
        GIT_INDEX_FILE: join(this.shadowDir, 'index'),
        // Prevent config leakage
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    return stdout;
  }
}
