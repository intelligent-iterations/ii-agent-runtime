/**
 * Bounded evaluation of GitHub Actions `${{ }}` expressions for one branch.
 *
 * Supports string, boolean, null and number literals, `github.ref`, `github.ref_name`,
 * finite `workflow_dispatch` inputs, workflow/job/step `env`, and the `==`, `!=`, `&&`, `||`
 * and `!` operators with parentheses. It returns every value a run on the branch can
 * produce. Anything else (secrets, vars, functions, run-time `GITHUB_ENV` values) stays
 * unresolved, with the reference that blocked it.
 */
export interface WorkflowValueContext {
  branch: string;
  /** Environment maps from innermost (step) to outermost (workflow). */
  env: readonly unknown[];
  /** Workflow `on:` value, for `inputs.*`. */
  on: unknown;
}
export type WorkflowValue = { values: string[] } | { unresolved: string };

type Value = string | boolean | number | null;
const MAX_VALUES = 8;
const MAX_DEPTH = 4;
class Unresolved extends Error {}
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const truthy = (value: Value) => value !== false && value !== null && value !== '' && value !== 0 && !Number.isNaN(value);
const text = (value: Value) => value === null ? '' : String(value);
const number = (value: Value) => value === null ? 0 : typeof value === 'boolean' ? Number(value) :
  typeof value === 'number' ? value : value.trim() === '' ? 0 : Number(value);
function equal(left: Value, right: Value): boolean {
  // GitHub compares strings case-insensitively and coerces mixed types to numbers.
  if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase();
  if (typeof left === typeof right || left === null || right === null) {
    if (left === null || right === null) return left === right || number(left) === number(right);
    return left === right;
  }
  return number(left) === number(right);
}
function unique(values: Value[]): Value[] {
  const out = [...new Map(values.map(value => [`${typeof value}:${String(value)}`, value])).values()];
  if (out.length > MAX_VALUES) throw new Unresolved('too many possible values');
  return out;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < source.length;) {
    const rest = source.slice(index);
    const space = /^\s+/.exec(rest);
    if (space) { index += space[0].length; continue; }
    const token = /^(?:'(?:[^']|'')*'|==|!=|&&|\|\||[!()]|-?[0-9]+(?:\.[0-9]+)?|[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)/.exec(rest);
    if (!token) throw new Unresolved(`unsupported expression syntax near "${rest.slice(0, 20)}"`);
    tokens.push(token[0]);
    index += token[0].length;
  }
  return tokens;
}

function inputValues(on: unknown, name: string): Value[] {
  const events = typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map(event => [event, null])) : record(on) ? on : {};
  if (Object.hasOwn(events, 'workflow_call')) throw new Unresolved(`inputs.${name} (reusable workflow input)`);
  if (!Object.hasOwn(events, 'workflow_dispatch')) return [null];
  const input = record(events.workflow_dispatch) && record(events.workflow_dispatch.inputs) ? events.workflow_dispatch.inputs[name] : undefined;
  if (input === undefined) return [null];
  if (record(input) && input.type === 'choice' && Array.isArray(input.options) && input.options.every((item: unknown) => typeof item === 'string'))
    return [null, ...input.options];
  if (record(input) && input.type === 'boolean') return [null, true, false];
  throw new Unresolved(`inputs.${name} (free-form dispatch input)`);
}

function reference(name: string, context: WorkflowValueContext, depth: number): Value[] {
  if (name === 'github.ref') return [`refs/heads/${context.branch}`];
  if (name === 'github.ref_name') return [context.branch];
  if (name === 'true' || name === 'false') return [name === 'true'];
  if (name === 'null') return [null];
  const [scope, key, ...more] = name.split('.');
  if (scope === 'inputs' && key && !more.length) return inputValues(context.on, key);
  if (scope === 'env' && key && !more.length) {
    for (const env of context.env) {
      if (!record(env) || !Object.hasOwn(env, key)) continue;
      const raw = env[key];
      if (typeof raw === 'number' || typeof raw === 'boolean') return [raw];
      const resolved = resolveWorkflowValue(raw, context, depth + 1);
      if ('unresolved' in resolved) throw new Unresolved(`env.${key} from ${resolved.unresolved}`);
      return resolved.values;
    }
    throw new Unresolved(`env.${key} (set at run time or undefined)`);
  }
  throw new Unresolved(name);
}

/** Recursive-descent evaluation over candidate value sets. */
function evaluate(source: string, context: WorkflowValueContext, depth: number): Value[] {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const take = (expected?: string) => {
    const token = tokens[position++];
    if (token === undefined || expected !== undefined && token !== expected) throw new Unresolved('incomplete expression');
    return token;
  };
  const primary = (): Value[] => {
    const token = take();
    if (token === '(') { const value = or(); take(')'); return value; }
    if (token.startsWith("'")) return [token.slice(1, -1).replace(/''/g, "'")];
    if (/^-?[0-9]/.test(token)) return [Number(token)];
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() === '(') throw new Unresolved(`${token}() function`);
      return reference(token, context, depth);
    }
    throw new Unresolved('incomplete expression');
  };
  const unary = (): Value[] => peek() === '!' ? (take(), unique(unary().map(value => !truthy(value)))) : primary();
  const comparison = (): Value[] => {
    const left = unary();
    const operator = peek();
    if (operator !== '==' && operator !== '!=') return left;
    take();
    const right = unary();
    return unique(left.flatMap(a => right.map(b => operator === '==' ? equal(a, b) : !equal(a, b))));
  };
  // Short-circuit per candidate: the right side is evaluated only when some candidate needs it.
  const chain = (next: () => Value[], operator: '&&' | '||') => (): Value[] => {
    let values = next();
    while (peek() === operator) {
      take();
      const start = position;
      const passes = (value: Value) => operator === '||' ? truthy(value) : !truthy(value);
      if (values.every(passes)) { skip(start, operator === '||' ? ['||'] : ['&&', '||']); continue; }
      const right = next();
      values = unique(values.flatMap(value => passes(value) ? [value] : right));
    }
    return values;
  };
  // Skip an operand whose value cannot matter: up to the next operator of equal or lower precedence.
  const skip = (start: number, stops: readonly string[]) => {
    let level = 0;
    position = start;
    while (position < tokens.length) {
      const token = tokens[position]!;
      if (level === 0 && (stops.includes(token) || token === ')')) return;
      if (token === '(') level++;
      if (token === ')') level--;
      position++;
    }
  };
  const and = chain(comparison, '&&');
  const or = chain(and, '||');
  const values = or();
  if (position !== tokens.length) throw new Unresolved('unsupported expression syntax');
  return values;
}

/** Every value a workflow setting can take on the context branch, or the reason it cannot be resolved. */
export function resolveWorkflowValue(value: unknown, context: WorkflowValueContext, depth = 0): WorkflowValue {
  if (typeof value !== 'string') return { unresolved: 'a non-string value' };
  if (depth > MAX_DEPTH) return { unresolved: 'deeply nested environment references' };
  const parts = value.split(/(\$\{\{[\s\S]*?\}\})/);
  let results = [''];
  try {
    for (const part of parts) {
      const match = /^\$\{\{([\s\S]*)\}\}$/.exec(part);
      const options = match ? evaluate(match[1]!, context, depth).map(text) : [part];
      results = [...new Set(results.flatMap(prefix => options.map(option => prefix + option)))];
      if (results.length > MAX_VALUES) throw new Unresolved('too many possible values');
    }
  } catch (error) {
    if (error instanceof Unresolved) return { unresolved: error.message };
    throw error;
  }
  return { values: results.map(item => item.trim()) };
}
