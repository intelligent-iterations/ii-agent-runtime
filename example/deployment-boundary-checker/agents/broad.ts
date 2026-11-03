import { createGrant, defineTool } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { githubContents } from '@intelligent-iterations/ii-agent-runtime/tools';

// A coding agent that may edit the functions deploy script, application code, the root manifest and docs on main of a repository that deploys to GCP.
const subject = 'agent:codex';
const writeFile = defineTool({
  name: 'write-file',
  operation: githubContents().write,
  credential: { provider: 'github', resource: 'acme/functions', key: 'functions-agent-key', assignment: subject },
});

export default {
  subject,
  tools: [writeFile],
  grants: [createGrant({
    subject, tool: writeFile,
    resources: { repository: ['acme/functions'], branch: ['main'], path: ['scripts/deploy-functions.sh', 'src/index.ts', 'package.json', 'docs/guide.md'] },
  })],
};
