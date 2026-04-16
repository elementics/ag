import { describe, it, expect } from 'vitest';
import { gitTool } from '../git.js';

const cwd = process.cwd();
const git = gitTool(cwd);

describe('git tool - parameter validation', () => {
  it('branch requires name', async () => {
    const result = await git.execute({ action: 'branch' });
    expect(result).toContain('name is required');
  });

  it('commit requires message', async () => {
    const result = await git.execute({ action: 'commit' });
    expect(result).toContain('message is required');
  });

  it('unknown action returns error', async () => {
    const result = await git.execute({ action: 'rebase' });
    expect(result).toContain('Unknown action');
  });
});
