import type { ConsumerIdentity } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { githubConsumerNames } from '@intelligent-iterations/ii-agent-runtime/github';

/** The product name people read: in replies, pull requests, the hub workflow's name and the commit author. */
export const PRODUCT_NAME = 'Software Factory';

export type HubLayoutName = 'current' | 'legacy';
/**
 * The durable names a hub was created with. The consumer identity's name derives the hub workflow path, the admission
 * ledger, task branches and the commit author's address; the folder holds the manifest and policy; the secrets hold the
 * App key and the runtime deploy key. Renaming any of them would orphan a hub's ledger, workflow or stored keys (an App
 * key cannot be uploaded again), so a hub keeps the layout it was created with. Only the display name follows the
 * product: it is written (commit author name, ledger description) but never looked up.
 */
export interface HubLayout {
  name: HubLayoutName;
  identity: ConsumerIdentity;
  /** The only workflow the hub may hold, and the one the runtime's issue intake accepts runs from. */
  workflowPath: string;
  configurationDirectory: string;
  manifestPath: string;
  policyPath: string;
  manifestKind: string;
  appKeySecret: string;
  runtimeKeySecret: string;
  /** The hub repository a new hub is created as, unless the user names another. */
  defaultHubRepository: string;
}

function layout(name: HubLayoutName, names: { identity: string; directory: string; kind: string; appKeySecret: string; runtimeKeySecret: string }): HubLayout {
  const identity: ConsumerIdentity = { name: names.identity, displayName: PRODUCT_NAME };
  return {
    name, identity, workflowPath: githubConsumerNames(identity).workflowPath, configurationDirectory: names.directory,
    manifestPath: `${names.directory}/hub.json`, policyPath: `${names.directory}/policy.json`, manifestKind: names.kind,
    appKeySecret: names.appKeySecret, runtimeKeySecret: names.runtimeKeySecret, defaultHubRepository: names.identity,
  };
}

/** Every hub created from now on. */
export const CURRENT_LAYOUT = layout('current', { identity: 'software-factory', directory: '.software-factory', kind: 'software-factory-hub',
  appKeySecret: 'SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY', runtimeKeySecret: 'SOFTWARE_FACTORY_RUNTIME_DEPLOY_KEY' });
/**
 * Hubs onboarded under the product's earlier name, recognised by `.agent-factory/hub.json` (kind `agent-factory-hub`).
 * They keep every durable name exactly as they were created; only the display name changes.
 */
export const LEGACY_LAYOUT = layout('legacy', { identity: 'agent-factory', directory: '.agent-factory', kind: 'agent-factory-hub',
  appKeySecret: 'AGENT_FACTORY_GITHUB_PRIVATE_KEY', runtimeKeySecret: 'AGENT_FACTORY_RUNTIME_DEPLOY_KEY' });
export const HUB_LAYOUTS: readonly HubLayout[] = [CURRENT_LAYOUT, LEGACY_LAYOUT];

/** The layout with this name; anything else is refused rather than guessed. */
export function hubLayout(name: unknown): HubLayout {
  const found = HUB_LAYOUTS.find(candidate => candidate.name === name);
  if (!found) throw Error(`Unknown hub layout ${JSON.stringify(String(name)).slice(0, 40)}; expected ${HUB_LAYOUTS.map(entry => entry.name).join(' or ')}`);
  return found;
}

/** Minutes a hub job spends around the agent run: setup, evidence upload and teardown. Reserved and held with each run. */
export const HUB_JOB_OVERHEAD_MINUTES = 5;
