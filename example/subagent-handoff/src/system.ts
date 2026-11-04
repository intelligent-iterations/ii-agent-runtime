import { createGrant, type InvocationAnalysis, type InvocationCatalog, type InvocationScalar,
  type ToolDefinition } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { HANDOFF_EVENT } from './workspace.js';

export const PLANNER = 'planner';
export const CODER = 'coder';
export const TASK_EVENT = 'subagent-handoff.task.submitted';

const chunks = <T>(values: readonly T[]) => Array.from({ length: Math.ceil(values.length / 256) }, (_, index) => values.slice(index * 256, index * 256 + 256));

export interface SystemOptions {
  name: string;
  files: readonly string[];
  testScript: string;
  /** Exact files the coder may ever write. Omitted means every project file (the broad setup). */
  coderWritablePaths?: readonly string[];
}

/** One declaration drives grants, the advisory analysis and the actual event routing. */
export function describeSystem(tools: ReadonlyMap<string, ToolDefinition>, options: SystemOptions) {
  const tool = (name: string) => tools.get(name)!;
  const project = { project: [options.name] };
  const writable = options.coderWritablePaths ?? options.files;
  const unknown = writable.filter(path => !options.files.includes(path));
  if (!writable.length || unknown.length) throw Error(`coderWritablePaths must name existing project files${unknown.length ? `: ${unknown.join(', ')}` : ''}`);
  const reading = (subject: string) => [
    createGrant({ subject, tool: tool('list-files'), resources: project }),
    ...chunks(options.files).map(path => createGrant({ subject, tool: tool('read-file'), resources: { ...project, path } })),
    createGrant({ subject, tool: tool('run-script'), resources: project, arguments: { script: [options.testScript] } }),
  ];
  const grants = {
    [PLANNER]: [...reading(PLANNER), createGrant({ subject: PLANNER, tool: tool('handoff-to-coder'), resources: project })],
    [CODER]: [...reading(CODER), ...chunks(writable).map(path => createGrant({ subject: CODER, tool: tool('write-file'), resources: { ...project, path } }))],
  };
  const catalog: InvocationCatalog = {
    agents: [
      { id: PLANNER, invokers: [{ id: 'developer-task', event: TASK_EVENT, match: project }] },
      { id: CODER, invokers: [{ id: 'planner-handoff', event: HANDOFF_EVENT, match: project }] },
    ],
    tools: [...tools.keys()].map(name => ({ name, effects: name === 'handoff-to-coder'
      ? [{ event: HANDOFF_EVENT, fields: { project: { input: 'project' } } }] : [] })),
    grants: [...grants[PLANNER], ...grants[CODER]].map(({ subject, tool, resources, arguments: args }) => ({ subject, tool, resources, arguments: args })),
  };
  return { grants, catalog, writable: [...writable] };
}

/** The supervisor activates exactly the agents whose declared invokers match an event. */
export function route(catalog: InvocationCatalog, event: string, fields: Readonly<Record<string, InvocationScalar>>): string[] {
  return catalog.agents.filter(agent => agent.invokers.some(invoker => invoker.event === event &&
    Object.entries(invoker.match).every(([key, values]) => Object.hasOwn(fields, key) && values.includes(fields[key]!)))).map(agent => agent.id);
}

/** Test folders plus `node --test`, Jest and Vitest default file patterns (`*.test.js`, `*_test.js`, `test-*.js`, `test.js`). */
export const testFile = /(^|\/)(test|tests|__tests__|__snapshots__)\/|[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)test(-[^/]*)?\.[cm]?[jt]sx?$/;
/** Files that decide what the test script runs: package manifests, lockfiles, tool configs, Makefile, Dockerfile. */
export const buildControl = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig[^/]*\.json|[^/]+\.config\.[cm]?[jt]s|Makefile|Dockerfile)$/;

/** Summarize the runtime analysis: which authority the planner can reach through the coder. */
export function summarize(analysis: InvocationAnalysis, from = PLANNER) {
  const warnings = analysis.warnings.filter(warning => warning.caller === from);
  const values = (tool: string, field: 'resources' | 'arguments', key: string) => [...new Set(warnings
    .filter(warning => warning.capability.tool === tool).flatMap(warning => warning.capability[field][key] ?? []).map(String))].sort();
  const writes = values('write-file', 'resources', 'path');
  const direct = analysis.directGrants.filter(grant => grant.subject === from && grant.tool === 'write-file');
  const notes: string[] = [];
  if (writes.some(path => buildControl.test(path))) notes.push('includes build/CI control files: with run-script, the coder could change what the test command executes');
  if (writes.some(path => testFile.test(path))) notes.push('includes test files: the coder could weaken a test instead of fixing the code');
  return {
    message: warnings.find(warning => warning.capability.tool === 'write-file')?.message,
    statuses: [...new Set(warnings.map(warning => warning.status))],
    directWrites: direct.length,
    reachableWrites: writes,
    reachableScripts: values('run-script', 'arguments', 'script'),
    notes,
  };
}
