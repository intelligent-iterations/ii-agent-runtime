export * from './ports.js';
export { workerResources } from './worker-resources.js';
// Explicit adapter construction for consumers that bind an already provisioned execution environment.
export { dockerTofuTarget } from '../providers/execution/docker/target.js';
export { openshellTarget, type OpenShellHost } from '../providers/execution/openshell/target.js';
export { executionServices } from '../providers/services.js';

export { createExecutionTarget } from './create-target.js';
export { openaiModel } from '../providers/model/openai/adapter.js';
export type { ExecutionServices } from '../providers/services.js';
export { runTrustedProcess, type ProcessRunner, type ProcessRequest } from '../providers/shared/process.js';
export { openWorkerStdioEndpoint, type WorkerStdioEndpoint } from '../providers/execution/shared/stdio-endpoint.js';
export { openTrustedProcess, type ProcessSessionRequest } from '../providers/shared/process-session.js';
export type { DockerTargetCheckpoint, DockerTargetReference } from '../providers/execution/docker/retained.js';
export { recoverDockerTarget } from '../providers/execution/docker/recovery.js';
