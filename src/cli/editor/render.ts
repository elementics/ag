import type { EditorState } from './types.js';
import { displayCursorOffset, pillLabel } from './buffer.js';
import { C } from '../../core/colors.js';

/** Visible length of a string after stripping ANSI escapes. */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** How many terminal rows a visible length occupies at given column width. */
function rowsForLen(len: number, cols: number): number {
  if (len === 0) return 1;
  return Math.floor((len - 1) / cols) + 1;
}

// Track render state across calls
let prevTotalRows = 1;
let prevCursorRow = 0;
// Last known cursor target — used by completion row to navigate back
let lastTargetRow = 0;
let lastTargetCol = 0;
// Whether a completion row was shown last render
let hadCompletionRow = false;

export function renderPromptLine(prompt: string, state: EditorState, cols: number): string {
  let line = '';
  for (const seg of state.segments) {
    if (seg.kind === 'text') {
      line += seg.text;
    } else {
      line += `${C.cyan}${C.dim}${pillLabel(seg)}${C.reset}`;
    }
  }

  const promptVisible = visibleLen(prompt);
  const totalVisible = promptVisible + visibleLen(line);
  const totalRows = rowsForLen(totalVisible, cols);

  const cursorAbsolute = promptVisible + displayCursorOffset(state);
  const targetRow = Math.floor(cursorAbsolute / cols);
  const targetCol = cursorAbsolute % cols;

  let out = '';

  // Step 1: Move from current cursor position to row 0
  // Cursor is always at prevCursorRow (completion row restores it)
  if (prevCursorRow > 0) {
    out += `\x1b[${prevCursorRow}A`;
  }
  out += '\r';

  // Step 2: Clear all rows (plus the completion row if one was shown)
  const rowsToClear = prevTotalRows + (hadCompletionRow ? 1 : 0);
  for (let i = 0; i < rowsToClear; i++) {
    out += '\x1b[2K';
    if (i < rowsToClear - 1) out += '\x1b[B';
  }
  if (rowsToClear > 1) {
    out += `\x1b[${rowsToClear - 1}A`;
  }
  out += '\r';

  // Step 3: Write prompt + content
  out += prompt + line;

  // Step 4: Navigate from write end to cursor target
  let endRow: number;
  if (totalVisible === 0) {
    endRow = 0;
  } else if (totalVisible % cols === 0) {
    endRow = totalVisible / cols;
  } else {
    endRow = Math.floor(totalVisible / cols);
  }

  if (endRow > targetRow) {
    out += `\x1b[${endRow - targetRow}A`;
  } else if (endRow < targetRow) {
    out += `\x1b[${targetRow - endRow}B`;
  }
  out += '\r';
  if (targetCol > 0) {
    out += `\x1b[${targetCol}C`;
  }

  // Update tracking
  prevTotalRows = Math.max(totalRows, endRow + 1);
  prevCursorRow = targetRow;
  lastTargetRow = targetRow;
  lastTargetCol = targetCol;
  hadCompletionRow = false;

  return out;
}

export function resetRenderState(): void {
  prevTotalRows = 1;
  prevCursorRow = 0;
  lastTargetRow = 0;
  lastTargetCol = 0;
  hadCompletionRow = false;
}

export function renderCompletionRow(state: EditorState, cols: number): string {
  const cs = state.completionState;
  if (!cs || !cs.showing || cs.candidates.length === 0) return '';

  // Build candidate display, fitting within one terminal row
  const indent = 2; // leading spaces
  const maxWidth = cols - indent - 1; // leave room
  const total = cs.candidates.length;
  let usedWidth = 0;
  let shownCount = 0;

  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const c = cs.candidates[i];
    const sep = parts.length > 0 ? 2 : 0; // "  " separator
    const needed = sep + c.display.length;

    // Reserve space for "+N more" suffix
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

  // Move down from cursor, write candidates, move back up to cursor position
  let out = '';
  // From cursor at (lastTargetRow, lastTargetCol), go to bottom of prompt content
  const bottomRow = prevTotalRows - 1;
  if (bottomRow > lastTargetRow) {
    out += `\x1b[${bottomRow - lastTargetRow}B`;
  }
  // Move to next line and write
  out += `\n\x1b[2K  ${row}`;
  // Move back up to cursor row: we're now on bottomRow + 1
  const rowsUp = (bottomRow + 1) - lastTargetRow;
  if (rowsUp > 0) {
    out += `\x1b[${rowsUp}A`;
  }
  // Restore column
  out += '\r';
  if (lastTargetCol > 0) {
    out += `\x1b[${lastTargetCol}C`;
  }

  hadCompletionRow = true;
  return out;
}

export function clearCompletionRow(): string {
  // Same navigation: go to bottom + 1, clear, come back
  let out = '';
  const bottomRow = prevTotalRows - 1;
  if (bottomRow > lastTargetRow) {
    out += `\x1b[${bottomRow - lastTargetRow}B`;
  }
  out += `\n\x1b[2K`;
  const rowsUp = (bottomRow + 1) - lastTargetRow;
  if (rowsUp > 0) {
    out += `\x1b[${rowsUp}A`;
  }
  out += '\r';
  if (lastTargetCol > 0) {
    out += `\x1b[${lastTargetCol}C`;
  }

  hadCompletionRow = false;
  return out;
}
