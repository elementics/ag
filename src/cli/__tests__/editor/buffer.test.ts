import { describe, it, expect } from 'vitest';
import {
  createEmpty,
  normalize,
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
  displaySegments,
  getTextBeforeCursor,
  getTokenAtCursor,
  getCursorOffset,
  displayCursorOffset,
} from '../../editor/buffer.js';
import type { EditorState } from '../../editor/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Type a string character by character. */
function type(state: EditorState, str: string): EditorState {
  let s = state;
  for (const ch of str) s = insertChar(s, ch);
  return s;
}

// ── createEmpty ────────────────────────────────────────────────────────────

describe('createEmpty', () => {
  it('creates a single empty TextSegment with cursor at start', () => {
    const s = createEmpty();
    expect(s.segments).toEqual([{ kind: 'text', text: '' }]);
    expect(s.cursor).toEqual({ seg: 0, off: 0 });
    expect(s.completionState).toBeNull();
    expect(s.pasteIdCounter).toBe(0);
  });
});

// ── normalize ──────────────────────────────────────────────────────────────

describe('normalize', () => {
  it('merges consecutive TextSegments', () => {
    const segs = normalize([
      { kind: 'text', text: 'ab' },
      { kind: 'text', text: 'cd' },
    ]);
    expect(segs).toEqual([{ kind: 'text', text: 'abcd' }]);
  });

  it('does not merge across PasteSegments', () => {
    const segs = normalize([
      { kind: 'text', text: 'a' },
      { kind: 'paste', id: 0, text: 'X', lineCount: 3 },
      { kind: 'text', text: 'b' },
    ]);
    expect(segs).toHaveLength(3);
  });

  it('returns at least one TextSegment for empty input', () => {
    expect(normalize([])).toEqual([{ kind: 'text', text: '' }]);
  });
});

// ── insertChar ─────────────────────────────────────────────────────────────

describe('insertChar', () => {
  it('inserts at the start of empty buffer', () => {
    const s = insertChar(createEmpty(), 'a');
    expect(serialize(s)).toBe('a');
    expect(s.cursor).toEqual({ seg: 0, off: 1 });
  });

  it('inserts at cursor position in text', () => {
    let s = type(createEmpty(), 'abc');
    s = moveCursorLeft(s);
    s = insertChar(s, 'X');
    expect(serialize(s)).toBe('abXc');
  });

  it('inserts before a paste pill (off=0)', () => {
    let s = createEmpty();
    s = insertPaste(s, 'line1\nline2\nline3');
    // Cursor is after pill; move to start
    s = moveCursorHome(s);
    s = insertChar(s, 'X');
    expect(serialize(s)).toBe('Xline1\nline2\nline3');
  });

  it('inserts after a paste pill (off=1)', () => {
    let s = createEmpty();
    s = insertPaste(s, 'line1\nline2\nline3');
    // Cursor is already after pill
    s = insertChar(s, 'X');
    expect(serialize(s)).toBe('line1\nline2\nline3X');
  });

  it('clears completionState on insert', () => {
    let s = createEmpty();
    s = { ...s, completionState: { candidates: [], commonPrefix: '', cycleIndex: -1, replacementStart: 0, replacementEnd: 0, showing: false } };
    s = insertChar(s, 'a');
    expect(s.completionState).toBeNull();
  });
});

// ── insertPaste ────────────────────────────────────────────────────────────

describe('insertPaste', () => {
  it('inserts a paste pill in empty buffer', () => {
    const pasted = 'a\nb\nc';
    let s = insertPaste(createEmpty(), pasted);
    expect(s.segments.some(seg => seg.kind === 'paste')).toBe(true);
    expect(serialize(s)).toBe(pasted);
    expect(s.pasteIdCounter).toBe(1);
  });

  it('splits text at cursor', () => {
    let s = type(createEmpty(), 'hello world');
    // Move cursor to after "hello "
    s = moveCursorHome(s);
    for (let i = 0; i < 6; i++) s = moveCursorRight(s);
    s = insertPaste(s, 'X\nY\nZ');
    expect(serialize(s)).toBe('hello X\nY\nZworld');
  });

  it('increments pasteIdCounter', () => {
    let s = createEmpty();
    s = insertPaste(s, 'a\nb\nc');
    s = insertPaste(s, 'd\ne\nf');
    expect(s.pasteIdCounter).toBe(2);
  });

  it('records correct lineCount', () => {
    let s = insertPaste(createEmpty(), 'a\nb\nc\nd');
    const pill = s.segments.find(seg => seg.kind === 'paste');
    expect(pill).toBeDefined();
    expect((pill as any).lineCount).toBe(4);
  });
});

// ── deleteBackward ─────────────────────────────────────────────────────────

describe('deleteBackward', () => {
  it('does nothing at start of empty buffer', () => {
    const s = deleteBackward(createEmpty());
    expect(serialize(s)).toBe('');
  });

  it('deletes one char in text', () => {
    let s = type(createEmpty(), 'abc');
    s = deleteBackward(s);
    expect(serialize(s)).toBe('ab');
  });

  it('deletes entire pill when cursor is after pill (off=1)', () => {
    let s = insertPaste(createEmpty(), 'a\nb\nc');
    // Cursor is after pill
    s = deleteBackward(s);
    expect(serialize(s)).toBe('');
    expect(s.segments.every(seg => seg.kind === 'text')).toBe(true);
  });

  it('deletes previous pill when at start of next text segment', () => {
    let s = type(createEmpty(), 'before');
    s = insertPaste(s, 'a\nb\nc');
    s = insertChar(s, 'X');
    // Now: "before" [pill] "X" with cursor after X
    // Move left so cursor is at start of 'X' text, which is right after pill
    s = moveCursorLeft(s);
    s = deleteBackward(s);
    expect(serialize(s)).toBe('beforeX');
  });

  it('deletes char from previous text segment when at seg boundary', () => {
    let s = type(createEmpty(), 'abc');
    s = insertPaste(s, 'x\ny\nz');
    // Cursor is after pill. Move back onto pill (off=0), now move back into text.
    s = moveCursorLeft(s); // onto pill off=0
    s = deleteBackward(s);
    expect(serialize(s)).toBe('abx\ny\nz');
  });
});

// ── deleteForward ──────────────────────────────────────────────────────────

describe('deleteForward', () => {
  it('does nothing at end of buffer', () => {
    let s = type(createEmpty(), 'abc');
    s = deleteForward(s);
    expect(serialize(s)).toBe('abc');
  });

  it('deletes one char forward in text', () => {
    let s = type(createEmpty(), 'abc');
    s = moveCursorHome(s);
    s = deleteForward(s);
    expect(serialize(s)).toBe('bc');
  });

  it('deletes pill when cursor is before pill (off=0)', () => {
    let s = insertPaste(createEmpty(), 'a\nb\nc');
    s = moveCursorHome(s);
    s = deleteForward(s);
    expect(serialize(s)).toBe('');
  });

  it('deletes next pill when at end of text before pill', () => {
    let s = type(createEmpty(), 'hello');
    s = insertPaste(s, 'a\nb\nc');
    // Segments: "hello" [pill] ""  cursor is after pill (flat=6)
    // Move back twice: flat=5 (pill off=0), flat=4 (end of "hello" off=5)
    // But pill is 1 unit, so flat 6->5 lands on pill off=0, flat 5->4 lands in text
    // We want cursor at flat=5 (right at boundary between text end and pill start)
    s = moveCursorLeft(s); // flat 5 = before pill
    s = deleteForward(s);
    expect(serialize(s)).toBe('hello');
  });
});

// ── Cursor movement ────────────────────────────────────────────────────────

describe('cursor movement', () => {
  it('moveCursorLeft from end steps back one char', () => {
    let s = type(createEmpty(), 'ab');
    s = moveCursorLeft(s);
    expect(getCursorOffset(s)).toBe(1);
  });

  it('moveCursorLeft does nothing at start', () => {
    const s = moveCursorLeft(createEmpty());
    expect(getCursorOffset(s)).toBe(0);
  });

  it('moveCursorRight steps forward one char', () => {
    let s = type(createEmpty(), 'ab');
    s = moveCursorHome(s);
    s = moveCursorRight(s);
    expect(getCursorOffset(s)).toBe(1);
  });

  it('moveCursorRight does nothing at end', () => {
    let s = type(createEmpty(), 'ab');
    s = moveCursorRight(s);
    expect(getCursorOffset(s)).toBe(2);
  });

  it('cursor moves across pill as one unit', () => {
    let s = type(createEmpty(), 'a');
    s = insertPaste(s, 'x\ny\nz');
    s = insertChar(s, 'b');
    // "a" [pill] "b"  total flat length = 1 + 1 + 1 = 3
    s = moveCursorHome(s);
    s = moveCursorRight(s); // flat 1 = end of 'a'
    s = moveCursorRight(s); // flat 2 = past pill
    s = moveCursorRight(s); // flat 3 = past 'b'
    expect(getCursorOffset(s)).toBe(3);
    // Now go back
    s = moveCursorLeft(s); // flat 2
    s = moveCursorLeft(s); // flat 1
    s = moveCursorLeft(s); // flat 0
    expect(getCursorOffset(s)).toBe(0);
  });

  it('home goes to start', () => {
    let s = type(createEmpty(), 'abc');
    s = moveCursorHome(s);
    expect(getCursorOffset(s)).toBe(0);
  });

  it('end goes to end', () => {
    let s = type(createEmpty(), 'abc');
    s = moveCursorHome(s);
    s = moveCursorEnd(s);
    expect(getCursorOffset(s)).toBe(3);
  });
});

// ── clearLine / deleteWordBackward ─────────────────────────────────────────

describe('clearLine', () => {
  it('clears everything', () => {
    let s = type(createEmpty(), 'hello world');
    s = clearLine(s);
    expect(serialize(s)).toBe('');
    expect(getCursorOffset(s)).toBe(0);
  });
});

describe('deleteWordBackward', () => {
  it('deletes last word', () => {
    let s = type(createEmpty(), 'hello world');
    s = deleteWordBackward(s);
    expect(serialize(s)).toBe('hello ');
  });

  it('deletes with trailing spaces', () => {
    let s = type(createEmpty(), 'hello   ');
    s = deleteWordBackward(s);
    expect(serialize(s)).toBe('');
  });

  it('does nothing on empty buffer', () => {
    const s = deleteWordBackward(createEmpty());
    expect(serialize(s)).toBe('');
  });
});

// ── serialize / displaySegments / getTextBeforeCursor ──────────────────────

describe('serialize', () => {
  it('expands paste pills to real content', () => {
    let s = type(createEmpty(), 'before');
    s = insertPaste(s, 'X\nY\nZ');
    s = type(s, 'after');
    expect(serialize(s)).toBe('beforeX\nY\nZafter');
  });
});

describe('displaySegments', () => {
  it('shows pill label instead of content', () => {
    let s = insertPaste(createEmpty(), 'a\nb\nc');
    const segs = displaySegments(s);
    expect(segs).toEqual([{ text: '[Pasted 3 lines]', isPill: true }]);
  });

  it('filters out empty text segments', () => {
    const segs = displaySegments(createEmpty());
    expect(segs).toEqual([]);
  });
});

describe('getTextBeforeCursor', () => {
  it('returns text up to cursor in simple text', () => {
    let s = type(createEmpty(), 'hello world');
    for (let i = 0; i < 5; i++) s = moveCursorLeft(s);
    expect(getTextBeforeCursor(s)).toBe('hello ');
  });

  it('includes pill content when cursor is after pill', () => {
    let s = insertPaste(createEmpty(), 'a\nb\nc');
    expect(getTextBeforeCursor(s)).toBe('a\nb\nc');
  });

  it('excludes pill content when cursor is before pill', () => {
    let s = insertPaste(createEmpty(), 'a\nb\nc');
    s = moveCursorHome(s);
    expect(getTextBeforeCursor(s)).toBe('');
  });
});

describe('getTokenAtCursor', () => {
  it('returns current token', () => {
    let s = type(createEmpty(), '/config set base');
    expect(getTokenAtCursor(s)).toEqual({ token: 'base', start: 12 });
  });

  it('returns empty token after space', () => {
    let s = type(createEmpty(), '/model ');
    expect(getTokenAtCursor(s)).toEqual({ token: '', start: 7 });
  });

  it('returns slash command as token', () => {
    let s = type(createEmpty(), '/mo');
    expect(getTokenAtCursor(s)).toEqual({ token: '/mo', start: 0 });
  });
});

describe('displayCursorOffset', () => {
  it('accounts for pill display width', () => {
    let s = type(createEmpty(), 'a');
    s = insertPaste(s, 'x\ny\nz');
    // cursor is after pill, display text is: "a[Pasted 3 lines]"
    const expected = 1 + '[Pasted 3 lines]'.length;
    expect(displayCursorOffset(s)).toBe(expected);
  });
});
