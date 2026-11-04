import { createGrant, defineTool } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { githubContents } from '@intelligent-iterations/ii-agent-runtime/tools';

// The same agent narrowed to the README of the same repository and branch.
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
    resources: { repository: [repository], branch: ['main'], path: ['README.md'] },
  })],
};
