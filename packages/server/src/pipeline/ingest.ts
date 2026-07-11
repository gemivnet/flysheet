import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { DataDirs } from '../paths.js';
import { findRawFileBySha, insertRawFile } from './storage.js';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** rename() when possible, copy+unlink across devices (Syncthing volumes). */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch {
    await copyFile(src, dest);
    await unlink(src);
  }
}

export interface IngestOptions {
  pool: pg.Pool;
  dirs: DataDirs;
  log: Logger;
  /** Called with the new raw_files.id after a file is registered (enqueue parse). */
  onRawFile: (rawFileId: number) => Promise<void>;
}

/**
 * Watched-folder ingest: hash → dedupe → immutable archive → registry → job.
 * Syncthing-safe: waits for write stability, ignores .syncthing.* temp files,
 * and picks up files already sitting in the inbox at startup.
 */
export function startIngest(opts: IngestOptions): FSWatcher {
  const { pool, dirs, log } = opts;

  const watcher = chokidar.watch(dirs.inbox, {
    ignored: (path, stats) => {
      const name = basename(path);
      if (name.startsWith('.syncthing.') || name.endsWith('.tmp') || name.startsWith('.')) return true;
      if (stats?.isFile() && !name.toLowerCase().endsWith('.csv')) return true;
      return path.startsWith(dirs.duplicates);
    },
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 250 },
  });

  const handleFile = async (path: string): Promise<void> => {
    const name = basename(path);
    const sha = await sha256File(path);
    const existing = await findRawFileBySha(pool, sha);
    if (existing) {
      const dupPath = join(dirs.duplicates, name);
      await moveFile(path, dupPath);
      log.info({ file: name, sha256: sha, existingId: existing.id }, 'duplicate file moved aside');
      return;
    }
    const size = (await stat(path)).size;
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const archiveDir = join(dirs.archive, yyyy, mm);
    await mkdir(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, `${sha.slice(0, 12)}_${name}`);
    await copyFile(path, archivePath); // archive first, then remove from inbox

    const row = await insertRawFile(pool, {
      sha256: sha,
      originalName: name,
      archivePath,
      sizeBytes: size,
    });
    if (!row) {
      // lost a race with a concurrent insert of the same content
      await moveFile(path, join(dirs.duplicates, name));
      return;
    }
    await unlink(path);
    log.info({ file: name, rawFileId: row.id, archivePath }, 'file archived');
    await opts.onRawFile(row.id);
  };

  watcher.on('add', (path) => {
    void handleFile(path).catch((err) => {
      log.error({ err, path }, 'ingest failed for file');
    });
  });
  return watcher;
}
