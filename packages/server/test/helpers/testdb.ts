import { inject } from 'vitest';
import pg from 'pg';
import { createPool } from '../../src/db.js';
import { migrate } from '../../src/migrate.js';

let dbCounter = 0;

export interface TestDb {
  url: string;
  pool: pg.Pool;
  teardown: () => Promise<void>;
}

/** Create a fresh migrated database on the shared embedded-postgres instance. */
export async function createTestDb(): Promise<TestDb> {
  const baseUrl = inject('pgBaseUrl');
  const name = `foqa_test_${process.pid}_${dbCounter++}`;
  const admin = new pg.Client({ connectionString: `${baseUrl}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = `${baseUrl}/${name}`;
  await migrate(url, 'up');
  const pool = createPool(url);
  return {
    url,
    pool,
    teardown: async () => {
      await pool.end();
    },
  };
}
