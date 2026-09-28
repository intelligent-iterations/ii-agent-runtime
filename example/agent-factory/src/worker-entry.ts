import { workerMain } from './worker.js';
try { await workerMain(); }
catch { process.stderr.write('Factory worker failed; inspect retained attempt evidence.\n'); process.exitCode = 1; }
