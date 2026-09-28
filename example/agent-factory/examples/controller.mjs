import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { configureGitHubFactory, createCodeAcceptance, validateAcceptanceChecks, checkCodeInstallation, loadAgentManifest, prepareSourceBundles, appAuthenticatedFetch, openFactoryApp, createHostPublisher } from '@intelligent-iterations/agent-factory-example';
import { setupDigest, canonicalJson } from '@intelligent-iterations/ii-agent-runtime';

// Keep this trusted configuration outside the agent's workspace.
const location = new URL('./installation.json', import.meta.url);
const installation = JSON.parse(readFileSync(location, 'utf8'));
const base = dirname(fileURLToPath(location));
const path = value => resolve(base, value);
if (!installation.appConfigPath) throw Error('Installation has no protected App configuration');
const appHandle = openFactoryApp(installation.appConfigPath, path(installation.directory));
if (typeof installation.agentsManifest !== 'string') throw Error('Installation requires a prepared agent manifest; run the wizard and launcher');
const manifest = loadAgentManifest(path(installation.agentsManifest), {
  workflowRepository: installation.repository, baseSetup: installation.roles.code.setup,
});
const sourceBundles = prepareSourceBundles(manifest, path(installation.directory + '/sources'));
const activeAgentTokens = new Map();
if (sourceBundles.size !== manifest.agents.length) throw Error('Every YAML agent needs a trusted local checkout for independent acceptance');
const manifestAgents = new Map(manifest.agents.map(agent => [agent.name, agent]));
const roles = structuredClone(manifest.roles);
if (Object.values(roles).some(role => role.kind !== 'code')) throw Error('New factory agents must use a coding role');
const configuredRoles = Object.values(roles);
for (const agent of manifest.agents) validateAcceptanceChecks(installation.acceptanceChecksByAgent?.[agent.name] ?? []);
const approved = new Set(configuredRoles.map(role => setupDigest(role.setup)));
function verificationSetupFor(role) {
  return { ...installation.verificationSetup, deployment: role.setup.deployment };
}
for (const role of configuredRoles) approved.add(setupDigest(verificationSetupFor(role)));
function sourceFor(context) {
  const input = JSON.parse(context.task.input);
  const agent = manifestAgents.get(input.role.setup.id);
  if (!agent || input.repository !== agent.request.repository || input.baseCommit !== agent.request.baseCommit) throw Error('Task differs from its approved YAML source');
  const source = sourceBundles.get(agent.name);
  if (!source) throw Error('Trusted source bundle missing');
  return source;
}
const workflows = {};
for (const role of configuredRoles) {
  const digest = setupDigest(role.setup);
  const workflow = installation.workerWorkflow;
  if (!workflow || !Number.isSafeInteger(workflow.id) || workflow.id < 1 || typeof workflow.ref !== 'string' || !workflow.ref.trim() ||
      typeof workflow.commit !== 'string' || !/^[a-f0-9]{40}$/.test(workflow.commit)) throw Error('Each role needs an approved workflow binding');
  if (workflows[digest] && canonicalJson(workflows[digest]) !== canonicalJson(workflow)) throw Error('Conflicting workflow bindings for one setup');
  workflows[digest] = workflow;
}
const configured = configureGitHubFactory({
  sourceBundle: async context => sourceFor(context),
  project: installation.project, directory: path(installation.directory),
  repository: installation.repository,
  roles, workflows,
  ...(installation.runner ? { runner: installation.runner } : {}),
  binaries: { ...installation.binaries, node: process.execPath },
  coordination: { maxAgents: manifest.maxConcurrentAgents },
  authenticatedFetch: appAuthenticatedFetch(appHandle.app, installation.repository),
  publish: createHostPublisher({ app: appHandle.app, baseBundle: async context => sourceFor(context) }),
  agentGrant: async context => {
    const input = JSON.parse(context.task.input);
    const permissions = input.role.githubPermissions ?? {};
    if (!Object.keys(permissions).length) return null;
    const grant = await appHandle.app.issue({ repository: input.repository, permissions,
      purpose: 'agent-api', recipient: `agent:${context.attemptId}`, attemptId: context.attemptId });
    activeAgentTokens.set(context.attemptId, grant);
    context.checkpoint('agentGrantId', grant.grantId);
    return { token: grant.token, delivered() {
      appHandle.ledger.append({ eventId: `${grant.grantId}:delivered`, grantId: grant.grantId,
        kind: 'delivered', at: new Date().toISOString() });
    } };
  },
  endAgentGrant: async context => {
    const grant = activeAgentTokens.get(context.attemptId);
    if (!grant) return;
    await appHandle.app.revoke(grant.grantId, grant.token);
    activeAgentTokens.delete(context.attemptId);
  },
  subject: 'configured-installation',
  authorize: async (_subject, setup) => ({ status: approved.has(setupDigest(setup)) ? 'verified' : 'denied', evidenceId: 'installation-approved-setup' }),
  billing: installation.billing,
  acceptance: ({ verificationRoot, verificationOutputs, ...infrastructure }) => {
    const code = createCodeAcceptance({
    ...infrastructure, root: verificationRoot, outputRoot: verificationOutputs,
    setup: installation.verificationSetup, workflow: installation.verificationWorkflow,
    setupFor: context => verificationSetupFor(JSON.parse(context.task.input).role),
    baseBundle: async context => sourceFor(context),
    policy: async context => structuredClone(installation.acceptanceChecksByAgent[JSON.parse(context.task.input).role.setup.id]),
    });
    return {
      verify: (context, retained) => {
        return code.verify(context, retained);
      },
      recoverVerification: async context => {
        await code.recoverVerification(context);
      },
    };
  },
});
export async function preflight() {
  for (const agent of manifest.agents) {
    appHandle.app.policy(agent.request.repository, { contents: 'read' });
    appHandle.app.policy(agent.request.repository, { contents: 'write' });
    if (Object.keys(manifest.roles[agent.name].githubPermissions ?? {}).length)
      appHandle.app.policy(agent.request.repository, manifest.roles[agent.name].githubPermissions);
    await appHandle.app.withToken({ repository: agent.request.repository, permissions: { contents: 'read' },
      purpose: 'preflight', recipient: 'host:preflight' }, async () => undefined);
  }
  return Promise.all(manifest.agents.map(agent => checkCodeInstallation({
    repository: installation.repository, transport: configured.options.transport, checks: configured.options.checks,
    verificationSetup: verificationSetupFor(manifest.roles[agent.name]), verificationWorkflow: installation.verificationWorkflow,
    source: { repository: agent.request.repository, commit: agent.request.baseCommit, ...sourceBundles.get(agent.name), bundle: sourceBundles.get(agent.name).path },
  })));
}

export const client = configured.client;
export const dispose = () => { configured.dispose(); appHandle.close(); };
export default configured.options;
