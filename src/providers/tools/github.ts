import type { ToolOperation } from '../../runtime/tools.js';
import { nameSchema, operationSchema, providerJson } from './http.js';

export function githubContents(options: { fetch?: typeof fetch } = {}) {
  const properties = {
    repository: { type: 'string', pattern: '^[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+$', maxLength: 256 },
    branch: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$', maxLength: 255 },
    path: { type: 'string', pattern: '^[a-zA-Z0-9._/-]+$', maxLength: 1024 },
  };
  const make = (write: boolean): ToolOperation => ({
    provider: 'github', id: write ? 'contents.write' : 'contents.read',
    description: write ? 'Create or update one repository file on a selected branch' : 'Read a repository file on a selected branch',
    resourceFields: ['repository', 'branch', 'path'],
    inputSchema: operationSchema({ ...properties, ...(write ? {
      content: { type: 'string', maxLength: 524288, pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' },
      message: { type: 'string', minLength: 1, maxLength: 1024 },
      sha: { ...nameSchema, pattern: '^[a-f0-9]{40}$' },
    } : {}) }, [...Object.keys(properties), ...(write ? ['content', 'message'] : [])]),
    execute: (input, credential, context) => {
      if (String(input.repository).split('/').some(part => part === '.' || part === '..')) throw Error('Invalid repository');
      for (const key of ['path', 'branch']) if (String(input[key]).split('/').some(part => !part || part === '.' || part === '..') ||
        String(input[key]).includes('..')) throw Error('Invalid repository path');
      const url = new URL(`/repos/${input.repository}/contents/${String(input.path).split('/').map(encodeURIComponent).join('/')}`, 'https://api.github.com');
      if (!write) url.searchParams.set('ref', String(input.branch));
      return providerJson(url, credential, context, { ...options, method: write ? 'PUT' : 'GET',
        ...(write ? { body: { branch: input.branch, message: input.message, content: input.content,
          ...(input.sha === undefined ? {} : { sha: input.sha }) } } : {}) });
    },
  });
  return { read: make(false), write: make(true) };
}
