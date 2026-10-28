import { gatewayTunnel } from './tunnel.js';
import type { TunnelFrame } from './channel.js';
import type { ExecutionTarget, Isolation, Worker, WorkerCommand, WorkerResources } from '../../../pipeline/ports.js';

export const MAX_FRAME_BYTES = 16 * 1048576;
export interface RemoteRequest { id: number; operation: string; value?: any }
export interface RemoteReply { id: number; ok: boolean; value?: unknown }

/** Dispatches worker provisioning, execution, isolation, gateway transport, and cleanup operations. */
export function remoteOperations(target: ExecutionTarget) {
  let worker: Worker | undefined;
  let isolation: Isolation | undefined;
  let closed = false;
  let tunnel: Awaited<ReturnType<typeof gatewayTunnel>> | undefined;
  const active = new AbortController();
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= (async () => {
    closed = true; active.abort();
    try { await isolation?.close(); } finally { try { await tunnel?.close(); } finally { await target.close(); } }
  })();
  return {
    close,
    receive(frame: TunnelFrame) { if (!tunnel) throw Error('Worker tunnel unavailable'); tunnel.receive(frame); },
    async handle(request: RemoteRequest): Promise<RemoteReply> {
      try {
        if (!Number.isSafeInteger(request.id) || request.id < 1 || closed) throw Error('Invalid remote operation');
        let value: unknown;
        if (request.operation === 'provision') {
          if (worker) throw Error('Worker already provisioned');
          const resources = request.value as WorkerResources;
          worker = await target.provision(resources, { signal: active.signal, deadlineMs: Date.now() + resources.timeoutSeconds * 1000 });
          value = { workspace: worker.workspace };
        } else if (request.operation === 'close') {
          await close();
        } else {
          if (!worker) throw Error('Worker unavailable');
          if (request.operation === 'run') {
            const { inputBase64, ...command } = request.value;
            value = await worker.run({ ...command, ...(inputBase64 === undefined ? {} : { input: Buffer.from(inputBase64, 'base64') }), signal: active.signal } as WorkerCommand);
          } else if (request.operation === 'setup') {
            value = await worker.setup(request.value.commands, { timeoutMs: request.value.timeoutMs, signal: active.signal });
          } else if (request.operation === 'isolate') {
            if (isolation) throw Error('Worker already isolated');
            isolation = await worker.isolate(); value = { address: isolation.address };
          } else if (request.operation === 'forward') {
            if (!isolation || tunnel || request.value.address !== isolation.address || !Number.isInteger(request.value.port) || request.value.port < 1 || request.value.port > 65535) throw Error('Invalid isolated tunnel');
            tunnel = await gatewayTunnel(isolation.address, request.value.port, process.stdout);
          } else if (request.operation === 'connect') {
            if (!isolation) throw Error('Worker not isolated');
            await isolation.connect(request.value.port);
          } else if (request.operation === 'seal') {
            await isolation?.close();
          } else throw Error('Unknown remote operation');
        }
        return { id: request.id, ok: true, ...(value === undefined ? {} : { value }) };
      } catch { return { id: request.id, ok: false }; }
    },
  };
}
