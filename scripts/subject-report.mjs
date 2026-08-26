#!/usr/bin/env node
// Which motif exists in which colour, and what is on disk for it.
//
// The catalog knows Flow's own titles ("Glass loom weaving cloth"), not the
// prompt-file stems the website uses ("real_time_stream_3_16x9"). That mapping
// existed nowhere but in filenames chosen by hand — which is how eleven
// downloads got attributed to the wrong step earlier.
//
// It is recoverable, because Flow stores the prompt TEXT and that text came from
// the prompt files. Matching the two gives the mapping as a join instead of as
// bookkeeping.
//
// The whole payload is read and reduced here; only the table is printed.
import fs from 'fs';
import path from 'path';
import { loadAllProjectCaches } from '../src/utils/media-index.js';
import { downloadsPath } from '../src/utils/paths.js';

const PROMPT_DIR = process.argv[2]
  || '/home/schneider/repos_private/VibeVoice/website_react/ai_image_resources/00_prompts';

// Both paths collapse whitespace before sending, so compare on the same footing.
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// A prefix is enough to identify a motif and survives trailing edits, but it
// must be long enough that the _2 / _3 revisions of one motif stay distinct.
const KEY_LEN = 300;

// The key must be colour-blind. Black passes were generated from colour-swapped
// copies of the very same prompt file, so their stored text differs from the file
// at exactly the colour words — keying on the raw text files them as strangers.
// Both variants normalise to the same key here, while variantOf() still reads the
// ORIGINAL text and can tell them apart. A motif that says "white" for a material
// normalises identically on both sides, so the match survives that too.
const colourBlind = (s) => norm(s)
  .replace(/#ffffff|#000000/g, '«bg»')
  .replace(/\b(white|black)\b/g, '«c»');
const keyOf = (s) => colourBlind(s).slice(0, KEY_LEN);

function variantOf(prompt) {
  if (!prompt) return null;
  if (/pure black|background to (?:pure )?black|on black/i.test(prompt)) return 'black';
  if (/pure white|background to (?:pure )?white|on white/i.test(prompt)) return 'white';
  return null;
}

// ---- local prompt files -----------------------------------------------------
const stems = fs.readdirSync(PROMPT_DIR).filter(f => f.endsWith('.txt'));
const byKey = new Map();
const fileText = new Map();
for (const f of stems) {
  const text = fs.readFileSync(path.join(PROMPT_DIR, f), 'utf-8');
  const stem = f.replace(/\.txt$/, '');
  fileText.set(stem, text);
  byKey.set(keyOf(text), stem);
}

// ---- what Flow holds --------------------------------------------------------
const caches = loadAllProjectCaches();
const downloads = JSON.parse(fs.readFileSync(downloadsPath(), 'utf-8'));

// A 2K file is recorded against the UPSCALE's media id, not against the step it
// was made from — so asking only for the step's own id reports "never
// downloaded" for images that are sitting right there. Follow sourceMediaId.
const derivedFrom = new Map();
for (const cache of loadAllProjectCaches()) {
  for (const m of cache.media || []) {
    if (m.derived && m.sourceMediaId) {
      if (!derivedFrom.has(m.sourceMediaId)) derivedFrom.set(m.sourceMediaId, []);
      derivedFrom.get(m.sourceMediaId).push(m.mediaId);
    }
  }
}
const dlFor = (mediaId) => [
  ...(downloads.byMediaId?.[mediaId] || []),
  ...(derivedFrom.get(mediaId) || []).flatMap(id => downloads.byMediaId?.[id] || []),
];

// stem -> { black:[...], white:[...], stale:[...] }
const subjects = new Map();
for (const stem of fileText.keys()) subjects.set(stem, { black: [], white: [], stale: [] });
const unmatched = [];

for (const cache of caches) {
  const genTitle = new Map((cache.generations || []).map(g => [g.editId, g.title]));
  for (const m of cache.media || []) {
    if (!m.prompt) continue;                       // derived media carry none
    const stem = byKey.get(keyOf(m.prompt));
    const v = variantOf(m.prompt);

    const entry = {
      editId: m.editId, mediaId: m.mediaId, step: m.step,
      title: genTitle.get(m.editId) || null,
      files: dlFor(m.mediaId).map(d => ({ res: d.resolution, name: path.basename(d.path), present: fs.existsSync(d.path) })),
    };

    if (stem) {
      // Matches a current prompt file exactly.
      (subjects.get(stem)[v === 'black' ? 'black' : v === 'white' ? 'white' : 'stale']).push(entry);
    } else if (v === 'black' && m.prompt.length < 400) {
      // The constant background-swap instruction — belongs to whatever it edited,
      // which the source chain knows; resolved below.
      entry.isSwap = 'black';
      unmatched.push(entry);
    } else if (v === 'white' && m.prompt.length < 400) {
      entry.isSwap = 'white';
      unmatched.push(entry);
    } else {
      unmatched.push(entry);
    }
  }
}

// A background-swap step names no motif of its own. Attribute it to the subject
// its generation already belongs to, rather than guessing from the filename.
const genToStem = new Map();
for (const [stem, s] of subjects) {
  for (const e of [...s.black, ...s.white, ...s.stale]) genToStem.set(e.editId, stem);
}
let attributed = 0;
for (const e of unmatched) {
  if (!e.isSwap) continue;
  const stem = genToStem.get(e.editId);
  if (stem) { subjects.get(stem)[e.isSwap].push(e); e.resolved = true; attributed++; }
}

// ---- report -----------------------------------------------------------------
const fmt = (list) => {
  if (!list.length) return '—';
  const res = new Set();
  for (const e of list) for (const f of e.files) res.add(f.present ? f.res : `${f.res}!`);
  return res.size ? [...res].sort().join('/') : 'gen';
};

const rows = [...subjects.entries()]
  .filter(([, s]) => s.black.length || s.white.length || s.stale.length)
  .sort((a, b) => a[0].localeCompare(b[0]));
const missing = [...subjects.entries()].filter(([, s]) => !s.black.length && !s.white.length && !s.stale.length);

console.log(`prompt files: ${stems.length}   generations in cache: ${caches.reduce((n, c) => n + (c.generations?.length || 0), 0)}`);
console.log(`matched to a current prompt file: ${rows.length}   swap-steps attributed: ${attributed}\n`);
console.log('legend: 2K/1K = downloaded at that resolution   "!" = recorded but file is gone   gen = generated, never downloaded\n');
console.log('subject'.padEnd(42) + 'black'.padEnd(10) + 'white'.padEnd(10) + 'note');
console.log('-'.repeat(80));
for (const [stem, s] of rows) {
  const note = s.stale.length ? `${s.stale.length} step(s) with no colour in the prompt` : '';
  console.log(stem.padEnd(42) + fmt(s.black).padEnd(10) + fmt(s.white).padEnd(10) + note);
}

console.log(`\n--- prompt files with NO generation matching their current text (${missing.length}) ---`);
console.log('Either never generated, or generated before the prompt was revised.');
for (const [stem] of missing) console.log('  ' + stem);

const leftover = unmatched.filter(e => !e.resolved);
console.log(`\n--- generations matching no current prompt file (${leftover.length}) ---`);
console.log('Older prompt versions, hand-typed experiments, or work from outside this pipeline.');
for (const e of leftover.slice(0, 12)) console.log(`  ${e.editId.slice(0, 8)}  ${e.title || '(untitled)'}`);
if (leftover.length > 12) console.log(`  … and ${leftover.length - 12} more`);
