import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// Two MCP sessions routinely share one Chrome instance, so two processes can
// reach the same JSON store at once. Everything here is synchronous on
// purpose: the payloads are small (well under a megabyte) and sync removes any
// chance of interleaving inside this process, which an async read-modify-write
// would reintroduce for free.

export function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger.warn('Could not read JSON store, using fallback', { filePath, error: err.message });
    return fallback;
  }
}

// Write to a sibling temp file and rename over the target. rename(2) within a
// directory is atomic, so a reader either sees the whole old file or the whole
// new one — never a truncated write. The pid in the temp name keeps two
// concurrent writers from clobbering each other's scratch file.
export function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 5000;

// Advisory lock via exclusive create. If the holder crashed the lock file is
// never released, so a lock older than LOCK_STALE_MS is broken rather than
// waited on — a deadlocked server is worse than a torn write we can detect.
export function withFileLock(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let fd = null;
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          logger.warn('Breaking stale lock', { lockPath });
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // The holder released it between our open and our stat — just retry.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }

  if (fd === null) {
    // Proceeding unlocked beats refusing to record the download at all: every
    // mutation here is a merge, so the worst case is last-writer-wins over a
    // superset, not data loss.
    logger.warn('Could not acquire lock, proceeding without it', { lockPath });
    return fn();
  }

  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}
