import {resolve} from 'node:path';

export type Editor = 'hyperframes' | 'remotion' | 'moviepy';
export interface Configuration {
  editor: Editor; image: string; workspaceHelperImage?: string; project: string; inputs: string[]; command: string[]; output: string;
  cpu: number; memoryMiB: number; diskGiB: number; timeoutSeconds: number;
  maxInputMiB: number; maxOutputMiB: number; expectedVideos: number;
}
export class ConfigurationError extends Error {
  constructor(readonly problems: string[]) { super(problems.join('\n')); }
}
export function configuration(value: unknown, directory: string, overrides: {image?: string} = {}): Configuration {
  const supplied = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const c: Record<string, unknown> = {...supplied, ...(overrides.image && supplied.image === undefined ? {image: overrides.image} : {})};
  const errors: string[] = [];
  const allowed = new Set(['editor','image','workspaceHelperImage','project','inputs','command','output','cpu','memoryMiB','diskGiB','timeoutSeconds','maxInputMiB','maxOutputMiB','expectedVideos']);
  for (const key of Object.keys(c)) if (!allowed.has(key)) errors.push(`Unknown setting ${key}.`);
  if (!['hyperframes','remotion','moviepy'].includes(String(c.editor))) errors.push('editor: choose hyperframes, remotion or moviepy.');
  if (typeof c.image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(c.image) || c.image.length > 512) errors.push('image: supply your editor image including its @sha256 digest, or leave image out and npm run demo builds one.');
  if (c.workspaceHelperImage !== undefined && (typeof c.workspaceHelperImage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(c.workspaceHelperImage))) errors.push('workspaceHelperImage: supply an immutable image with GNU util-linux and e2fsprogs, or omit it to use image.');
  for (const key of ['project','output']) if (typeof c[key] !== 'string' || !c[key] || /[\0\r\n]/.test(c[key] as string)) errors.push(`${key}: supply a directory path.`);
  if (!Array.isArray(c.inputs) || !c.inputs.length || c.inputs.length > 128 || c.inputs.some(p => typeof p !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./ -]*$/.test(p) || p.split('/').some(v => !v || v.startsWith('.')))) errors.push('inputs: list relative files/directories inside project, without dotfiles or parent paths.');
  if (!Array.isArray(c.command) || !c.command.length || c.command.length > 128 || c.command.some(p => typeof p !== 'string' || !p || p.length > 8192 || p.includes('\0'))) errors.push('command: supply an executable and its arguments as a JSON array.');
  for (const [key,min,max] of [['cpu',1,4],['memoryMiB',256,8192],['diskGiB',1,80],['timeoutSeconds',240,7200],['maxInputMiB',1,480],['maxOutputMiB',1,240],['expectedVideos',1,32]] as const) {
    const n = c[key]; if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) errors.push(`${key}: choose an integer from ${min} to ${max}.`);
  }
  if (errors.length) throw new ConfigurationError(errors);
  return {...c,project:resolve(directory,c.project as string),output:resolve(directory,c.output as string)} as unknown as Configuration;
}
