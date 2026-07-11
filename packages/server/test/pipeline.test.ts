import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateScenario, simulateScenario } from '@foqa/g3x-synth';
import { loadConfig } from '../src/config.js';
import { parseRawFile } from '../src/pipeline/parseFile.js';
import { insertRawFile } from '../src/pipeline/storage.js';
import { createTestDb, type TestDb } from './helpers/testdb.js';

const config = loadConfig();
let db: TestDb;
let fixtureDir: string;

beforeAll(async () => {
  db = await createTestDb();
  fixtureDir = mkdtempSync(join(tmpdir(), 'foqa-fixtures-'));
});
afterAll(async () => {
  await db.teardown();
});

async function registerFile(name: string, csv: string, salt = ''): Promise<number> {
  const path = join(fixtureDir, name);
  writeFileSync(path, csv);
  const row = await insertRawFile(db.pool, {
    sha256: `test-${name}-${salt}-${csv.length}`,
    originalName: name,
    archivePath: path,
    sizeBytes: csv.length,
  });
  return row!.id;
}

describe('parseRawFile + flight assembly', () => {
  it('one clean file → one flight with all samples', async () => {
    const sim = simulateScenario('pattern-work', 42);
    const gen = generateScenario('pattern-work', { seed: 42 });
    const rawId = await registerFile(gen.files[0]!.name, gen.files[0]!.csv);
    const result = await parseRawFile(db.pool, config, rawId);

    expect(result.flightId).not.toBeNull();
    expect(result.sampleCount).toBe(sim.length);
    const flight = (await db.pool.query('SELECT * FROM flights WHERE id = $1', [result.flightId])).rows[0];
    expect(flight.stitched).toBe(false);
    expect(flight.status).toBe('parsed');
    const count = await db.pool.query('SELECT count(*) FROM samples WHERE flight_id = $1', [result.flightId]);
    expect(Number(count.rows[0].count)).toBe(sim.length);
    // extra jsonb carries the unmapped AltB column
    const one = await db.pool.query(
      `SELECT extra FROM samples WHERE flight_id = $1 LIMIT 1`,
      [result.flightId],
    );
    expect(one.rows[0].extra.AltB).toBeDefined();
    const file = (await db.pool.query('SELECT status, g3x_metadata FROM raw_files WHERE id = $1', [rawId])).rows[0];
    expect(file.status).toBe('parsed');
    expect(file.g3x_metadata.airframe_name).toBe('RV-12');
  });

  it('reparsing the same file is idempotent (new flight id, same content, no leftovers)', async () => {
    const gen = generateScenario('normal-xc', { seed: 42 });
    const rawId = await registerFile(gen.files[0]!.name, gen.files[0]!.csv);
    const r1 = await parseRawFile(db.pool, config, rawId);
    const r2 = await parseRawFile(db.pool, config, rawId);
    expect(r2.sampleCount).toBe(r1.sampleCount);
    // reparse replaces the flight; the old one must be gone entirely
    const flights = await db.pool.query('SELECT id, start_ts, end_ts FROM flights ORDER BY id');
    // pattern-work flight from previous test + exactly one xc flight
    expect(flights.rows).toHaveLength(2);
    expect(flights.rows.map((r) => r.id)).not.toContain(r1.flightId);
    const count = await db.pool.query('SELECT count(*) FROM samples WHERE flight_id = $1', [
      r2.flightId,
    ]);
    expect(Number(count.rows[0].count)).toBe(r2.sampleCount);
    const orphanSamples = await db.pool.query(
      'SELECT count(*) FROM samples WHERE flight_id = $1',
      [r1.flightId],
    );
    expect(Number(orphanSamples.rows[0].count)).toBe(0);
  });
});

describe('stitching (power-interruption)', () => {
  it('two files, in order → one stitched flight', async () => {
    const local = await createTestDb();
    try {
      const sim = simulateScenario('power-interruption', 42);
      const gen = generateScenario('power-interruption', { seed: 42 });
      expect(gen.files).toHaveLength(2);
      const totalWritten = gen.files.reduce((n, f) => n + f.csv.trimEnd().split('\n').length - 3, 0);
      expect(totalWritten).toBe(sim.length - 45); // 45 s gap dropped

      let flightId: number | null = null;
      for (const f of gen.files) {
        const path = join(fixtureDir, `inorder-${f.name}`);
        writeFileSync(path, f.csv);
        const row = await insertRawFile(local.pool, {
          sha256: `stitch-${f.name}`,
          originalName: f.name,
          archivePath: path,
          sizeBytes: f.csv.length,
        });
        const res = await parseRawFile(local.pool, config, row!.id);
        flightId = res.flightId ?? flightId;
      }
      const flights = await local.pool.query('SELECT * FROM flights');
      expect(flights.rows).toHaveLength(1);
      expect(flights.rows[0].stitched).toBe(true);
      const count = await local.pool.query('SELECT count(*) FROM samples WHERE flight_id = $1', [
        flights.rows[0].id,
      ]);
      expect(Number(count.rows[0].count)).toBe(totalWritten);
    } finally {
      await local.teardown();
    }
  });

  it('two files, reverse order → same single stitched flight (order independence)', async () => {
    const local = await createTestDb();
    try {
      const gen = generateScenario('power-interruption', { seed: 42 });
      for (const f of [...gen.files].reverse()) {
        const path = join(fixtureDir, `reverse-${f.name}`);
        writeFileSync(path, f.csv);
        const row = await insertRawFile(local.pool, {
          sha256: `stitch-rev-${f.name}`,
          originalName: f.name,
          archivePath: path,
          sizeBytes: f.csv.length,
        });
        await parseRawFile(local.pool, config, row!.id);
      }
      const flights = await local.pool.query('SELECT * FROM flights');
      expect(flights.rows).toHaveLength(1);
      expect(flights.rows[0].stitched).toBe(true);
      const sessions = await local.pool.query(
        'SELECT flight_id FROM log_sessions ORDER BY start_ts',
      );
      expect(sessions.rows).toHaveLength(2);
      expect(sessions.rows[0].flight_id).toBe(sessions.rows[1].flight_id);
    } finally {
      await local.teardown();
    }
  });
});
