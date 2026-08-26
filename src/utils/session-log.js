import path from 'path';

// In-memory, process-lifetime log of every generation touched this session —
// keyed by edit-route id so a generate + a later edit + N downloads (1K/2K,
// black/white passes, re-downloads) all collapse onto one row instead of
// duplicating. Exists so the agent can dump one markdown table at the end of
// a batch instead of re-stating file paths/titles/links in its own prose —
// cheaper in output tokens, and the links are guaranteed accurate since they
// come straight from what was actually written to disk.
const entries = new Map();

export function logEntry({ editId, editUrl, title, filePath, resolution }) {
  if (!editId) return;
  if (!entries.has(editId)) entries.set(editId, { editUrl: null, title: null, files: [] });
  const e = entries.get(editId);
  if (editUrl) e.editUrl = editUrl;
  if (title) e.title = title;
  if (filePath) e.files.push({ filePath, resolution: resolution || null });
}

export function renderSessionLog() {
  if (entries.size === 0) return 'No generations logged this session yet.';
  const rows = [...entries.values()].map(e => {
    const label = e.title || 'untitled';
    const titleCell = e.editUrl ? `[${label}](${e.editUrl})` : label;
    const fileCell = e.files.length
      ? e.files
        .map(f => `[${path.basename(f.filePath)}${f.resolution ? ` (${f.resolution})` : ''}](file://${path.resolve(f.filePath)})`)
        .join('<br>')
      : '_not downloaded_';
    return `| ${titleCell} | ${fileCell} |`;
  });
  return ['| Generation | Files |', '|---|---|', ...rows].join('\n');
}

export function clearSessionLog() {
  entries.clear();
}
