import { describe, it, expect } from 'vitest';
import { getEnvironmentContext } from '../agent.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

describe('getEnvironmentContext', () => {
  it('includes date, OS, and CWD', () => {
    const result = getEnvironmentContext(process.cwd());
    expect(result).toContain('# Environment');
    expect(result).toContain('Date:');
    expect(result).toContain('OS:');
    expect(result).toContain('CWD:');
    // Date should be ISO format YYYY-MM-DD
    expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
  });

  it('detects Node.js + TypeScript stack from config files', () => {
    const result = getEnvironmentContext(process.cwd());
    // This project has package.json and tsconfig.json
    expect(result).toContain('Stack:');
    expect(result).toContain('Node.js');
    expect(result).toContain('TypeScript');
  });

  it('detects git info when in a git repo', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ag-env-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmp });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
      // Need at least one commit for rev-parse to work
      writeFileSync(join(tmp, 'test.txt'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: tmp });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp });

      const result = getEnvironmentContext(tmp);
      expect(result).toContain('Git branch:');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports dirty git status', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ag-env-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmp });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
      writeFileSync(join(tmp, 'test.txt'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: tmp });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp });

      // Create an uncommitted file
      writeFileSync(join(tmp, 'dirty.txt'), 'changed');

      const result = getEnvironmentContext(tmp);
      expect(result).toContain('Git status: 1 changed file(s)');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles git repo with no commits gracefully', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ag-env-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmp });
      const result = getEnvironmentContext(tmp);
      expect(result).toContain('# Environment');
      expect(result).not.toContain('Git branch');
      // Should not contain any git error output
      expect(result).not.toContain('fatal');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles non-git directory gracefully', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ag-env-test-'));
    try {
      const result = getEnvironmentContext(tmp);
      expect(result).toContain('# Environment');
      expect(result).not.toContain('Git branch');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detects multiple stack markers', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ag-env-test-'));
    try {
      writeFileSync(join(tmp, 'package.json'), '{}');
      writeFileSync(join(tmp, 'Cargo.toml'), '');
      const result = getEnvironmentContext(tmp);
      expect(result).toContain('Node.js');
      expect(result).toContain('Rust');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('omits stack line when no config files found', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ag-env-test-'));
    try {
      const result = getEnvironmentContext(tmp);
      expect(result).not.toContain('Stack:');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
