import fs from 'fs';
import path from 'path';
import { indexPath, outputDir } from './paths.js';
import { readJson, writeJsonAtomic, withFileLock } from './atomic-json.js';
import { logger } from './logger.js';

// The catalog of everything this MCP has ever generated, edited, or downloaded.
//
// Keyed by the /edit/{id} route id, because that is the only id that is both
// stable and navigable. A generation's history steps hang off it, and every
// downloaded file hangs off the STEP rather than off the generation — a black
// background pass and a white one are two steps with different media ids, and
// attaching downloads at the generation level would flatten exactly the
// distinction a caller needs to read back without guessing.
//
// Paths recorded here are absolute. The predecessor stored them relative to a
// cwd that varied per client, which is how 164 recorded file references ended
// up pointing at nothing.

const EMPTY = { version: 1, generations: {}, byMediaId: {}, byTitle: {} };

export function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function load() {
  const idx = readJson(indexPath(), null);
  if (!idx || typeof idx !== 'object' || !idx.generations) return structuredClone(EMPTY);
  return idx;
}

// byMediaId/byTitle are pure functions of `generations`, rebuilt on every write
// rather than maintained alongside it, so they cannot drift out of sync.
function rebuildDerived(idx) {
  idx.byMediaId = {};
  idx.byTitle = {};
  for (const [editId, gen] of Object.entries(idx.generations)) {
    for (const step of gen.steps || []) {
      if (step.mediaId) idx.byMediaId[step.mediaId] = editId;
    }
    if (gen.titleKey) {
      (idx.byTitle[gen.titleKey] ||= []).push(editId);
    }
  }
  idx.updatedAt = new Date().toISOString();
  return idx;
}

// Every mutation re-reads from disk inside the lock, merges, and writes
// atomically. Nothing holds an in-memory copy across an await. Because every
// mutation is a union rather than a replacement, even a lost lock degrades to
// last-writer-wins over a superset instead of losing records.
function mutate(fn) {
  return withFileLock(indexPath(), () => {
    const idx = load();
    const out = fn(idx);
    writeJsonAtomic(indexPath(), rebuildDerived(idx));
    return out;
  });
}

function ensureGen(idx, editId) {
  const now = new Date().toISOString();
  idx.generations[editId] ||= { editId, steps: [], createdAt: now };
  idx.generations[editId].seenAt = now;
  return idx.generations[editId];
}

// Never overwrites a known value with null/undefined: flow_generate_image
// records a generation before its title exists, and a later download backfills
// it. A naive assign would erase the title on every subsequent write.
function assignKnown(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== null && v !== '') target[k] = v;
  }
}

export function recordGeneration({ editId, projectId, editUrl, title, model, ratio }) {
  if (!editId) return null;
  return mutate((idx) => {
    const gen = ensureGen(idx, editId);
    assignKnown(gen, { projectId, editUrl, title, model, ratio });
    if (title) gen.titleKey = normalizeTitle(title);
    return gen;
  });
}

export function recordStep({ editId, mediaId, prompt, tileId, n, source }) {
  if (!editId || !mediaId) return null;
  return mutate((idx) => {
    const gen = ensureGen(idx, editId);
    let step = gen.steps.find((s) => s.mediaId === mediaId);
    if (!step) {
      step = { mediaId, downloads: [], firstSeenAt: new Date().toISOString() };
      gen.steps.push(step);
    }
    assignKnown(step, { prompt, tileId, source });
    if (typeof n === 'number') step.n = n;
    return step;
  });
}

export function recordDownload({ editId, mediaId, path: filePath, resolution, bytes, method }) {
  if (!editId || !filePath) return null;
  const abs = path.resolve(filePath);
  return mutate((idx) => {
    const gen = ensureGen(idx, editId);
    // A 2K download can arrive before the history panel has ever been scraped,
    // so the step may not exist yet — create a placeholder keyed by media id.
    // Without a media id at all, park it on the generation rather than
    // guessing which step it belongs to.
    if (!mediaId) {
      gen.unattributedDownloads ||= [];
      if (!gen.unattributedDownloads.some((d) => d.path === abs)) {
        gen.unattributedDownloads.push({ path: abs, resolution, bytes, at: new Date().toISOString(), method });
      }
      return null;
    }
    let step = gen.steps.find((s) => s.mediaId === mediaId);
    if (!step) {
      step = { mediaId, downloads: [], firstSeenAt: new Date().toISOString(), source: 'download' };
      gen.steps.push(step);
    }
    step.downloads ||= [];
    // Dedupe on the absolute path: re-downloading to the same place updates the
    // record in place instead of appending a duplicate row.
    const existing = step.downloads.find((d) => d.path === abs);
    const rec = { path: abs, resolution, bytes, at: new Date().toISOString(), method };
    if (existing) Object.assign(existing, rec);
    else step.downloads.push(rec);
    return rec;
  });
}

// Union by media id. Steps the DOM shows but we have never seen are inserted
// (this is what picks up work done in the user's own browser or a parallel
// session). Steps we know that the DOM no longer shows are KEPT and flagged —
// each remains individually fetchable at 1K by its media id, so dropping them
// would throw away the only recovery path for a superseded version.
export function mergeHistorySteps(editId, steps, meta = {}) {
  if (!editId) return null;
  if (!steps?.length) {
    logger.warn('History sync produced no steps — the panel may have been closed', { editId });
  }
  recordGeneration({ editId, ...meta });
  return mutate((idx) => {
    const gen = ensureGen(idx, editId);
    const seen = new Set();
    for (const s of steps || []) {
      if (!s.mediaId) continue;
      seen.add(s.mediaId);
      let step = gen.steps.find((x) => x.mediaId === s.mediaId);
      if (!step) {
        step = { mediaId: s.mediaId, downloads: [], firstSeenAt: new Date().toISOString(), source: 'dom' };
        gen.steps.push(step);
      }
      assignKnown(step, { prompt: s.prompt, tileId: s.tileId });
      if (typeof s.index === 'number') step.n = s.index;
      step.staleInDom = false;
    }
    if (steps?.length) {
      for (const step of gen.steps) {
        if (!seen.has(step.mediaId)) step.staleInDom = true;
      }
    }
    return gen;
  });
}

// A prompt is the honest source for which background pass a step is, but
// reading one is the caller's job to interpret — so derive the obvious case
// here and label it as derived. Null whenever the prompt does not clearly say.
function inferVariant(prompt) {
  if (!prompt) return null;
  if (/pure black|background to (?:pure )?black|on black/i.test(prompt)) return 'black';
  if (/pure white|background to (?:pure )?white|on white/i.test(prompt)) return 'white';
  return null;
}

const PROMPT_PREVIEW_CHARS = 160;

// Shapes one generation for a tool response. Truncation lives here rather than
// in the store: the full text is always on disk, and a caller that wants it can
// ask. Eight steps of 1400-char prompts is ~2800 tokens of payload nobody read.
export function view(editId, { fullPrompts = false, step = null } = {}) {
  const idx = load();
  const gen = idx.generations[editId];
  if (!gen) return null;

  const steps = (gen.steps || [])
    .filter((s) => step === null || s.n === step)
    .map((s) => {
      const out = { mediaId: s.mediaId };
      if (typeof s.n === 'number') out.n = s.n;
      const showFull = fullPrompts || (step !== null && s.n === step);
      if (s.prompt) {
        out.prompt = showFull || s.prompt.length <= PROMPT_PREVIEW_CHARS
          ? s.prompt
          : s.prompt.slice(0, PROMPT_PREVIEW_CHARS) + '…';
        if (!showFull && s.prompt.length > PROMPT_PREVIEW_CHARS) out.promptChars = s.prompt.length;
      }
      const variant = inferVariant(s.prompt);
      if (variant) out.variant = variant;
      if (s.staleInDom) out.staleInDom = true;
      // Absence of `dl` is the signal for "not downloaded" — cheaper and less
      // ambiguous than an empty array plus a flag.
      const dl = (s.downloads || []).map((d) => ({
        res: d.resolution,
        p: d.path,
        present: fs.existsSync(d.path),
      }));
      if (dl.length) out.dl = dl;
      return out;
    });

  const out = { editId, steps };
  if (gen.title) out.title = gen.title;
  if (gen.editUrl) out.editUrl = gen.editUrl;
  if (gen.model) out.model = gen.model;
  if (gen.ratio) out.ratio = gen.ratio;
  if (gen.unattributedDownloads?.length) {
    out.unattributed = gen.unattributedDownloads.map((d) => ({ res: d.resolution, p: d.path, present: fs.existsSync(d.path) }));
  }
  return out;
}

// Bulk import of a whole project, from Flow's own project endpoint rather than
// from the DOM. One call replaces navigating to every generation in turn, and
// it reaches generations this MCP never made — including ones from before it
// existed. Merges, never replaces: a step already carrying downloads keeps them.
export function importProjectContents({ projectId, generations, media }) {
  return mutate((idx) => {
    let gens = 0, steps = 0, titles = 0;
    const byEdit = new Map();
    for (const m of media) {
      if (!m.editId || !m.mediaId) continue;
      if (!byEdit.has(m.editId)) byEdit.set(m.editId, []);
      byEdit.get(m.editId).push(m);
    }
    for (const g of generations) {
      if (!g.editId) continue;
      const gen = ensureGen(idx, g.editId);
      assignKnown(gen, { projectId, title: g.title });
      if (g.title) { gen.titleKey = normalizeTitle(g.title); titles++; }
      if (g.createdAt) gen.createdAt = g.createdAt;
      if (!gen.editUrl && projectId) {
        gen.editUrl = `https://labs.google/fx/en/tools/flow/project/${projectId}/edit/${g.editId}`;
      }
      gens++;
      for (const m of byEdit.get(g.editId) || []) {
        let step = gen.steps.find((x) => x.mediaId === m.mediaId);
        if (!step) {
          step = { mediaId: m.mediaId, downloads: [], firstSeenAt: m.createdAt || new Date().toISOString(), source: 'project-api' };
          gen.steps.push(step);
          steps++;
        }
        assignKnown(step, { prompt: m.prompt });
      }
    }
    return { generations: gens, steps, titles };
  });
}

export function getGeneration(editId) {
  return load().generations[editId] || null;
}

export function findByMediaId(mediaId) {
  const idx = load();
  const editId = idx.byMediaId[mediaId];
  return editId ? idx.generations[editId] : null;
}

export function findByDownloadPath(filePath) {
  const abs = path.resolve(filePath);
  const idx = load();
  for (const gen of Object.values(idx.generations)) {
    for (const s of gen.steps || []) {
      if ((s.downloads || []).some((d) => d.path === abs)) return { generation: gen, step: s };
    }
  }
  return null;
}

// Three tiers, first non-empty wins, deliberately no fuzzy scoring: edit
// distance happily confuses "vs dragon" with "vs dragon 2", which is the exact
// class of mixup the id-verification code elsewhere exists to prevent. When
// more than one candidate survives, all are returned and the caller picks.
export function findByTitle(query) {
  const idx = load();
  const q = normalizeTitle(query);
  if (!q) return [];
  const entries = Object.values(idx.generations).filter((g) => g.titleKey);
  const shape = (g) => ({ editId: g.editId, title: g.title, stepCount: (g.steps || []).length });

  const exact = entries.filter((g) => g.titleKey === q);
  if (exact.length) return exact.map(shape);

  const contains = entries.filter((g) => g.titleKey.includes(q) || q.includes(g.titleKey));
  if (contains.length) return contains.map(shape);

  const tokens = q.split(' ').filter(Boolean);
  const subset = entries.filter((g) => tokens.every((t) => g.titleKey.includes(t)));
  return subset.map(shape);
}

export function listGenerationsIndexed({ limit = 20 } = {}) {
  const idx = load();
  return Object.values(idx.generations)
    .sort((a, b) => Date.parse(b.seenAt || 0) - Date.parse(a.seenAt || 0))
    .slice(0, limit)
    .map((g) => ({ editId: g.editId, title: g.title, stepCount: (g.steps || []).length }));
}

// Files sitting in outputs/ that the index cannot account for. These are listed,
// never guessed at — their names came from caller-supplied filenames and carry
// no recoverable media id, so inventing an attribution would be worse than
// admitting the gap.
export function listOrphanDownloads() {
  const idx = load();
  const known = new Set();
  for (const gen of Object.values(idx.generations)) {
    for (const s of gen.steps || []) for (const d of s.downloads || []) known.add(d.path);
    for (const d of gen.unattributedDownloads || []) known.add(d.path);
  }
  const dir = outputDir('image');
  try {
    return fs.readdirSync(dir)
      .map((f) => path.join(dir, f))
      .filter((p) => fs.statSync(p).isFile() && !known.has(p));
  } catch {
    return [];
  }
}

export function renderMarkdown(editIds = null) {
  const idx = load();
  const gens = editIds
    ? editIds.map((id) => idx.generations[id]).filter(Boolean)
    : Object.values(idx.generations).sort((a, b) => Date.parse(b.seenAt || 0) - Date.parse(a.seenAt || 0));
  if (!gens.length) return 'No generations recorded yet.';

  const rows = gens.map((gen) => {
    const label = gen.title || gen.editId.slice(0, 8);
    const titleCell = gen.editUrl ? `[${label}](${gen.editUrl})` : label;
    const files = [];
    for (const s of gen.steps || []) {
      for (const d of s.downloads || []) {
        const mark = fs.existsSync(d.path) ? '' : ' ⚠missing';
        files.push(`[${path.basename(d.path)}${d.resolution ? ` (${d.resolution})` : ''}](file://${d.path})${mark}`);
      }
    }
    return `| ${titleCell} | ${files.length ? files.join('<br>') : '_not downloaded_'} |`;
  });
  return ['| Generation | Files |', '|---|---|', ...rows].join('\n');
}

export function indexLocation() {
  return indexPath();
}
