import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { memoryTool } from '../memory.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { paths, loadGlobalMemory, loadProjectMemory, saveGlobalMemory } from '../../memory/memory.js';

const fakeCwd = `/tmp/__ag_memtool_test_${randomBytes(8).toString('hex')}__`;
let projectDir: string;
let mem: ReturnType<typeof memoryTool>;
let originalGlobal: string;

beforeEach(() => {
  mkdirSync(fakeCwd, { recursive: true });
  projectDir = paths(fakeCwd).projectDir;
  mem = memoryTool(fakeCwd);
  originalGlobal = loadGlobalMemory(fakeCwd);
});

afterEach(() => {
  saveGlobalMemory(originalGlobal, fakeCwd);
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true });
  if (existsSync(fakeCwd)) rmSync(fakeCwd, { recursive: true });
});

describe('memory tool', () => {
  it('saves to global memory', async () => {
    const result = await mem.execute({ action: 'save', tier: 'global', content: 'I prefer tabs' });
    expect(result).toContain('global memory');
    expect(loadGlobalMemory(fakeCwd)).toContain('I prefer tabs');
  });

  it('saves to project memory', async () => {
    const result = await mem.execute({ action: 'save', tier: 'project', content: 'Using Express' });
    expect(result).toContain('project memory');
    expect(loadProjectMemory(fakeCwd)).toContain('Using Express');
  });

  it('unknown action returns error', async () => {
    const result = await mem.execute({ action: 'delete', tier: 'global', content: 'x' });
    expect(result).toContain('Unknown action');
  });
});
