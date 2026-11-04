import { LOGGING_API } from '../src/cloud-logging.js';

/**
 * For tests only: a fetch that sends the adapter's Cloud Logging requests to `origin` (the floci-gcp emulator or a
 * local test server) instead of logging.googleapis.com, and fails any other request. The code under test still
 * builds the real Google request; only its destination changes. `seen` collects each intercepted path.
 */
export function interceptGoogle(origin: string, seen: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== LOGGING_API) throw Error(`Test interception: unexpected request to ${url.origin}`);
    seen.push(url.pathname);
    return fetch(new URL(`${url.pathname}${url.search}`, origin), init);
  };
}

/** For tests only: stands in for Application Default Credentials. */
export const testCredential = async () => ({ values: { accessToken: 'test-only-token' }, expiresAt: Date.now() + 60000 });
