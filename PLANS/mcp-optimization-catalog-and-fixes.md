# MCP optimization: a real catalog, three bug fixes, and a description diet

## Context

This MCP drives Google Flow through Playwright. Daily use surfaced that it cannot answer the
question the agent asks constantly: **"what do I already have?"**

Today's concrete case: a generation was edited from a white background to a black one. Both versions
exist in Flow, each with its own media id and its own prompt. The MCP could not say which was
already downloaded, or at what resolution — that had to be reconstructed from chat scrollback. The
user's framing: *"Interpretationsarbeit aus dem MCP herausnehmen"* — the server should state facts,
not leave the agent inferring them.

Investigation found the tracking gap is not the only problem, and that three other defects share one
root: state that was never designed to outlive a request.

- **State forks by working directory.** `config/flow.config.json` sets `"flowHome": "."`, so
  `getFlowHome()` (`src/utils/config.js:33-35`) returns the literal string `"."` and every path
  built on it resolves against *the client's cwd*. The server is registered under two project scopes
  with no `cwd` set, so this already happened: `VibeVoice/config/flow.projects.json` exists
  alongside the repo's own, with different projects and fabricated `proj_<Date.now()>` ids.
- **The existing metadata index is entirely dangling.** Measured: **164 file references across 149
  `outputs/metadata/*.json`, 0 of which exist.** Meanwhile **125 real images sit in `outputs/images/`
  with no metadata at all**, because `flow_download_latest` never calls `saveMetadata` (no import,
  no call). Resolution (1K/2K) is stored nowhere on disk.
- **The stuck job queue has a root cause.** `const JOB_TIMEOUT = get('jobTimeoutMs', 300000)` is
  declared at `src/queue/job-queue.js:6` and **never referenced again** — no `setTimeout`, no
  `Date.now()` comparison anywhere in the file. A job reaching `status:'running'` whose handler never
  returns stays running forever, and `createJob`'s guard (`:27`) then rejects everything after it.
  `flow_queue_reset` is a manual workaround for a watchdog that was configured and never wired.
- **2K upscale always fails in headless Chrome.** Proven live: 5 attempts across 3 generations all
  failed headless; the same id succeeded immediately after reconnecting headed. Flow shows its own
  "Upscaling Failed!" toast, which the MCP never reads — it burns 60s and then throws
  `"Timed out waiting for the 2K upscaled download to complete"`, naming the wrong cause.
- **The tool surface costs ~7k tokens on every request.** 23 tools: 11,882 chars of descriptions +
  14,318 of schemas. The top 5 descriptions are 59% of the description budget and read as incident
  write-ups. The `project_id`/`project_name`/`campaign` triplet is copy-pasted across 9 tools
  (~2,400 chars). Six tools are strict subsets of tools that already exist.

Outcome: one authoritative catalog of every generation and every downloaded file, three fixed
defects, and a tool surface that stops taxing every request.

## Architecture decision: global catalog, local images

Two kinds of data with opposite requirements; conflating them is what broke.

A Flow **generation** is a cloud entity under one account — `32d0b03c` is the same generation
regardless of which repo asks. A per-cwd catalog gives contradictory answers to "is this
downloaded?" depending on where the client started, so the catalog is **global**. **Images** must
land where you are working, or every generation ends in moving files by hand — so output stays
**cwd-relative**.

They are joined by storing **absolute paths in the catalog**, which makes the 164-of-164-missing
failure structurally impossible and lets the catalog answer across repos. On read, each path gets an
`fs.existsSync` check reporting `present: true|false` — self-healing against files moved outside the
MCP.

| Data | Location | Rationale |
|---|---|---|
| `media-index.json` (new) | `$XDG_DATA_HOME/flow-mcp/`, default `~/.local/share/flow-mcp/` | generation identity is global; must never fork |
| `projects.json` | same (migrated out of cwd) | a Flow project is global too; currently forked |
| `outputs/images/` | cwd, unchanged | lands where you work |
| `config/flow.config.json` | stays in repo | already module-relative, not broken |
| `chrome-profile-*/` | stays in repo | auth state; moving means re-authenticating |

---

## Phase 0 — kill the cwd fork (blocks Pillar 1)

Fix `getFlowHome()` globally rather than anchoring only the new index: a forked `outputs/`
re-creates the dangling-reference bug *inside* the new store.

`src/utils/config.js:33` — honor only absolute overrides, ignore relative ones:

```js
export function getFlowHome() {
  const configured = config.flowHome;
  if (configured && path.isAbsolute(configured)) return configured;
  return FLOW_HOME;   // module-relative repo root
}
```

Remove `"flowHome": "."` from `config/flow.config.json` and `flow.config.example.json`.
`src/navigation/project-navigator.js:11` bypasses the helper entirely
(`path.resolve(get('flowHome','.'), …)`) — repoint it. The other three consumers
(`file-manager.js:7`, `screenshots.js:6`, `discover-ui.js:10`) become correct for free.

**New `src/utils/atomic-json.js`**, used by the new index *and* by `saveProjects`
(`project-navigator.js:24-28`, currently a bare `writeFileSync`):

```js
readJson(filePath, fallback)
writeJsonAtomic(filePath, data)   // write <file>.tmp-<pid> in same dir, then renameSync
withFileLock(filePath, fn)        // openSync(lock,'wx'), 50×10ms retry, break if mtime >5s stale
```

All sync — payloads are <1 MB and sync eliminates intra-process interleaving. Two MCP sessions share
one Chrome, so this matters.

**One-shot projects merge:** union `VibeVoice/config/flow.projects.json` into the global file by
`id`, **dropping every `/^proj_\d{13}$/` id** (fabricated, never referred to a real Flow project),
keeping max `last_used` on collisions. Then delete the forked tree.

---

## Pillar 1 — the generation catalog

### New `src/utils/media-index.js` — replaces `src/utils/session-log.js`

Replace, don't extend: `session-log.js` has no `fs`, no per-step model, and appends duplicate file
rows. Keeping both means two stores. Delete it and repoint its four importers.

```jsonc
{
  "version": 1,
  "generations": {
    "<editId>": {                          // the /edit/<id> route id — the only stable key
      "projectId": "…", "editUrl": "…",
      "title": "Audio wave splitting into text",
      "titleKey": "audio wave splitting into text",   // normalized, for lookup
      "model": "Nano Banana Pro", "ratio": "16:9",
      "createdAt": "…", "seenAt": "…",
      "steps": [{
        "n": 0,                            // history-panel DOM order at last scrape
        "tileId": "fe_id_…",               // NOT navigable — kept only for DOM re-matching
        "mediaId": "355f89ba-…",           // individually fetchable at 1K, forever
        "prompt": "Change the background to pure black (#000000)…",
        "source": "edit",                  // generate | edit | dom | migrated
        "firstSeenAt": "…",
        "staleInDom": false,
        "downloads": [{ "path": "/abs/…_b.png", "resolution": "2K",
                        "bytes": 1424928, "at": "…", "method": "ui-upscale-2k" }]
      }]
    }
  },
  "byMediaId": { "<mediaId>": "<editId>" },     // DERIVED, rebuilt on every write
  "byTitle":   { "<titleKey>": ["<editId>"] }   // DERIVED; titles are not unique
}
```

Three decisions worth naming:

- **Downloads hang off the step, not the generation.** That is exactly what the requirement needs: a
  black pass and a white pass *are* two history steps with different `mediaId`s. Attaching downloads
  to the generation would flatten the distinction we are trying to surface.
- **No `jobId` anywhere.** It is `randomUUID().slice(0,8)`, process-local, and appears in no other
  persisted structure. Dead weight.
- **`byMediaId`/`byTitle` are derived**, rebuilt inside the write function, never hand-maintained —
  so they cannot drift.

API:

```js
recordGeneration({ editId, projectId, editUrl, title, model, ratio })
recordStep({ editId, mediaId, prompt, tileId, n, source })
recordDownload({ editId, mediaId, path, resolution, bytes, method })
mergeHistorySteps(editId, steps, { title, editUrl, projectId })
getGeneration(editId, { fullPrompts = false, step = null })
findByTitle(query) / findByMediaId(id) / findByDownloadPath(absPath)
listOrphanDownloads()          // readdir(outputs/images) minus every indexed path
renderMarkdown(editIds)        // replaces renderSessionLog()
```

Two invariants carry the correctness:

- **Null-safe upsert** — never overwrite a known value with `null`. `generate-image.js:377` records
  without a title; a later download backfills it. This is already `logEntry`'s intended behavior.
- **Downloads dedupe by absolute path** — re-downloading updates `bytes`/`at`/`resolution` in place,
  fixing `session-log.js`'s append-duplicates bug.

Every mutation runs inside `withFileLock`: re-read from disk, merge, rebuild derived, write
atomically. Never hold an in-memory copy across an `await`. Because every mutation is a *union*,
even a lost lock degrades to last-writer-wins on a superset — not data loss.

### Write path — the four existing `logEntry` sites

1. **`generate-image.js:377`** — the uuid *is* the mediaId and the prompt is in scope:
   `recordGeneration` + `recordStep({source:'generate'})` + `recordDownload({resolution:'1K',
   method:'generate-autosave'})`.
2. **`download-latest.js:201`** (1K) — `mediaId` already in scope; record generation + download.
3. **`download-latest.js:143`** (2K) — **currently has no mediaId at all**, which is why 2K
   downloads cannot attach to a step. Export the already-written but module-private
   `getMainPreviewMediaId` (`gallery.js:290`) and call it immediately *before*
   `menu2kOption.click()`. Highest-value small change in this pillar.
4. **`edit-generation.js:57`** — after `followUpEdit`, one `recordStep({prompt: args.instruction,
   source:'edit'})` per new id. This site records **no prompt today** — the "which prompt made this"
   hole for every edit.

**Retire `saveMetadata` entirely** (`file-manager.js:51-58`) and its five call sites. Leaving it
alive means a second, still-dangling index.

### Live refresh — `src/tools/generation-context.js`

**Not inside `navigateToGeneration`.** `gallery.js` is a pure DOM module; a disk write there makes
every helper a persistence side-effect and makes "navigate without touching state" impossible.

```js
openAndSync(page, { id, url })   // navigate → scrape title + history steps → merge → return record
syncCurrent(page)                // same, assumes already on /edit/
```

Called by the four handlers that already funnel through `navigateToGeneration`
(`open-generation.js:22`, `download-latest.js:43`, `edit-generation.js:25`,
`generation-history.js:18`). `mergeHistorySteps` unions by `mediaId`: steps present in the DOM but
not the index are inserted with `source:'dom'` — this is what captures work done in the user's own
browser or a parallel session. Steps in the index but **no longer in the DOM are kept** and flagged
`staleInDom`, so a recoverable pre-edit version is never destroyed.

### Close three `listHistorySteps` gaps (`gallery.js:130-148`)

Without these the merge silently records nothing — the worst failure mode in this design, because it
looks like it works.

1. **Panel closed → 0 steps → silent no-op.** Add `ensureHistoryPanelOpen(page)`: if
   `[id^="history-step-"]` is empty, click "Show history" and wait ≤3s. Must never click "Hide".
2. **No scroll pass.** Reuse the loop-until-dry pattern `listGenerations` already applies to
   `[data-testid="virtuoso-scroller"]` (`gallery.js:185-201`); a long edit chain is otherwise
   truncated to whatever is mounted.
3. **Wrong-image risk.** A step contains *two* `getMediaUrlRedirect` images — its own result and a
   source chip for the image it derives from. `querySelector` takes the first in DOM order, correct
   today by luck. The step's `id` is `history-step-fe_id_<mediaId>` and in a captured DOM that
   suffix **equals** the media id exactly. Read the id suffix as primary, cross-check the img src,
   warn on mismatch.

Add a warn-log whenever a sync yields 0 steps on an `/edit/` page.

**Ordering is not confirmed.** A captured DOM suggests newest-first, but nothing downstream may
depend on it: keep `n` as pure DOM order and derive recency from our own `firstSeenAt`.

### Read API — `flow_index`, token-cheap by default

```json
{ "editId":"32d0b03c", "title":"Audio wave splitting into text", "editUrl":"…",
  "steps":[
    {"n":0,"mediaId":"355f89ba","variant":"black",
     "prompt":"Change the background to pure black (#000000)…",
     "dl":[{"res":"2K","present":true,"p":"/abs/…_b.png"}]},
    {"n":1,"mediaId":"684976ef","variant":"white",
     "prompt":"Modern 3D illustration on pure white (#FFFFFF): one voice…"}
  ]}
```

Token rules enforced in the **serializer**, not the store:

- `prompt` truncated to **160 chars** — enough to separate a black pass from a white pass, which is
  the actual job. Eight steps × 1400 chars (~2,800 tokens) becomes ~340. Opt in with
  `full_prompts:true`, or `step:<n>` for one step's full text (the realistic case).
- **Omit every null/empty field.** Absence of `dl` *means* not downloaded. No `status:"success"`
  (MCP signals errors via `isError`), no `hint` strings.
- `variant` is a **labelled heuristic** over prompt text (`/pure black|background to black/i`) — the
  user's literal use case, honest about being derived rather than observed.
- `format: 'json' | 'markdown' | 'compact'`; `markdown` reproduces today's table verbatim.
- Accepts `title` alongside `id`/`url`, so *"geh nochmal zu Audio Wave Splitting into Text"* works.

**Title lookup: three tiers, no fuzzy matching.** Exact on `titleKey` → substring either direction →
token-subset. No Levenshtein: fuzzy scoring mismatches near-identical titles ("vs dragon" vs
"vs dragon 2"), exactly the confusion class `verifyNewestTileIds` already exists to fight. If more
than one candidate survives, return them all as `{editId, title, stepCount}` — ~15 tokens each,
never silently wrong.

### Migration — `scripts/migrate-metadata.mjs`, run once, manually

Measured, not assumed: **zero `flow_*` files exist anywhere on disk**, and none of the 125 real
images match the `Title_<8charid>` pattern `titleToFilenameBase` produces. Their names came from
explicit `filename` arguments.

- **The 149 metadata files are worth migrating.** Each carries `{prompt, editIds[], imageUuids[]}` —
  literally `recordGeneration` + `recordStep`. Zip `imageUuids[i]` → `editIds[i]` positionally,
  `source:'migrated'`, and **skip `files[]` entirely** (0/164 exist). Yield: ~120-149 generations
  with their real originating prompt, each still recoverable at 1K by `mediaId`.
- **The 125 orphans: do not fabricate linkage.** Expose them via `listOrphanDownloads()` and let a
  future download that writes to an existing path adopt it. Zero risk of wrong attribution.
- Then `git mv outputs/metadata outputs/metadata.legacy`.

---

## Pillar 2 — headless 2K

**Hard-block in headless, with a `force:true` escape hatch.** 5/5 deterministic failures is
categorical, not a flaky race worth a 60-second burn per attempt; the escape hatch covers the case
where it turns out to be a temporary server condition.

1. **`src/browser/connect.js`** — export the launch mode:
   ```js
   export function getLaunchMode() { return lastLaunchMode; }
   ```
   ⚠ **`lastLaunchMode` is assigned in exactly one place** — `connect.js:370`, inside
   `launchChromeDirect` (`:210`). `launchNewBrowser` (`:110`) reads `headless` at `:127` and pushes
   `--headless=new` at `:128` but **never assigns it**. A guard reading this state would silently
   no-op on that path and look like it works. Fix both in the same change.

2. **`download-latest.js`**, top of the `resolution === '2K'` branch, mirroring the existing 4K
   guard three lines above — throw `NOT_SUPPORTED` (already defined, already used there) naming
   headless as the cause and pointing at `flow_connect{headless:false}` or `{virtual_display:true}`.

3. **Read the toast** — the right fix for the *headed* failure case, turning a 60s timeout into a
   ~2s diagnosis. New pure-DOM `readUpscaleToast(page)` in `gallery.js`, polled inside the existing
   CDP wait loop (`download-latest.js:113-117`), bailing with a new `ErrorCodes.UPSCALE_FAILED`.
   **Do not hardcode a hashed class**: scan `[role="status"], [role="alert"], [aria-live]` for
   `/Upscal(ing|e)\s+(Failed|complete)/i`, falling back to document innerText.

Cross-pillar: `getLaunchMode()` is also what `flow_status` should report — add
`mode:{headless, virtualDisplay, profile}` in the same edit as Pillar 3's `flow_status` merge.

---

## Pillar 3 — description diet

**Target: 27,669 → ~9,000 chars** (~7k → ~2.3k tokens per request). Tools **23 → 15**.

> Note: you approved merging the **6** duplicate tools. Pillar 1 makes three more collapse naturally
> — `flow_open_generation`, `flow_session_log`, and `flow_generation_history` all become views on
> the same index — so the plan folds them into one `flow_index`. That is 3 beyond the literal
> approval; flagging it rather than assuming it.

A grep of `~/.claude/` found the doomed tool names only in plan files and history snapshots — **no
saved skill or agent config depends on them**, so breaking risk is effectively zero.

| removed | replacement |
|---|---|
| `flow_queue_status` | `flow_status` (already returns `.queue`) |
| `flow_account_check` | `flow_status.account` (same `checkAccount` call) |
| `flow_queue_reset` | `flow_status{reset_queue:true}` — mostly obsoleted by Pillar 4 |
| `flow_get_settings` | `flow_change_settings` with no params = read |
| `flow_open_characters` | `flow_discover_ui{page:'characters'}` — already an enum value |
| `flow_open_tools_gallery` | `flow_discover_ui{page:'tools-gallery'}` — already an enum value |
| `flow_open_generation` | `flow_index{id}`; keep `navigate_only:true` for the bare-navigate case |
| `flow_session_log` | `flow_index{format:'markdown'}` |
| `flow_generation_history` | `flow_index{id}` — same job, now disk+DOM backed |

Keep `flow_screenshot`: the one escape hatch when the DOM story fails.

**Rewrite rule for all 15:** one imperative sentence, ≤200 chars, stating what it does and what it
returns. No history, no "confirmed live", no post-mortems of earlier versions of the tool itself.
`flow_edit_generation` 2011 → ~180 is the biggest cut and it is **earned, not relocated**: its
recovery procedure becomes structurally unnecessary once `flow_index` returns every superseded
step's `mediaId` directly.

**Deduplicate the project triplet** — a `PROJECT_PARAMS` constant spread into each schema, with each
description cut from ~120 to ~35 chars: 2,400 → ~950.

**Where the prose goes.** Conditional recovery advice belongs in the `FlowError` thrown when that
condition occurs, where it costs zero tokens until it fires — Pillar 2's headless message is the
template. Long-form goes to `docs/FLOW_API_NOTES.md`. **No `flow_help` tool**: it would burn a
permanent `tools/list` slot to serve text read at most once, and an agent that needs it does not
know to call it.

**Delete what does not work:** `flow_status.full` (declared, but the handler takes no args and
`index.js` passes none — the screenshot never happens), `flow_queue_status.history_limit`,
`flow_use_grid_architect.references` (documented as non-functional in its own description), and the
dead `handleFlowOpen` import at `src/index.js:15`.

**Kill the four response-body `hint` strings** (`flow-status.js:7-9`, `download-latest.js:16`,
`generate-image.js:446`, `generation-history.js:32`) — they pay a token toll on every call forever
to restate fixed policy. `WORKFLOW_HINT` moves to the server-level MCP `instructions` field, sent
once at `initialize` instead of once per call. **Verified: installed SDK is 1.29.0 and supports it**
(`server/index.d.ts:15`, `types.d.ts:883`).

---

## Pillar 4 — queue watchdog

**Lazy check on access, no timer.** A stdio MCP server must exit cleanly when its client closes the
pipe; a live `setInterval` holds the event loop open and would need `unref()` plus teardown on three
exit paths. Nothing observes a job's expiry except the next `createJob`/`getStatus`, both
synchronous — so lazy is strictly simpler and provably sufficient.

`src/queue/job-queue.js`, finally using the constant declared and abandoned at `:6`:

```js
reapStale() {
  const j = this.currentJob;
  if (!j || (j.status !== 'running' && j.status !== 'queued')) return null;
  const started = Date.parse(j.startedAt || j.createdAt);
  if (Date.now() - started < JOB_TIMEOUT) return null;
  return this.failJob(j.id, new FlowError(ErrorCodes.GENERATION_TIMEOUT,
    `Job ${j.id} (${j.type}) exceeded jobTimeoutMs (${JOB_TIMEOUT}ms) — auto-reaped.`));
}
```

Called at the top of `createJob()` **before** the `JOB_IN_PROGRESS` throw (`:26-33`) — that is what
unsticks the queue — and at the top of `getStatus()`. The `|| createdAt` fallback matters:
`startedAt` is null for a `'queued'` job, so a job throwing between `createJob` and `startJob` would
otherwise be immortal.

**Make `getStatus(historyLimit)` honest** — it currently takes no arguments while `index.js:488`
passes one and the schema advertises history. Return `{id, type, status, completedAt, error.message}`
only; **never `params`** (the full 1400-char prompt), `result`, or stacks.

**Bound the `jobs` Map** (currently unbounded, retaining every prompt for the process lifetime): cap
at ~50, evicting oldest completed/failed, and truncate `params.prompt` to 200 chars on completion —
the full text now lives on disk.

⚠ **Cross-pillar:** `backfillTitle` (`src/tools/generation-title.js`) reads `job.result.prompt` off
completed jobs and `list-generations.js:21` depends on it. Pruning breaks it. It must first consult
the index, falling back to job history — **do not ship the pruning before Pillar 1's index is
populated.**

---

## Order of work

| Phase | Work | Why here |
|---|---|---|
| **0** | `getFlowHome()` fix, `atomic-json.js`, projects merge | Blocks everything; Pillar 1's paths are wrong without it |
| **1** | Pillar 4 (reap, `getStatus`, prune) | Self-contained, one file, immediate relief from the stuck queue |
| **2** | Pillar 2 (`getLaunchMode` + both assign sites, 2K guard, toast) | Small, independent |
| **3** | Pillar 1 store + write path + `saveMetadata` teardown + migration | Index fills before anything depends on it |
| **4** | `generation-context.js`, `gallery.js` gap fixes, `flow_index` | Read side, once the store has content |
| **5** | Pillar 3 diet | **Last** — it deletes the tools Pillar 1 supersedes; earlier removes capability before the replacement exists |

## Verification

`node --check` every touched file (the repo's established habit — no build step, no test suite), and
**restart the MCP** — code changes do not load into a running server.

Live, on the worked example from this session (`32d0b03c-3a5b-48bb-b0f3-8dddbdbc73e9`, which
genuinely has a white step and a black step):

1. `flow_index({ title: "Audio wave splitting into text" })` → resolves by title, 2 steps, black
   marked downloaded at 2K with `present:true`, white with no `dl` key at all.
2. Move that file on disk, call again → `present:false`. Confirms the existence check is real.
3. `flow_download_latest({ id, resolution:"2K" })` on the white step, re-query → the new download
   attaches to the **right step** (this is what the `getMainPreviewMediaId` change buys).
4. Restart the MCP, re-query → identical answer. The current in-memory log returns nothing here.
5. Query from a **different cwd** → identical answer, proving the fork is gone.
6. `flow_connect({headless:true})` then a 2K download → fails immediately naming headless, not a 60s
   timeout. Then `{force:true}` → attempts and reports Flow's own toast text.
7. Start a generation, kill the client mid-flight, wait past `jobTimeoutMs`, generate again →
   succeeds instead of `JOB_IN_PROGRESS`.
8. Count the `tools/list` payload before and after.

Steps 1-5 spend no credits (navigation and downloads only); no generation call is needed to validate
the catalog.

## Risks

- **History-panel scroll container and the "Show history" button are unverified.** If the panel is
  closed the merge silently records nothing — hence the mandatory warn-log on a 0-step sync.
- **Panel ordering is inferred from one captured DOM.** The explicit `n` + `firstSeenAt` split
  limits the blast radius if it is wrong.
- **The "Upscaling Failed!" toast DOM is unverified** — needs one instrumented live headless attempt.
- **Does the 2K asset actually correspond to `getMainPreviewMediaId`?** Verify by comparing pixel
  dimensions of the 1K and 2K files for the same step before trusting the attribution.
- **`listHistorySteps` prompt extraction is positional** (`.reuse-prompt-button` →
  `closest('div').parentElement.firstElementChild`) and will break on a Flow redesign. It is the
  only anchor available; the class itself is stable and non-hashed, and the failure mode is a `null`
  prompt, not a wrong one.
- **Removing nine tools is breaking**, accepted because the user is the sole consumer and a grep
  found no config depending on them. Every behavior survives as a parameter on an absorbing tool.
