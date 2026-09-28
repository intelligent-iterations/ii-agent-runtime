#!/usr/bin/env node
// Synthetic CLI fixture. It creates no virtual machine and invokes no provider.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [action, ...args] = process.argv.slice(2);
const path = join(process.env.TART_HOME, 'synthetic-vm.json');
const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { present: false };
const persist = () => writeFileSync(path, JSON.stringify(state));
switch (action) {
  case 'clone': state.present = true; state.name = args[1]; state.running = false; state.cpu = 2; state.memory = 2048; persist(); break;
  case 'set': state.cpu = Number(args[2]); state.memory = Number(args[4]); persist(); break;
  case 'list': console.log(JSON.stringify(state.present ? [{ Source: 'local', Name: state.name, Running: state.running }] : [])); break;
  case 'get': console.log(JSON.stringify({ OS: 'linux', CPU: state.cpu, Memory: state.memory, Running: state.running })); break;
  case 'stop': state.running = false; persist(); break;
  case 'delete': state.present = false; persist(); break;
  default: process.exit(1);
}
