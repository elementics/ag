/**
 * Bash tool - the universal interface for system operations
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Tool } from '../core/types.js';

const MAX_BUFFER = 1024 * 1024; // 1 MB
const BG_MAX_OUTPUT = 100 * 1024; // 100 KB rolling buffer for background processes
const BG_INITIAL_WAIT = 2000; // ms to wait for initial output from background process

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\bfind\s+[~\/](?![\w.])/, message: 'Blocked: `find` on home/root directory. Use the grep tool (action=find) to search for files, or scope to a specific subdirectory.' },
  { pattern: /\brm\b(?![^\n]*-[a-zA-Z]*r)[^\n]*-[a-zA-Z]*f[a-zA-Z]*\s+(~|\/($|\s))/, message: 'Blocked: `rm -f` targeting home or root directory.' },
  { pattern: /\brm\b[^\n]*-[a-zA-Z]*r[a-zA-Z]*[^\n]*\s+(~|~\/|\/($|\s|\*|[^\/\s]+(\s|$)))/, message: 'Blocked: recursive `rm` targeting home, root, or system directory.' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|f[a-zA-Z]*r)[a-zA-Z]*\s+\/\*/, message: 'Blocked: destructive `rm` targeting root glob.' },
  { pattern: /:\(\)\{.*:\|:/, message: 'Blocked: fork bomb detected.' },
  { pattern: /\bdd\b.*\bof=\/dev\//, message: 'Blocked: dd write to device.' },
  { pattern: /\bmkfs\b/, message: 'Blocked: filesystem format command.' },
  { pattern: /\b(chmod|chown)\s+-[a-zA-Z]*R[a-zA-Z]*\s+.*[~\/]/, message: 'Blocked: recursive permission change on home/root.' },
  { pattern: /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|sudo)/, message: 'Blocked: pipe-to-shell pattern detected. Download the script first and review it.' },
  { pattern: />\s*\/dev\/[hs]d[a-z]/, message: 'Blocked: redirect write to raw block device.' },
  { pattern: /\bsudo\s+rm\b/, message: 'Blocked: sudo rm is too dangerous. Remove files without sudo or do it manually.' },
];

function checkCommand(command: string): string | null {
  for (const { pattern, message } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return `Error: ${message}`;
  }
  return null;
}

interface BackgroundProcess {
  child: ChildProcess;
  command: string;
  output: string;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
}

const backgrounds = new Map<number, BackgroundProcess>();

function appendOutput(bg: BackgroundProcess, data: string): void {
  bg.output += data;
  if (bg.output.length > BG_MAX_OUTPUT) {
    bg.output = bg.output.slice(-BG_MAX_OUTPUT);
  }
}

function startBackground(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const pid = child.pid;
    if (!pid) {
      resolve('Error: failed to start background process');
      return;
    }

    const bg: BackgroundProcess = {
      child,
      command,
      output: '',
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
    };
    backgrounds.set(pid, bg);

    child.stdout?.on('data', (chunk: Buffer) => appendOutput(bg, chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => appendOutput(bg, chunk.toString()));

    child.on('close', (code) => {
      bg.exited = true;
      bg.exitCode = code;
    });

    child.on('error', (err) => {
      bg.exited = true;
      bg.exitCode = 1;
      appendOutput(bg, `Process error: ${err.message}\n`);
    });

    // Wait briefly for initial output, then return
    setTimeout(() => {
      const initial = bg.output;
      bg.output = ''; // clear so next read gets new output
      const status = bg.exited
        ? `Process exited immediately with code ${bg.exitCode}`
        : `Background process started (PID ${pid})`;
      const lines = [
        status,
        `Command: ${command}`,
      ];
      if (initial) lines.push(`Initial output:\n${initial.trim()}`);
      if (!bg.exited) {
        lines.push(`Use bash(action="output", pid=${pid}) to check output`);
        lines.push(`Use bash(action="kill", pid=${pid}) to stop it`);
      }
      resolve(lines.join('\n'));
    }, BG_INITIAL_WAIT);
  });
}

function getOutput(pid: number): string {
  const bg = backgrounds.get(pid);
  if (!bg) return `Error: no background process with PID ${pid}`;
  const output = bg.output || '(no new output)';
  bg.output = ''; // clear buffer
  const status = bg.exited ? `[exited with code ${bg.exitCode}]` : '[running]';
  return `PID ${pid} ${status} — ${bg.command}\n${output.trim()}`;
}

function killProcess(pid: number): string {
  const bg = backgrounds.get(pid);
  if (!bg) return `Error: no background process with PID ${pid}`;
  if (!bg.exited) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
    try { bg.child.kill('SIGTERM'); } catch { /* already dead */ }
  }
  const output = bg.output || '(no output)';
  backgrounds.delete(pid);
  return `PID ${pid} killed — ${bg.command}\nFinal output:\n${output.trim()}`;
}

/** Kill all background processes. Called on REPL exit. */
export function cleanupBackgroundProcesses(): void {
  for (const [pid, bg] of backgrounds) {
    if (!bg.exited) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
      try { bg.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
  backgrounds.clear();
}

function runForeground(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let stdoutOverflow = false;
    let settled = false;

    function finish(result: string) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) {
        stdout += chunk.toString();
      } else {
        stdoutOverflow = true;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) {
        stderr += chunk.toString();
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      let result = stdout.trim();
      if (stdoutOverflow) {
        result += '\n... (output truncated at 1MB)';
      }
      if (code === 0) {
        finish(result);
      } else {
        const status = code ?? 1;
        finish(`EXIT ${status}\n${(stdout + stderr).trim()}`);
      }
    });

    child.on('error', (err) => {
      finish(`EXIT 1\n${err.message}`);
    });

    if (signal) {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        const killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, 3000);
        child.once('close', () => {
          clearTimeout(killTimer);
          finish('EXIT 130\n[interrupted by user]');
        });
        if (child.exitCode !== null || child.killed) {
          clearTimeout(killTimer);
          finish('EXIT 130\n[interrupted by user]');
        }
      };

      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort);
        child.once('close', () => signal.removeEventListener('abort', onAbort));
      }
    }
  });
}

export function bashToolFactory(cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the project directory. For tests, builds, installs, servers, and system operations. Dangerous commands (rm -rf, sudo rm, pipe-to-shell) are blocked. For long-running processes (dev servers, watchers), set background=true — returns PID immediately. Check output with action="output" pid=PID. Stop with action="kill" pid=PID.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute'
          },
          background: {
            type: 'boolean',
            description: 'Run in background. Returns PID immediately. Use for dev servers, watchers, long-running processes.'
          },
          action: {
            type: 'string',
            enum: ['output', 'kill'],
            description: 'Action on a background process: "output" reads recent output, "kill" stops it'
          },
          pid: {
            type: 'number',
            description: 'PID of background process (required with action)'
          }
        },
        required: []
      }
    },
    execute: async ({ command, background, action, pid }: { command?: string; background?: boolean; action?: string; pid?: number }, signal?: AbortSignal): Promise<string> => {
      // Background process management
      if (action === 'output' && pid != null) return getOutput(pid);
      if (action === 'kill' && pid != null) return killProcess(pid);
      if (action && !pid) return 'Error: action requires a pid';

      if (!command) return 'Error: command is required';

      const blocked = checkCommand(command);
      if (blocked) return blocked;

      if (background) return startBackground(command, cwd);
      return runForeground(command, cwd, signal);
    }
  };
}
