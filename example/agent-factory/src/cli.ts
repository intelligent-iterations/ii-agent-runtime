#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createFactory, type FactoryConfig } from './index.js';
import { launchFactory } from './launch.js';
import { createAccessLedger } from './access-ledger.js';
import { assessCapabilityGrant } from '@intelligent-iterations/ii-agent-runtime';
import { ingestInstallationWebhook, recordInstallationReview } from './installation-audit.js';
import { loadFactoryAppConfig, openFactoryApp } from './factory-app-auth.js';
import { createGitHubApp } from './github-app.js';

const usage = `Setup: run ./setup.sh from example/agent-factory
Launch: ii-factory launch [INSTALLATION_DIRECTORY]
Access: ii-factory access list INSTALLATION_DIRECTORY
        ii-factory access history INSTALLATION_DIRECTORY [GRANT_ID]
        ii-factory access webhook INSTALLATION_DIRECTORY EVENT DELIVERY_ID SIGNATURE BODY_FILE SECRET_FILE
        ii-factory access review INSTALLATION_DIRECTORY REPOSITORY INSTALLATION_ID ACTION ACTOR OCCURRED_AT AUDIT_EVENT_ID
        ii-factory access installations INSTALLATION_DIRECTORY
        ii-factory access sync INSTALLATION_DIRECTORY APP_CONFIG_PATH

Usage: ii-factory <config.json> <command>
  spawn <name> <role> <task> [repository base-commit]
  list
  permissions [agent-id]
  status <agent-id>
  cancel <agent-id>
  result <agent-id> [timeout-ms]

Uses the local durable work database. A separately running factory controller
executes submitted work. Relative database paths resolve beside config.json.`;

async function main(args: string[]) {
  if (args[0] === 'launch') {
    if (args.length > 2) throw Error(usage);
    const cancellation = new AbortController();
    const stop = () => cancellation.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const result = await launchFactory(args[1] ?? '.factory', { signal: cancellation.signal, report: value => console.log(JSON.stringify(value, null, 2)) });
      if (!result.accepted) process.exitCode = 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  if (args[0] === 'access') {
    const [action, directory, ...parameters] = args.slice(1);
    if (!directory || !['list', 'history', 'webhook', 'review', 'installations', 'sync'].includes(action ?? '')) throw Error(usage);
    const installationPath = join(resolve(directory), 'installation.json');
    const installation = existsSync(installationPath) ? JSON.parse(readFileSync(installationPath, 'utf8')) : { directory: 'state' };
    if (action === 'sync') {
      if (parameters.length !== 1) throw Error(usage);
      const handle = openFactoryApp(resolve(parameters[0]!), join(resolve(directory), installation.directory));
      try { console.log(JSON.stringify({ recorded: await handle.app.syncDeliveries(), installations: handle.ledger.installationEvents() }, null, 2)); }
      finally { handle.close(); }
      return;
    }
    const ledger = createAccessLedger(join(resolve(directory, installation.directory), 'access'));
    try {
      let value: unknown;
      if (action === 'webhook') {
        if (parameters.length !== 5) throw Error(usage);
        const [event, deliveryId, signature, bodyFile, secretFile] = parameters as [string, string, string, string, string];
        const stat = lstatSync(resolve(secretFile));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw Error('Unsafe webhook secret file');
        value = { recorded: ingestInstallationWebhook(ledger, { event, deliveryId, signature,
          body: readFileSync(resolve(bodyFile)), secret: readFileSync(resolve(secretFile), 'utf8').trim() }) };
      } else if (action === 'review') {
        if (parameters.length !== 6) throw Error(usage);
        const [repository, installationId, reviewedAction, actor, occurredAt, auditEventId] = parameters as [string, string, string, string, string, string];
        recordInstallationReview(ledger, { repository, installationId: Number(installationId), action: reviewedAction as 'granted' | 'removed',
          actor, occurredAt, auditEventId });
        value = ledger.latestInstallation(repository);
      } else if (action === 'installations') {
        if (parameters.length) throw Error(usage);
        value = ledger.installationEvents();
      } else if (action === 'history') {
        if (parameters.length > 1) throw Error(usage);
        value = ledger.events(parameters[0]);
      } else {
        if (parameters.length) throw Error(usage);
        let reconciliation: 'verified' | 'unknown' | 'not_configured' = 'not_configured';
        if (installation.appConfigPath) {
          try { await createGitHubApp(loadFactoryAppConfig(installation.appConfigPath), ledger).syncDeliveries(); reconciliation = 'verified'; }
          catch { reconciliation = 'unknown'; }
        }
        value = { reconciliation, grants: ledger.current().map(grant => {
          const findings = assessCapabilityGrant(grant, new Date(), 300_000);
          const installationEvent = ledger.latestInstallation(grant.resource);
          if (grant.provider === 'github-app' && !grant.endedAt && (!installationEvent || installationEvent.action !== 'granted' ||
              (grant.grantedAt && installationEvent.at > grant.grantedAt))) findings.push({ grantId: grant.id, reason: 'unverified' });
          if (grant.provider === 'github-app' && !grant.endedAt && reconciliation !== 'verified') findings.push({ grantId: grant.id, reason: 'stale' });
          return { grant, findings };
        }) };
      }
      console.log(JSON.stringify(value, null, 2));
    } finally { ledger.close(); }
    return;
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return; }
  const [configPath, command, ...rest] = args;
  if (!configPath || !command) throw Error(usage);
  const arities: Record<string, number[]> = { spawn: [3, 5], list: [0], permissions: [0, 1], status: [1], cancel: [1], result: [1, 2] };
  if (!Object.hasOwn(arities, command) || !arities[command]!.includes(rest.length)) throw Error(usage);
  const timeoutMs = rest[1] === undefined ? undefined : Number(rest[1]);
  if (command === 'result' && timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw Error('Timeout must be a positive integer in milliseconds');
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as FactoryConfig;
  config.database = resolve(dirname(resolve(configPath)), config.database);
  const factory = createFactory(config);
  const interrupt = new AbortController();
  const stop = () => interrupt.abort(new Error('Result wait interrupted; agent state is unchanged'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    let value: unknown;
    switch (command) {
      case 'spawn': value = factory.spawn(rest[0]!, { role: rest[1]!, task: rest[2]!,
        ...(rest[3] === undefined ? {} : { repository: rest[3], baseCommit: rest[4]! }) }).inspect(); break;
      case 'list': value = factory.list(); break;
      case 'permissions': value = rest[0] === undefined ? factory.permissions() : factory.agent(rest[0]).permissions(); break;
      case 'status': value = factory.agent(rest[0]!).inspect(); break;
      case 'cancel': { const agent = factory.agent(rest[0]!); agent.cancel(); value = agent.inspect(); break; }
      case 'result': value = await factory.agent(rest[0]!).result({ signal: interrupt.signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) }); break;
    }
    console.log(JSON.stringify(value, null, 2));
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); factory.close();
  }
}

main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : 'Factory command failed'); process.exitCode = 1; });
