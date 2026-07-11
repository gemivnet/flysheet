import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DataDirs {
  root: string;
  inbox: string;
  duplicates: string;
  archive: string;
  terrain: string;
  nasr: string;
}

/** Data layout under FOQA_DATA_DIR (default ./data). Creates directories. */
export function dataDirs(root = process.env.FOQA_DATA_DIR ?? './data'): DataDirs {
  const abs = resolve(root);
  const dirs: DataDirs = {
    root: abs,
    inbox: join(abs, 'inbox'),
    duplicates: join(abs, 'inbox', 'duplicates'),
    archive: join(abs, 'archive'),
    terrain: join(abs, 'terrain'),
    nasr: join(abs, 'nasr'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}
