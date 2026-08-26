import { getPage, isBrowserConnected } from '../browser/connect.js';
import { openAndSync } from './generation-context.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import {
  view, findByTitle, findByMediaId, listGenerationsIndexed,
  listOrphanDownloads, renderMarkdown, indexLocation,
} from '../utils/media-index.js';

// One read surface over the catalog. Replaces flow_open_generation (navigate),
// flow_generation_history (steps) and flow_session_log (table) — all three were
// asking the same question with different amounts of guesswork attached.
export async function handleIndexQuery(args = {}) {
  const format = args.format || 'json';

  if (args.orphans) {
    const files = listOrphanDownloads();
    return { indexPath: indexLocation(), orphanCount: files.length, orphans: files };
  }

  let editId = args.id || null;

  if (!editId && args.url) {
    editId = args.url.split('/edit/')[1]?.split(/[/?#]/)[0] || null;
  }

  if (!editId && args.media_id) {
    editId = findByMediaId(args.media_id)?.editId || null;
    if (!editId) throw new FlowError(ErrorCodes.INVALID_PARAMS, `No indexed generation contains media id "${args.media_id}".`);
  }

  if (!editId && args.title) {
    const hits = findByTitle(args.title);
    if (!hits.length) {
      throw new FlowError(ErrorCodes.INVALID_PARAMS,
        `No indexed generation matches title "${args.title}". Use flow_index with no arguments to list what is known.`);
    }
    // Never pick for the caller when the title is ambiguous — near-identical
    // titles are exactly where a confident guess does real damage.
    if (hits.length > 1) return { ambiguous: true, matches: hits };
    editId = hits[0].editId;
  }

  if (!editId) {
    if (format === 'markdown') return { markdown: renderMarkdown() };
    return { indexPath: indexLocation(), generations: listGenerationsIndexed({ limit: args.limit || 20 }) };
  }

  // Refresh from the live DOM when a browser is available, so the answer
  // reflects edits made outside this MCP. Falls back to the stored record when
  // there is no browser — the whole point of persisting it.
  if (isBrowserConnected() && args.refresh !== false) {
    try {
      await openAndSync(getPage(), { id: editId });
    } catch (err) {
      // A navigation failure must not deny the caller the record we already
      // hold; report it instead of throwing the stored answer away.
      const stored = view(editId, { fullPrompts: args.full_prompts, step: args.step ?? null });
      if (stored) return { ...stored, refreshFailed: err.message };
      throw err;
    }
  }

  const record = view(editId, { fullPrompts: args.full_prompts, step: args.step ?? null });
  if (!record) throw new FlowError(ErrorCodes.INVALID_PARAMS, `Nothing indexed for generation "${editId}".`);

  if (format === 'markdown') return { markdown: renderMarkdown([editId]) };
  if (format === 'compact') {
    return {
      compact: (record.steps || []).map(s => {
        const res = (s.dl || []).map(d => d.res).join(',');
        return `${s.n ?? '?'} ${s.mediaId?.slice(0, 8)} [${res || '-'}] ${s.variant || ''} ${s.prompt || ''}`.trim();
      }),
    };
  }
  return record;
}
