import { GoogleAuth } from 'google-auth-library';
import { admitToolSession, createToolSession, preflightTools, type ToolCredential, type ToolOperation } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { openWorkerGateway } from '@intelligent-iterations/ii-agent-runtime/tools';
import { cloudLoggingGrant, cloudLoggingOperation, cloudLoggingTool, SUBJECT, type ResourceType } from './cloud-logging.js';

export const LOGGING_READ_SCOPE = 'https://www.googleapis.com/auth/logging.read';

interface TokenClient { getAccessToken(): Promise<{ token?: string | null }>; credentials?: { expiry_date?: number | null } }

/**
 * Application Default Credentials on the trusted host only: GOOGLE_APPLICATION_CREDENTIALS (service-account key or
 * workload identity federation config), `gcloud auth application-default login`, or an attached service account.
 * The read-only Logging scope is requested; the agent never receives this token.
 */
export function gcpCredentials(auth: { getClient(): Promise<unknown> } = new GoogleAuth({ scopes: [LOGGING_READ_SCOPE] }), retryDelayMs = 1500) {
  const resolve = async (): Promise<ToolCredential> => {
    const client = await auth.getClient() as TokenClient;
    const { token } = await client.getAccessToken();
    if (!token) throw Error('Application Default Credentials returned no access token');
    const expiry = client.credentials?.expiry_date;
    return { values: { accessToken: token }, expiresAt: typeof expiry === 'number' ? expiry : Date.now() + 300000 };
  };
  // Keyless (workload identity federation) sign-in was seen to fail once with a transient Google error and then
  // succeed. Try once more before reporting; a real configuration problem fails both times.
  return async (): Promise<ToolCredential> => {
    try { return await resolve(); } catch {
      await new Promise(done => setTimeout(done, retryDelayMs));
      return resolve();
    }
  };
}

/** One line for the trusted host's terminal: no control characters, nothing token- or key-shaped, at most 200 characters. */
export function hostLine(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/-----BEGIN[^]*?(?:-----END[^-]*-----|$)/g, '[redacted]')
    .replace(/(?:ya29\.|1\/\/|eyJ|GOCSPX-)[\w./+=-]*/g, '[redacted]')
    .replace(/[A-Za-z0-9_+/=-]{48,}/g, '[redacted]').trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

function credentialReason(error: unknown): string {
  // JSON parser messages quote the input, which here is a credential file. Never show that text.
  if (error instanceof SyntaxError) return 'Google credentials unavailable: the credential file is not valid JSON';
  return `Google credentials unavailable: ${error instanceof Error ? error.message : 'unknown error'}`;
}

function operationReason(error: unknown): string {
  if (error instanceof SyntaxError) return 'Cloud Logging returned a response that is not JSON';
  if (!(error instanceof Error)) return 'Cloud Logging request failed';
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'Cloud Logging request interrupted (deadline or cancellation)';
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  if (error instanceof TypeError && cause)
    return `Cloud Logging endpoint unreachable (${typeof cause.code === 'string' ? cause.code : String(cause.message ?? 'network error')})`;
  return error.message.startsWith('Cloud Logging') ? error.message : `Cloud Logging read not attempted: ${error.message}`;
}

export async function startGateway(options: { project: string; resourceType: ResourceType; resource: string; address: string;
  signal: AbortSignal; deadlineMs: number; resolveCredential: () => Promise<ToolCredential>; logView?: string;
  /** Defaults to the global fetch, which calls Google. Tests inject one that redirects to an emulator. */
  fetch?: typeof fetch;
  model: { respond(input: unknown): Promise<Response> };
  /** Trusted-host diagnostics (default: stderr). The agent only ever receives the gateway's sanitized HTTP status. */
  hostLog?: (line: string) => void }) {
  const hostLog = options.hostLog ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const operation = cloudLoggingOperation(options);
  const reported: ToolOperation = { ...operation, async execute(input, credential, context) {
    try { return await operation.execute(input, credential, context); } catch (error) { hostLog(hostLine(operationReason(error))); throw error; }
  } };
  const tool = cloudLoggingTool(options, reported);
  const session = createToolSession({ subject: SUBJECT, tools: [tool], grants: [cloudLoggingGrant(tool, options.project, options.resource)],
    context: { executionId: 'cloud-logging', attemptId: '1', inputDigest: 'cloud-logging-query', deadlineMs: options.deadlineMs, signal: options.signal },
    resolveCredential: async () => {
      try { return await options.resolveCredential(); } catch (error) { hostLog(hostLine(credentialReason(error))); throw error; }
    } });
  // This custom read adapter has no provider IAM/escalation inspector. Keep that absence explicit.
  // Admission policy is the consumer's: unknown provider coverage is advisory here; grants remain mandatory.
  const report = await preflightTools(session, { inspectors: [], signal: options.signal });
  admitToolSession(session, report, []);
  const gateway = await openWorkerGateway({ address: options.address, grants: [], tools: session, model: options.model, signal: options.signal });
  return { ...gateway, report };
}
