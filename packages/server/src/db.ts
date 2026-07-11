import pg from 'pg';

// int8 (BIGINT: ids, count(*)) as JS number — flight ids and sample counts
// never approach 2^53 in a single-aircraft system.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export type Db = pg.Pool;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** Run fn inside a transaction; rolls back on throw. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
