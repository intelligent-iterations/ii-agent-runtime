import { Ajv, type ValidateFunction } from 'ajv';
import { canonicalJson } from './data.js';
import type { CredentialBinding, CredentialResolutionContext } from './credential-bindings.js';

export type ToolScalar = string | number | boolean;
export type ToolConstraints = Readonly<Record<string, readonly ToolScalar[]>>;
export interface ToolContext extends CredentialResolutionContext { subject: string }
/** Resolved only outside the sandbox. All values are treated as sensitive. */
export interface ToolCredential { values: Readonly<Record<string, string>>; expiresAt: number }
/** Trusted adapter contract, not an assertion supplied by the agent. */
export interface ToolOperation {
  provider: string;
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Top-level input fields that identify the operation's resource scope. */
  resourceFields: readonly string[];
  execute(input: Readonly<Record<string, unknown>>, credential: ToolCredential, context: ToolContext): Promise<unknown>;
}
export interface ToolDefinition {
  readonly name: string;
  readonly provider: string;
  readonly operation: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly resourceFields: readonly string[];
}
export interface ToolGrant {
  readonly subject: string;
  readonly tool: string;
  readonly resources: ToolConstraints;
  readonly arguments: ToolConstraints;
}
export class ToolError extends Error {
  constructor(readonly code: string) { super(code); }
}
const bindings = new WeakMap<ToolDefinition, {
  credential: CredentialBinding; execute: ToolOperation['execute']; validate: ValidateFunction;
}>();
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;
const field = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function onlyKeys(input: object, allowed: readonly string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ToolError('TOOL_UNSUPPORTED_FIELD');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export function toolSnapshot<T>(value: T): T {
  try { return freeze(JSON.parse(canonicalJson(value)) as T); }
  catch { throw new ToolError('TOOL_INVALID_DATA'); }
}
function named(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new ToolError('TOOL_INVALID_NAME');
}

/** Defines one bounded external operation. The returned descriptor contains no key or resolver. */
export function defineTool(input: { name: string; operation: ToolOperation; credential: CredentialBinding }): ToolDefinition {
  named(input.name); named(input.operation.provider); named(input.operation.id);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.name)) throw new ToolError('TOOL_INVALID_NAME');
  const operation = input.operation;
  if (typeof operation.execute !== 'function' || typeof operation.description !== 'string' || operation.description.length > 2048 ||
      operation.inputSchema.type !== 'object' || operation.inputSchema.additionalProperties !== false) throw new ToolError('TOOL_INVALID_OPERATION');
  const schema = toolSnapshot(operation.inputSchema);
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || !Array.isArray(schema.required) || !Array.isArray(operation.resourceFields) ||
      new Set(operation.resourceFields).size !== operation.resourceFields.length ||
      operation.resourceFields.some(key => !field.test(key) || forbidden.has(key) || !Object.hasOwn(properties, key) ||
        !(schema.required as unknown[]).includes(key))) throw new ToolError('TOOL_INVALID_RESOURCES');
  let validate: ValidateFunction;
  try { validate = new Ajv({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false }).compile(schema); }
  catch { throw new ToolError('TOOL_INVALID_SCHEMA'); }
  const credential = toolSnapshot(input.credential);
  onlyKeys(credential, ['provider', 'resource', 'key', 'assignment']);
  for (const value of [credential.provider, credential.resource, credential.key, credential.assignment]) named(value);
  if (credential.provider !== operation.provider) throw new ToolError('TOOL_CREDENTIAL_PROVIDER');
  const tool = toolSnapshot({ name: input.name, provider: operation.provider, operation: operation.id,
    description: operation.description, inputSchema: schema, resourceFields: [...operation.resourceFields] });
  bindings.set(tool, { credential, execute: operation.execute.bind(operation), validate });
  return tool;
}

/** Trusted configuration identity. References only; never resolved values or executor code. */
export function toolCredentialReferences(tools: readonly ToolDefinition[]): readonly CredentialBinding[] {
  return Object.freeze(tools.map(tool => {
    const binding = bindings.get(tool);
    if (!binding) throw new ToolError('TOOL_UNREGISTERED');
    return binding.credential;
  }));
}

function constraints(input: ToolConstraints, allowed: readonly string[]): ToolConstraints {
  const result = toolSnapshot(input);
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new ToolError('TOOL_INVALID_CONSTRAINT');
  for (const [key, values] of Object.entries(result)) {
    if (!allowed.includes(key) || forbidden.has(key) || !Array.isArray(values) || !values.length || values.length > 256 ||
        values.some(value => !['string', 'number', 'boolean'].includes(typeof value) ||
          (typeof value === 'number' && !Number.isFinite(value)) ||
          (typeof value === 'string' && (value.length > 2048 || value.includes('*'))))) throw new ToolError('TOOL_INVALID_CONSTRAINT');
  }
  return result;
}
/** Exact finite sets only. No glob interpretation or implicit resource wildcard. */
export function createGrant(input: { subject: string; tool: ToolDefinition; resources: ToolConstraints; arguments?: ToolConstraints }): ToolGrant {
  onlyKeys(input, ['subject', 'tool', 'resources', 'arguments']);
  named(input.subject);
  if (!bindings.has(input.tool)) throw new ToolError('TOOL_UNREGISTERED');
  const resources = constraints(input.resources, input.tool.resourceFields);
  if (input.tool.resourceFields.some(key => !Object.hasOwn(resources, key))) throw new ToolError('TOOL_MISSING_RESOURCE_CONSTRAINT');
  const argumentFields = Object.keys(input.tool.inputSchema.properties as object).filter(key => !input.tool.resourceFields.includes(key));
  const args = constraints(input.arguments ?? {}, argumentFields);
  return toolSnapshot({ subject: input.subject, tool: input.tool.name, resources, arguments: args });
}

/** Narrow one complete clause; never combine independent grants into a broader cross-product. */
export function narrowGrant(parent: ToolGrant, input: { resources?: ToolConstraints; arguments?: ToolConstraints }): ToolGrant {
  onlyKeys(input, ['resources', 'arguments']);
  const narrow = (outer: ToolConstraints, inner: ToolConstraints) => {
    for (const [key, values] of Object.entries(outer)) {
      if (!inner[key] || inner[key]!.some(value => !values.includes(value))) throw new ToolError('TOOL_GRANT_WIDENING');
    }
  };
  const resources = constraints(input.resources ?? parent.resources, Object.keys(parent.resources));
  const args = constraints(input.arguments ?? parent.arguments, Object.keys(input.arguments ?? parent.arguments));
  narrow(parent.resources, resources); narrow(parent.arguments, args);
  return toolSnapshot({ ...parent, resources, arguments: args });
}

export interface ToolSession {
  readonly subject: string;
  readonly tools: readonly ToolDefinition[];
  readonly grants: readonly ToolGrant[];
  invoke(tool: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
}
/** Call only from the trusted supervisor/gateway. The subject is fixed for the whole session. */
export function createToolSession(options: {
  subject: string; tools: readonly ToolDefinition[]; grants: readonly ToolGrant[];
  context: CredentialResolutionContext;
  resolveCredential(reference: Readonly<CredentialBinding>, context: ToolContext): Promise<ToolCredential>;
}): ToolSession {
  named(options.subject);
  const tools = new Map(options.tools.map(tool => [tool.name, tool]));
  if (tools.size !== options.tools.length || tools.size > 128 || options.tools.some(tool => !bindings.has(tool))) throw new ToolError('TOOL_INVALID_SET');
  const grants = options.grants.map(grant => {
    onlyKeys(grant, ['subject', 'tool', 'resources', 'arguments']);
    const tool = tools.get(grant.tool);
    if (!tool) throw new ToolError('TOOL_UNKNOWN_GRANT');
    return createGrant({ subject: grant.subject, tool, resources: grant.resources, arguments: grant.arguments });
  }).filter(grant => grant.subject === options.subject);
  if (!(options.context.signal instanceof AbortSignal) || !Number.isSafeInteger(options.context.deadlineMs) ||
      options.context.deadlineMs <= Date.now() || options.context.deadlineMs - Date.now() > 2147483647) throw new ToolError('TOOL_INTERRUPTED');
  const context = Object.freeze({ ...options.context, subject: options.subject,
    signal: AbortSignal.any([options.context.signal, AbortSignal.timeout(Math.max(1, options.context.deadlineMs - Date.now()))]) });
  const resolveCredential = options.resolveCredential;
  const interrupted = (signal = context.signal) => {
    if (!(signal instanceof AbortSignal) || signal.aborted || !Number.isSafeInteger(context.deadlineMs) ||
        context.deadlineMs <= Date.now()) throw new ToolError('TOOL_INTERRUPTED');
  };
  interrupted();
  const bounded = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    let onAbort: (() => void) | undefined;
    try {
      if (signal.aborted) throw new ToolError('TOOL_INTERRUPTED');
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        onAbort = () => reject(new ToolError('TOOL_INTERRUPTED'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  };
  return Object.freeze({
    subject: options.subject,
    tools: Object.freeze([...tools.values()].filter(tool => grants.some(grant => grant.tool === tool.name))),
    grants: Object.freeze(grants),
    async invoke(name: string, raw: unknown, signal?: AbortSignal): Promise<unknown> {
      const callContext = Object.freeze({ ...context, signal: signal ? AbortSignal.any([context.signal, signal]) : context.signal });
      interrupted(callContext.signal);
      const tool = tools.get(name);
      const binding = tool && bindings.get(tool);
      if (!tool || !binding) throw new ToolError('TOOL_DENIED');
      const input = toolSnapshot(raw);
      if (!binding.validate(input)) throw new ToolError('TOOL_INVALID_INPUT');
      const args = input as Record<string, unknown>;
      const matches = (clause: ToolConstraints) => Object.entries(clause).every(([key, values]) =>
        Object.hasOwn(args, key) && values.includes(args[key] as ToolScalar));
      if (!grants.some(grant => grant.tool === name && matches(grant.resources) && matches(grant.arguments))) throw new ToolError('TOOL_DENIED');
      // No key resolution or upstream work happens until the complete grant matches.
      try {
        const credential = toolSnapshot(await bounded(() => resolveCredential(binding.credential, callContext), callContext.signal));
        interrupted(callContext.signal);
        if (!credential || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now() ||
            !credential.values || !Object.keys(credential.values).length ||
            Object.values(credential.values).some(value => typeof value !== 'string' || !value)) throw new Error('invalid credential');
        const result = await bounded(() => binding.execute(args, credential, callContext), callContext.signal);
        interrupted(callContext.signal);
        const encoded = canonicalJson(result);
        if (Buffer.byteLength(encoded) > 1048576 || Object.values(credential.values).some(value =>
          encoded.includes(value) || encoded.includes(Buffer.from(value).toString('base64')) ||
          encoded.includes(JSON.stringify(value).slice(1, -1)))) throw new Error('unsafe tool output');
        return toolSnapshot(result);
      } catch { throw new ToolError('TOOL_EXECUTION_FAILED'); }
    },
  });
}
