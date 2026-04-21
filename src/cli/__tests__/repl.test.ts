import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPlanModeBlockReason } from '../../core/agent.js';

/**
 * Structural tests for the REPL's raw-mode / interrupt handling.
 *
 * The REPL relies on readline managing raw mode (set at construction,
 * cleared at close). The interrupt-detection code (escape key listener)
 * must NOT toggle setRawMode itself — doing so leaves stdin in cooked
 * mode after the agent run, causing readline to double-echo user input.
 *
 * These tests read the source to enforce that invariant so the bug
 * cannot silently regress.
 */

const replSource = readFileSync(
  resolve(import.meta.dirname, '..', 'repl.ts'),
  'utf-8',
);

describe('REPL interrupt handling — raw mode invariant', () => {
  // Extract the runAgent closure body (between `const runAgent` and the next
  // top-level `await runAgent`).  We look for setRawMode calls inside it.
  const runAgentMatch = replSource.match(
    /const runAgent = async[\s\S]*?finally\s*\{[\s\S]*?\}\s*\}/,
  );
  const runAgentBody = runAgentMatch?.[0] ?? '';

  it('runAgent body is found in source', () => {
    expect(runAgentBody.length).toBeGreaterThan(100);
  });

  it('does NOT call setRawMode(true) inside runAgent', () => {
    // readline manages raw mode; the interrupt setup must not override it
    expect(runAgentBody).not.toMatch(/setRawMode\s*\(\s*true\s*\)/);
  });

  it('does NOT call setRawMode(false) inside runAgent', () => {
    // Turning raw mode off after agent run breaks readline's next question()
    expect(runAgentBody).not.toMatch(/setRawMode\s*\(\s*false\s*\)/);
  });

  it('pauses readline before adding initial keypress listener', () => {
    // Must pause rl to detach its keypress handler before we add ours.
    // The initial setup is in the `if (process.stdin.isTTY)` block after
    // the onKeypress function definition, not inside the steer handler.
    const isTTYBlock = runAgentBody.indexOf('if (process.stdin.isTTY)');
    expect(isTTYBlock).toBeGreaterThan(-1);
    const pauseIdx = runAgentBody.indexOf('.rl.pause()', isTTYBlock);
    const onKeypressIdx = runAgentBody.indexOf("on('keypress'", isTTYBlock);
    expect(pauseIdx).toBeGreaterThan(-1);
    expect(onKeypressIdx).toBeGreaterThan(-1);
    expect(pauseIdx).toBeLessThan(onKeypressIdx);
  });

  it('removes keypress listener in finally block', () => {
    const finallyMatch = runAgentBody.match(/finally\s*\{[\s\S]*\}/);
    expect(finallyMatch).not.toBeNull();
    expect(finallyMatch![0]).toMatch(/removeListener\s*\(\s*['"]keypress['"]/);
  });

  it('shows result ref ids in tool_end output when available', () => {
    expect(replSource).toMatch(/resultRefId != null/);
    expect(replSource).toMatch(/\[result #\$\{chunk\.resultRefId\}\]/);
  });

  it('persists interaction mode changes on Shift-Tab', () => {
    expect(replSource).toMatch(/saveConfig\(\{ interactionMode: this\.interactionMode \}\)/);
  });

  it('documents clear alias and session clear scope in help output', () => {
    expect(replSource).toMatch(/\/memory clear <scope>.*session, project, or all/);
    expect(replSource).toMatch(/\/clear \[scope\].*Alias for \/memory clear/);
  });

  it('handles clear alias with session default', () => {
    expect(replSource).toMatch(/case 'clear':/);
    expect(replSource).toMatch(/const scope = args\[0\]\?\.toLowerCase\(\) \|\| 'session'/);
  });
});

describe('interaction mode enforcement', () => {
  it('allows read-only file access in plan mode', () => {
    expect(getPlanModeBlockReason('file', { action: 'read', path: 'src/app.ts' })).toBeNull();
  });

  it('allows plan operations in plan mode', () => {
    expect(getPlanModeBlockReason('plan', { action: 'save', content: 'draft plan' })).toBeNull();
  });

  it('allows web fetch in plan mode', () => {
    expect(getPlanModeBlockReason('web', { action: 'fetch', url: 'https://example.com' })).toBeNull();
  });

  it('blocks bash in plan mode', () => {
    expect(getPlanModeBlockReason('bash', { command: 'npm test' })).toContain('bash execution is disabled');
  });

  it('blocks agent spawning in plan mode', () => {
    expect(getPlanModeBlockReason('agent', { prompt: 'implement the feature' })).toContain('sub-agents are disabled');
  });

  it('blocks file edits in plan mode', () => {
    expect(getPlanModeBlockReason('file', { action: 'edit', path: 'src/app.ts' })).toContain('file is not allowed');
  });
});
