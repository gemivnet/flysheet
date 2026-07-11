import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

/**
 * Boots one embedded Postgres for the whole server test run. Individual test
 * files create their own throwaway databases via test/helpers/testdb.ts.
 * (Production runs TimescaleDB in Docker; the migration degrades gracefully.)
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dataDir = mkdtempSync(join(tmpdir(), 'foqa-pgtest-'));
  const port = 55439;
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  project.provide('pgBaseUrl', `postgres://postgres:postgres@127.0.0.1:${port}`);
  return async () => {
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgBaseUrl: string;
  }
}
