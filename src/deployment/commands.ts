import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { recordDeploymentCommand } from './workspace.js';

export interface CommandOptions { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string | Uint8Array }
export interface CommandExecutor {
  run(binary: string, args: string[], options: CommandOptions): Promise<string>;
  start(binary: string, args: string[], options: CommandOptions, logPath: string): Promise<void>;
}
// The command cannot start until its process group has been recorded. IPC closes
// even after SIGKILL of the owner; the guard then terminates its whole group.
const guardSource = `
const {spawn}=require('node:child_process');
const stop=()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(1)}};
process.once('disconnect',stop);
process.once('message',({binary,args})=>{
  if(!process.connected)return stop();
  const child=spawn(binary,args,{stdio:['inherit','inherit','inherit']});
  child.once('error',stop);
  child.once('close',code=>{
    if(process.connected)process.send({complete:code===0},stop);else stop();
  });
});
`;
/** No shell expansion; bounded output and time. Raw errors never enter operation records. */
export const commands: CommandExecutor = {
  run(binary, args, options) {
    return new Promise((resolve, reject) => {
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw Error('Explicit command timeout is required');
      const child = spawn(process.execPath, ['-e', guardSource], { cwd: options.cwd, env: options.env, detached: true,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', 'ipc'] });
      const decoder = new StringDecoder('utf8');
      let stdout = ''; let bytes = 0; let failed = false; let completed = false;
      const fail = () => {
        failed = true;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Close still determines completion. */ } }
      };
      const timer = setTimeout(fail, options.timeoutMs);
      child.once('spawn', () => {
        if (failed) { fail(); return; }
        try {
          recordDeploymentCommand(options.cwd, child.pid!);
          child.send({ binary, args }, error => { if (error) fail(); });
          if (options.input !== undefined) { child.stdin?.on('error', () => {}); child.stdin?.end(options.input); }
        } catch { fail(); }
      });
      child.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) fail(); else stdout += decoder.write(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) fail(); });
      child.once('message', message => { completed = (message as { complete?: unknown }).complete === true; });
      child.once('error', fail);
      child.once('close', () => {
        clearTimeout(timer);
        if (!failed && completed) resolve(stdout + decoder.end());
        else reject(new Error('External command failed; inspect operation state before retrying'));
      });
    });
  },
  start(binary, args, options, logPath) {
    return new Promise((resolve, reject) => {
      const log = openSync(logPath, 'a', 0o600);
      const child = spawn(binary, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', log, log] });
      closeSync(log);
      child.once('error', () => reject(new Error('VM process could not start')));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  },
};
export function toolEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
