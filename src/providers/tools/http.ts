import type { ToolContext, ToolCredential, ToolOperation } from '../../runtime/tools.js';

/** Credentials go only to a fixed provider origin. Redirects and response headers never reach the agent. */
export async function providerJson(url: URL, credential: ToolCredential, context: ToolContext,
  options: { method?: string; body?: unknown; fetch?: typeof fetch } = {}): Promise<unknown> {
  const token = credential.values.accessToken;
  if (!token) throw Error('Access token unavailable');
  const response = await (options.fetch ?? fetch)(url, {
    method: options.method ?? 'GET', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, Math.min(30000, context.deadlineMs - Date.now())))]),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) { await response.body?.cancel(); throw Error('Provider request failed'); }
  if (response.status === 204) return { completed: true };
  return readProviderJson(response);
}

export async function readProviderJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Provider response missing');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > 1048576) throw Error('Provider response limit');
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export const nameSchema = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' };
export function operationSchema(properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
export type ToolTransport = Pick<ToolOperation, 'execute'>;
