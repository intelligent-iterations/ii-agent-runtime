import { readFileSync } from 'node:fs';
import { captureGuestFiles, executeLibvirtGuest, executeTartGuest, loadDeployment, loadLibvirtDeployment,
  type CaptureOptions, type CapturedFile } from '@intelligent-iterations/ii-agent-runtime';

function provider(path: string): 'tart' | 'libvirt' {
  const value = JSON.parse(readFileSync(path, 'utf8')) as { setup?: { deployment?: { provider?: unknown } } };
  if (value.setup?.deployment?.provider === 'tart') { loadDeployment(path); return 'tart'; }
  if (value.setup?.deployment?.provider === 'libvirt') { loadLibvirtDeployment(path); return 'libvirt'; }
  throw Error('Unsupported guest provider');
}

export function executeGuest(path: string, command: string[], input?: string | Uint8Array): Promise<string> {
  return provider(path) === 'tart' ? executeTartGuest(path, command, input) : executeLibvirtGuest(path, command, input);
}

export function captureFiles(path: string, options: CaptureOptions): Promise<CapturedFile[]> {
  return captureGuestFiles(path, options, executeGuest);
}
