import type { EditorState, EditorResult, CompletionEngine, FooterData } from './types.js';
import {
  createEmpty,
  insertChar,
  insertPaste,
  deleteBackward,
  deleteForward,
  moveCursorLeft,
  moveCursorRight,
  moveCursorHome,
  moveCursorEnd,
  clearLine,
  deleteWordBackward,
  serialize,
  getTextBeforeCursor,
  getTokenAtCursor,
} from './buffer.js';
import { renderPromptLine, renderCompletionRow, clearCompletionRow, resetRenderState, renderFooter } from './render.js';
import { commonPrefix } from './completion.js';

const PASTE_LINE_THRESHOLD = 3;
const PASTE_CHAR_THRESHOLD = 200;
const PASTE_TIMING_MS = 15;

/** Normalize \r\n and bare \r to \n — terminals send \r in raw mode. */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Bracket paste escape sequences
const BRACKET_PASTE_START = '\x1b[200~';
const BRACKET_PASTE_END = '\x1b[201~';

export interface ReadLineOptions {
  /** If true, Ctrl+C exits the process. If false, resolves with empty string. Default: true. */
  exitOnCtrlC?: boolean;
  /** Footer data to display on a reserved bottom row. */
  footer?: FooterData;
  /** Optional callback for Shift+Tab when not cycling completions. */
  onShiftTab?: () => void;
}

export function readLine(
  prompt: string,
  completionEngine: CompletionEngine | null,
  options?: ReadLineOptions,
): Promise<EditorResult> {
  return new Promise<EditorResult>((resolve) => {
    let state: EditorState = createEmpty();
    let pasteBuffer = '';
    let pasteTimer: ReturnType<typeof setTimeout> | null = null;
    let bracketPasting = false;
    let bracketPasteContent = '';
    let completionShowing = false;

    const cols = () => process.stderr.columns || 80;
    const rows = () => process.stderr.rows || 24;
    const footerData = options?.footer ?? null;

    function setupScrollRegion() {
      if (!footerData) return;
      const r = rows();
      // Set scroll region to all rows except the last
      process.stderr.write(`\x1b[1;${r - 1}r`);
      // Render footer on the reserved bottom row
      process.stderr.write(renderFooter(footerData, cols()));
      // Move cursor back into scroll region
      process.stderr.write(`\x1b[${r - 1};1H`);
    }

    function updateFooter() {
      if (!footerData) return;
      // Save cursor, redraw just the footer row, then restore cursor.
      process.stderr.write('\x1b7');
      process.stderr.write(renderFooter(footerData, cols()));
      process.stderr.write('\x1b8');
    }

    function teardownScrollRegion() {
      if (!footerData) return;
      // Reset scroll region to full terminal
      process.stderr.write('\x1b[r');
      // Clear the footer row
      const r = rows();
      process.stderr.write(`\x1b[${r};1H\x1b[2K`);
      // Move cursor back up
      process.stderr.write(`\x1b[${r - 1};1H`);
    }

    function render() {
      let out = renderPromptLine(prompt, state, cols());
      if (state.completionState?.showing) {
        out += renderCompletionRow(state, cols());
        completionShowing = true;
      } else if (completionShowing) {
        out += clearCompletionRow();
        completionShowing = false;
      }
      process.stderr.write(out);
    }

    function onResize() {
      // Re-setup scroll region on terminal resize
      if (footerData) {
        setupScrollRegion();
      }
      render();
    }

    function finish(text: string) {
      // Clean up
      if (pasteTimer) clearTimeout(pasteTimer);
      process.stdin.removeListener('data', onData);
      process.stderr.removeListener('resize', onResize);
      teardownScrollRegion();
      // Disable bracket paste mode (raw mode is owned by readline, don't touch it)
      process.stderr.write('\x1b[?2004l');
      // Clear completion row if showing
      if (completionShowing) {
        process.stderr.write(clearCompletionRow());
      }
      // Move past prompt
      process.stderr.write('\n');
      resolve({ text });
    }

    function handleTab(direction: 1 | -1 = 1) {
      if (!completionEngine) return;

      const textBefore = getTextBeforeCursor(state);
      const { token, start } = getTokenAtCursor(state);

      if (state.completionState?.showing && state.completionState.candidates.length > 0) {
        // Cycle through candidates
        const cs = state.completionState;
        const len = cs.candidates.length;
        const nextIdx = (cs.cycleIndex + direction + len) % len;
        const candidate = cs.candidates[nextIdx];

        // Replace the token with the candidate text
        // We need to rebuild state: delete from replacementStart to current cursor, then insert candidate
        let s = state;
        // Delete back to replacement start
        const curOff = getTextBeforeCursor(s).length;
        const deleteCount = curOff - cs.replacementStart;
        for (let i = 0; i < deleteCount; i++) {
          s = deleteBackward(s);
        }
        // Insert the candidate
        for (const ch of candidate.text) {
          s = insertChar(s, ch);
        }

        state = {
          ...s,
          completionState: {
            ...cs,
            cycleIndex: nextIdx,
            replacementEnd: cs.replacementStart + candidate.text.length,
          },
        };
        render();
        return;
      }

      // New completion request
      const candidates = completionEngine.complete(textBefore);
      if (!Array.isArray(candidates) || candidates.length === 0) {
        process.stderr.write('\x07'); // bell
        return;
      }

      if (candidates.length === 1) {
        // Single match — inline complete
        const candidate = candidates[0];
        // Delete current token and insert completion
        let s = state;
        for (let i = 0; i < token.length; i++) s = deleteBackward(s);
        for (const ch of candidate.text) s = insertChar(s, ch);
        state = s;
        render();
        return;
      }

      // Multiple matches
      const texts = candidates.map(c => c.text);
      const prefix = commonPrefix(texts);

      if (prefix.length > token.length) {
        // Extend to common prefix
        let s = state;
        for (let i = 0; i < token.length; i++) s = deleteBackward(s);
        for (const ch of prefix) s = insertChar(s, ch);
        state = {
          ...s,
          completionState: {
            candidates,
            commonPrefix: prefix,
            cycleIndex: -1,
            replacementStart: start,
            replacementEnd: start + prefix.length,
            showing: true,
          },
        };
      } else {
        // Show candidates without extending
        state = {
          ...state,
          completionState: {
            candidates,
            commonPrefix: prefix,
            cycleIndex: -1,
            replacementStart: start,
            replacementEnd: start + token.length,
            showing: true,
          },
        };
      }
      render();
    }

    function processPasteBuffer() {
      pasteTimer = null;
      const buf = normalizeLineEndings(pasteBuffer);
      pasteBuffer = '';

      const lineCount = buf.split('\n').length;
      if (lineCount >= PASTE_LINE_THRESHOLD || buf.length >= PASTE_CHAR_THRESHOLD) {
        state = insertPaste(state, buf);
      } else {
        // Process character by character, normalizing \n to space for short pastes
        for (const ch of buf) {
          if (ch === '\n' || ch === '\r') {
            state = insertChar(state, ' ');
          } else if (ch >= ' ' || ch === '\t') {
            state = insertChar(state, ch);
          }
        }
      }
      render();
    }

    function processKey(data: string) {
      // Handle bracket paste
      if (data.includes(BRACKET_PASTE_START)) {
        const startIdx = data.indexOf(BRACKET_PASTE_START);
        // Process any chars before the marker
        if (startIdx > 0) processKey(data.slice(0, startIdx));
        bracketPasting = true;
        bracketPasteContent = '';
        // Process content after start marker
        const afterStart = data.slice(startIdx + BRACKET_PASTE_START.length);
        if (afterStart.includes(BRACKET_PASTE_END)) {
          const endIdx = afterStart.indexOf(BRACKET_PASTE_END);
          bracketPasteContent += afterStart.slice(0, endIdx);
          finishBracketPaste();
          // Process anything after end marker
          const afterEnd = afterStart.slice(endIdx + BRACKET_PASTE_END.length);
          if (afterEnd.length > 0) processKey(afterEnd);
        } else {
          bracketPasteContent += afterStart;
        }
        return;
      }

      if (bracketPasting) {
        if (data.includes(BRACKET_PASTE_END)) {
          const endIdx = data.indexOf(BRACKET_PASTE_END);
          bracketPasteContent += data.slice(0, endIdx);
          finishBracketPaste();
          const afterEnd = data.slice(endIdx + BRACKET_PASTE_END.length);
          if (afterEnd.length > 0) processKey(afterEnd);
        } else {
          bracketPasteContent += data;
        }
        return;
      }

      // Check if this looks like pasted content (multi-byte with newlines)
      if (data.length > 1 && (data.includes('\n') || data.includes('\r'))) {
        pasteBuffer += data;
        if (pasteTimer) clearTimeout(pasteTimer);
        pasteTimer = setTimeout(processPasteBuffer, PASTE_TIMING_MS);
        return;
      }

      // Single keystrokes or short sequences
      if (data.length > 1 && !data.startsWith('\x1b')) {
        // Rapid typing or short paste without newlines — insert char by char
        for (const ch of data) {
          processKey(ch);
        }
        return;
      }

      // ── Key dispatch ─────────────────────────────────────────────────

      switch (data) {
        case '\r':  // Enter
        case '\n':
          finish(serialize(state));
          return;

        case '\x7f':  // Backspace
          state = deleteBackward(state);
          render();
          return;

        case '\x1b[3~':  // Delete
          state = deleteForward(state);
          render();
          return;

        case '\x1b[D':  // Left
          state = moveCursorLeft(state);
          render();
          return;

        case '\x1b[C':  // Right
          state = moveCursorRight(state);
          render();
          return;

        case '\x1b[H':  // Home
        case '\x01':    // Ctrl-A
          state = moveCursorHome(state);
          render();
          return;

        case '\x1b[F':  // End
        case '\x05':    // Ctrl-E
          state = moveCursorEnd(state);
          render();
          return;

        case '\x09':  // Tab
          handleTab(1);
          return;

        case '\x1b[Z':  // Shift+Tab — cycle backward or toggle mode
          if (options?.onShiftTab && !state.completionState?.showing) {
            options.onShiftTab();
            updateFooter();
            return;
          }
          handleTab(-1);
          return;

        case '\x03':  // Ctrl-C
          finish('');
          if (options?.exitOnCtrlC !== false) process.exit(0);
          return;

        case '\x15':  // Ctrl-U
          state = clearLine(state);
          render();
          return;

        case '\x17':  // Ctrl-W
          state = deleteWordBackward(state);
          render();
          return;

        case '\x1b':  // Bare escape — ignore
          return;

        case '\x1b[A':  // Up arrow — ignore (no history)
        case '\x1b[B':  // Down arrow — ignore
          return;
      }

      // Printable characters
      if (data.length === 1 && data >= ' ') {
        state = insertChar(state, data);
        render();
        return;
      }

      // Multi-byte UTF-8 characters (emoji, CJK, etc.)
      if (data.length > 1 && data.codePointAt(0)! >= 0x80) {
        state = insertChar(state, data);
        render();
        return;
      }
    }

    function finishBracketPaste() {
      bracketPasting = false;
      const content = normalizeLineEndings(bracketPasteContent);
      bracketPasteContent = '';

      const lineCount = content.split('\n').length;
      if (lineCount >= PASTE_LINE_THRESHOLD || content.length >= PASTE_CHAR_THRESHOLD) {
        state = insertPaste(state, content);
      } else {
        // Short paste — normalize newlines to spaces
        for (const ch of content) {
          if (ch === '\n' || ch === '\r') {
            state = insertChar(state, ' ');
          } else if (ch >= ' ' || ch === '\t') {
            state = insertChar(state, ch);
          }
        }
      }
      render();
    }

    function onData(buf: Buffer) {
      const data = buf.toString('utf-8');

      // If we're accumulating a paste via timing heuristic
      if (pasteBuffer.length > 0 && !bracketPasting) {
        pasteBuffer += data;
        if (pasteTimer) clearTimeout(pasteTimer);
        pasteTimer = setTimeout(processPasteBuffer, PASTE_TIMING_MS);
        return;
      }

      processKey(data);
    }

    // ── Setup ──────────────────────────────────────────────────────────

    // Raw mode is owned by readline (set ON at construction, stays ON).
    // We just add our data listener and enable bracket paste.
    resetRenderState();
    setupScrollRegion();
    process.stderr.write('\n'); // blank line gap between previous output and prompt
    process.stderr.write('\x1b[?2004h');
    process.stdin.on('data', onData);
    process.stdin.resume();
    process.stderr.on('resize', onResize);
    render();
  });
}
