import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  globMatch,
  parsePattern,
  extractMatchKey,
  inferPattern,
  PermissionManager,
} from '../permissions.js';

// ── globMatch ───────────────────────────────────────────────────────────────

describe('globMatch', () => {
  it('matches literal strings', () => {
    expect(globMatch('npm test', 'npm test')).toBe(true);
    expect(globMatch('npm test', 'npm run')).toBe(false);
  });

  it('* matches any non-slash sequence', () => {
    expect(globMatch('npm *', 'npm test')).toBe(true); // space is literal, * matches "test"
    expect(globMatch('npm*', 'npmtest')).toBe(true);
    expect(globMatch('*', 'anything')).toBe(true);
    expect(globMatch('*', 'path/with/slashes')).toBe(true); // bare * is special — globMatch returns true early
  });

  it('* in path context does not cross slashes', () => {
    expect(globMatch('src/*', 'src/foo.ts')).toBe(true);
    expect(globMatch('src/*', 'src/deep/foo.ts')).toBe(false);
  });

  it('** matches across slashes', () => {
    expect(globMatch('src/**', 'src/foo.ts')).toBe(true);
    expect(globMatch('src/**', 'src/deep/nested/foo.ts')).toBe(true);
  });

  it('? matches single character', () => {
    expect(globMatch('?.ts', 'a.ts')).toBe(true);
    expect(globMatch('?.ts', 'ab.ts')).toBe(false);
  });

  it('handles mixed patterns', () => {
    expect(globMatch('*github.com*', 'api.github.com')).toBe(true);
    expect(globMatch('*github.com*', 'github.com')).toBe(true);
    expect(globMatch('*github.com*', 'example.com')).toBe(false);
  });

  it('handles empty pattern and value', () => {
    expect(globMatch('', '')).toBe(true);
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('a', '')).toBe(false);
  });
});

// ── parsePattern ────────────────────────────────────────────────────────────

describe('parsePattern', () => {
  it('parses full Tool(qualifier:glob) syntax', () => {
    expect(parsePattern('bash(npm:*)')).toEqual({ tool: 'bash', qualifier: 'npm', glob: '*' });
    expect(parsePattern('file(write:src/**)')).toEqual({ tool: 'file', qualifier: 'write', glob: 'src/**' });
  });

  it('parses qualifier-only Tool(qualifier)', () => {
    expect(parsePattern('git(commit)')).toEqual({ tool: 'git', qualifier: 'commit', glob: null });
  });

  it('parses Tool(*) shorthand', () => {
    expect(parsePattern('bash(*)')).toEqual({ tool: 'bash', qualifier: '*', glob: null });
  });

  it('parses wildcard *', () => {
    expect(parsePattern('*')).toEqual({ tool: '*', qualifier: '*', glob: null });
  });

  it('parses bare tool name', () => {
    expect(parsePattern('bash')).toEqual({ tool: 'bash', qualifier: '*', glob: null });
  });

  it('normalizes tool name to lowercase', () => {
    expect(parsePattern('Bash(npm:*)')).toEqual({ tool: 'bash', qualifier: 'npm', glob: '*' });
    expect(parsePattern('FILE(write:*)')).toEqual({ tool: 'file', qualifier: 'write', glob: '*' });
  });
});

// ── extractMatchKey ─────────────────────────────────────────────────────────

describe('extractMatchKey', () => {
  it('extracts bash: first word as qualifier, full command as value', () => {
    const key = extractMatchKey('bash', { command: 'npm test --verbose' });
    expect(key).toEqual({ qualifier: 'npm', value: 'npm test --verbose' });
  });

  it('extracts file: action + path', () => {
    const key = extractMatchKey('file', { action: 'write', path: 'src/foo.ts' });
    expect(key).toEqual({ qualifier: 'write', value: 'src/foo.ts' });
  });

  it('extracts git: action only', () => {
    const key = extractMatchKey('git', { action: 'commit', message: 'fix' });
    expect(key).toEqual({ qualifier: 'commit', value: '' });
  });

  it('extracts web fetch: action + hostname', () => {
    const key = extractMatchKey('web', { action: 'fetch', url: 'https://api.github.com/repos' });
    expect(key).toEqual({ qualifier: 'fetch', value: 'api.github.com' });
  });

  it('extracts web search: action + query', () => {
    const key = extractMatchKey('web', { action: 'search', query: 'typescript generics' });
    expect(key).toEqual({ qualifier: 'search', value: 'typescript generics' });
  });

  it('uses permissionKey for custom tools', () => {
    const key = extractMatchKey('deploy', { target: 'staging', branch: 'main' }, { qualifier: 'target' });
    expect(key).toEqual({ qualifier: 'staging', value: '' });
  });

  it('uses permissionKey with value field', () => {
    const key = extractMatchKey('mytool', { action: 'read', path: '/etc/hosts' }, { qualifier: 'action', value: 'path' });
    expect(key).toEqual({ qualifier: 'read', value: '/etc/hosts' });
  });

  it('returns wildcard for unknown tools without permissionKey', () => {
    const key = extractMatchKey('weather', { city: 'London' });
    expect(key).toEqual({ qualifier: '*', value: '' });
  });
});

// ── inferPattern ────────────────────────────────────────────────────────────

describe('inferPattern', () => {
  it('infers bash pattern: firstWord:*', () => {
    expect(inferPattern('bash', { command: 'npm test' })).toBe('bash(npm:*)');
    expect(inferPattern('bash', { command: 'git push origin main' })).toBe('bash(git:*)');
  });

  it('infers file pattern: action:dir/**', () => {
    expect(inferPattern('file', { action: 'write', path: 'src/core/foo.ts' })).toBe('file(write:src/**)');
  });

  it('infers file pattern: action:* for root files', () => {
    expect(inferPattern('file', { action: 'edit', path: 'README.md' })).toBe('file(edit:*)');
  });

  it('infers git pattern: action only', () => {
    expect(inferPattern('git', { action: 'commit' })).toBe('git(commit)');
    expect(inferPattern('git', { action: 'push' })).toBe('git(push)');
  });

  it('infers web fetch pattern with hostname', () => {
    expect(inferPattern('web', { action: 'fetch', url: 'https://api.github.com/repos' })).toBe('web(fetch:*api.github.com*)');
  });

  it('infers web search pattern', () => {
    expect(inferPattern('web', { action: 'search', query: 'test' })).toBe('web(search:*)');
  });

  it('infers custom tool with permissionKey', () => {
    expect(inferPattern('deploy', { target: 'staging' }, { qualifier: 'target' })).toBe('deploy(staging)');
  });

  it('infers custom tool with permissionKey + value', () => {
    expect(inferPattern('deploy', { target: 'staging', branch: 'main' }, { qualifier: 'target', value: 'branch' })).toBe('deploy(staging:*)');
  });

  it('infers opaque custom tool without permissionKey', () => {
    expect(inferPattern('weather', { city: 'London' })).toBe('weather(*)');
  });
});

// ── PermissionManager ───────────────────────────────────────────────────────

describe('PermissionManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ag-perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createPm(projectRules?: { allow?: string[]; deny?: string[] }, globalRules?: { allow?: string[]; deny?: string[] }): PermissionManager {
    // Write project permissions
    if (projectRules) {
      const agDir = join(tmpDir, '.ag');
      mkdirSync(agDir, { recursive: true });
      writeFileSync(join(agDir, 'permissions.json'), JSON.stringify(projectRules));
    }
    // We can't easily override global path, so we test project + session only
    return new PermissionManager(tmpDir);
  }

  it('returns ask when no rules match', () => {
    const pm = createPm();
    expect(pm.check('bash', { command: 'npm test' })).toBe('ask');
  });

  it('returns allow when an allow rule matches', () => {
    const pm = createPm({ allow: ['bash(npm:*)'] });
    expect(pm.check('bash', { command: 'npm test' })).toBe('allow');
  });

  it('returns deny when a deny rule matches', () => {
    const pm = createPm({ deny: ['bash(rm:*)'] });
    expect(pm.check('bash', { command: 'rm -rf /' })).toBe('deny');
  });

  it('deny overrides allow for the same tool call', () => {
    const pm = createPm({ allow: ['bash(*)'], deny: ['bash(rm:*)'] });
    expect(pm.check('bash', { command: 'rm -rf /' })).toBe('deny');
    expect(pm.check('bash', { command: 'npm test' })).toBe('allow');
  });

  it('session rules work via addRule', () => {
    const pm = createPm();
    expect(pm.check('bash', { command: 'npm test' })).toBe('ask');
    pm.addRule({ pattern: 'bash(npm:*)', effect: 'allow' }, 'session');
    expect(pm.check('bash', { command: 'npm test' })).toBe('allow');
    expect(pm.check('bash', { command: 'npm run build' })).toBe('allow');
  });

  it('does not duplicate rules', () => {
    const pm = createPm();
    pm.addRule({ pattern: 'bash(npm:*)', effect: 'allow' }, 'session');
    pm.addRule({ pattern: 'bash(npm:*)', effect: 'allow' }, 'session');
    expect(pm.getRules('session')).toHaveLength(1);
  });

  it('removeRule works', () => {
    const pm = createPm();
    pm.addRule({ pattern: 'bash(npm:*)', effect: 'allow' }, 'session');
    expect(pm.removeRule('bash(npm:*)', 'session')).toBe(true);
    expect(pm.getRules('session')).toHaveLength(0);
    expect(pm.removeRule('nonexistent', 'session')).toBe(false);
  });

  it('getRules returns rules from all scopes', () => {
    const pm = createPm({ allow: ['file(write:src/**)'] });
    pm.addRule({ pattern: 'bash(npm:*)', effect: 'allow' }, 'session');
    const all = pm.getRules();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some(r => r.scope === 'session' && r.pattern === 'bash(npm:*)')).toBe(true);
    expect(all.some(r => r.scope === 'project' && r.pattern === 'file(write:src/**)')).toBe(true);
  });

  it('save persists project rules to disk', () => {
    const pm = createPm();
    pm.addRule({ pattern: 'bash(npm:*)', effect: 'allow' }, 'project');
    pm.save('project');
    expect(existsSync(join(tmpDir, '.ag', 'permissions.json'))).toBe(true);
    // Reload and verify
    const pm2 = new PermissionManager(tmpDir);
    expect(pm2.check('bash', { command: 'npm test' })).toBe('allow');
  });

  it('clear removes rules for a scope', () => {
    const pm = createPm({ allow: ['bash(npm:*)'] });
    pm.addRule({ pattern: 'git(commit)', effect: 'allow' }, 'session');
    pm.clear('session');
    expect(pm.getRules('session')).toHaveLength(0);
    expect(pm.getRules('project')).toHaveLength(1);
  });

  it('handles missing permission files gracefully', () => {
    const emptyDir = join(tmpDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const pm = new PermissionManager(emptyDir);
    expect(pm.check('bash', { command: 'ls' })).toBe('ask');
  });

  it('wildcard * pattern allows everything', () => {
    const pm = createPm({ allow: ['*'] });
    expect(pm.check('bash', { command: 'rm -rf /' })).toBe('allow');
    expect(pm.check('file', { action: 'write', path: 'foo.ts' })).toBe('allow');
    expect(pm.check('unknown', { anything: true })).toBe('allow');
  });

  it('custom tool with permissionKey checks correctly', () => {
    const pm = createPm({ allow: ['deploy(staging)'] });
    expect(pm.check('deploy', { target: 'staging' }, { qualifier: 'target' })).toBe('allow');
    expect(pm.check('deploy', { target: 'production' }, { qualifier: 'target' })).toBe('ask');
  });

  it('custom tool without permissionKey: toolname(*) allows all', () => {
    const pm = createPm({ allow: ['weather(*)'] });
    expect(pm.check('weather', { city: 'London' })).toBe('allow');
    expect(pm.check('weather', { city: 'Tokyo' })).toBe('allow');
  });

  it('file path patterns with ** work', () => {
    const pm = createPm({ allow: ['file(write:src/**)'] });
    expect(pm.check('file', { action: 'write', path: 'src/core/foo.ts' })).toBe('allow');
    expect(pm.check('file', { action: 'write', path: 'src/deep/nested/bar.ts' })).toBe('allow');
    expect(pm.check('file', { action: 'write', path: 'test/foo.ts' })).toBe('ask');
  });

  it('web fetch hostname patterns work', () => {
    const pm = createPm({ allow: ['web(fetch:*github.com*)'] });
    expect(pm.check('web', { action: 'fetch', url: 'https://api.github.com/repos' })).toBe('allow');
    expect(pm.check('web', { action: 'fetch', url: 'https://evil.com' })).toBe('ask');
  });
});
