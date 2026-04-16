import { Tool } from './types.js';
import type { SkillMeta } from './skills.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type Severity = 'warn' | 'block';

export type PatternCategory =
  | 'direct-injection'
  | 'encoded-payload'
  | 'suspicious-override'
  | 'hidden-content'
  | 'exfiltration';

export interface ScanFinding {
  severity: Severity;
  category: PatternCategory;
  message: string;
  matched: string;
}

export interface ScanResult {
  ok: boolean;
  findings: ScanFinding[];
}

// ── Pattern Definitions ──────────────────────────────────────────────────────

export interface GuardrailPattern {
  pattern: RegExp;
  severity: Severity;
  category: PatternCategory;
  message: string;
  /** If true, skip matches that appear inside fenced/inline code blocks */
  skipInCodeBlocks?: boolean;
}

export const GUARDRAIL_PATTERNS: GuardrailPattern[] = [
  // Direct injection — attempts to override system instructions
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: "ignore previous instructions"' },
  { pattern: /you\s+are\s+now\s+(in\s+)?developer\s+mode/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: "developer mode" activation' },
  { pattern: /system\s+override/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: "system override"' },
  { pattern: /reveal\s+(your\s+)?(system\s+)?prompt/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: prompt exfiltration attempt' },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|rules|guidelines)/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: "disregard previous instructions"' },
  { pattern: /forget\s+(all\s+)?(previous|prior|your)\s+(instructions|rules|guidelines)/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: "forget instructions"' },
  { pattern: /new\s+instructions?\s*:/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: "new instructions" directive' },
  { pattern: /act\s+as\s+(if\s+you\s+are\s+|a\s+)?(unrestricted|jailbroken|unfiltered)/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: jailbreak attempt' },
  { pattern: /do\s+not\s+follow\s+(any\s+)?(your\s+)?(previous|original)\s+(instructions|rules)/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: "do not follow" directive' },
  { pattern: /pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(different|new|unrestricted|unfiltered)/i, severity: 'block', category: 'direct-injection', message: 'prompt injection: identity override' },

  // Suspicious override — language specifically targeting the agent's security/permission system
  { pattern: /\b(always|never|must)\s+(ignore|override|skip|bypass)\s+(permission|security|guard|confirmation|prompt|rule)/i, severity: 'warn', category: 'suspicious-override', message: 'suspicious instruction-like language targeting agent security' },
  { pattern: /\boverride\s+(system\s+prompt|security|permission|guardrail)/i, severity: 'warn', category: 'suspicious-override', message: 'suspicious "override system/security" language' },
  { pattern: /\b(bypass|disable|skip)\s+(permission|security|confirmation|guard)/i, severity: 'warn', category: 'suspicious-override', message: 'suspicious "bypass security" language', skipInCodeBlocks: true },
  { pattern: /\brun\s+without\s+(permission|confirmation|asking)/i, severity: 'warn', category: 'suspicious-override', message: 'suspicious "run without permission" language' },
  { pattern: /\bauto[\s-]?approve\s+(all|every|tool|action|command)/i, severity: 'warn', category: 'suspicious-override', message: 'suspicious "auto-approve" language' },

  // Hidden content — invisible payloads
  { pattern: /<!--[\s\S]*?\b(ignore|override|instruction|disregard|forget|reveal)\b[\s\S]*?-->/i, severity: 'block', category: 'hidden-content', message: 'HTML comment contains suspicious instruction' },
  { pattern: /[\x00-\x08\x0E-\x1F]/, severity: 'block', category: 'hidden-content', message: 'content contains control characters' },

  // Exfiltration — data exfil attempts in descriptions
  { pattern: /\b(fetch|curl|wget|axios)\s*\(/i, severity: 'block', category: 'exfiltration', message: 'description contains network call invocation' },
  { pattern: /https?:\/\/[^\s"')<>]{10,}/i, severity: 'warn', category: 'exfiltration', message: 'description contains URL', skipInCodeBlocks: true },
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i, severity: 'warn', category: 'exfiltration', message: 'description contains email address', skipInCodeBlocks: true },
  { pattern: /\bwebhook\b/i, severity: 'warn', category: 'exfiltration', message: 'description references webhook', skipInCodeBlocks: true },

  // Encoded payload — HTML entities that could hide instructions
  { pattern: /&#x?[0-9a-fA-F]+;.*&#x?[0-9a-fA-F]+;/i, severity: 'warn', category: 'encoded-payload', message: 'content contains HTML entity encoding' },
];

// Zero-width and bidirectional characters
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF\u2060\u200E\u200F\u202A-\u202E]/;

// Base64: 40+ chars from the base64 alphabet, optionally ending with = or ==
const BASE64_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;

// Suspicious tool names
const SUSPICIOUS_TOOL_NAME_RE = /\b(system_override|admin_override|sudo|root_access)\b/i;

// Fenced code block pattern — used to strip code blocks before exfiltration checks
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;

// Inline code pattern
const INLINE_CODE_RE = /`[^`]+`/g;

/** Strip fenced and inline code blocks from content */
export function stripCodeBlocks(content: string): string {
  return content.replace(FENCED_CODE_BLOCK_RE, '').replace(INLINE_CODE_RE, '');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function decodeBase64Safe(str: string): string | null {
  try {
    const buf = Buffer.from(str, 'base64');
    // Reject if it doesn't round-trip (not valid base64)
    if (buf.toString('base64').replace(/=+$/, '') !== str.replace(/=+$/, '')) return null;
    const decoded = buf.toString('utf-8');
    // Reject binary content (contains null bytes)
    if (decoded.includes('\0')) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function hasZeroWidthChars(content: string): boolean {
  return ZERO_WIDTH_RE.test(content);
}

export function mergeResults(...results: ScanResult[]): ScanResult {
  const findings: ScanFinding[] = [];
  for (const r of results) findings.push(...r.findings);
  return { ok: findings.every(f => f.severity !== 'block'), findings };
}

// ── Core Scanning ────────────────────────────────────────────────────────────

export function scanContent(content: string, context: string, _depth = 0): ScanResult {
  if (!content) return { ok: true, findings: [] };

  const findings: ScanFinding[] = [];
  const strippedContent = stripCodeBlocks(content);

  // Run all regex patterns
  for (const { pattern, severity, category, message, skipInCodeBlocks } of GUARDRAIL_PATTERNS) {
    const target = skipInCodeBlocks ? strippedContent : content;
    const match = target.match(pattern);
    if (match) {
      findings.push({ severity, category, message: `${context}: ${message}`, matched: match[0] });
    }
  }

  // Check for zero-width characters
  if (hasZeroWidthChars(content)) {
    findings.push({
      severity: 'block',
      category: 'hidden-content',
      message: `${context}: content contains zero-width or bidirectional characters`,
      matched: content.match(ZERO_WIDTH_RE)![0],
    });
  }

  // Check for base64-encoded payloads (one level of recursion)
  if (_depth === 0) {
    const b64Matches = content.match(BASE64_RE);
    if (b64Matches) {
      for (const b64 of b64Matches) {
        const decoded = decodeBase64Safe(b64);
        if (decoded) {
          const inner = scanContent(decoded, `${context} (decoded base64)`, 1);
          if (!inner.ok) {
            findings.push({
              severity: 'block',
              category: 'encoded-payload',
              message: `${context}: base64-encoded content contains injection`,
              matched: b64.slice(0, 60) + (b64.length > 60 ? '...' : ''),
            });
            findings.push(...inner.findings);
          }
        }
      }
    }
  }

  return { ok: findings.every(f => f.severity !== 'block'), findings };
}

export function scanTool(tool: Tool): ScanResult {
  const name = tool.function.name;
  const results: ScanResult[] = [];

  // Scan tool description
  results.push(scanContent(tool.function.description, `tool "${name}" description`));

  // Scan parameter descriptions
  const props = tool.function.parameters?.properties;
  if (props) {
    for (const [paramName, paramDef] of Object.entries(props)) {
      const desc = (paramDef as { description?: string }).description;
      if (desc) {
        results.push(scanContent(desc, `tool "${name}" param "${paramName}"`));
      }
    }
  }

  // Check for suspicious tool names
  if (SUSPICIOUS_TOOL_NAME_RE.test(name)) {
    const finding: ScanFinding = {
      severity: 'warn',
      category: 'suspicious-override',
      message: `tool "${name}": suspicious tool name`,
      matched: name,
    };
    results.push({ ok: true, findings: [finding] });
  }

  return mergeResults(...results);
}

export function scanSkill(skill: SkillMeta): ScanResult {
  const results: ScanResult[] = [];
  results.push(scanContent(skill.content, `skill "${skill.name}"`));
  results.push(scanContent(skill.description, `skill "${skill.name}" description`));
  return mergeResults(...results);
}
