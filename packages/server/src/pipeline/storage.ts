import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { SAMPLE_PARAMS, type Sample } from '@foqa/shared';

export interface RawFileRow {
  id: number;
  sha256: string;
  original_name: string;
  archive_path: string;
  size_bytes: number;
  status: string;
  error: string | null;
  g3x_metadata: Record<string, string>;
}

export async function findRawFileBySha(
  db: pg.Pool | pg.PoolClient,
  sha256: string,
): Promise<RawFileRow | null> {
  const res = await db.query('SELECT * FROM raw_files WHERE sha256 = $1', [sha256]);
  return (res.rows[0] as RawFileRow) ?? null;
}

export async function insertRawFile(
  db: pg.Pool | pg.PoolClient,
  file: { sha256: string; originalName: string; archivePath: string; sizeBytes: number },
): Promise<RawFileRow | null> {
  const res = await db.query(
    `INSERT INTO raw_files (sha256, original_name, archive_path, size_bytes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sha256) DO NOTHING
     RETURNING *`,
    [file.sha256, file.originalName, file.archivePath, file.sizeBytes],
  );
  return (res.rows[0] as RawFileRow) ?? null;
}

export async function setRawFileStatus(
  db: pg.Pool | pg.PoolClient,
  id: number,
  status: 'received' | 'parsed' | 'failed' | 'quarantined' | 'ignored',
  error?: string,
): Promise<void> {
  await db.query('UPDATE raw_files SET status = $2, error = $3 WHERE id = $1', [
    id,
    status,
    error ?? null,
  ]);
}

const SAMPLE_COLS = ['flight_id', 'ts', ...SAMPLE_PARAMS.map((p) => p.name), 'extra'];

function csvEscape(v: string): string {
  return `"${v.replaceAll('"', '""')}"`;
}

/** Bulk-load canonical samples for one flight via COPY (not INSERT). */
export async function copySamples(
  client: pg.PoolClient,
  flightId: number,
  samples: Sample[],
): Promise<void> {
  if (samples.length === 0) return;
  const target = client.query(
    copyFrom(`COPY samples (${SAMPLE_COLS.join(', ')}) FROM STDIN WITH (FORMAT csv)`),
  );
  function* rows(): Generator<string> {
    for (const s of samples) {
      const cells: string[] = [String(flightId), s.ts.toISOString()];
      for (const p of SAMPLE_PARAMS) {
        const v = s.values[p.name];
        cells.push(v === null || v === undefined ? '' : String(v));
      }
      cells.push(csvEscape(JSON.stringify(s.extra)));
      yield cells.join(',') + '\n';
    }
  }
  await pipeline(Readable.from(rows()), target);
}
