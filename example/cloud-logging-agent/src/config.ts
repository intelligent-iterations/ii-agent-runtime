import { readFileSync } from 'node:fs';
import { LOG_VIEW_PATTERN, PROJECT_PATTERN, RESOURCE_PATTERN, RESOURCE_TYPES, type ResourceType } from './cloud-logging.js';

/** Trusted configuration. It holds no secrets: credentials come from the host environment. */
export interface Config {
  project: string; resourceType: ResourceType; resource: string; logView?: string;
  /** Emulator origin; set only for emulator runs. */
  emulator?: string;
  execution?: string; image?: string; model?: string;
  inputMicrousdPerMillionTokens?: number; outputMicrousdPerMillionTokens?: number;
  /** Lines the CLI prints before running, such as ignored settings. */
  notices: string[];
}

const unset = (value: unknown) => typeof value !== 'string' || value.startsWith('YOUR_');

export function readConfig(path: string): Config {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Error(`${path} not found. Create it with: cp config.example.json ${path}`);
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw Error(`${path} is not valid JSON`); }
  return parseConfig(raw);
}

/** Validates the trusted grant. The placeholders in config.example.json fail here and name the field to edit. */
export function parseConfig(raw: unknown): Config {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (unset(input.project) || !new RegExp(PROJECT_PATTERN).test(input.project as string))
    throw Error('Set "project" in config.json to your Google Cloud project ID');
  if (typeof input.resourceType !== 'string' || !Object.hasOwn(RESOURCE_TYPES, input.resourceType))
    throw Error('Set "resourceType" in config.json to cloud_function or cloud_run_revision');
  if (unset(input.resource) || !new RegExp(RESOURCE_PATTERN).test(input.resource as string))
    throw Error('Set "resource" in config.json to the exact function or Cloud Run service name');
  if (input.logView !== undefined && (typeof input.logView !== 'string' || !new RegExp(LOG_VIEW_PATTERN).test(input.logView)))
    throw Error('logView must look like locations/global/buckets/_Default/views/VIEW_ID');
  const config = { ...input, notices: [] } as unknown as Config;
  delete (config as { emulatorEndpoint?: unknown }).emulatorEndpoint;
  if (input.emulatorEndpoint !== undefined) {
    const url = URL.parse(String(input.emulatorEndpoint));
    if (!url || !['http:', 'https:'].includes(url.protocol)) throw Error('emulatorEndpoint must be an http(s) URL');
    config.emulator = url.origin;
    if (config.logView !== undefined) {
      delete config.logView;
      config.notices.push('EMULATOR MODE: floci-gcp has no log views; logView is ignored.');
    }
  }
  return config;
}

/** Codex runs only: the worker image, the selected model and its rates, which the runtime's model gateway uses to bound spend. */
export function checkCodex(config: Config) {
  if (typeof config.image !== 'string' || !config.image) throw Error('Set "image" in config.json to the worker image');
  if (unset(config.model) || !config.model) throw Error('Set "model" in config.json to a Codex-compatible model');
  for (const key of ['inputMicrousdPerMillionTokens', 'outputMicrousdPerMillionTokens'] as const)
    if (!Number.isSafeInteger(config[key]) || config[key]! <= 0) throw Error(`Set ${key} in config.json to the selected model's rate`);
}
