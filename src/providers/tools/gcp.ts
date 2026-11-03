import type { ToolOperation } from '../../runtime/tools.js';
import { nameSchema, operationSchema, providerJson } from './http.js';

/** Bounded Compute operations; no caller-selected URL, headers, method, or raw credential. */
export function gcpCompute(options: { fetch?: typeof fetch } = {}) {
  const make = (id: string, method: string, instance: boolean): ToolOperation => ({
    provider: 'gcp', id, description: id,
    resourceFields: instance ? ['project', 'zone', 'instance'] : ['project', 'zone'],
    inputSchema: operationSchema({ project: nameSchema, zone: nameSchema, ...(instance ? { instance: nameSchema } : {}) }),
    execute: (input, credential, context) => {
      const path = `/compute/v1/projects/${encodeURIComponent(String(input.project))}/zones/${encodeURIComponent(String(input.zone))}/instances` +
        (instance ? `/${encodeURIComponent(String(input.instance))}` : '');
      return providerJson(new URL(path, 'https://compute.googleapis.com'), credential, context, { ...options, method });
    },
  });
  return {
    listInstances: make('compute.instances.list', 'GET', false),
    getInstance: make('compute.instances.get', 'GET', true),
    deleteInstance: make('compute.instances.delete', 'DELETE', true),
  };
}
