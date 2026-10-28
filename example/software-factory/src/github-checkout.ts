import { join } from 'node:path';
import { runTrustedProcess, type ProcessRunner } from '@intelligent-iterations/ii-agent-runtime/pipeline';

/**
 * A shallow clone of one branch on the trusted host, with the token passed through git's environment so it never
 * appears in arguments or in the clone's configuration. Submodules and hooks are not run.
 */
export async function cloneRepository(input: { repository: string; base?: string; token: string; directory: string; executablePath: string; process?: ProcessRunner }) {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString('base64')}`;
  await (input.process ?? runTrustedProcess)({ command: 'git', cwd: input.directory, timeoutMs: 300000, maxOutputBytes: 1048576,
    args: ['clone', '--depth=1', '--single-branch', '--no-recurse-submodules', '--no-tags', ...(input.base ? ['--branch', input.base] : []),
      `https://github.com/${input.repository}.git`, join(input.directory, 'repository')],
    env: { PATH: input.executablePath, HOME: input.directory, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: header,
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null' } });
  return join(input.directory, 'repository');
}
