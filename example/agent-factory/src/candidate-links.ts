import { posix } from 'node:path';

/** Only links resolving through candidate entries to a regular file are supported. */
export function validateCandidateLinks(entries: ReadonlyMap<string, string | null>): void {
  for (const [path, target] of entries) {
    if (target === null) continue;
    const seen = new Set<string>(); let current = path;
    while (true) {
      if (seen.has(current) || seen.size >= 40) throw Error('Candidate link cycle or depth limit');
      seen.add(current);
      if (!entries.has(current)) throw Error('Candidate link target is missing or not a file');
      const value = entries.get(current)!;
      if (value === null) break;
      if (!value || Buffer.byteLength(value) > 4096 || posix.isAbsolute(value) || /[\\\u0000]/.test(value) ||
          value.split('/').some(part => part.toLowerCase() === '.git')) throw Error('Unsafe candidate link target');
      const next = posix.normalize(posix.join(posix.dirname(current), value));
      if (next === '..' || next.startsWith('../') || next === '.' || next.split('/').some(part => part.toLowerCase() === '.git')) throw Error('Candidate link escapes repository');
      current = next;
    }
  }
}
