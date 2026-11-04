// Stands in for api.github.com in npm run test:demo. Load it before the CLI with node --import. It replaces fetch
// with the GitHub API responses recorded for the demo repository (fixtures/demo-github-responses.json) and refuses
// every request it has no recording for. The CLI, its arguments and the grants files are the demo's own.
//
// GITHUB_RECORD=1 records instead: GET requests go to api.github.com with the caller's GITHUB_TOKEN, and when the
// process exits, each response's URL, status and body replace the recording. Headers and the token are never kept,
// and a commit response keeps only its sha.
// GITHUB_REQUEST_LOG=<file> writes every request the process made, so a test can prove which calls the demo makes.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../fixtures/demo-github-responses.json', import.meta.url);
const record = process.env.GITHUB_RECORD === '1';
const github = globalThis.fetch;
const responses = record ? [] : JSON.parse(readFileSync(file, 'utf8')).responses;
const requested = [];
const json = { 'content-type': 'application/json' };
// Recorded bodies are escaped to ASCII, so the fixture stays plain text whatever the repository contains.
const ascii = text => text.replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  requested.push(`${method} ${url}`);
  if (record) {
    if (method !== 'GET' || new URL(url).origin !== 'https://api.github.com') throw Error(`Not recorded: ${method} ${url} is not a GitHub API read`);
    const response = await github(input, init);
    const body = await response.text();
    // The commit response names its author; the checker reads only its sha, so only the sha is kept.
    const parsed = JSON.parse(body), kept = /\/commits\/[^/]+$/.test(new URL(url).pathname) && response.ok ? { sha: parsed.sha } : parsed;
    if (!responses.some(item => item.url === url)) responses.push({ url, status: response.status, body: kept });
    return new Response(body, { status: response.status, headers: json });
  }
  const recorded = method === 'GET' ? responses.find(item => item.url === url) : undefined;
  if (!recorded) {
    process.stderr.write(`Refused: no recorded GitHub response for ${method} ${url}\n`);
    throw Error(`No recorded GitHub response for ${method} ${url}`);
  }
  return new Response(JSON.stringify(recorded.body), { status: recorded.status, headers: json });
};

process.on('exit', () => {
  if (process.env.GITHUB_REQUEST_LOG) writeFileSync(process.env.GITHUB_REQUEST_LOG, JSON.stringify(requested));
  if (record && responses.length) writeFileSync(file, ascii(JSON.stringify({ recordedAt: new Date().toISOString(),
    note: 'GitHub API responses (URL, status, body) from a read-only run of npm run demo, recorded by test/recorded-github.mjs.',
    responses }, null, 2)) + '\n');
});
