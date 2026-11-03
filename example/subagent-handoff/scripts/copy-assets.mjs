import { cpSync } from 'node:fs';
// The compiled CLI resolves ../worker and ../sample relative to dist/src.
cpSync('worker', 'dist/worker', { recursive: true });
cpSync('sample', 'dist/sample', { recursive: true });
