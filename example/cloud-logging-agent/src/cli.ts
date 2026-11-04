import { main } from './app.js';

// Setup mistakes print one plain line, never a stack trace.
main(process.argv.slice(2)).then(code => { process.exitCode = code; },
  error => { console.error(error instanceof Error ? error.message : 'Cloud Logging run failed'); process.exitCode = 1; });
