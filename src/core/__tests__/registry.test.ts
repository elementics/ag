import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatInstalls, installSkill, removeSkill } from '../registry.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { rmSync } from 'node:fs';

const SKILLS_DIR = join(homedir(), '.ag', 'skills');
const TEST_SKILL = `__test-skill-${Date.now()}`;

function mockTree(skillDir: string, files: string[]) {
  return {
    tree: [
      { path: skillDir, type: 'tree', sha: 'abc' },
      ...files.map(f => ({ path: `${skillDir}/${f}`, type: 'blob', sha: 'def', size: 100 })),
    ],
  };
}

describe('formatInstalls', () => {
  it('returns raw number for small values', () => {
    expect(formatInstalls(0)).toBe('0');
    expect(formatInstalls(42)).toBe('42');
    expect(formatInstalls(999)).toBe('999');
  });

  it('formats thousands with K suffix', () => {
    expect(formatInstalls(1000)).toBe('1.0K');
    expect(formatInstalls(2500)).toBe('2.5K');
    expect(formatInstalls(10000)).toBe('10.0K');
  });
});

describe('installSkill', () => {
  it('throws on invalid format (no @ separator)', async () => {
    await expect(installSkill('invalid-source')).rejects.toThrow('Format');
  });

  it('throws a clean actionable message when skill is not found in repo', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    try {
      await expect(installSkill('nonexistent-owner/nonexistent-repo@nonexistent-skill'))
        .rejects.toThrow('registry entry may be outdated');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes skill name and install hint in the not-found error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    try {
      await expect(installSkill('myowner/myrepo@my-skill'))
        .rejects.toThrow('Skill "my-skill" was not found in myowner/myrepo');
      await expect(installSkill('myowner/myrepo@my-skill'))
        .rejects.toThrow('/skill add <owner>/<repo>@my-skill');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('installSkill - full directory fetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    const skillDir = join(SKILLS_DIR, TEST_SKILL);
    if (existsSync(skillDir)) rmSync(skillDir, { recursive: true });
  });

  it('downloads all files in the skill directory', async () => {
    const skillMdContent = '---\nname: test\ndescription: A test skill\ntools: true\n---\nTest instructions';
    const toolsContent = 'export default { type: "function", function: { name: "test" }, execute: () => {} }';

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      // Trees API
      if (urlStr.includes('/git/trees/main')) {
        return new Response(JSON.stringify(mockTree(TEST_SKILL, ['SKILL.md', 'tools.mjs'])), { status: 200 });
      }

      // File downloads via raw.githubusercontent.com
      if (urlStr.endsWith('/SKILL.md')) {
        return new Response(skillMdContent, { status: 200 });
      }
      if (urlStr.endsWith('/tools.mjs')) {
        return new Response(toolsContent, { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const result = await installSkill(`test/repo@${TEST_SKILL}`);
    expect(result).toContain('2 files');

    const skillDir = join(SKILLS_DIR, TEST_SKILL);
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir, 'tools.mjs'))).toBe(true);
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(skillMdContent);
    expect(readFileSync(join(skillDir, 'tools.mjs'), 'utf-8')).toBe(toolsContent);
  });

  it('finds skills nested in arbitrary directory structures', async () => {
    // Simulates tool-belt/skills where skill is at tools/agent-tools/
    const nestedDir = `tools/${TEST_SKILL}`;

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      if (urlStr.includes('/git/trees/main')) {
        return new Response(JSON.stringify(mockTree(nestedDir, ['SKILL.md', 'references/cli.md'])), { status: 200 });
      }

      if (urlStr.endsWith('/SKILL.md')) {
        return new Response('---\nname: test\ndescription: test\n---\nContent', { status: 200 });
      }
      if (urlStr.endsWith('/cli.md')) {
        return new Response('# CLI Reference', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const result = await installSkill(`test/repo@${TEST_SKILL}`);
    expect(result).toContain('2 files');

    const skillDir = join(SKILLS_DIR, TEST_SKILL);
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir, 'references', 'cli.md'))).toBe(true);
  });

  it('falls back to master branch', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      // main branch fails
      if (urlStr.includes('/git/trees/main')) {
        return new Response('Not Found', { status: 404 });
      }

      // master branch works
      if (urlStr.includes('/git/trees/master')) {
        return new Response(JSON.stringify(mockTree(TEST_SKILL, ['SKILL.md'])), { status: 200 });
      }

      if (urlStr.endsWith('/SKILL.md')) {
        return new Response('---\nname: test\ndescription: test\n---\nContent', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const result = await installSkill(`test/repo@${TEST_SKILL}`);
    expect(result).toContain('1 file');
  });

  it('reports warnings for files that fail to download', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      if (urlStr.includes('/git/trees/main')) {
        return new Response(JSON.stringify(mockTree(TEST_SKILL, ['SKILL.md', 'broken.js'])), { status: 200 });
      }

      if (urlStr.endsWith('/SKILL.md')) {
        return new Response('---\nname: test\ndescription: test\n---\nContent', { status: 200 });
      }
      if (urlStr.endsWith('/broken.js')) {
        return new Response('Server Error', { status: 500 });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const result = await installSkill(`test/repo@${TEST_SKILL}`);
    expect(result).toContain('Warnings');
    expect(result).toContain('broken.js');
    expect(existsSync(join(SKILLS_DIR, TEST_SKILL, 'SKILL.md'))).toBe(true);
  });

  it('sends auth header when GITHUB_TOKEN is set', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    process.env.GITHUB_TOKEN = 'test-token-123';

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.headers) capturedHeaders.push(init.headers as Record<string, string>);
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    await installSkill(`test/repo@${TEST_SKILL}`).catch(() => {});
    delete process.env.GITHUB_TOKEN;

    expect(capturedHeaders.length).toBeGreaterThan(0);
    expect(capturedHeaders[0]['Authorization']).toBe('Bearer test-token-123');
  });
});

describe('removeSkill', () => {
  it('returns not-found for nonexistent skill', () => {
    const result = removeSkill('nonexistent-skill-xyz-' + Date.now());
    expect(result).toContain('not found');
  });
});
