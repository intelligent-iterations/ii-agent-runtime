// Adapted: reset stateful denylist patterns and preserve prototype-named data keys.
export const REDACTION_VERSION = "redact.v1";

const SECRET_HEADER_PATTERN = /^(authorization|cookie|x-api-key|proxy-authorization)$/i;
const SECRET_PATH_PATTERN = /(^|\/)(\.env[^/]*|credentials[^/]*|secrets\/|[^/]+\.(pem|key))$/i;
const SENSITIVE_HOME_PATTERN = /(^|\/)\.(aws|ssh)(\/|$)/i;

export interface RedactionOptions {
  denylist?: RegExp[];
}

export interface RedactionResult<T = unknown> {
  value: T;
  dropped: boolean;
  reasons: string[];
}

export function redactPayload<T = unknown>(value: T, options: RedactionOptions = {}): RedactionResult<T> {
  const reasons: string[] = [];
  try {
    const redacted = redactValue(value, [], reasons, options) as T;
    return { value: redacted, dropped: false, reasons };
  } catch (error) {
    return {
      value: "[event dropped: redaction failed]" as T,
      dropped: true,
      reasons: [`redaction_failed:${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

function redactValue(value: unknown, path: string[], reasons: string[], options: RedactionOptions): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    if (shouldMaskString(path, value, options, reasons)) {
      return "[redacted]";
    }
    return applyDenylist(value, options, reasons);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, [...path, String(index)], reasons, options));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const loweredKey = key.toLowerCase();
    if (isSecretKey(key) || SECRET_HEADER_PATTERN.test(loweredKey)) {
      Object.defineProperty(output, key, { value: "[redacted]", enumerable: true, writable: true, configurable: true });
      reasons.push(`key:${path.concat(key).join(".")}`);
      continue;
    }
    Object.defineProperty(output, key, { value: redactValue(child, [...path, key], reasons, options), enumerable: true, writable: true, configurable: true });
  }
  return output;
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (
    [
      "apikey",
      "authorization",
      "bearertoken",
      "cookie",
      "key",
      "password",
      "privatekey",
      "proxyauthorization",
      "secret",
      "token",
      "xapikey"
    ].includes(normalized)
  ) {
    return true;
  }

  if (/(token|secret|password)$/.test(normalized)) {
    return true;
  }

  if (/key$/.test(normalized) && /(api|auth|private|secret|ssh|pem|access|refresh)/.test(normalized)) {
    return true;
  }

  return false;
}

function shouldMaskString(pathParts: string[], value: string, options: RedactionOptions, reasons: string[]): boolean {
  const pathLabel = pathParts.join(".");
  if (pathParts.some((part) => /path|file|filename/i.test(part)) && (SECRET_PATH_PATTERN.test(value) || SENSITIVE_HOME_PATTERN.test(value))) {
    reasons.push(`path:${pathLabel}`);
    return true;
  }
  for (const pattern of options.denylist ?? []) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      reasons.push(`denylist:${pathLabel}`);
      return true;
    }
  }
  return false;
}

function applyDenylist(value: string, options: RedactionOptions, reasons: string[]): string {
  let output = value;
  for (const pattern of options.denylist ?? []) {
    output = output.replace(pattern, () => {
      reasons.push("denylist:string");
      return "[redacted]";
    });
  }
  return output;
}
