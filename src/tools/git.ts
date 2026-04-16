import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Tool } from '../core/types.js';

const execFileAsync = promisify(execFile);

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8', timeout: 30_000 });
  return stdout.trim();
}

async function tryRun(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await run(args, cwd) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: ((err.stdout ?? '') + (err.stderr ?? '')).trim() };
  }
}

function isRepo(cwd: string): boolean {
  return existsSync(join(cwd, '.git'));
}

async function defaultBranch(cwd: string): Promise<string> {
  const ref = await tryRun(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
  if (ref.ok) return ref.out.replace('refs/remotes/origin/', '');
  const branches = await tryRun(['branch', '-r'], cwd);
  if (branches.ok) {
    if (branches.out.includes('origin/main')) return 'main';
    if (branches.out.includes('origin/master')) return 'master';
  }
  return 'main';
}

async function currentBranch(cwd: string): Promise<string> {
  const result = await tryRun(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (result.ok) return result.out;
  const sym = await tryRun(['symbolic-ref', '--short', 'HEAD'], cwd);
  return sym.ok ? `${sym.out} (no commits yet)` : '(no commits yet)';
}

async function remoteUrl(cwd: string): Promise<string> {
  const r = await tryRun(['remote', 'get-url', 'origin'], cwd);
  return r.ok ? r.out : '';
}

async function compareUrl(cwd: string, branch: string): Promise<string> {
  const remote = await remoteUrl(cwd);
  if (!remote) return '';
  const base = await defaultBranch(cwd);
  const url = remote
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
  return `${url}/compare/${base}...${branch}`;
}

// ── Action handlers ────────────────────────────────────────────────────────

async function doStatus(cwd: string): Promise<string> {
  if (!isRepo(cwd)) return 'Not a git repository. Use action=init first.';
  const lines: string[] = [];
  lines.push(`Branch: ${await currentBranch(cwd)}`);

  const remote = await remoteUrl(cwd);
  if (remote) lines.push(`Remote: ${remote}`);

  const status = await run(['status', '--porcelain'], cwd);
  if (status) {
    const files = status.split('\n');
    const staged = files.filter(f => /^[MADRC]/.test(f)).length;
    const unstaged = files.filter(f => /^.[MADRC]/.test(f)).length;
    const untracked = files.filter(f => f.startsWith('??')).length;
    lines.push(`Changes: ${staged} staged, ${unstaged} unstaged, ${untracked} untracked`);
  } else {
    lines.push('Working tree clean.');
  }

  const ahead = await tryRun(['rev-list', '@{u}..HEAD', '--count'], cwd);
  const behind = await tryRun(['rev-list', 'HEAD..@{u}', '--count'], cwd);
  if (ahead.ok && behind.ok) {
    lines.push(`Ahead: ${ahead.out}, Behind: ${behind.out}`);
  }

  const log = await tryRun(['log', '--oneline', '-5'], cwd);
  if (log.ok && log.out) lines.push(`\nRecent commits:\n${log.out}`);

  return lines.join('\n');
}

async function doInit(cwd: string, remote?: string): Promise<string> {
  if (isRepo(cwd)) {
    const branch = await currentBranch(cwd);
    const existing = await remoteUrl(cwd);
    let msg = `Already a git repo. Branch: ${branch}`;
    if (existing) msg += `, Remote: ${existing}`;
    if (remote && remote !== existing) {
      await tryRun(['remote', 'remove', 'origin'], cwd);
      await run(['remote', 'add', 'origin', remote], cwd);
      msg += `\nRemote updated to: ${remote}`;
    }
    return msg;
  }
  await run(['init'], cwd);
  let msg = 'Initialized git repository.';
  if (remote) {
    await run(['remote', 'add', 'origin', remote], cwd);
    msg += ` Remote set to: ${remote}`;
  }
  return msg;
}

async function doBranch(cwd: string, name: string): Promise<string> {
  if (!isRepo(cwd)) return 'Not a git repository. Use action=init first.';
  const lines: string[] = [];

  const status = await run(['status', '--porcelain'], cwd);
  if (status) {
    return `Error: ${status.split('\n').length} uncommitted change(s) detected. Commit or stash your changes before creating a new branch.\n\nDirty files:\n${status}`;
  }

  const fetchResult = await tryRun(['fetch', 'origin'], cwd);
  if (fetchResult.ok) {
    lines.push('Fetched latest from origin.');
  } else {
    lines.push('Warning: Could not fetch from origin (no remote or offline). Branching from local state.');
  }

  const base = await defaultBranch(cwd);
  if (fetchResult.ok) {
    await tryRun(['checkout', base], cwd);
    await tryRun(['merge', '--ff-only', `origin/${base}`], cwd);
    lines.push(`Updated local ${base} to origin/${base}.`);
  }

  const result = await tryRun(['checkout', '-b', name], cwd);
  if (result.ok) {
    lines.push(`Created and switched to branch: ${name}`);
  } else {
    const sw = await tryRun(['checkout', name], cwd);
    lines.push(sw.ok
      ? `Branch ${name} already exists. Switched to it.`
      : `Error creating branch: ${result.out}`);
  }

  return lines.join('\n');
}

async function doCommit(cwd: string, message: string, files?: string[]): Promise<string> {
  if (!isRepo(cwd)) return 'Not a git repository. Use action=init first.';

  if (files && files.length > 0) {
    await run(['add', ...files], cwd);
  } else {
    await run(['add', '-A'], cwd);
  }

  const staged = await tryRun(['diff', '--cached', '--stat'], cwd);
  if (!staged.out) return 'Nothing to commit. Working tree clean.';

  const result = await tryRun(['commit', '-m', message], cwd);
  return result.ok ? `Committed: ${message}\n${result.out}` : `Commit failed: ${result.out}`;
}

async function doPush(cwd: string, force?: boolean): Promise<string> {
  if (!isRepo(cwd)) return 'Not a git repository. Use action=init first.';

  const branch = await currentBranch(cwd);
  const base = await defaultBranch(cwd);

  if (branch === base) {
    return `You're on ${base}. Create a feature branch first with action=branch.`;
  }

  const args = ['push', '-u', 'origin', branch];
  if (force) args.splice(1, 0, '--force-with-lease');
  const result = await tryRun(args, cwd);

  const lines: string[] = [];
  if (result.ok || result.out.includes('->')) {
    lines.push(`Pushed ${branch} to origin.`);
  } else {
    return `Push failed: ${result.out}`;
  }

  const url = await compareUrl(cwd, branch);
  if (url) lines.push(`\nCreate PR: ${url}`);

  return lines.join('\n');
}

// ── Exported tool ──────────────────────────────────────────────────────────

export function gitTool(cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'git',
      description: 'Git operations. Actions: status (branch, changes, recent commits), init (initialize repo), branch (create from latest main), commit (stage + commit), push (push + PR compare URL).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'init', 'branch', 'commit', 'push'], description: 'The git operation to perform.' },
          name: { type: 'string', description: 'Branch name (for action=branch, e.g. "feature/add-auth").' },
          message: { type: 'string', description: 'Commit message (for action=commit).' },
          files: { type: 'array', items: { type: 'string' }, description: 'Specific files to stage (for action=commit). Omit to stage all.' },
          remote: { type: 'string', description: 'Remote URL (for action=init, e.g. "git@github.com:user/repo.git").' },
          force: { type: 'boolean', description: 'Force push with lease (for action=push). Default: false.' }
        },
        required: ['action']
      }
    },
    execute: async ({ action, name, message, files, remote, force }: {
      action: string; name?: string; message?: string; files?: string[]; remote?: string; force?: boolean;
    }): Promise<string> => {
      switch (action) {
        case 'status': return doStatus(cwd);
        case 'init': return doInit(cwd, remote);
        case 'branch': {
          if (!name) return 'Error: name is required for action=branch.';
          return doBranch(cwd, name);
        }
        case 'commit': {
          if (!message) return 'Error: message is required for action=commit.';
          return doCommit(cwd, message, files);
        }
        case 'push': return doPush(cwd, force);
        default: return `Unknown action "${action}". Use: status, init, branch, commit, push.`;
      }
    }
  };
}
