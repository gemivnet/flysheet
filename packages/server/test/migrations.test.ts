import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DERIVED_PARAMS, SAMPLE_PARAMS } from '@foqa/shared';
import { migrate } from '../src/migrate.js';
import { createTestDb, type TestDb } from './helpers/testdb.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.teardown();
});

async function tableColumns(table: string): Promise<string[]> {
  const res = await db.pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return res.rows.map((r) => r.column_name as string);
}

describe('migration 0001', () => {
  it('creates all tables', async () => {
    const res = await db.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    const tables = res.rows.map((r) => r.table_name as string);
    for (const t of [
      'raw_files',
      'flights',
      'log_sessions',
      'samples',
      'samples_derived',
      'flight_phases',
      'events',
      'airports',
      'runways',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('samples columns exactly cover the canonical SAMPLE_PARAMS registry', async () => {
    const cols = await tableColumns('samples');
    for (const p of SAMPLE_PARAMS) expect(cols).toContain(p.name);
    // and nothing beyond registry + keys + extra
    const allowed = new Set([...SAMPLE_PARAMS.map((p) => p.name), 'flight_id', 'ts', 'extra']);
    for (const c of cols) expect(allowed.has(c), `unexpected samples column ${c}`).toBe(true);
  });

  it('samples_derived columns exactly cover DERIVED_PARAMS', async () => {
    const cols = await tableColumns('samples_derived');
    const allowed = new Set([...DERIVED_PARAMS.map((p) => p.name), 'flight_id', 'ts']);
    for (const p of DERIVED_PARAMS) expect(cols).toContain(p.name);
    for (const c of cols) expect(allowed.has(c), `unexpected derived column ${c}`).toBe(true);
  });

  it('migrates down clean and back up', async () => {
    await migrate(db.url, 'down');
    const res = await db.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'flights'`,
    );
    expect(res.rowCount).toBe(0);
    await migrate(db.url, 'up');
    const res2 = await db.pool.query(`SELECT count(*) FROM flights`);
    expect(Number(res2.rows[0].count)).toBe(0);
  });
});
