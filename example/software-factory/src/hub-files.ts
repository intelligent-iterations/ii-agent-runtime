import { stringify } from 'yaml';
import { expression, pins, type RuntimeSource } from './workflow-yaml.js';
import { HUB_JOB_OVERHEAD_MINUTES, PRODUCT_NAME, type HubLayout } from './identity.js';

// The App key, runtime deploy key, manifest and policy (the organization's agent policy, without a target; each issue's
// repository is filled in at launch) are named by the hub's layout (see identity.ts). The model key's name is shared.
export const HUB_MODEL_KEY_SECRET = 'OPENAI_API_KEY';
/** Tells the hub launch which layout its workflow was generated for. */
export const HUB_LAYOUT_VARIABLE = 'FACTORY_HUB_LAYOUT';
/** Where the hub job keeps one run's evidence, under the runner's temporary directory. */
export const HUB_ARTIFACT_FOLDER = 'software-factory-artifacts';
export const HUB_FORM_PATH = '.github/ISSUE_TEMPLATE/agent-task.yml';
export const HUB_FORM_CONFIG_PATH = '.github/ISSUE_TEMPLATE/config.yml';

export interface HubManifest {
  schemaVersion: 2;
  /** The layout's manifest kind: a hub's manifest is read only as the layout its workflow names. */
  kind: string;
  organization: string;
  hub: { repository: string; id: number; branch: string };
  app: { id: number; installationId: number };
}
const id = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

export function validateHubManifest(input: unknown, layout: HubLayout): HubManifest {
  const value = input as HubManifest;
  if (!value || value.schemaVersion !== 2 || value.kind !== layout.manifestKind || !/^[a-z0-9][a-z0-9-]*$/.test(value.organization ?? '') ||
    !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/.test(value.hub?.repository ?? '') || value.hub.repository.split('/')[0] !== value.organization ||
    !id(value.hub?.id) || !/^[A-Za-z0-9._][A-Za-z0-9._\/-]{0,99}$/.test(value.hub?.branch ?? '') || value.hub.branch.includes('..') ||
    !id(value.app?.id) || !id(value.app?.installationId)) throw Error('Invalid hub manifest');
  return value;
}

export function createIssueForm(organization: string): string {
  return stringify({
    name: 'Agent task',
    description: `Ask an agent to make a change in one of ${organization}'s repositories.`,
    title: '[agent] ',
    body: [
      { type: 'markdown', attributes: { value: 'The agent works on a task branch in the repository you name and opens a pull request for you to review; it never pushes to an existing branch. You need write access to that repository.' } },
      { type: 'input', id: 'repository', attributes: { label: 'Repository', description: `Name of the ${organization} repository to change`, placeholder: 'my-repository' }, validations: { required: true } },
      { type: 'input', id: 'base', attributes: { label: 'Pull request into', description: 'Branch the agent starts from and opens its pull request against. Leave empty for the repository\'s default branch.', placeholder: 'main' }, validations: { required: false } },
      { type: 'textarea', id: 'task', attributes: { label: 'Task', description: 'What should the agent do? Include how to verify it.' }, validations: { required: true } },
    ],
  }, { lineWidth: 0 });
}

/** Where an owner grants a repository's Actions access to a ghcr.io package. */
export function packageSettings(image: string): string {
  const match = /^ghcr\.io\/([a-z0-9-]+)\/([a-z0-9._-]+?)(?:@sha256:[a-f0-9]{64}|:[A-Za-z0-9._-]+)?$/.exec(image);
  return match ? `https://github.com/orgs/${match[1]}/packages/container/${encodeURIComponent(match[2]!)}/settings` : 'the package settings';
}

/** The hub's workflow: a hub issue event verifies, reserves and runs one agent against the issue's repository. */
export function createHubWorkflow(input: { layout: HubLayout; source: RuntimeSource; image: string; registryLogin: boolean; timeoutMinutes: number; maxRunNumber: number;
  retentionDays: number; signerRepository?: string }): string {
  const { source, layout } = input;
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(source.repository) || !/^[a-f0-9]{40}$/.test(source.revision) || source.readTokenSecret !== undefined ||
    (source.readSshKeySecret !== undefined && source.readSshKeySecret !== layout.runtimeKeySecret) ||
    !Number.isSafeInteger(input.timeoutMinutes) || input.timeoutMinutes < 1 || input.timeoutMinutes > 55 ||
    !Number.isSafeInteger(input.maxRunNumber) || input.maxRunNumber < 1 ||
    !Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 30) throw Error('Invalid hub workflow input');
  if (input.registryLogin && !input.image.startsWith('ghcr.io/')) throw Error('Registry login is supported only for ghcr.io worker images');
  if (!/@sha256:[a-f0-9]{64}$/.test(input.image)) throw Error('The worker image must be pinned by digest');
  const signer = input.signerRepository;
  if (signer !== undefined && !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(signer)) throw Error('Invalid image signer repository');
  // A signed build record proves which repository's workflow built this exact digest; checked before the image is used.
  const verify = 'if ! gh attestation verify "oci://$FACTORY_WORKER_IMAGE" --repo "$FACTORY_IMAGE_SIGNER"; then\n' +
    '  echo "::error::The worker image has no valid build attestation from $FACTORY_IMAGE_SIGNER, so it will not be used."; exit 1\nfi\n';
  const workflow = {
    name: PRODUCT_NAME,
    on: { issues: { types: ['opened', 'reopened', 'labeled'] } },
    permissions: {},
    jobs: {
      agent: {
        // Admission is ordered through the hub's deployments, so no concurrency group can cancel a waiting run. Ordinary
        // triage labels are skipped before a runner starts; approval labels are expected to start with "agent".
        if: expression(`github.run_number <= ${input.maxRunNumber} && (github.event.action != 'labeled' || startsWith(github.event.label.name, 'agent'))`),
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': input.timeoutMinutes + HUB_JOB_OVERHEAD_MINUTES,
        permissions: { contents: 'read', issues: 'write', actions: 'read', deployments: 'write', ...(input.registryLogin ? { packages: 'read' } : {}),
          ...(signer ? { attestations: 'read' } : {}) },
        steps: [
          { name: 'Read immutable runtime source', uses: pins.checkout, with: {
            repository: source.repository, ref: source.revision, path: 'factory-runtime', 'persist-credentials': false, 'fetch-depth': 1,
            ...(source.readSshKeySecret ? { 'ssh-key': expression(`secrets.${source.readSshKeySecret}`) } : {}) } },
          ...(input.registryLogin ? [{ name: signer ? 'Verify and pull private worker image' : 'Pull private worker image', id: 'pull',
            env: { FACTORY_WORKER_IMAGE: input.image, FACTORY_REGISTRY_TOKEN: expression('github.token'), FACTORY_PACKAGE_SETTINGS: packageSettings(input.image),
              ...(signer ? { GH_TOKEN: expression('github.token'), FACTORY_IMAGE_SIGNER: signer } : {}) },
            run: 'printf %s "$FACTORY_REGISTRY_TOKEN" | docker login ghcr.io --username software-factory --password-stdin\n' + (signer ? verify : '') +
              'if ! docker pull "$FACTORY_WORKER_IMAGE"; then\n' +
              '  echo "::error::This hub cannot read the worker image. Add this repository with Read access under Manage Actions access at $FACTORY_PACKAGE_SETTINGS"\n' +
              '  docker logout ghcr.io; exit 1\nfi\ndocker logout ghcr.io' }] : []),
          ...(signer && !input.registryLogin ? [{ name: 'Verify worker image', id: 'pull',
            env: { GH_TOKEN: expression('github.token'), FACTORY_WORKER_IMAGE: input.image, FACTORY_IMAGE_SIGNER: signer }, run: verify.trimEnd() }] : []),
          { name: 'Use Node.js', uses: pins.node, with: { 'node-version': '22' } },
          { name: 'Use OpenTofu', uses: pins.tofu, with: { tofu_version: '1.12.6', tofu_wrapper: false } },
          { name: 'Build trusted runtime', 'working-directory': 'factory-runtime',
            run: 'npm ci --ignore-scripts\nnpm run build\nnpm --prefix example/software-factory ci --ignore-scripts\nnpm --prefix example/software-factory run build' },
          { name: 'Verify, reserve and execute', id: 'launch', 'working-directory': 'factory-runtime', env: {
            // The workflow comes from the hub's own trusted commit, so the layout it names is trusted like the rest of it.
            [HUB_LAYOUT_VARIABLE]: layout.name,
            FACTORY_GITHUB_TOKEN: expression('github.token'), FACTORY_APP_PRIVATE_KEY: expression(`secrets.${layout.appKeySecret}`),
            FACTORY_CODEX_API_KEY: expression(`secrets.${HUB_MODEL_KEY_SECRET}`), FACTORY_ARTIFACT_PARENT: expression('runner.temp') + `/${HUB_ARTIFACT_FOLDER}` },
            run: 'node example/software-factory/dist/actions-cli.js hub-launch' },
          { name: 'Retain bounded run evidence', if: expression("always() && steps.launch.outputs.artifact_directory != ''"), uses: pins.artifact, with: {
            name: expression('format(\'software-factory-{0}-{1}\', github.run_id, github.run_attempt)'),
            path: expression('steps.launch.outputs.artifact_directory'), 'retention-days': input.retentionDays,
            'if-no-files-found': 'error', 'include-hidden-files': false, 'compression-level': 0 } },
          // The launch step replies on the issue itself; this covers setup that failed before it could run.
          { name: 'Reply when setup failed', if: expression("failure() && steps.launch.outcome == 'skipped'"), env: {
            GH_TOKEN: expression('github.token'), FACTORY_ISSUE: expression('github.event.issue.number'),
            FACTORY_RUN_URL: expression("format('{0}/{1}/actions/runs/{2}', github.server_url, github.repository, github.run_id)"),
            FACTORY_PULL_OUTCOME: input.registryLogin || signer ? expression('steps.pull.outcome') : 'skipped', FACTORY_PACKAGE_SETTINGS: packageSettings(input.image) },
            run: 'if [ "$FACTORY_PULL_OUTCOME" = failure ]; then\n' +
              '  reason="it could not use its worker image: either it cannot read it (an owner can add this repository with Read access under Manage Actions access at $FACTORY_PACKAGE_SETTINGS) or the image failed its signature check. Fix that, then close and reopen this issue"\n' +
              'else\n  reason="its setup failed before the request was checked"\nfi\n' +
              'gh issue comment "$FACTORY_ISSUE" --repo "$GITHUB_REPOSITORY" --body "No agent started: $reason. [Run details]($FACTORY_RUN_URL)"' },
        ],
      },
    },
  };
  return stringify(workflow, { lineWidth: 0 });
}
