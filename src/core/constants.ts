import { join } from 'node:path';
import { homedir } from 'node:os';
import { openSync, readSync, closeSync } from 'node:fs';

export const AG_DIR = join(homedir(), '.ag');

export const DEFAULT_IGNORE = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', '.venv', 'venv',
]);

/** Check if a file is binary by scanning for null bytes in the first 512 bytes. */
export function isBinary(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = readSync(fd, buf, 0, 512, 0);
    closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}
