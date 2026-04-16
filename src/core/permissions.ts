import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AG_DIR } from './constants.js';
import type { PermissionKey } from './types.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type PermissionEffect = 'allow' | 'deny';
export type PermissionScope = 'session' | 'project' | 'global';

export interface PermissionRule {
  pattern: string;
  effect: PermissionEffect;
}

export interface PermissionFile {
  allow?: string[];
  deny?: string[];
}

export interface ParsedPattern {
  tool: string;       // lowercase tool name, or '*'
  qualifier: string;  // action/command-prefix, or '*'
  glob: string | null; // glob for the value, or null (match any)
}

// ── Glob Matching ───────────────────────────────────────────────────────────

/** Hand-rolled glob matcher — supports *, **, ? with no dependencies */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  // Convert glob to regex:
  // 1. Escape regex-special chars (except our glob chars)
  // 2. Replace ** → any sequence (including /)
  // 3. Replace * → any sequence (excluding /)
  // 4. Replace ? → single char
  const SENTINEL = '\0GLOBSTAR\0';
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials
    .replace(/\*\*/g, SENTINEL)             // protect **
    .replace(/\*/g, '[^/]*')               // * = non-slash seq
    .replace(new RegExp(SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.*') // ** = any seq
    .replace(/\?/g, '.');                  // ? = single char
  return new RegExp(`^${re}$`).test(value);
}

// ── Pattern Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a pattern string like "bash(npm:*)" into structured form.
 * Supports: "Tool(qualifier:glob)", "Tool(qualifier)", "Tool(*)", "*"
 */
export function parsePattern(str: string): ParsedPattern {
  const s = str.trim();
  if (s === '*') return { tool: '*', qualifier: '*', glob: null };

  const parenIdx = s.indexOf('(');
  if (parenIdx === -1) {
    // Bare tool name: "bash" → bash(*)
    return { tool: s.toLowerCase(), qualifier: '*', glob: null };
  }

  const tool = s.slice(0, parenIdx).toLowerCase();
  const inner = s.slice(parenIdx + 1, s.endsWith(')') ? s.length - 1 : s.length);

  const colonIdx = inner.indexOf(':');
  if (colonIdx === -1) {
    // No glob: "git(commit)" or "bash(*)"
    return { tool, qualifier: inner || '*', glob: null };
  }

  const qualifier = inner.slice(0, colonIdx) || '*';
  const glob = inner.slice(colonIdx + 1) || '*';
  return { tool, qualifier, glob };
}

// ── Match Key Extraction ────────────────────────────────────────────────────

interface MatchKey {
  qualifier: string;
  value: string;
}

/** Extract qualifier + value from a tool call for pattern matching */
export function extractMatchKey(
  toolName: string,
  args: Record<string, unknown>,
  permissionKey?: PermissionKey,
): MatchKey {
  const name = toolName.toLowerCase();

  // Built-in tools have hardcoded extraction
  switch (name) {
    case 'bash': {
      const cmd = String(args.command || '');
      const firstWord = cmd.trimStart().split(/\s+/)[0] || '';
      return { qualifier: firstWord, value: cmd };
    }
    case 'file':
      return { qualifier: String(args.action || '*'), value: String(args.path || '') };
    case 'git':
      return { qualifier: String(args.action || '*'), value: '' };
    case 'web': {
      const action = String(args.action || '*');
      if (action === 'fetch' && args.url) {
        try {
          const hostname = new URL(String(args.url)).hostname;
          return { qualifier: action, value: hostname };
        } catch { /* fall through */ }
      }
      return { qualifier: action, value: String(args.url || args.query || '') };
    }
  }

  // Custom tools: use permissionKey if provided
  if (permissionKey?.qualifier) {
    const q = String(args[permissionKey.qualifier] ?? '*');
    const v = permissionKey.value ? String(args[permissionKey.value] ?? '') : '';
    return { qualifier: q, value: v };
  }

  // No permissionKey: opaque tool
  return { qualifier: '*', value: '' };
}

// ── Pattern Inference ───────────────────────────────────────────────────────

/** Generate a reasonable permission pattern from a concrete tool call */
export function inferPattern(
  toolName: string,
  args: Record<string, unknown>,
  permissionKey?: PermissionKey,
): string {
  const name = toolName.toLowerCase();

  switch (name) {
    case 'bash': {
      const cmd = String(args.command || '');
      const firstWord = cmd.trimStart().split(/\s+/)[0] || '*';
      return `bash(${firstWord}:*)`;
    }
    case 'file': {
      const action = String(args.action || '*');
      const path = String(args.path || '');
      const firstDir = path.split('/')[0];
      const glob = firstDir && firstDir !== path ? `${firstDir}/**` : '*';
      return `file(${action}:${glob})`;
    }
    case 'git':
      return `git(${String(args.action || '*')})`;
    case 'web': {
      const action = String(args.action || '*');
      if (action === 'fetch' && args.url) {
        try {
          const hostname = new URL(String(args.url)).hostname;
          return `web(fetch:*${hostname}*)`;
        } catch { /* fall through */ }
      }
      return `web(${action}:*)`;
    }
  }

  // Custom tools
  if (permissionKey?.qualifier) {
    const q = String(args[permissionKey.qualifier] ?? '*');
    if (permissionKey.value) {
      return `${name}(${q}:*)`;
    }
    return `${name}(${q})`;
  }

  return `${name}(*)`;
}

// ── Pattern Matching ────────────────────────────────────────────────────────

function matchesRule(pattern: ParsedPattern, toolName: string, key: MatchKey): boolean {
  // Tool name check
  if (pattern.tool !== '*' && pattern.tool !== toolName.toLowerCase()) return false;
  // Qualifier check
  if (pattern.qualifier !== '*' && !globMatch(pattern.qualifier, key.qualifier)) return false;
  // Glob check (if pattern has one)
  if (pattern.glob !== null && key.value && !globMatch(pattern.glob, key.value)) return false;
  return true;
}

// ── PermissionManager ───────────────────────────────────────────────────────

export class PermissionManager {
  private readonly cwd: string;
  private readonly projectPath: string;
  private readonly globalPath: string;

  private sessionRules: PermissionRule[] = [];
  private projectRules: PermissionRule[] = [];
  private globalRules: PermissionRule[] = [];

  constructor(cwd: string) {
    this.cwd = cwd;
    this.projectPath = join(cwd, '.ag', 'permissions.json');
    this.globalPath = join(AG_DIR, 'permissions.json');
    this.reload();
  }

  /** Reload project + global rules from disk */
  reload(): void {
    this.projectRules = this.loadFile(this.projectPath);
    this.globalRules = this.loadFile(this.globalPath);
  }

  /** Check whether a tool call is allowed, denied, or needs prompting */
  check(
    toolName: string,
    args: Record<string, unknown>,
    permissionKey?: PermissionKey,
  ): 'allow' | 'deny' | 'ask' {
    const key = extractMatchKey(toolName, args, permissionKey);
    const allRules = [...this.sessionRules, ...this.projectRules, ...this.globalRules];

    // Deny wins: check deny rules first across all scopes
    for (const rule of allRules) {
      if (rule.effect === 'deny' && matchesRule(parsePattern(rule.pattern), toolName, key)) {
        return 'deny';
      }
    }

    // Then check allow rules
    for (const rule of allRules) {
      if (rule.effect === 'allow' && matchesRule(parsePattern(rule.pattern), toolName, key)) {
        return 'allow';
      }
    }

    return 'ask';
  }

  /** Add a permission rule to a scope */
  addRule(rule: PermissionRule, scope: PermissionScope): void {
    const list = this.rulesForScope(scope);
    // Avoid duplicates
    if (!list.some(r => r.pattern === rule.pattern && r.effect === rule.effect)) {
      list.push(rule);
    }
  }

  /** Remove a rule by pattern from a scope */
  removeRule(pattern: string, scope: PermissionScope): boolean {
    const list = this.rulesForScope(scope);
    const idx = list.findIndex(r => r.pattern === pattern);
    if (idx !== -1) { list.splice(idx, 1); return true; }
    return false;
  }

  /** Get rules, optionally filtered by scope */
  getRules(scope?: PermissionScope): Array<PermissionRule & { scope: PermissionScope }> {
    const result: Array<PermissionRule & { scope: PermissionScope }> = [];
    const add = (rules: PermissionRule[], s: PermissionScope) => {
      for (const r of rules) result.push({ ...r, scope: s });
    };
    if (!scope || scope === 'session') add(this.sessionRules, 'session');
    if (!scope || scope === 'project') add(this.projectRules, 'project');
    if (!scope || scope === 'global') add(this.globalRules, 'global');
    return result;
  }

  /** Persist rules to disk */
  save(scope: 'project' | 'global'): void {
    const path = scope === 'project' ? this.projectPath : this.globalPath;
    const rules = scope === 'project' ? this.projectRules : this.globalRules;
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: PermissionFile = {
      allow: rules.filter(r => r.effect === 'allow').map(r => r.pattern),
      deny: rules.filter(r => r.effect === 'deny').map(r => r.pattern),
    };
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  }

  /** Clear rules for a scope */
  clear(scope: PermissionScope): void {
    if (scope === 'session') this.sessionRules = [];
    else if (scope === 'project') this.projectRules = [];
    else if (scope === 'global') this.globalRules = [];
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private rulesForScope(scope: PermissionScope): PermissionRule[] {
    switch (scope) {
      case 'session': return this.sessionRules;
      case 'project': return this.projectRules;
      case 'global': return this.globalRules;
    }
  }

  private loadFile(path: string): PermissionRule[] {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as PermissionFile;
      const rules: PermissionRule[] = [];
      for (const p of raw.allow ?? []) rules.push({ pattern: p, effect: 'allow' });
      for (const p of raw.deny ?? []) rules.push({ pattern: p, effect: 'deny' });
      return rules;
    } catch {
      return [];
    }
  }
}
