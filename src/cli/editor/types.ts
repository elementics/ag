// ── Segment types ──────────────────────────────────────────────────────────

export interface TextSegment {
  kind: 'text';
  text: string;
}

export interface PasteSegment {
  kind: 'paste';
  id: number;
  text: string;
  lineCount: number;
}

export type Segment = TextSegment | PasteSegment;

// Cursor position within the segment array.
// For TextSegment: off is a character offset within .text (0..text.length).
// For PasteSegment: off is 0 (before pill) or 1 (after pill).
export interface CursorPos {
  seg: number;
  off: number;
}

export interface EditorState {
  segments: Segment[];
  cursor: CursorPos;
  completionState: CompletionState | null;
  pasteIdCounter: number;
}

// ── Completion types ───────────────────────────────────────────────────────

export interface CompletionCandidate {
  text: string;     // replacement text
  display: string;  // what to show in candidate list
}

export interface CompletionState {
  candidates: CompletionCandidate[];
  commonPrefix: string;
  cycleIndex: number;        // -1 = not cycling, 0..N = cycling
  replacementStart: number;  // char offset in serialized text where replacement begins
  replacementEnd: number;
  showing: boolean;
}

export interface CompletionEngine {
  complete(textBeforeCursor: string): CompletionCandidate[] | Promise<CompletionCandidate[]>;
  invalidateModelCache(): void;
  setSkillSearchCache(results: Array<{ source: string; skillId: string }>): void;
  /** @internal Await the in-flight model fetch (for tests). */
  _waitForModelFetch(): Promise<void>;
}

// ── Footer data (shown while editor is active) ────────────────────────────

export interface FooterData {
  mode: 'plan' | 'auto';
  model: string;
  contextPct: number;
  contextUsed: number;
  contextMax: number;
  currentTokens: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  turn: number;
}

// ── Editor result ──────────────────────────────────────────────────────────

export interface EditorResult {
  text: string;  // fully expanded text (paste pills resolved)
}

// ── Display segment for rendering ──────────────────────────────────────────

export interface DisplaySegment {
  text: string;
  isPill: boolean;
}
