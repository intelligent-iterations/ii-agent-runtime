import type { WorkflowInstallationTransport } from './workflow-installation.js';

/** The factory owns its workflow repository; cloning the SDK never selects it. */
export async function prepareFactoryRepository(
  repository: string,
  transport: WorkflowInstallationTransport,
) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error('Use OWNER/REPO for the factory repository');
  const existing = await transport.request('GET', `/repos/${repository}`);
  if (existing.status === 200) {
    const body = existing.body as { archived?: boolean; private?: boolean };
    if (body.archived || body.private !== true)
      throw Error('Factory repository must be an installed private repository');
    return;
  }
  throw Error('Create a private factory repository and install the App on it before onboarding');
}
