import { Ajv } from 'ajv';
import { compileConfiguration as compileRuntime, canonicalJson, digest, ConfigurationError,
  type RuntimeConfiguration as InfrastructureConfiguration, type CompiledConfiguration as InfrastructureArtifact
} from '@intelligent-iterations/ii-agent-runtime/runtime';

export type LaunchPolicy =
  | { mode: 'authorized-author'; minimumPermission: 'read' | 'triage' | 'write' | 'maintain' | 'admin' }
  | { mode: 'maintainer-approval'; minimumPermission: 'read' | 'triage' | 'write' | 'maintain' | 'admin'; label: string }
  | { mode: 'any-author'; allowPublicContributors: true };
export type RuntimeConfiguration = InfrastructureConfiguration & { launchPolicy: LaunchPolicy };
export interface CompiledConfiguration extends Omit<InfrastructureArtifact, 'configuration'> {
  configuration: RuntimeConfiguration;
  /** Only this artifact is passed to runtime infrastructure adapters. */
  runtime: InfrastructureArtifact;
}
const validateLaunch = new Ajv({ strict: true }).compile<LaunchPolicy>({
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "mode",
        "minimumPermission"
      ],
      "properties": {
        "mode": {
          "const": "authorized-author"
        },
        "minimumPermission": {
          "$ref": "#/definitions/permission"
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "mode",
        "minimumPermission",
        "label"
      ],
      "properties": {
        "mode": {
          "const": "maintainer-approval"
        },
        "minimumPermission": {
          "$ref": "#/definitions/permission"
        },
        "label": {
          "type": "string",
          "minLength": 1,
          "maxLength": 50,
          "pattern": "^[a-zA-Z0-9][a-zA-Z0-9: _-]*$"
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "mode",
        "allowPublicContributors"
      ],
      "properties": {
        "mode": {
          "const": "any-author"
        },
        "allowPublicContributors": {
          "const": true
        }
      }
    }
  ],
  "definitions": {
    "permission": {
      "enum": [
        "read",
        "triage",
        "write",
        "maintain",
        "admin"
      ]
    }
  }
});

/** Bind application authorization policy separately from runtime infrastructure configuration. */
export function compileConfiguration(input: unknown): CompiledConfiguration {
  const data = JSON.parse(canonicalJson(input));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigurationError('SCHEMA');
  const { launchPolicy, ...infrastructure } = data;
  if (!validateLaunch(launchPolicy)) throw new ConfigurationError('SCHEMA', undefined, '/launchPolicy');
  const runtime = compileRuntime(infrastructure);
  const configuration = { ...runtime.configuration, launchPolicy };
  const canonical = canonicalJson(configuration);
  const { revision: _revision, ...semantic } = configuration;
  return { runtime, configuration, canonical, setupDigest: digest(canonicalJson(semantic)), artifactDigest: digest(canonical) };
}
