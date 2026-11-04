import { basename, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import type { WorkflowIdentityAssessor } from '@intelligent-iterations/ii-agent-runtime/tools';
import { checkBoundary, checkGcpTokenFile, checkoutOf, gcpServiceAccounts, githubWorkflows, loadAgent, localWorkflows, requireWorkflowFiles,
  singleScope, type BoundaryResult } from './check.js';
import { renderComparison, renderResult } from './render.js';

const usage = `Usage: deployment-boundary-checker --grants <file> [--compare <file>] (--workflows <dir> | --github)
                                    [--gcp-token-file <path>] [--report] [--json]

Answers: can this coding agent change anything that runs with deployment credentials?

  --grants <file>          Trusted module exporting { subject, tools, grants } built with defineTool/createGrant.
                           Keep it in this folder's agents/ so it uses the checker's installed runtime
  --compare <file>         A second grants module, shown side by side with the first
  --workflows <dir>        Read workflow files from a local checkout, for example /path/to/repo/.github/workflows
  --github                 Read workflows and Actions settings from GitHub; needs a read token in GITHUB_TOKEN
  --gcp-token-file <path>  Absolute path to a file holding a GCP OAuth access token for a reader (for example
                           gcloud auth print-access-token). Assesses the GCP service accounts that deploy jobs use
  --report                 Also print the full runtime preflight report
  --json                   Print machine-readable results

Without --gcp-token-file, the GCP service accounts deploy jobs use are listed but their authority is not
assessed. Identities from other clouds are always listed, never assessed.

Exit codes: 0 no recognized path, 1 path found, 2 can't tell, 64 usage or configuration error.
With --compare, the exit code describes the --compare configuration.`;

/** Argument mistakes: the usage text follows the message. */
class UsageError extends Error {}
const label = (file: string) => basename(file).replace(/\.[cm]?[jt]s$/, '');

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    grants: { type: 'string' }, compare: { type: 'string' }, workflows: { type: 'string' }, github: { type: 'boolean' },
    'gcp-token-file': { type: 'string' }, report: { type: 'boolean' }, json: { type: 'boolean' },
    help: { type: 'boolean' } } });
  if (values.help) { process.stdout.write(usage + '\n'); return 0; }
  if (!values.grants) throw new UsageError('--grants is required');
  if (!values.workflows === !values.github) throw new UsageError('Choose exactly one of --workflows or --github');
  const tokenFile = values['gcp-token-file'];
  if (tokenFile !== undefined && !isAbsolute(tokenFile)) throw new UsageError('--gcp-token-file must be an absolute path');
  const token = process.env.GITHUB_TOKEN;
  if (values.github && !token) throw new UsageError('--github needs a read token in GITHUB_TOKEN, for example GITHUB_TOKEN=$(gh auth token)');
  // Setup mistakes fail here, not later as unreadable service accounts.
  if (tokenFile) checkGcpTokenFile(tokenFile);
  const notes = new Set<string>();
  const files = [values.grants, ...(values.compare ? [values.compare] : [])];
  const identity: Record<string, WorkflowIdentityAssessor> = tokenFile ? { gcp: gcpServiceAccounts(tokenFile, notes) } : {};
  const designated = Object.keys(identity);
  const runs: { label: string; result: BoundaryResult }[] = [];
  const warnings = new Set<string>();
  for (const file of files) {
    const agent = await loadAgent(file);
    let workflows;
    if (values.workflows) {
      const scope = singleScope(agent);
      workflows = localWorkflows(values.workflows, scope);
      // The sample grants name acme's repository; say so when the checkout is another one.
      const checkout = checkoutOf(values.workflows);
      if (checkout.repository && checkout.repository.toLowerCase() !== scope.repository.toLowerCase())
        warnings.add(`Warning: ${values.workflows} is from ${checkout.repository}, but ${file} grants writes to ${scope.repository}. Set repository in ${file}.`);
      if (checkout.branch && checkout.branch !== scope.branch)
        warnings.add(`Warning: ${values.workflows} is checked out on ${checkout.branch}; its workflows are checked as ${scope.branch} from ${file}.`);
    } else workflows = githubWorkflows(token!, notes);
    const result = await checkBoundary({ agent, workflows, ...(designated.length ? { workflowIdentity: identity } : {}) });
    if (values.github) requireWorkflowFiles(result, file);
    runs.push({ label: label(file), result });
  }
  for (const warning of warnings) process.stderr.write(`${warning}\n`);
  if (values.json) {
    process.stdout.write(JSON.stringify(runs.map(({ label, result }) => ({ label, subject: result.subject, answer: result.answer,
      admission: result.admission, writable: result.writable, inspected: result.inspected, check: result.execution, report: result.report })), null, 2) + '\n');
  } else {
    const options = { report: values.report === true, designated };
    process.stdout.write((runs.length > 1 ? renderComparison(runs, options) : renderResult(runs[0]!.result, options)) + '\n');
    if (!identity.gcp) process.stderr.write('\nNote: without --gcp-token-file, GCP service accounts that deploy jobs use are listed but not assessed.\n');
    if (values.workflows) process.stderr.write('Note: local workflow files carry no Actions settings, so Actions is treated as enabled.\n');
  }
  for (const note of notes) process.stderr.write(`Note: ${note}\n`);
  const answer = runs.at(-1)!.result.answer;
  return answer === 'yes' ? 1 : answer === 'unknown' ? 2 : 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  // Argument, setup and configuration problems only. Provider errors never reach here: preflight reports them as unknown.
  const argument = error instanceof UsageError || /^ERR_PARSE_ARGS/.test(String((error as { code?: unknown })?.code));
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${argument ? `\n${usage}\n` : 'Run with --help for usage.\n'}`);
  process.exitCode = 64;
});
