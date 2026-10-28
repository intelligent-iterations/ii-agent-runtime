import { openTofuWorker } from './execution/docker/provisioning.js';
import { isolateWorkerNetwork } from './execution/docker/network.js';
import { loadWorkerSource, runWorkerSetup } from './execution/docker/setup.js';
import { openWorkerGateway } from './gateway/worker.js';
import { codexModelGateway } from './model/openai/gateway.js';

/** Default provider operations and the existing dependency-injection contract. */
export const executionServices = { openTofuWorker, isolateWorkerNetwork, openWorkerGateway, codexModelGateway, loadWorkerSource, runWorkerSetup };
export type ExecutionServices = typeof executionServices;
