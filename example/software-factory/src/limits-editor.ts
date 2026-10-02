/** Interactive editing of the hub policy's launch rules and limits. Enter keeps the value shown in brackets. */
import { HUB_JOB_OVERHEAD_MINUTES } from './identity.js';

export class LimitError extends Error {}

const dollars = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;
function whole(answer: string, minimum: number, maximum: number, what: string): number {
  const value = Number(answer);
  if (!/^\d+$/.test(answer) || value < minimum || value > maximum) throw new LimitError(`Enter a whole number of ${what} from ${minimum} to ${maximum}.`);
  return value;
}
function money(answer: string, what: string): number {
  const match = /^\$?\s*(\d{1,6}(?:\.\d{1,2})?)$/.exec(answer);
  const micro = match ? Math.round(Number(match[1]) * 1e6) : 0;
  if (!micro) throw new LimitError(`Enter ${what} in US dollars, for example 20 or 7.50.`);
  return micro;
}

export interface LimitQuestion { prompt: string; current: string; apply(policy: Record<string, any>, answer: string): void }

/** The questions, in order. Later questions depend on earlier answers, so the list is rebuilt after each one. */
export function limitQuestions(policy: Record<string, any>): LimitQuestion[] {
  const launch = policy.launchPolicy, limits = policy.limits;
  const questions: LimitQuestion[] = [
    { prompt: 'Who starts an agent? 1 = the issue author, 2 = someone who adds a label', current: launch.mode === 'maintainer-approval' ? '2' : '1',
      apply: (p, answer) => {
        if (!['1', '2'].includes(answer)) throw new LimitError('Enter 1 or 2.');
        p.launchPolicy = answer === '2' ? { mode: 'maintainer-approval', minimumPermission: p.launchPolicy.minimumPermission, label: p.launchPolicy.label ?? 'agent:run' }
          : { mode: 'authorized-author', minimumPermission: p.launchPolicy.minimumPermission };
      } },
  ];
  if (launch.mode === 'maintainer-approval') questions.push({ prompt: 'Approval label (must start with "agent")', current: launch.label,
    apply: (p, answer) => {
      if (!/^agent[A-Za-z0-9:._-]{0,45}$/.test(answer)) throw new LimitError('The label must start with "agent" and use letters, numbers, ":", ".", "_" or "-" (up to 50 characters).');
      p.launchPolicy.label = answer;
    } });
  questions.push(
    { prompt: `Access to the named repository needed to ${launch.mode === 'maintainer-approval' ? 'approve' : 'start'} (write, maintain or admin)`, current: launch.minimumPermission,
      apply: (p, answer) => {
        if (!['write', 'maintain', 'admin'].includes(answer)) throw new LimitError('Enter write, maintain or admin.');
        p.launchPolicy.minimumPermission = answer;
      } },
    { prompt: 'Agents running at once, across the organization (1-10)', current: String(limits.maxConcurrent), apply: (p, a) => { p.limits.maxConcurrent = whole(a, 1, 10, 'agents'); } },
    { prompt: 'Agent runs per issue (1-10)', current: String(limits.maxRunsPerIssue), apply: (p, a) => { p.limits.maxRunsPerIssue = whole(a, 1, 10, 'runs'); } },
    { prompt: 'Agent runs per month, across the organization (1-1000)', current: String(limits.maxRunsPerMonth), apply: (p, a) => { p.limits.maxRunsPerMonth = whole(a, 1, 1000, 'runs'); } },
    { prompt: 'Minutes one run may take (1-55)', current: String(limits.timeoutMinutes), apply: (p, a) => { p.limits.timeoutMinutes = whole(a, 1, 55, 'minutes'); } },
    { prompt: 'Model budget per run (USD)', current: (limits.maxModelCostMicrousdPerRun / 1e6).toFixed(2), apply: (p, a) => { p.limits.maxModelCostMicrousdPerRun = money(a, 'the per-run model budget'); } },
    { prompt: 'Total budget per month, across the organization (USD)', current: (limits.maxCostMicrousdPerMonth / 1e6).toFixed(2), apply: (p, a) => { p.limits.maxCostMicrousdPerMonth = money(a, 'the monthly budget'); } },
  );
  return questions;
}

/** Each run reserves its model budget plus runner time up front, so a month must fit at least one run. */
export function checkLimits(policy: Record<string, any>): void {
  const limits = policy.limits;
  const perRun = limits.maxModelCostMicrousdPerRun + (limits.timeoutMinutes + HUB_JOB_OVERHEAD_MINUTES) * limits.runnerMicrousdPerMinute;
  if (perRun > limits.maxCostMicrousdPerMonth) throw new LimitError(`One run reserves up to ${dollars(perRun)} (model ${dollars(limits.maxModelCostMicrousdPerRun)} plus ${limits.timeoutMinutes + HUB_JOB_OVERHEAD_MINUTES} runner minutes), more than the monthly budget of ${dollars(limits.maxCostMicrousdPerMonth)}, so every run would be refused. Raise the monthly budget or lower the per-run budget or minutes.`);
}

export async function editLimits(start: Record<string, any>, ask: (question: string) => Promise<string>, report: (message: string) => void): Promise<Record<string, any>> {
  for (;;) {
    const policy = structuredClone(start);
    for (let index = 0; ; index++) {
      const question = limitQuestions(policy)[index];
      if (!question) break;
      for (;;) {
        const answer = (await ask(`? ${question.prompt} [${question.current}]: `)).trim();
        try { question.apply(policy, answer || question.current); break; }
        catch (error) { if (!(error instanceof LimitError)) throw error; report(`✗ ${error.message}`); }
      }
    }
    try { checkLimits(policy); return policy; }
    catch (error) { if (!(error instanceof LimitError)) throw error; report(`✗ ${error.message}`); start = policy; }
  }
}
