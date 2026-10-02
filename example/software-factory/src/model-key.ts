/** A key that cannot be read back once stored is checked before it is saved, and confirmed by a masked preview. */
export class ModelKeyError extends Error {}

export function maskKey(value: string): string {
  return `${value.slice(0, Math.min(8, Math.floor(value.length / 4)))}...${value.slice(-4)} (${value.length} characters)`;
}

export function checkModelKey(raw: string): { value: string; preview: string; warning?: string } {
  const value = raw.trim();
  if (!value) throw new ModelKeyError('No key was entered.');
  if (/\s/.test(value)) throw new ModelKeyError('The key contains spaces or line breaks. Paste it once, then press Enter.');
  const half = value.length / 2;
  // A double paste produces the same key twice in a row, which is long enough to pass a length check.
  if (Number.isInteger(half) && value.slice(0, half) === value.slice(half)) throw new ModelKeyError('That looks like the key pasted twice. Paste it once, then press Enter.');
  if ((value.match(/sk-/g) ?? []).length > 1) throw new ModelKeyError('That looks like more than one key. Paste a single key, then press Enter.');
  if (value.length < 20 || value.length > 512) throw new ModelKeyError('That is not the length of an API key.');
  const warning = value.startsWith('sk-') ? undefined : 'OpenAI API keys usually start with "sk-".';
  return { value, preview: maskKey(value), ...(warning ? { warning } : {}) };
}
