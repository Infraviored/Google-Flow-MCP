#!/usr/bin/env node
// One-shot, run manually — never on server start.
//
// outputs/metadata/*.json was written by saveMetadata with file paths relative
// to whatever cwd the client happened to have. Measured before writing this:
// 164 recorded file references, zero of which resolve. The paths are gone.
//
// What survived is the valuable half — each record still carries the prompt
// that produced it plus the media ids and edit ids it produced, which is
// exactly a generation plus its steps. Those are migrated. The dead files[]
// arrays are skipped rather than imported as phantom downloads.
import fs from 'fs';
import path from 'path';
import { recordGeneration, recordStep, listOrphanDownloads, indexLocation } from '../src/utils/media-index.js';

const SOURCES = [
  path.resolve(import.meta.dirname, '..', 'outputs', 'metadata'),
  '/home/schneider/repos_private/VibeVoice/outputs/metadata',
];

let files = 0, generations = 0, steps = 0, skipped = 0;

for (const dir of SOURCES) {
  if (!fs.existsSync(dir)) { console.log(`skip (absent): ${dir}`); continue; }
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); }
    catch { skipped++; continue; }
    files++;

    const editIds = meta.editIds || [];
    const mediaIds = meta.imageUuids || [];
    if (!editIds.length) { skipped++; continue; }

    // editIds[i] and imageUuids[i] were pushed in the same order by the same
    // loop, so position is the only link available — and it is the real one.
    for (let i = 0; i < editIds.length; i++) {
      const editId = editIds[i];
      if (!editId) continue;
      recordGeneration({ editId, model: meta.model, ratio: meta.ratio });
      generations++;
      const mediaId = mediaIds[i];
      if (mediaId) {
        recordStep({ editId, mediaId, prompt: meta.prompt, source: 'migrated' });
        steps++;
      }
    }
  }
}

console.log(`\nindex: ${indexLocation()}`);
console.log(`metadata files read : ${files}`);
console.log(`generations recorded: ${generations}`);
console.log(`steps recorded      : ${steps}`);
console.log(`skipped (no editIds): ${skipped}`);

const orphans = listOrphanDownloads();
console.log(`\nimages on disk the index cannot attribute: ${orphans.length}`);
console.log('These carry caller-supplied names with no recoverable media id, so they are');
console.log('listed rather than guessed at. A future download to the same path adopts them.');
for (const o of orphans.slice(0, 5)) console.log(`  ${path.basename(o)}`);
if (orphans.length > 5) console.log(`  … and ${orphans.length - 5} more`);
