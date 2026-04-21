import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { planTool } from '../plan.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { paths } from '../../memory/memory.js';

const fakeCwd = `/tmp/__ag_plan_test_${randomBytes(8).toString('hex')}__`;
let projectDir: string;
let plan: ReturnType<typeof planTool>;

beforeEach(() => {
  mkdirSync(fakeCwd, { recursive: true });
  projectDir = paths(fakeCwd).projectDir;
  plan = planTool(fakeCwd);
});

afterEach(() => {
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true });
  if (existsSync(fakeCwd)) rmSync(fakeCwd, { recursive: true });
});

describe('plan tool', () => {
  it('save creates a plan and returns path', async () => {
    const result = await plan.execute({ action: 'save', content: '# My Plan\nStep 1' });
    expect(result).toContain('Plan saved');
  });

  it('save requires content', async () => {
    const result = await plan.execute({ action: 'save' });
    expect(result).toContain('content is required');
  });

  it('list shows saved plans', async () => {
    await plan.execute({ action: 'save', content: 'plan 1', name: 'first' });
    await plan.execute({ action: 'save', content: 'plan 2', name: 'second' });
    const result = await plan.execute({ action: 'list' });
    expect(result).toContain('first');
    expect(result).toContain('second');
  });

  it('list returns message when empty', async () => {
    const result = await plan.execute({ action: 'list' });
    expect(result).toContain('No plans');
  });

  it('read loads a specific plan by name', async () => {
    await plan.execute({ action: 'save', content: 'specific content', name: 'readable' });
    const listResult = await plan.execute({ action: 'list' });
    // Extract the plan name from the list
    const name = listResult.split('\n').find(l => l.trimStart().startsWith('>') || /^\s{2}\S/.test(l))!.replace(/^>\s*/, '').split('  ')[0].trim();
    const result = await plan.execute({ action: 'read', name });
    expect(result).toContain('specific content');
  });

  it('read requires name', async () => {
    const result = await plan.execute({ action: 'read' });
    expect(result).toContain('name is required');
  });

  it('append adds to latest plan', async () => {
    await plan.execute({ action: 'save', content: 'base plan', name: 'appendable' });
    const result = await plan.execute({ action: 'append', content: '\nappended text' });
    expect(result).toContain('Appended');
  });

  it('append requires content', async () => {
    const result = await plan.execute({ action: 'append' });
    expect(result).toContain('content is required');
  });

  it('switch activates a different plan', async () => {
    await plan.execute({ action: 'save', content: 'plan A', name: 'alpha' });
    await plan.execute({ action: 'save', content: 'plan B', name: 'beta' });
    const result = await plan.execute({ action: 'switch', name: 'alpha' });
    expect(result).toContain('Switched to plan');
    expect(result).toContain('alpha');
  });

  it('switch requires name', async () => {
    const result = await plan.execute({ action: 'switch' });
    expect(result).toContain('name is required');
  });

  it('switch errors on nonexistent plan', async () => {
    const result = await plan.execute({ action: 'switch', name: 'nonexistent' });
    expect(result).toContain('No plan matching');
  });

  it('unknown action returns error', async () => {
    const result = await plan.execute({ action: 'delete' });
    expect(result).toContain('Unknown action');
  });
});
