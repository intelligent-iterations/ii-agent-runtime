import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from '@intelligent-iterations/ii-agent-runtime/pipeline';

export async function loadWorkerFiles(worker: Worker) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-logging-payload-'));
  try {
    for (const name of ['package.json', 'package-lock.json', 'run.mjs', 'mcp.mjs', 'probe.mjs'])
      copyFileSync(new URL(`../worker/${name}`, import.meta.url), join(directory, name));
    await worker.load(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
