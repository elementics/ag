import type { EditorState, CursorPos, Segment, TextSegment, PasteSegment, DisplaySegment } from './types.js';

// ── Constructors ───────────────────────────────────────────────────────────

export function createEmpty(): EditorState {
  return {
    segments: [{ kind: 'text', text: '' }],
    cursor: { seg: 0, off: 0 },
    completionState: null,
    pasteIdCounter: 0,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function text(t: string): TextSegment {
  return { kind: 'text', text: t };
}

/** Merge consecutive TextSegments and drop empty ones (except keep at least one). */
export function normalize(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.kind === 'text' && out.length > 0 && out[out.length - 1].kind === 'text') {
      (out[out.length - 1] as TextSegment).text += seg.text;
    } else {
      out.push({ ...seg } as Segment);
    }
  }
  // Ensure there's always at least one TextSegment
  if (out.length === 0) out.push(text(''));
  return out;
}

/** Convert (seg, off) to flat char offset across all segments. */
function flatOffset(segs: Segment[], cur: CursorPos): number {
  let flat = 0;
  for (let i = 0; i < cur.seg && i < segs.length; i++) {
    flat += segLen(segs[i]);
  }
  if (cur.seg < segs.length) {
    flat += cur.off;
  }
  return flat;
}

/** Convert flat offset back to (seg, off). */
function cursorFromFlat(segs: Segment[], flat: number): CursorPos {
  let remaining = flat;
  for (let i = 0; i < segs.length; i++) {
    const len = segLen(segs[i]);
    if (remaining <= len) {
      // For paste segments, clamp to 0 or 1
      if (segs[i].kind === 'paste') {
        return { seg: i, off: remaining > 0 ? 1 : 0 };
      }
      return { seg: i, off: remaining };
    }
    remaining -= len;
  }
  // Past end — put at end of last segment
  const last = segs.length - 1;
  return { seg: last, off: segLen(segs[last]) };
}

/** Logical length of a segment (paste pills count as 1 unit). */
function segLen(seg: Segment): number {
  return seg.kind === 'text' ? seg.text.length : 1;
}

// ── Insert operations ──────────────────────────────────────────────────────

export function insertChar(state: EditorState, ch: string): EditorState {
  const segs = state.segments.map(s => ({ ...s })) as Segment[];
  const { seg, off } = state.cursor;
  const cur = segs[seg];

  if (cur.kind === 'text') {
    (cur as TextSegment).text = cur.text.slice(0, off) + ch + cur.text.slice(off);
    return {
      ...state,
      segments: segs,
      cursor: { seg, off: off + ch.length },
      completionState: null,
    };
  }

  // On a PasteSegment — insert a TextSegment before or after
  if (off === 0) {
    // Before pill: insert text before this segment
    segs.splice(seg, 0, text(ch));
    return {
      ...state,
      segments: normalize(segs),
      cursor: cursorFromFlat(normalize(segs), flatOffset(segs, { seg, off: 0 }) + ch.length),
      completionState: null,
    };
  } else {
    // After pill: insert text after this segment
    segs.splice(seg + 1, 0, text(ch));
    const normed = normalize(segs);
    const flat = flatOffset(state.segments, state.cursor) + ch.length;
    return {
      ...state,
      segments: normed,
      cursor: cursorFromFlat(normed, flat),
      completionState: null,
    };
  }
}

export function insertPaste(state: EditorState, pastedText: string): EditorState {
  const lineCount = pastedText.split('\n').length;
  const pill: PasteSegment = {
    kind: 'paste',
    id: state.pasteIdCounter,
    text: pastedText,
    lineCount,
  };

  const segs = state.segments.map(s => ({ ...s })) as Segment[];
  const { seg, off } = state.cursor;
  const cur = segs[seg];

  let newSegs: Segment[];
  if (cur.kind === 'text') {
    const before = text(cur.text.slice(0, off));
    const after = text(cur.text.slice(off));
    newSegs = [...segs.slice(0, seg), before, pill, after, ...segs.slice(seg + 1)];
  } else if (off === 0) {
    newSegs = [...segs.slice(0, seg), pill, ...segs.slice(seg)];
  } else {
    newSegs = [...segs.slice(0, seg + 1), pill, ...segs.slice(seg + 1)];
  }

  const normed = normalize(newSegs);
  // Place cursor after the pill
  const pillFlat = flatOffset(state.segments, state.cursor) + 1;

  return {
    ...state,
    segments: normed,
    cursor: cursorFromFlat(normed, pillFlat),
    completionState: null,
    pasteIdCounter: state.pasteIdCounter + 1,
  };
}

// ── Delete operations ──────────────────────────────────────────────────────

export function deleteBackward(state: EditorState): EditorState {
  const { seg, off } = state.cursor;
  const segs = state.segments;
  const cur = segs[seg];

  if (cur.kind === 'text' && off > 0) {
    // Simple: delete one char within text
    const newSegs = segs.map(s => ({ ...s })) as Segment[];
    (newSegs[seg] as TextSegment).text = cur.text.slice(0, off - 1) + cur.text.slice(off);
    return { ...state, segments: newSegs, cursor: { seg, off: off - 1 }, completionState: null };
  }

  if (cur.kind === 'paste' && off === 1) {
    // Delete the entire pill
    const newSegs = [...segs.slice(0, seg), ...segs.slice(seg + 1)];
    const normed = normalize(newSegs);
    const flat = flatOffset(segs, { seg, off: 0 });
    return { ...state, segments: normed, cursor: cursorFromFlat(normed, flat), completionState: null };
  }

  // At start of a segment — look backward
  if (off === 0 && seg > 0) {
    const prev = segs[seg - 1];
    if (prev.kind === 'paste') {
      // Delete the previous pill
      const newSegs = [...segs.slice(0, seg - 1), ...segs.slice(seg)];
      const normed = normalize(newSegs);
      const flat = flatOffset(segs, { seg: seg - 1, off: 0 });
      return { ...state, segments: normed, cursor: cursorFromFlat(normed, flat), completionState: null };
    }
    if (prev.kind === 'text' && prev.text.length > 0) {
      // Delete last char of previous text segment
      const newSegs = segs.map(s => ({ ...s })) as Segment[];
      (newSegs[seg - 1] as TextSegment).text = prev.text.slice(0, -1);
      const normed = normalize(newSegs);
      const flat = flatOffset(segs, { seg: seg - 1, off: prev.text.length - 1 });
      return { ...state, segments: normed, cursor: cursorFromFlat(normed, flat), completionState: null };
    }
  }

  return state; // At very start, nothing to delete
}

export function deleteForward(state: EditorState): EditorState {
  const { seg, off } = state.cursor;
  const segs = state.segments;
  const cur = segs[seg];

  if (cur.kind === 'text' && off < cur.text.length) {
    const newSegs = segs.map(s => ({ ...s })) as Segment[];
    (newSegs[seg] as TextSegment).text = cur.text.slice(0, off) + cur.text.slice(off + 1);
    return { ...state, segments: newSegs, cursor: { seg, off }, completionState: null };
  }

  if (cur.kind === 'paste' && off === 0) {
    // Delete the pill under cursor
    const flat = flatOffset(segs, { seg, off: 0 });
    const newSegs = [...segs.slice(0, seg), ...segs.slice(seg + 1)];
    const normed = normalize(newSegs);
    return { ...state, segments: normed, cursor: cursorFromFlat(normed, flat), completionState: null };
  }

  // At end of segment — look forward
  const nextSeg = seg + (cur.kind === 'paste' && off === 1 ? 1 : (off >= segLen(cur) ? 1 : 0));
  if (nextSeg < segs.length && nextSeg !== seg) {
    const next = segs[nextSeg];
    if (next.kind === 'paste') {
      const flat = flatOffset(segs, state.cursor);
      const newSegs = [...segs.slice(0, nextSeg), ...segs.slice(nextSeg + 1)];
      const normed = normalize(newSegs);
      return { ...state, segments: normed, cursor: cursorFromFlat(normed, flat), completionState: null };
    }
    if (next.kind === 'text' && next.text.length > 0) {
      const newSegs = segs.map(s => ({ ...s })) as Segment[];
      (newSegs[nextSeg] as TextSegment).text = next.text.slice(1);
      const normed = normalize(newSegs);
      const flat = flatOffset(segs, state.cursor);
      return { ...state, segments: normed, cursor: cursorFromFlat(normed, flat), completionState: null };
    }
  }

  return state; // At very end
}

// ── Cursor movement ────────────────────────────────────────────────────────

export function moveCursorLeft(state: EditorState): EditorState {
  const flat = flatOffset(state.segments, state.cursor);
  if (flat === 0) return state;
  return { ...state, cursor: cursorFromFlat(state.segments, flat - 1), completionState: null };
}

export function moveCursorRight(state: EditorState): EditorState {
  const flat = flatOffset(state.segments, state.cursor);
  const total = state.segments.reduce((sum, s) => sum + segLen(s), 0);
  if (flat >= total) return state;
  return { ...state, cursor: cursorFromFlat(state.segments, flat + 1), completionState: null };
}

export function moveCursorHome(state: EditorState): EditorState {
  return { ...state, cursor: { seg: 0, off: 0 }, completionState: null };
}

export function moveCursorEnd(state: EditorState): EditorState {
  const total = state.segments.reduce((sum, s) => sum + segLen(s), 0);
  return { ...state, cursor: cursorFromFlat(state.segments, total), completionState: null };
}

// ── Line editing shortcuts ─────────────────────────────────────────────────

/** Ctrl-U: clear entire line. */
export function clearLine(_state: EditorState): EditorState {
  return createEmpty();
}

/** Ctrl-W: delete word backward. */
export function deleteWordBackward(state: EditorState): EditorState {
  const textBefore = getTextBeforeCursor(state);
  if (textBefore.length === 0) return state;

  // Skip trailing whitespace, then delete back to next whitespace
  const end = textBefore.length;
  let i = end - 1;
  while (i >= 0 && textBefore[i] === ' ') i--;
  while (i >= 0 && textBefore[i] !== ' ') i--;
  const charsToDelete = end - (i + 1);

  let s = state;
  for (let d = 0; d < charsToDelete; d++) {
    s = deleteBackward(s);
  }
  return s;
}

// ── Serialization ──────────────────────────────────────────────────────────

/** Expand all segments to plain text (paste pills expanded to real content). */
export function serialize(state: EditorState): string {
  return state.segments.map(s => s.kind === 'text' ? s.text : s.text).join('');
}

/** Label for a paste pill. */
export function pillLabel(seg: PasteSegment): string {
  if (seg.lineCount > 1) return `[Pasted ${seg.lineCount} lines]`;
  return `[Pasted ${seg.text.length} chars]`;
}

/** Return display-ready segments (pills shown as labels). */
export function displaySegments(state: EditorState): DisplaySegment[] {
  return state.segments
    .filter(s => s.kind === 'paste' || (s.kind === 'text' && s.text.length > 0))
    .map(s => {
      if (s.kind === 'paste') {
        return { text: pillLabel(s), isPill: true };
      }
      return { text: s.text, isPill: false };
    });
}

/** Get serialized text from start up to cursor position. */
export function getTextBeforeCursor(state: EditorState): string {
  const { seg, off } = state.cursor;
  let result = '';
  for (let i = 0; i < seg; i++) {
    result += state.segments[i].kind === 'text' ? state.segments[i].text : (state.segments[i] as PasteSegment).text;
  }
  if (seg < state.segments.length) {
    const cur = state.segments[seg];
    if (cur.kind === 'text') {
      result += cur.text.slice(0, off);
    } else if (off > 0) {
      result += cur.text;
    }
  }
  return result;
}

/** Extract current token at cursor (word boundary = whitespace). */
export function getTokenAtCursor(state: EditorState): { token: string; start: number } {
  const before = getTextBeforeCursor(state);
  const match = before.match(/(\S+)$/);
  if (!match) return { token: '', start: before.length };
  return { token: match[1], start: before.length - match[1].length };
}

/** Get the flat cursor offset. */
export function getCursorOffset(state: EditorState): number {
  return flatOffset(state.segments, state.cursor);
}

/** Total display length (pills count as their label length). */
export function displayLength(state: EditorState): number {
  return state.segments.reduce((sum, s) => {
    if (s.kind === 'text') return sum + s.text.length;
    return sum + pillLabel(s).length;
  }, 0);
}

/** Cursor position in display coordinates. */
export function displayCursorOffset(state: EditorState): number {
  const { seg, off } = state.cursor;
  let pos = 0;
  for (let i = 0; i < seg; i++) {
    const s = state.segments[i];
    if (s.kind === 'text') pos += s.text.length;
    else pos += pillLabel(s).length;
  }
  if (seg < state.segments.length) {
    const cur = state.segments[seg];
    if (cur.kind === 'text') {
      pos += off;
    } else if (off > 0) {
      pos += `[Pasted ${cur.lineCount} lines]`.length;
    }
  }
  return pos;
}
