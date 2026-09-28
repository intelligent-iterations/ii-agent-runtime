import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runCodeVerification, type CodeVerificationInput } from './code-verifier.js';

if (process.getuid?.() !== 0) throw Error('Verification coordinator requires root inside its dedicated guest');
const envelope = JSON.parse(readFileSync('/opt/factory/workload/attempt.json', 'utf8'));
const input = envelope.input.verification as CodeVerificationInput;
if (input.attemptId !== envelope.attemptId) throw Error('Verification attempt mismatch');
const identity = {
  uid: Number(execFileSync('/usr/bin/id', ['-u', 'agent'], { encoding: 'utf8' }).trim()),
  gid: Number(execFileSync('/usr/bin/id', ['-g', 'agent'], { encoding: 'utf8' }).trim()),
};
const result = await runCodeVerification({ ...input, identity });
if (!result.accepted) process.exitCode = 1;
