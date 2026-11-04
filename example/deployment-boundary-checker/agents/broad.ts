import { createGrant, defineTool } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { githubContents } from '@intelligent-iterations/ii-agent-runtime/tools';

// A coding agent that may edit the end-to-end test runner, the Go entry point, the Makefile and the README on main of
// Google's public Secret Manager provider for the Secrets Store CSI Driver. Its e2e workflow signs in to Google Cloud.
const repository = 'GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp';
const subject = 'agent:codex';
const writeFile = defineTool({
  name: 'write-file',
  operation: githubContents().write,
  credential: { provider: 'github', resource: repository, key: 'csi-provider-agent-key', assignment: subject },
});

export default {
  subject,
  tools: [writeFile],
  grants: [createGrant({
    subject, tool: writeFile,
    resources: { repository: [repository], branch: ['main'], path: ['test/infra/runner.sh', 'main.go', 'Makefile', 'README.md'] },
  })],
};
