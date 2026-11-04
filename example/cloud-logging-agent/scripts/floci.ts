// Shared by `npm run demo` and `npm run test:emulator`: start, seed and remove the upstream floci-gcp emulator.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { LogEntry } from '../src/cloud-logging.js';

/** Independent upstream emulator, the same immutable image the runtime's GCP proof pins. Nothing here emulates Logging itself. */
export const FLOCI_IMAGE = 'floci/floci-gcp@sha256:eae9683d806ceb643bcb36aee97cdb8cad13c3e2959cd053bf40e481994fde12';

export const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface Floci {
  name: string;
  /** Set by start(), for example http://127.0.0.1:55012. */
  endpoint: string;
  /** Run the container and wait until it answers. Call remove() afterwards, also on failure or interruption. */
  start(): Promise<void>;
  /** POST to the emulator's Logging v2 API, for example `entries:write`. */
  api(path: string, body: unknown): Promise<any>;
  /** Remove the container and its anonymous volume and verify both are gone. Safe at any time, and twice. */
  remove(): void;
}

/** The handle exists before the container does, so a signal handler can always remove it. */
export function createFloci(prefix: string): Floci {
  const name = `${prefix}-${randomUUID()}`;
  let volumes: string[] = [], removed = false, attempted = false;
  const floci: Floci = {
    name, endpoint: '',
    async start() {
      attempted = true;
      docker('run', '--detach', '--rm', '--name', name, '--memory', '512m', '--publish', '127.0.0.1::4588', FLOCI_IMAGE);
      volumes = docker('inspect', '--format', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}', name).split(' ').filter(Boolean);
      const endpoint = `http://${docker('port', name, '4588/tcp').split('\n')[0]}`;
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw Error(`Unexpected emulator endpoint ${endpoint}`);
      const until = Date.now() + 30000;
      while (!(await fetch(endpoint).then(() => true, () => false))) {
        if (Date.now() > until) throw Error('Emulator did not become ready');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      floci.endpoint = endpoint;
    },
    async api(path, body) {
      const response = await fetch(`${floci.endpoint}/v2/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw Error(`Emulator ${path}: HTTP ${response.status}`);
      return response.json();
    },
    remove() {
      if (removed || !attempted) return;
      // The image declares VOLUME /app/data: remove the anonymous volume with the container.
      try { docker('rm', '--force', '--volumes', name); } catch { /* never created, gone, or already being removed; verified below */ }
      // An interrupted `docker run --rm` can leave removal in progress for a moment: wait for it rather than guess.
      const gone = (args: string[], failure: string) => {
        for (const until = Date.now() + 30000; docker(...args);) {
          if (Date.now() > until) throw Error(failure);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
      };
      gone(['ps', '--all', '--quiet', '--filter', `name=^/${name}$`], `Emulator cleanup failed; run: docker rm -f -v ${name}`);
      for (const volume of volumes)
        gone(['volume', 'ls', '--quiet', '--filter', `name=^${volume}$`], `Emulator volume cleanup failed; run: docker volume rm ${volume}`);
      removed = true;
    },
  };
  return floci;
}

export type Resource = NonNullable<LogEntry['resource']>;
export const cloudFunction = (name: string, project: string): Resource =>
  ({ type: 'cloud_function', labels: { function_name: name, region: 'us-central1', project_id: project } });
export const cloudRunService = (name: string, project: string): Resource =>
  ({ type: 'cloud_run_revision', labels: { service_name: name, revision_name: `${name}-00042-xuv`, configuration_name: name,
    location: 'us-central1', project_id: project } });
