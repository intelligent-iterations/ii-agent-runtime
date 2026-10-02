/** Terminal color, only for a real terminal and never when NO_COLOR is set (https://no-color.org). */
export function colorSupported(output: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return output.isTTY === true && env.TERM !== 'dumb';
}

export interface Palette {
  enabled: boolean;
  bold(text: string): string; dim(text: string): string; green(text: string): string; red(text: string): string;
  yellow(text: string): string; cyan(text: string): string; link(text: string): string;
}
export function palette(enabled: boolean): Palette {
  const wrap = (open: string, close: string) => (text: string) => enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  const underline = wrap('4', '24');
  const cyan = wrap('36', '39');
  return { enabled, bold: wrap('1', '22'), dim: wrap('2', '22'), green: wrap('32', '39'), red: wrap('31', '39'), yellow: wrap('33', '39'), cyan,
    link: text => cyan(underline(text)) };
}

/**
 * Styles a message by its leading mark (✓ success, ✗ error, ! warning, ? question, · skipped), links, and a trailing
 * parenthetical detail, so callers write plain text and a pipe or NO_COLOR gets exactly that text.
 */
export function decorate(text: string, style: Palette): string {
  if (!style.enabled) return text;
  return text.split('\n').map(line => {
    const links = (value: string) => value.replace(/https?:\/\/[^\s)]+/g, url => style.link(url));
    const detail = (value: string) => value.replace(/( \([^()]*\))(:?)$/, (_, note: string, colon: string) => style.dim(note) + colon);
    const marked = /^(\s*)(✓|✗|!|\?|·) (.*)$/.exec(line);
    if (!marked) return /^[A-Z][^:]{0,60}:$/.test(line) ? style.bold(line) : links(line);
    const [, indent, mark, rest] = marked as unknown as [string, string, string, string];
    if (mark === '✓') return `${indent}${style.green(mark)} ${detail(links(rest))}`;
    if (mark === '✗') return `${indent}${style.red(`${mark} ${rest}`)}`;
    if (mark === '!') return `${indent}${style.yellow(`${mark} ${rest}`)}`;
    if (mark === '·') return `${indent}${style.dim(`${mark} ${rest}`)}`;
    // A question is bold; its default choice or current value, such as (Y/n) or [3], is dimmed.
    const suffix = /( (?:\([YyNn]\/[YyNn]\)|\[[^\]]*\]))?(:? ?)$/.exec(rest)!;
    const question = rest.slice(0, rest.length - suffix[0].length);
    return `${indent}${style.cyan(style.bold(mark))} ${style.bold(question)}${suffix[1] ? style.dim(suffix[1]) : ''}${suffix[2]}`;
  }).join('\n');
}
