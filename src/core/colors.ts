const nc = 'NO_COLOR' in process.env || !process.stderr.isTTY;
export const C = nc
  ? { reset: '', dim: '', cyan: '', green: '', red: '', bold: '', yellow: '' }
  : { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m', yellow: '\x1b[33m' };

/** Render basic markdown as ANSI-styled text */
export function renderMarkdown(text: string): string {
  if (nc) return text;
  const R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m', IT = '\x1b[3m', CY = '\x1b[36m';

  // Code blocks: dim the content, leave language hint out
  text = text.replace(/```\w*\n([\s\S]*?)```/g, (_m, code) => `${D}${code.trimEnd()}${R}`);

  return text.split('\n').map(line => {
    // Headers
    if (/^#{1,3}\s/.test(line)) return `${B}${CY}${line.replace(/^#+\s*/, '')}${R}`;
    // Bullet lists: color the dash/star
    if (/^(\s*)[*-]\s/.test(line)) line = line.replace(/^(\s*)[*-]/, `$1${CY}·${R}`);
    // Numbered lists: color the number
    if (/^\s*\d+\.\s/.test(line)) line = line.replace(/^(\s*)(\d+\.)/, `$1${CY}$2${R}`);
    // Inline code (before bold/italic to avoid conflicts)
    line = line.replace(/`([^`]+)`/g, `${CY}$1${R}`);
    // Bold
    line = line.replace(/\*\*([^*]+)\*\*/g, `${B}$1${R}`);
    // Italic (single * or _)
    line = line.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${IT}$1${R}`);
    line = line.replace(/(?<!_)_([^_]+)_(?!_)/g, `${IT}$1${R}`);
    // Links: [text](url) → text (dim url)
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${B}$1${R} ${D}($2)${R}`);
    // Horizontal rules
    if (/^-{3,}$/.test(line.trim())) return `${D}${'─'.repeat(40)}${R}`;
    return line;
  }).join('\n');
}
