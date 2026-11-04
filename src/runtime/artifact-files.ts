import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function requireDirectory(directory: string): string {
  const absolute = resolve(directory);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute || stat.uid !== process.getuid?.()) throw Error('Unsafe artifact directory');
  return absolute;
}
export function readBounded(path: string, maximum: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > maximum || stat.size < 1) throw Error('Invalid artifact file');
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const received = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (received === 0) break;
      size += received;
    }
    const content = buffer.subarray(0, size);
    if (content.length !== stat.size || content.length > maximum) throw Error('Artifact changed during read');
    return content;
  } finally { closeSync(descriptor); }
}
