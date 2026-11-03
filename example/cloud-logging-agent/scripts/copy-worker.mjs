import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/worker', { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'run.mjs', 'mcp.mjs', 'probe.mjs']) cpSync(`worker/${file}`, `dist/worker/${file}`);
