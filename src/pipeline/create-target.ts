import type { CompiledConfiguration } from '../runtime/configuration.js';
import { cloudTarget } from '../providers/execution/remote/target.js';
import { UnsupportedPipelineTarget, type ExecutionTarget } from './ports.js';

/** Select agent infrastructure explicitly; control-process location never selects execution. */
export function createExecutionTarget(compiled: CompiledConfiguration, options: {
  host: { workParent: string; executablePath: string; cloudEnvironment?: Record<string, string> };
  executionTarget?: ExecutionTarget;
}): ExecutionTarget {
  const environment = compiled.configuration.environment;
  if (!environment.hosting) throw new UnsupportedPipelineTarget('environment.hosting', 'missing');
  if (!['docker', 'openshell'].includes(environment.provider)) throw new UnsupportedPipelineTarget('environment.provider', environment.provider);
  if (environment.hosting.provider === 'github') {
    if (!options.executionTarget) throw new UnsupportedPipelineTarget('executionTarget', 'GitHub deployment requires an explicit target');
    return options.executionTarget;
  }
  if (options.executionTarget) throw new UnsupportedPipelineTarget('executionTarget', 'cannot override the configured cloud deployment');
  return cloudTarget({ hosting: environment.hosting, isolation: environment.provider, parent: options.host.workParent,
    executablePath: options.host.executablePath, environment: options.host.cloudEnvironment ?? {} });
}
