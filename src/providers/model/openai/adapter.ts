import type { CompiledConfiguration } from '../../../runtime/configuration.js';
import type { ModelProvider } from '../../../pipeline/ports.js';
import type { ExecutionServices } from '../../services.js';

/** OpenAI's Responses API behind the run's request, token and spend limits. The key never reaches the worker. */
export function openaiModel(compiled: CompiledConfiguration, options: { apiKey: () => string; services: Pick<ExecutionServices, 'codexModelGateway'> }): ModelProvider {
  const config = compiled.configuration;
  return { open: signal => options.services.codexModelGateway({ model: config.harness.model, apiKey: options.apiKey, limits: config.limits, signal }) };
}
