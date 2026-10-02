import { colorSupported, decorate, palette } from './style.js';

/** Terminal progress: every slow step says what it is doing, how far along it is, and when GitHub is the one being slow. */
export interface ProgressTask {
  /** One unit of work finished; `detail` names it, for example the repository just handled. */
  tick(detail?: string): void;
  /** A line that stays in the scrollback, such as a skipped repository. */
  note(text: string): void;
  done(summary?: string): void;
  fail(summary: string): void;
}
export interface Progress {
  line(text: string): void;
  task(label: string, total?: number): ProgressTask;
}
interface Output { write(text: string): unknown; isTTY?: boolean }

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function createProgress(output: Output = process.stdout, options: { now?: () => number; heartbeatMs?: number; quietMs?: number; color?: boolean } = {}): Progress {
  const now = options.now ?? Date.now;
  const tty = output.isTTY === true;
  const style = palette(options.color ?? colorSupported(output));
  const quietMs = options.quietMs ?? 10000;
  let active: { render(): string } | undefined;
  const clear = () => { if (tty && active) output.write('\r\x1b[2K'); };
  const draw = () => { if (tty && active) output.write(`\r\x1b[2K${active.render()}`); };
  return {
    line(text) { clear(); output.write(`${decorate(text, style)}\n`); draw(); },
    task(label, total) {
      const started = now();
      let completed = 0, frame = 0, last = started, detail = '', finished = false;
      const state = {
        render() {
          const parts: string[] = [];
          if (total !== undefined) parts.push(`${completed}/${total}`);
          if (detail) parts.push(detail);
          const quiet = now() - last;
          const waiting = quiet >= quietMs ? `still waiting on GitHub (${duration(quiet)})` : '';
          if (!waiting && total !== undefined && completed >= 3 && completed < total) parts.push(`about ${duration((now() - started) / completed * (total - completed))} left`);
          const tail = [...parts.map(part => style.dim(part)), ...(waiting ? [style.yellow(waiting)] : [])];
          return [`${style.cyan(frames[frame++ % frames.length]!)} ${label}`, ...tail].join(style.dim(' · '));
        },
      };
      if (active) clear();
      active = state;
      if (tty) draw(); else output.write(`${label}${total !== undefined ? ` (${total})` : ''}...\n`);
      const timer = tty ? setInterval(draw, options.heartbeatMs ?? 250) : undefined;
      timer?.unref?.();
      const finish = (mark: string, text: string) => {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        clear();
        if (active === state) active = undefined;
        output.write(`${decorate(`${mark} ${text}`, style)}\n`);
        draw();
      };
      return {
        tick(name) { completed++; last = now(); detail = name ?? ''; if (tty) draw(); },
        note(text) { last = now(); clear(); output.write(`  ${decorate(text, style)}\n`); draw(); },
        done(summary) { finish('✓', summary ?? `${label} (${duration(now() - started)})`); },
        fail(summary) { finish('✗', summary); },
      };
    },
  };
}
