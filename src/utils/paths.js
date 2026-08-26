import path from 'path';
import fs from 'fs';
import os from 'os';
import { getFlowHome } from './config.js';

// Two kinds of state with opposite requirements, kept deliberately apart.
//
// GLOBAL (this data dir): things whose identity lives in Google's cloud under
// one account — a generation, a project. `32d0b03c` is the same generation no
// matter which repo the client was started from, so a per-cwd copy would give
// contradictory answers to "is this already downloaded?" depending on where
// you happened to be sitting. That is exactly the fork that produced two
// divergent flow.projects.json files.
//
// LOCAL (outputs/): the image files themselves, which belong next to the work
// they were made for — otherwise every generation ends in moving files by hand.
//
// The two are joined by the index storing ABSOLUTE paths, so a download made
// from one repo is still findable (and still checkable for existence) from
// another.
export function dataDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const dir = path.join(base, 'flow-mcp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function downloadsPath() {
  return path.join(dataDir(), 'downloads.json');
}

export function indexPath() {
  return downloadsPath();
}

export function cacheDir() {
  const dir = path.join(dataDir(), 'cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectCachePath(projectId) {
  return path.join(cacheDir(), `${projectId}.json`);
}

export function projectsPath() {
  return path.join(dataDir(), 'projects.json');
}

// Output stays cwd-relative on purpose (see above) — unchanged behavior.
export function outputDir(type) {
  const dir = path.join(getFlowHome(), 'outputs', type === 'video' ? 'videos' : 'images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
