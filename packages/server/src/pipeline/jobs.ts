import PgBoss from 'pg-boss';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { FoqaConfig } from '../config.js';
import { parseRawFile } from './parseFile.js';

export const QUEUE_PARSE = 'parse-file';
export const QUEUE_ANALYZE = 'analyze-flight';

export interface JobsOptions {
  pool: pg.Pool;
  databaseUrl: string;
  config: FoqaConfig;
  log: Logger;
  /** Stage B implementation; wired by the analyze module. */
  analyzeFlight: (flightId: number) => Promise<void>;
}

export interface Jobs {
  boss: PgBoss;
  enqueueParse: (rawFileId: number) => Promise<void>;
  enqueueAnalyze: (flightId: number) => Promise<void>;
  stop: () => Promise<void>;
}

/** Durable Postgres-native job queue (pg-boss): parse-file → analyze-flight. */
export async function startJobs(opts: JobsOptions): Promise<Jobs> {
  const { pool, config, log } = opts;
  const boss = new PgBoss({ connectionString: opts.databaseUrl });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();
  await boss.createQueue(QUEUE_PARSE);
  await boss.createQueue(QUEUE_ANALYZE);

  const enqueueAnalyze = async (flightId: number): Promise<void> => {
    await boss.send(
      QUEUE_ANALYZE,
      { flightId },
      { retryLimit: 3, retryDelay: 15, singletonKey: String(flightId) },
    );
  };

  await boss.work<{ rawFileId: number }>(QUEUE_PARSE, async (jobs) => {
    for (const job of jobs) {
      const { rawFileId } = job.data;
      const result = await parseRawFile(pool, config, rawFileId);
      log.info(
        { rawFileId, flightId: result.flightId, samples: result.sampleCount, warnings: result.warnings },
        'parsed raw file',
      );
      for (const flightId of result.changedFlightIds) await enqueueAnalyze(flightId);
    }
  });

  await boss.work<{ flightId: number }>(QUEUE_ANALYZE, async (jobs) => {
    for (const job of jobs) {
      await opts.analyzeFlight(job.data.flightId);
      log.info({ flightId: job.data.flightId }, 'analyzed flight');
    }
  });

  return {
    boss,
    enqueueParse: async (rawFileId) => {
      await boss.send(QUEUE_PARSE, { rawFileId }, { retryLimit: 3, retryDelay: 15 });
    },
    enqueueAnalyze,
    stop: () => boss.stop({ graceful: false, wait: false }),
  };
}
