import { mkdtempSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FSWatcher } from 'chokidar';
import { generateScenario } from '@foqa/g3x-synth';
import pino from 'pino';
import { loadConfig } from '../src/config.js';
import { dataDirs } from '../src/paths.js';
import { startIngest } from '../src/pipeline/ingest.js';
import { startJobs, type Jobs } from '../src/pipeline/jobs.js';
import { createTestDb, type TestDb } from './helpers/testdb.js';

const config = loadConfig();
let db: TestDb;
let jobs: Jobs;
let watcher: FSWatcher;
let root: string;

const analyzed: number[] = [];

beforeAll(async () => {
  db = await createTestDb();
  root = mkdtempSync(join(tmpdir(), 'foqa-ingest-'));
  const dirs = dataDirs(root);
  jobs = await startJobs({
    pool: db.pool,
    databaseUrl: db.url,
    config,
    log: pino({ level: 'silent' }),
    analyzeFlight: async (id) => {
      analyzed.push(id);
    },
  });
  watcher = startIngest({
    pool: db.pool,
    dirs,
    log: pino({ level: 'silent' }),
    onRawFile: (id) => jobs.enqueueParse(id),
  });
});

afterAll(async () => {
  await watcher.close();
  await jobs.stop();
  await db.teardown();
});

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(500);
  }
  throw new Error('timed out waiting for condition');
}

describe('ingest end-to-end', () => {
  it('drop CSV → archived, parsed, flight created, analyze enqueued; re-drop → deduped', async () => {
    const gen = generateScenario('go-around', { seed: 42 });
    const file = gen.files[0]!;
    writeFileSync(join(root, 'inbox', file.name), file.csv);

    await waitFor(async () => {
      const r = await db.pool.query(`SELECT count(*) FROM flights`);
      return Number(r.rows[0].count) === 1;
    });

    const raw = await db.pool.query('SELECT * FROM raw_files');
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0].status).toBe('parsed');
    expect(raw.rows[0].archive_path).toContain('archive');
    // inbox emptied
    const inbox = await readdir(join(root, 'inbox'));
    expect(inbox.filter((f) => f.endsWith('.csv'))).toHaveLength(0);
    // analyze job ran for the new flight
    await waitFor(async () => analyzed.length >= 1);

    // re-drop the identical file → deduped into inbox/duplicates
    writeFileSync(join(root, 'inbox', `copy-${file.name}`), file.csv);
    await waitFor(async () => {
      const dups = await readdir(join(root, 'inbox', 'duplicates'));
      return dups.length === 1;
    });
    const raw2 = await db.pool.query('SELECT count(*) FROM raw_files');
    expect(Number(raw2.rows[0].count)).toBe(1);
  });
});
