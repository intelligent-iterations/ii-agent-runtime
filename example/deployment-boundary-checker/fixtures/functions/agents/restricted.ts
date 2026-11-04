import { createGrant, defineTool } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { githubContents } from '@intelligent-iterations/ii-agent-runtime/tools';

// Unit-test sample: an agent that may edit only documentation of the sample acme/functions repository.
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
    resources: { repository: ['acme/functions'], branch: ['main'], path: ['docs/guide.md'] },
  })],
};
