import { createTelemetryCollector, createSqliteTelemetryStore, type TelemetryOptions } from '@intelligent-iterations/ii-agent-runtime';
/** This example selects local SQLite; the runtime collector accepts any supplied store. */
export function createFactoryTelemetry(options: Omit<TelemetryOptions, 'openStore'> & { database: string }) {
  const { database, ...collector } = options;
  return createTelemetryCollector({ ...collector, openStore: () => createSqliteTelemetryStore(database) });
}
