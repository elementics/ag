import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
});
