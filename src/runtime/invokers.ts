import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { canonicalJson } from './data.js';

export type InvocationScalar = string | number | boolean;
export type InvocationConstraints = Readonly<Record<string, readonly InvocationScalar[]>>;
/** Application-owned declaration, not a verified or enforced activation rule. */
export interface Invoker {
  id: string;
  event: string;
  match: InvocationConstraints;
  /** Opaque requirements such as approval or an admission policy; never assumed satisfied. */
  conditions?: readonly string[];
}
export interface InvocationToolEffect {
  event: string;
  /** Event fields are fixed values or copied from a named scalar tool input. */
  fields: Readonly<Record<string, { input: string } | { values: readonly InvocationScalar[] }>>;
}
export interface InvocationTool { name: string; effects?: readonly InvocationToolEffect[] }
/** Analysis metadata only. This does not create or enforce an executable grant. */
export interface InvocationGrant {
  subject: string;
  tool: string;
  resources: InvocationConstraints;
  arguments: InvocationConstraints;
  conditions?: readonly string[];
}
export interface InvocationCatalog {
  agents: readonly { id: string; invokers: readonly Invoker[] }[];
  tools: readonly InvocationTool[];
  grants: readonly InvocationGrant[];
}
export interface InvocationEdge {
  caller: string;
  callee: string;
  tool: string;
  grantIndex: number;
  invoker: string;
  event: string;
  status: 'declared' | 'conditional' | 'unknown';
  conditions: readonly string[];
  unknownFields: readonly string[];
}
export interface InvocationWarning {
  caller: string;
  callee: string;
  path: readonly InvocationEdge[];
  capability: InvocationGrant;
  status: InvocationEdge['status'];
  conditions: readonly string[];
  message: string;
}
export interface InvocationAnalysis {
  basis: 'user-declared';
  exhaustive: false;
  truncated: boolean;
  directGrants: readonly InvocationGrant[];
  edges: InvocationEdge[];
  warnings: InvocationWarning[];
  unknownEffects: { subject: string; tool: string }[];
}
const schema = JSON.parse(readFileSync(new URL('../../schemas/invocation-catalog.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile<InvocationCatalog>(schema);
const unique = (values: readonly string[]) => [...new Set(values)];
const status = (edges: readonly InvocationEdge[], conditions: readonly string[]): InvocationEdge['status'] =>
  edges.some(edge => edge.status === 'unknown') ? 'unknown' : conditions.length ? 'conditional' : 'declared';

/** Pure, offline advisory analysis. Never resolves credentials, starts Runs or changes grants. */
export function analyzeInvocations(input: InvocationCatalog): InvocationAnalysis {
  const catalog: unknown = JSON.parse(canonicalJson(input));
  if (!validate(catalog)) throw new Error(`INVOCATION_SCHEMA:${validate.errors?.[0]?.instancePath}`);
  const agents = new Map(catalog.agents.map(agent => [agent.id, agent]));
  const tools = new Map(catalog.tools.map(tool => [tool.name, tool]));
  if (agents.size !== catalog.agents.length || tools.size !== catalog.tools.length ||
      catalog.agents.some(agent => new Set(agent.invokers.map(invoker => invoker.id)).size !== agent.invokers.length)) {
    throw new Error('INVOCATION_DUPLICATE_ID');
  }
  for (const grant of catalog.grants) {
    if (!agents.has(grant.subject) || !tools.has(grant.tool)) throw new Error('INVOCATION_UNKNOWN_REFERENCE');
    if (Object.keys(grant.resources).some(key => Object.hasOwn(grant.arguments, key))) throw new Error('INVOCATION_AMBIGUOUS_INPUT');
  }
  const report: InvocationAnalysis = { basis: 'user-declared', exhaustive: false, truncated: false,
    directGrants: catalog.grants, edges: [], warnings: [], unknownEffects: [] };
  // Bound graph expansion and output independently of graph cycles or fan-out.
  const limit = 4096;
  for (const [grantIndex, grant] of catalog.grants.entries()) {
    const tool = tools.get(grant.tool)!;
    if (tool.effects === undefined) report.unknownEffects.push({ subject: grant.subject, tool: grant.tool });
    for (const effect of tool.effects ?? []) for (const agent of catalog.agents) for (const invoker of agent.invokers) {
      if (effect.event !== invoker.event) continue;
      const unknownFields: string[] = [];
      let disjoint = false;
      // Input bindings may be reused by several event fields. Intersect all requirements
      // on that input, so individually matching fields cannot imply an impossible call.
      const inputRequirements = new Map<string, readonly InvocationScalar[]>();
      for (const [field, wanted] of Object.entries(invoker.match)) {
        const binding = Object.hasOwn(effect.fields, field) ? effect.fields[field] : undefined;
        if (!binding) { unknownFields.push(field); continue; }
        if ('values' in binding) {
          if (!binding.values.some(value => wanted.includes(value))) disjoint = true;
          continue;
        }
        const declared = Object.hasOwn(grant.resources, binding.input) ? grant.resources[binding.input]
          : Object.hasOwn(grant.arguments, binding.input) ? grant.arguments[binding.input] : undefined;
        const previous = inputRequirements.get(binding.input) ?? declared;
        const intersection = previous ? previous.filter(value => wanted.includes(value)) : wanted;
        inputRequirements.set(binding.input, intersection);
        if (!intersection.length) disjoint = true;
        // Without a finite domain we cannot establish that the tool accepts this value.
        if (!declared) unknownFields.push(field);
      }
      if (disjoint) continue;
      if (report.edges.length === limit) { report.truncated = true; continue; }
      const conditions = unique([...(grant.conditions ?? []), ...(invoker.conditions ?? [])]);
      report.edges.push({ caller: grant.subject, callee: agent.id, tool: tool.name, grantIndex,
        invoker: invoker.id, event: effect.event, conditions, unknownFields,
        status: unknownFields.length ? 'unknown' : conditions.length ? 'conditional' : 'declared' });
    }
  }
  let traversed = 0;
  const walk = (caller: string, current: string, path: InvocationEdge[], visited: Set<string>): void => {
    for (const edge of report.edges.filter(edge => edge.caller === current)) {
      if (++traversed > limit) { report.truncated = true; return; }
      const next = [...path, edge];
      const pathConditions = unique(next.flatMap(item => item.conditions));
      for (const capability of catalog.grants.filter(grant => grant.subject === edge.callee)) {
        if (report.warnings.length === limit) { report.truncated = true; return; }
        const conditions = unique([...pathConditions, ...(capability.conditions ?? [])]);
        report.warnings.push({ caller, callee: edge.callee, path: next, capability,
          conditions, status: status(next, conditions),
          message: `Based on declarations, ${caller} can potentially activate ${edge.callee} via ${next.map(item => item.tool).join(' → ')}; ${capability.tool} is indirectly reachable (${status(next, conditions)}${conditions.length ? `; requires ${conditions.join(", ")}` : ""}).` });
      }
      if (!visited.has(edge.callee)) walk(caller, edge.callee, next, new Set([...visited, edge.callee]));
      if (traversed > limit || report.warnings.length === limit) { report.truncated = true; return; }
    }
  };
  for (const agent of catalog.agents) {
    walk(agent.id, agent.id, [], new Set([agent.id]));
    if (traversed > limit || report.warnings.length === limit) break;
  }
  return report;
}
