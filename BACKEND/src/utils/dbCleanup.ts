import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

export function runtimeDirectory(): string {
  if (process.env.MANAGER_DB_PATH) return path.dirname(process.env.MANAGER_DB_PATH);
  return path.join(process.cwd(), 'runtime');
}

export function cleanupProbeDbs(): string[] {
  const directory = runtimeDirectory();
  if (!fs.existsSync(directory)) return [];

  const removed: string[] = [];
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.startsWith('probe')) continue;
    const base = entry.replace(/-(journal|wal|shm)$/, '');
    if (!base.endsWith('.sqlite')) continue;
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const target = path.join(directory, base + suffix);
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { force: true });
          removed.push(path.basename(target));
        }
      } catch (error) {
        logger.warn('probe db cleanup failed', { target, error: String(error) });
      }
    }
  }
  return removed;
}