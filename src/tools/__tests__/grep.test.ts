import { describe, it, expect } from 'vitest';
import { grepTool } from '../grep.js';
import { resolve } from 'node:path';

const cwd = resolve(process.cwd());
const grep = grepTool(cwd);

describe('grep tool - path boundary', () => {
  it('blocks search outside project directory', async () => {
    const result = await grep.execute({ action: 'search', pattern: 'test', path: '../../..' });
    expect(result).toMatch(/must be within the project directory/);
  });

  it('blocks find outside project directory', async () => {
    const result = await grep.execute({ action: 'find', pattern: '*.ts', path: '../../..' });
    expect(result).toMatch(/must be within the project directory/);
  });
});

describe('grep tool - search', () => {
  it('finds pattern in files', async () => {
    const result = await grep.execute({ action: 'search', pattern: '@elementics/ag', glob: '*.json' });
    expect(result).toContain('package.json');
  });

  it('returns no matches for pattern not in code', async () => {
    const result = await grep.execute({ action: 'search', pattern: 'ZZZYYYXXX_NEVER_IN_CODE_12345', path: 'src/core' });
    expect(result).toMatch(/No matches/);
  });
});

describe('grep tool - find', () => {
  it('finds files by glob', async () => {
    const result = await grep.execute({ action: 'find', pattern: '*.json' });
    expect(result).toContain('package.json');
  });

  it('finds typescript files', async () => {
    const result = await grep.execute({ action: 'find', pattern: '*.ts', path: 'src/core' });
    expect(result).toContain('agent.ts');
  });
});
