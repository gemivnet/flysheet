import { createReadStream } from 'node:fs';
import type pg from 'pg';
import type { FoqaConfig } from '../config.js';
import { withTransaction } from '../db.js';
import { PARSER_VERSION } from '../version.js';
import { parseG3xCsv } from '../parse/g3xParser.js';
import { computeSessionStats, reconcileFlights } from './assemble.js';
import { copySamples, setRawFileStatus } from './storage.js';

export interface ParseFileResult {
  rawFileId: number;
  sessionId: number | null;
  flightId: number | null;
  sampleCount: number;
  warnings: string[];
  /** Flights needing (re)analysis after this parse. */
  changedFlightIds: number[];
}

/**
 * Stage A for one raw file: archive CSV → canonical samples + session row +
 * flight reconciliation, in a single transaction. Idempotent: an earlier
 * session for the same raw file (crashed retry, forced reparse) is replaced.
 */
export async function parseRawFile(
  pool: pg.Pool,
  config: FoqaConfig,
  rawFileId: number,
): Promise<ParseFileResult> {
  const fileRes = await pool.query('SELECT * FROM raw_files WHERE id = $1', [rawFileId]);
  const rawFile = fileRes.rows[0];
  if (!rawFile) throw new Error(`raw_file ${rawFileId} not found`);

  try {
    const parsed = await parseG3xCsv(
      createReadStream(rawFile.archive_path as string),
      config.parameterMap,
    );
    if (parsed.samples.length === 0) {
      await setRawFileStatus(pool, rawFileId, 'quarantined', 'no parseable samples');
      return {
        rawFileId,
        sessionId: null,
        flightId: null,
        sampleCount: 0,
        warnings: parsed.warnings,
        changedFlightIds: [],
      };
    }
    const stats = computeSessionStats(parsed.samples, config.aircraft);

    return await withTransaction(pool, async (client) => {
      // Replace any earlier parse of this file (idempotence).
      const old = await client.query(
        'SELECT id, flight_id, start_ts, end_ts FROM log_sessions WHERE raw_file_id = $1',
        [rawFileId],
      );
      for (const row of old.rows) {
        if (row.flight_id !== null) {
          await client.query(
            'DELETE FROM samples WHERE flight_id = $1 AND ts BETWEEN $2 AND $3',
            [row.flight_id, row.start_ts, row.end_ts],
          );
        }
        await client.query('DELETE FROM log_sessions WHERE id = $1', [row.id]);
      }

      const ins = await client.query(
        `INSERT INTO log_sessions
           (raw_file_id, start_ts, end_ts, sample_count, first_move_ts, last_move_ts,
            first_airborne, last_airborne, start_lat, start_lon, end_lat, end_lon, parser_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          rawFileId,
          stats.startTs,
          stats.endTs,
          stats.sampleCount,
          stats.firstMoveTs,
          stats.lastMoveTs,
          stats.firstAirborneTs,
          stats.lastAirborneTs,
          stats.startLat,
          stats.startLon,
          stats.endLat,
          stats.endLon,
          PARSER_VERSION,
        ],
      );
      const sessionId = ins.rows[0].id as number;

      const { changedFlightIds } = await reconcileFlights(client, config.aircraft, PARSER_VERSION);

      const sess = await client.query('SELECT flight_id FROM log_sessions WHERE id = $1', [sessionId]);
      const flightId = (sess.rows[0]?.flight_id as number | null) ?? null;
      if (flightId !== null) await copySamples(client, flightId, parsed.samples);

      await client.query(
        `UPDATE raw_files SET status = 'parsed', error = NULL, g3x_metadata = $2 WHERE id = $1`,
        [rawFileId, JSON.stringify(parsed.metadata)],
      );

      return {
        rawFileId,
        sessionId,
        flightId,
        sampleCount: parsed.samples.length,
        warnings: parsed.warnings,
        changedFlightIds,
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setRawFileStatus(pool, rawFileId, 'failed', message);
    throw err;
  }
}
