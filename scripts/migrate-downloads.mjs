#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { dataDir, downloadsPath } from '../src/utils/paths.js';

const oldIndexPath = path.join(dataDir(), 'media-index.json');
const backupPath = path.join(dataDir(), 'media-index.json.v1');
const targetPath = downloadsPath();

if (!fs.existsSync(oldIndexPath)) {
  console.log(`No legacy index found at ${oldIndexPath}. Nothing to migrate.`);
  process.exit(0);
}

const raw = fs.readFileSync(oldIndexPath, 'utf-8');
let oldIndex;
try {
  oldIndex = JSON.parse(raw);
} catch (e) {
  console.error(`Failed to parse ${oldIndexPath}:`, e.message);
  process.exit(1);
}

const downloads = {
  version: 1,
  byMediaId: {},
  unattributed: {},
  generations: {},
  updatedAt: new Date().toISOString(),
};

let genCount = 0;
let dlCount = 0;
let unattrCount = 0;
let sidecarCount = 0;

for (const [editId, gen] of Object.entries(oldIndex.generations || {})) {
  genCount++;
  if (gen.model || gen.ratio) {
    downloads.generations[editId] = {};
    if (gen.model) downloads.generations[editId].model = gen.model;
    if (gen.ratio) downloads.generations[editId].ratio = gen.ratio;
    sidecarCount++;
  }

  for (const step of gen.steps || []) {
    if (step.mediaId && Array.isArray(step.downloads) && step.downloads.length > 0) {
      downloads.byMediaId[step.mediaId] ||= [];
      for (const d of step.downloads) {
        if (!d.path) continue;
        const abs = path.resolve(d.path);
        const existing = downloads.byMediaId[step.mediaId].find((x) => x.path === abs);
        const rec = {
          path: abs,
          resolution: d.resolution || '1K',
          bytes: d.bytes ?? null,
          at: d.at || new Date().toISOString(),
          method: d.method || 'direct-api',
        };
        if (existing) Object.assign(existing, rec);
        else downloads.byMediaId[step.mediaId].push(rec);
        dlCount++;
      }
    }
  }

  if (Array.isArray(gen.unattributedDownloads) && gen.unattributedDownloads.length > 0) {
    downloads.unattributed[editId] ||= [];
    for (const d of gen.unattributedDownloads) {
      if (!d.path) continue;
      const abs = path.resolve(d.path);
      const existing = downloads.unattributed[editId].find((x) => x.path === abs);
      const rec = {
        path: abs,
        resolution: d.resolution || '1K',
        bytes: d.bytes ?? null,
        at: d.at || new Date().toISOString(),
        method: d.method || 'unknown',
      };
      if (existing) Object.assign(existing, rec);
      else downloads.unattributed[editId].push(rec);
      unattrCount++;
    }
  }
}

fs.writeFileSync(targetPath, JSON.stringify(downloads, null, 2));
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(oldIndexPath, backupPath);
}

console.log('Migration complete:');
console.log(`  Source                : ${oldIndexPath}`);
console.log(`  Backup                : ${backupPath}`);
console.log(`  Target                : ${targetPath}`);
console.log(`  Generations scanned   : ${genCount}`);
console.log(`  Sidecars recorded     : ${sidecarCount}`);
console.log(`  Step downloads lifted : ${dlCount}`);
console.log(`  Unattributed downloads: ${unattrCount}`);
