import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrate(
  databaseUrl: string,
  direction: 'up' | 'down' = 'up',
  count?: number,
): Promise<void> {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    count: count ?? Infinity,
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}
