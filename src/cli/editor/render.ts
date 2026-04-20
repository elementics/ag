import type { EditorState, FooterData } from './types.js';
import { displayCursorOffset, pillLabel } from './buffer.js';
import { C } from '../../core/colors.js';

/** Visible length of a string after stripping ANSI escapes. */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Track whether a completion row was shown last render
let hadCompletionRow = false;
// Track cursor column for completion row restore
let lastCursorCol = 0;

/**
 * Render the prompt + editor content on a single row.
 * Never fills the exact terminal width — prevents terminal scroll.
 * When content exceeds available width, shows a viewport around the cursor.
 */
export function renderPromptLine(prompt: string, state: EditorState, cols: number): string {
  // Build full display text (with ANSI for pills) and matching plain text
  let styled = '';
  let plain = '';
  for (const seg of state.segments) {
    if (seg.kind === 'text') {
      styled += seg.text;
      plain += seg.text;
    } else {
      const label = pillLabel(seg);
      styled += `${C.cyan}${C.dim}${label}${C.reset}`;
      plain += label;
    }
  }

  const promptWidth = visibleLen(prompt);
  const cursorOff = displayCursorOffset(state);

  // Available width for content — leave 1 col free to prevent exact-fill scroll
  const maxContent = cols - promptWidth - 1;

  let displayStyled: string;
  let cursorCol: number;

  if (plain.length <= maxContent) {
    // Fits — render as-is
    displayStyled = styled;
    cursorCol = promptWidth + cursorOff;
  } else {
    // Viewport: show a window around the cursor
    const halfView = Math.floor(maxContent / 2);
    let viewStart = cursorOff - halfView;
    if (viewStart < 0) viewStart = 0;
    if (viewStart + maxContent > plain.length) viewStart = Math.max(0, plain.length - maxContent);

    const hasLeft = viewStart > 0;
    const hasRight = viewStart + maxContent < plain.length;

    // Reserve space for ellipsis indicators
    const leftCost = hasLeft ? 1 : 0;
    const rightCost = hasRight ? 1 : 0;
    const contentSpace = maxContent - leftCost - rightCost;
    const sliceStart = hasLeft ? viewStart + 1 : viewStart;
    const sliceEnd = sliceStart + contentSpace;

    displayStyled = '';
    if (hasLeft) displayStyled += `${C.dim}\u2026${C.reset}`;
    displayStyled += buildStyledSlice(state, sliceStart, sliceEnd);
    if (hasRight) displayStyled += `${C.dim}\u2026${C.reset}`;

    cursorCol = promptWidth + leftCost + (cursorOff - sliceStart);
  }

  let out = '';

  // Clear current line (always single row — no wrapping)
  if (hadCompletionRow) {
    // Also clear the completion row below
    out += '\r\x1b[2K\n\x1b[2K\x1b[A\r';
    hadCompletionRow = false;
  } else {
    out += '\r\x1b[2K';
  }

  // Write prompt + content
  out += prompt + displayStyled;

  // Position cursor
  out += '\r';
  if (cursorCol > 0) {
    out += `\x1b[${cursorCol}C`;
  }

  lastCursorCol = cursorCol;
  return out;
}

/**
 * Build the styled (ANSI) substring for a visible character range [visStart, visEnd).
 * Walks segments and extracts the portion, preserving pill styling.
 */
function buildStyledSlice(state: EditorState, visStart: number, visEnd: number): string {
  let pos = 0;
  let result = '';

  for (const seg of state.segments) {
    if (seg.kind === 'text') {
      const segEnd = pos + seg.text.length;
      if (segEnd > visStart && pos < visEnd) {
        const s = Math.max(0, visStart - pos);
        const e = Math.min(seg.text.length, visEnd - pos);
        result += seg.text.slice(s, e);
      }
      pos = segEnd;
    } else {
      const label = pillLabel(seg);
      const segEnd = pos + label.length;
      if (segEnd > visStart && pos < visEnd) {
        const s = Math.max(0, visStart - pos);
        const e = Math.min(label.length, visEnd - pos);
        result += `${C.cyan}${C.dim}${label.slice(s, e)}${C.reset}`;
      }
      pos = segEnd;
    }
    if (pos >= visEnd) break;
  }

  return result;
}

/** Reset the render state (call when starting a new prompt). */
export function resetRenderState(): void {
  hadCompletionRow = false;
  lastCursorCol = 0;
}

/** Render the completion candidate row below the prompt. */
export function renderCompletionRow(state: EditorState, cols: number): string {
  const cs = state.completionState;
  if (!cs || !cs.showing || cs.candidates.length === 0) return '';

  const indent = 2;
  const maxWidth = cols - indent - 1;
  const total = cs.candidates.length;
  let usedWidth = 0;
  let shownCount = 0;

  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const c = cs.candidates[i];
    const sep = parts.length > 0 ? 2 : 0;
    const needed = sep + c.display.length;

    const moreText = ` +${total - shownCount} more`;
    const moreWidth = i < total - 1 ? moreText.length : 0;

    if (usedWidth + needed + moreWidth > maxWidth && parts.length > 0) {
      parts.push(`${C.dim}+${total - shownCount} more${C.reset}`);
      break;
    }

    if (i === cs.cycleIndex) {
      parts.push(`${C.cyan}${c.display}${C.reset}`);
    } else {
      parts.push(`${C.dim}${c.display}${C.reset}`);
    }
    usedWidth += needed;
    shownCount++;
  }

  const row = parts.join('  ');

  // Write candidates on line below, then return cursor to prompt line
  let out = `\n\x1b[2K  ${row}\x1b[A\r`;
  if (lastCursorCol > 0) {
    out += `\x1b[${lastCursorCol}C`;
  }

  hadCompletionRow = true;
  return out;
}

/** Clear the completion row (blank the line below and return cursor). */
export function clearCompletionRow(): string {
  hadCompletionRow = false;
  let out = `\n\x1b[2K\x1b[A\r`;
  if (lastCursorCol > 0) {
    out += `\x1b[${lastCursorCol}C`;
  }
  return out;
}

// ── Footer rendering ─────────────────────────────────────────────────────

function formatTokensShort(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1000000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function formatCost(cost: number): string {
  return cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2);
}

/** Render the status footer for the reserved bottom row. */
export function renderFooter(data: FooterData, cols: number): string {
  const BAR_WIDTH = 8;
  const pct = data.contextPct;
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const barColor = pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.green;
  const bar = `${barColor}${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}${C.reset}`;

  const parts: string[] = [];
  parts.push(data.model);
  parts.push(`${bar} ${barColor}${pct}%${C.reset}`);
  parts.push(`↑${formatTokensShort(data.inputTokens)} ↓${formatTokensShort(data.outputTokens)}`);
  if (data.cost != null && data.cost > 0) {
    parts.push(`$${formatCost(data.cost)}`);
  }
  parts.push(`turn ${data.turn}`);

  let line = parts.join(`${C.dim} │ ${C.reset}`);

  // Truncate model name if too wide
  const lineVisible = visibleLen(line);
  if (lineVisible > cols - 1) {
    // Rebuild with truncated model
    const maxModel = Math.max(8, data.model.length - (lineVisible - cols + 2));
    const truncModel = data.model.slice(0, maxModel) + '…';
    parts[0] = truncModel;
    line = parts.join(`${C.dim} │ ${C.reset}`);
  }

  // Position on the reserved bottom row and write
  const rows = process.stderr.rows || 24;
  return `\x1b[${rows};1H\x1b[2K${C.dim}${line}${C.reset}`;
}
