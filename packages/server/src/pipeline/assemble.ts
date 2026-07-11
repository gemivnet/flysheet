import type pg from 'pg';
import { haversineNm, type AircraftConfig, type Sample } from '@foqa/shared';

/**
 * Flight assembly: group log sessions (power cycles) into flights and
 * reconcile the flights table. Runs as a global idempotent pass — the result
 * is independent of file arrival order, which makes reprocessing and
 * out-of-order ingest trivial.
 */

/** gs above this = definitely not taxiing (used as the "airborne" stitch hint). */
const AIRBORNE_GS_KT = 40;
/** Session ended airborne if the last airborne sample is within this of the end. */
const ENDED_AIRBORNE_SLOP_S = 15;

export interface SessionStats {
  startTs: Date;
  endTs: Date;
  sampleCount: number;
  firstMoveTs: Date | null;
  lastMoveTs: Date | null;
  firstAirborneTs: Date | null;
  lastAirborneTs: Date | null;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
}

/** Movement = gs > threshold sustained for `sustainS` consecutive seconds. */
export function computeSessionStats(samples: Sample[], aircraft: AircraftConfig): SessionStats {
  if (samples.length === 0) throw new Error('empty session');
  const gsAt = (i: number) => samples[i]!.values.gs_kt ?? 0;
  const { moving_gs_kt, moving_sustain_s } = aircraft.phases;

  let firstMove: Date | null = null;
  let lastMove: Date | null = null;
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    if (gsAt(i) > moving_gs_kt) {
      run++;
      if (run >= moving_sustain_s && firstMove === null) firstMove = samples[i - run + 1]!.ts;
      if (run >= moving_sustain_s) lastMove = samples[i]!.ts;
    } else {
      run = 0;
    }
  }
  let firstAirborne: Date | null = null;
  let lastAirborne: Date | null = null;
  for (const s of samples) {
    if ((s.values.gs_kt ?? 0) > AIRBORNE_GS_KT) {
      firstAirborne ??= s.ts;
      lastAirborne = s.ts;
    }
  }
  const first = samples[0]!;
  const last = samples.at(-1)!;
  return {
    startTs: first.ts,
    endTs: last.ts,
    sampleCount: samples.length,
    firstMoveTs: firstMove,
    lastMoveTs: lastMove,
    firstAirborneTs: firstAirborne,
    lastAirborneTs: lastAirborne,
    startLat: first.values.lat ?? null,
    startLon: first.values.lon ?? null,
    endLat: last.values.lat ?? null,
    endLon: last.values.lon ?? null,
  };
}

export interface SessionRow {
  id: number;
  raw_file_id: number;
  start_ts: Date;
  end_ts: Date;
  sample_count: number;
  first_move_ts: Date | null;
  last_move_ts: Date | null;
  first_airborne: Date | null;
  last_airborne: Date | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
  flight_id: number | null;
}

function endedAirborne(s: SessionRow): boolean {
  return (
    s.last_airborne !== null &&
    s.end_ts.getTime() - s.last_airborne.getTime() < ENDED_AIRBORNE_SLOP_S * 1000
  );
}

/** Pure grouping: sessions sorted by start_ts → stitched groups. */
export function groupSessions(sessions: SessionRow[], aircraft: AircraftConfig): SessionRow[][] {
  const sorted = [...sessions].sort((a, b) => a.start_ts.getTime() - b.start_ts.getTime());
  const groups: SessionRow[][] = [];
  for (const s of sorted) {
    const current = groups.at(-1);
    const prev = current?.at(-1);
    if (
      prev &&
      endedAirborne(prev) &&
      s.start_ts.getTime() - prev.end_ts.getTime() < aircraft.stitching.max_gap_s * 1000 &&
      prev.end_lat !== null &&
      prev.end_lon !== null &&
      s.start_lat !== null &&
      s.start_lon !== null &&
      haversineNm(prev.end_lat, prev.end_lon, s.start_lat, s.start_lon) <
        aircraft.stitching.max_dist_nm
    ) {
      current!.push(s);
    } else {
      groups.push([s]);
    }
  }
  return groups;
}

export interface ReconcileResult {
  /** Flights whose composition or bounds changed (need [re]analysis). */
  changedFlightIds: number[];
}

/**
 * Reconcile the flights table with the current session grouping, inside the
 * caller's transaction. Creates flights for new groups, merges flights when a
 * late-arriving file joins two, updates bounds, deletes orphaned flights.
 */
export async function reconcileFlights(
  client: pg.PoolClient,
  aircraft: AircraftConfig,
  parserVersion: number,
): Promise<ReconcileResult> {
  const res = await client.query('SELECT * FROM log_sessions ORDER BY start_ts');
  const sessions = res.rows as SessionRow[];
  const groups = groupSessions(sessions, aircraft);
  const changed = new Set<number>();
  const keptFlightIds = new Set<number>();

  for (const group of groups) {
    const withMovement = group.filter((s) => s.first_move_ts !== null);
    if (withMovement.length === 0) continue; // engine-run only, no flight

    const startTs = withMovement[0]!.first_move_ts!;
    const endTs = withMovement.at(-1)!.last_move_ts!;
    const takeoffTs = group.map((s) => s.first_airborne).find((t) => t !== null) ?? null;
    const landingTs = [...group].reverse().map((s) => s.last_airborne).find((t) => t !== null) ?? null;
    const stitched = group.length > 1;

    const existingIds = [...new Set(group.map((s) => s.flight_id).filter((v): v is number => v !== null))];
    let flightId: number;
    if (existingIds.length === 0) {
      const ins = await client.query(
        `INSERT INTO flights (start_ts, end_ts, takeoff_ts, landing_ts, stitched, parser_version, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'parsed') RETURNING id`,
        [startTs, endTs, takeoffTs, landingTs, stitched, parserVersion],
      );
      flightId = ins.rows[0].id as number;
      changed.add(flightId);
    } else {
      flightId = Math.min(...existingIds);
      for (const merge of existingIds.filter((id) => id !== flightId)) {
        await client.query('UPDATE samples SET flight_id = $1 WHERE flight_id = $2', [flightId, merge]);
        await client.query('UPDATE samples_derived SET flight_id = $1 WHERE flight_id = $2', [flightId, merge]);
        await client.query('UPDATE log_sessions SET flight_id = $1 WHERE flight_id = $2', [flightId, merge]);
        await client.query('DELETE FROM flights WHERE id = $1', [merge]);
        changed.add(flightId);
      }
      const upd = await client.query(
        `UPDATE flights
           SET start_ts = $2, end_ts = $3, takeoff_ts = $4, landing_ts = $5, stitched = $6,
               parser_version = $7,
               status = CASE WHEN start_ts <> $2 OR end_ts <> $3 THEN 'parsed' ELSE status END
         WHERE id = $1
         RETURNING (start_ts <> $2 OR end_ts <> $3) AS bounds_changed`,
        [flightId, startTs, endTs, takeoffTs, landingTs, stitched, parserVersion],
      );
      if (upd.rows[0]?.bounds_changed) changed.add(flightId);
    }
    keptFlightIds.add(flightId);
    for (const s of group) {
      if (s.flight_id !== flightId) {
        await client.query('UPDATE log_sessions SET flight_id = $1 WHERE id = $2', [flightId, s.id]);
        changed.add(flightId);
      }
    }
  }

  // Remove flights that no longer own any session (cascades samples/derived/phases/events).
  const orphan = await client.query(
    `DELETE FROM flights WHERE id NOT IN (SELECT DISTINCT flight_id FROM log_sessions WHERE flight_id IS NOT NULL)
     RETURNING id`,
  );
  for (const row of orphan.rows) changed.delete(row.id as number);

  return { changedFlightIds: [...changed] };
}
