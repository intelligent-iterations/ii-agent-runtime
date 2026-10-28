/** Provider credentials belong to the trusted launcher, never to the issue or worker configuration. */
export function cloudEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const allowed = /^(AWS_|ARM_|GOOGLE_|CLOUDSDK_|OCI_|DIGITALOCEAN_|HCLOUD_|TF_)[A-Z0-9_]+$/;
  const result = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && (allowed.test(entry[0]) || entry[0] === 'HOME')));
  if (env.FACTORY_CLOUD_ENVIRONMENT) {
    let values: unknown;
    try { values = JSON.parse(env.FACTORY_CLOUD_ENVIRONMENT); } catch { throw Error('Invalid cloud credentials JSON'); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('Invalid cloud credentials object');
    for (const [key, value] of Object.entries(values)) {
      if (!allowed.test(key) || typeof value !== 'string' || value.includes('\0')) throw Error('Invalid cloud credential entry');
      result[key] = value;
    }
  }
  return result;
}
