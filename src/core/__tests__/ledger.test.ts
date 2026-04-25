import { describe, expect, it } from 'vitest';
import { AgentLedger } from '../ledger.js';

describe('AgentLedger', () => {
  it('blocks repeated same-file mutations after three unverified edits', () => {
    const ledger = new AgentLedger();
    ledger.beginTurn(1);

    for (let i = 0; i < 3; i++) {
      expect(ledger.shouldBlockTool('file', { action: 'edit', path: 'src/a.ts' }, i)).toBeNull();
      ledger.recordToolResult('file', { action: 'edit', path: 'src/a.ts' }, 'Edited src/a.ts', false, i);
    }

    const guard = ledger.shouldBlockTool('file', { action: 'edit', path: 'src/a.ts' }, 3);
    expect(guard?.trigger).toBe('repeat_mutation');
    expect(guard?.path).toBe('src/a.ts');
    expect(ledger.getStatus()).toBe('guard_stopped');
  });

  it('allows another mutation after a confirming read', () => {
    const ledger = new AgentLedger();
    ledger.beginTurn(1);

    for (let i = 0; i < 3; i++) {
      ledger.recordToolResult('file', { action: 'edit', path: 'src/a.ts' }, 'Edited src/a.ts', false, i);
    }
    ledger.recordToolResult('file', { action: 'read', path: 'src/a.ts' }, '1\tcontent', false, 3);

    expect(ledger.shouldBlockTool('file', { action: 'edit', path: 'src/a.ts' }, 4)).toBeNull();
  });

  it('allows another mutation after a verification command', () => {
    const ledger = new AgentLedger();
    ledger.beginTurn(1);

    for (let i = 0; i < 3; i++) {
      ledger.recordToolResult('file', { action: 'write', path: 'src/a.ts' }, 'Wrote src/a.ts', false, i);
    }
    ledger.recordToolResult('bash', { command: 'npm run type-check' }, 'ok', false, 3);

    expect(ledger.shouldBlockTool('file', { action: 'write', path: 'src/a.ts' }, 4)).toBeNull();
  });
});
