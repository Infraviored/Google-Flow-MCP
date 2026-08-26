# Make Flow the source of truth, keep only downloads local

Branch: `feat/flow-api-as-truth`

## Context

Everything this MCP knows about a generation — its title, the prompts behind its
edit steps — was scraped out of the DOM, and that turned out to be the wrong
foundation. The gallery grid carries **no text at all**: tiles are empty until
hovered, and a hover reveals exactly one title at a time. `__NEXT_DATA__` does
not carry it either (414 KB, containing neither `"prompt"` nor `"title"`). So
titles could only ever come from this process's own job history, which is why
asking the catalog for *"Two glass whales singing documents"* returned nothing
at the start of this session — the MCP had made that image an hour earlier.

The DOM path is also actively unreliable. Earlier today `listHistorySteps` read
a step's media id from the element id suffix and recorded `a474f7a3`, which
returns **404** from `getMediaUrlRedirect`, while the thumbnail's own src
returned **200 image/jpeg**. That produced a phantom catalog entry: the prompt
on a dead id, the downloaded file on a second, real one, for a single image.

`flow.projectInitialData` — the request the gallery page already makes on mount —
returns all of it in one call. Measured live on this project:

| | |
|---|---|
| workflows (= generations) | **174**, all 174 with a title |
| media | **557**, 303 carrying their full prompt |
| payload / latency | 1.45 MB in 1.6 s |
| pagination markers | **none** (`nextPageToken`, `hasMore`, `totalSize` all absent) |
| span | 2026-08-14 → today, i.e. the whole project |

Three joins make it usable, each verified rather than assumed:

- **`workflow.name` IS the `/edit/{id}` route id** — checked against four ids
  this MCP had just generated; all four matched.
- **`workflowStepId` decodes to a plain step ordinal** — it is a protobuf varint:
  `CAE`→1, `CAI`→2, `CAM`→3, `CAQ`→4. That is the edit chain in exact order.
  Confirmed on the known white→black chain (`32d0b03c`): step 1 the white
  original, step 2 *"Change the background to pure black"*, both with prompts.
- **Upscales are stored as media and fetchable by id.** Fetching the prompt-less
  step of `c17ae021` returned 2,050,169 bytes, sha `2d7bd38d…` — **byte-identical
  to the 2K file the UI upscale flow produced earlier today**.

And the upscale itself is a plain backend call — **proven end to end, not
inferred**. `POST /v1/flow/upsampleImage` on `aisandbox-pa.googleapis.com`
returned 200 and produced a real 2048x2048 image, fetched straight back by media
id. No download button, no 60-second wait, no CDP blob handling.

The one thing that gates it is a reCAPTCHA Enterprise token, and the first replay
attempt failed 403 `PUBLIC_ERROR_UNUSUAL_ACTIVITY`. That was **not** bot
detection: the UI click had succeeded in the same browser minutes earlier, with
the same automation flags. The cause was the action name. Rather than guess
again, `grecaptcha.enterprise.execute` was wrapped at runtime and a real 2K click
observed — the page calls it with `action: "IMAGE_GENERATION"`, nothing
upscale-specific. With that value the same request returns 200. A valid token for
the wrong action is exactly what produces "evaluation failed" rather than
"invalid token".

So no fingerprint spoofing is needed and none should be added: the call is made
from inside the real, signed-in page.

Outcome: Flow owns what Flow knows; the local store shrinks to the one fact Flow
cannot have — which file is on this disk, at what resolution.

## Architecture

| Layer | Owns | Where |
|---|---|---|
| Flow API | generations, titles, ordered steps, prompts, seeds, media incl. upscales | live |
| Cache | last API snapshot per project, TTL'd | `~/.local/share/flow-mcp/cache/<projectId>.json` |
| Local facts | `mediaId → [{path, resolution, bytes, at}]` | `~/.local/share/flow-mcp/downloads.json` |

Splitting cache from facts is the point: the cache is disposable and can be
refetched in 1.6 s; `downloads.json` is precious and never auto-cleared. The
1.45 MB payload is far too expensive to fetch per query, so reads hit the cache
and refresh only when stale or when explicitly asked.

## Work

### 1. Extend `src/browser/flow-api.js`

Already fetches and projects the payload. Add:

- `decodeStepOrdinal(workflowStepId)` — `Buffer.from(s,'base64')[1]`. Export it;
  the projection should carry `step` (the ordinal) per media instead of leaving
  callers to decode.
- Carry through what the projection currently drops: `seed`
  (`image.generatedImage.seed`), `mediaGenerationId`, `mediaBlobSize`, and
  `dimensions`.
- **Discriminator, measured:** media with a prompt ⟺ media with dimensions
  (exactly 303 of each; the other 254 have neither). Mark those as
  `derived: true` rather than guessing they are all upscales — a fetch reports
  the real size when one is actually wanted.
- `upsampleImage(page, { mediaGenerationId, resolution })` — see §4.
- A **structure check** on every fetch: if `projectContents.workflows` is absent
  or empty where it was not before, throw loudly. The endpoint is undocumented;
  it must fail visibly rather than silently returning an empty catalog.

### 2. Shrink `src/utils/media-index.js` (currently 364 lines)

Keep, unchanged in spirit: `recordDownload`, `listOrphanDownloads`,
`renderMarkdown`, `indexLocation`, `normalizeTitle`, `inferVariant`, and the
`readJson`/`writeJsonAtomic`/`withFileLock` plumbing from `src/utils/atomic-json.js`.

Rewrite as joins over cache + downloads rather than over a merged local store:
`view`, `findByTitle`, `findByMediaId`, `listGenerationsIndexed`.

Delete: `mergeHistorySteps` (29 lines), `recordStep` (14), `getGeneration` and
`findByDownloadPath` (already zero callers), the `staleInDom` handling, and the
`source` field — written from six call sites and **read from none**.

`recordGeneration` cannot go entirely: `model` and `ratio` are known at generate
time and appear **nowhere** in the API payload (`imageGenerationRequestData` is
`{}`). Keep a minimal local sidecar for those two fields only.

**Migration** (`scripts/migrate-downloads.mjs`, run once): lift every
`steps[].downloads[]` and `unattributedDownloads[]` out of the existing
`media-index.json` into the new `downloads.json`, keyed by media id. Print counts;
leave the old file in place as `media-index.json.v1`.

### 3. Delete the DOM metadata path

- `src/browser/gallery.js:107-208` — `getGenerationTitle`, `ensureHistoryPanelOpen`,
  `listHistorySteps` and its scroll loop (102 lines with comments).
- The `.sc-cb61226a-2` title scrape inside `listGenerations` (`gallery.js:230-234`)
  — a hashed class that only ever mounted on the first tile of a batch anyway.
  The id/editUrl part of `listGenerations` **stays**: `download-latest.js:69` and
  `verifyNewestTileIds` need it.
- `src/tools/generation-context.js` (41 lines, one entry point, one caller).
- `src/tools/generation-title.js` (`backfillTitle`) — its only live caller,
  `list-generations.js:21`, takes titles from the cache instead. This also drops
  `jobQueue.getCompletedJobs()` to zero callers.
- Already dead, no importers, their tools removed in the earlier merge:
  `src/tools/generation-history.js`, `src/tools/open-generation.js`.

Everything else in `gallery.js` stays — `waitForNewMedia`, `waitForStableTileIds`,
`verifyNewestTileIds`, `navigateToGeneration`, `followUpEdit`,
`getMainPreviewMediaId`, `readUpscaleToast` are all still load-bearing for
generate/edit/download.

### 4. 2K without the UI

Proven in a spike; implement as the normal path with the UI kept as fallback.

`src/browser/flow-api.js` gains `upsampleImage(page, { mediaId, projectId, resolution })`,
which runs inside the page context because both credentials must come from there:

```js
const token = await grecaptcha.enterprise.execute(SITE_KEY, { action: 'IMAGE_GENERATION' });
const { access_token } = await (await fetch('/fx/api/auth/session')).json();
POST https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage
  authorization: `Bearer ${access_token}`
  { mediaId, targetResolution: 'UPSAMPLE_IMAGE_RESOLUTION_2K',
    clientContext: { recaptchaContext: { token, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
                     projectId, tool: 'PINHOLE', userPaygateTier, sessionId: ';' + Date.now() } }
```

Site key `6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV`, read out of the bundle. The
response carries the new medium's `name` — fetch that via `getMediaUrlRedirect`.

`userPaygateTier` is `PAYGATE_TIER_ONE` in the captured request. That is this
account's tier, not a universal constant, so read it from `appConfig`/`userData`
in the project payload if it is there, and fall back to the captured value.

New 2K order in `src/tools/download-latest.js`:

1. Cache already lists an upscale medium for this generation → direct GET by id.
   Works headless, instant.
2. None yet → `upsampleImage()`, then GET the returned id.
3. API call fails → today's UI flow, unchanged.

This retires the fragile machinery from the normal path: `Browser.setDownloadBehavior`,
the blob interception and its ENOENT failures, the 60-second poll, and the
`readUpscaleToast` watch. All of it survives in step 3.

Batch 2K becomes possible for the first time — list from cache, upscale and fetch
each by id, no per-image clicking.

### 5. Tools

- `flow_index` — served from cache joined with `downloads.json`; `refresh: true`
  refetches. No DOM.
- `flow_download_latest` — as §4.
- `flow_list_generations` — titles from the cache; keep the tile scan only for
  "what is newest on screen".

## Verification

`node --check` every touched file, restart the MCP, then live:

1. `flow_index({title: "Two glass whales singing documents"})` → resolves. It
   returned nothing before any of this work.
2. `flow_index({id: "32d0b03c-…"})` → two steps in order, step 1 white with its
   prompt, step 2 black with *"Change the background to pure black"*, plus the
   2K download attached to the right step and `present: true`.
3. Delete the cache file, query again → refetches, same answer. Proves the cache
   is disposable and `downloads.json` is not.
4. `flow_index` with no browser connected → still answers from cache.
5. 2K on a generation that already has an upscale → direct fetch, no UI touched.
6. 2K on one that does not → `upsampleImage()` returns 200 and the fetched file
   is a real 2K image. Verified in the spike: 2048x2048, 1642 KB.
   Then force the API call to fail and confirm the UI fallback still works.
7. Re-download an existing file → one download record updated in place, not a
   second appended.
8. Count lines removed; confirm `grep -r "listHistorySteps\|backfillTitle\|staleInDom" src/` is empty.

Steps 1-4 and 7 spend no credits.

## Risks

- **The endpoint is undocumented and can change without notice.** Mitigated by
  the structure check in §1 — loud failure, not a silently empty catalog. The
  DOM path is being deleted deliberately (your call), so recovery would mean
  reverting this commit; keeping the branch history clean matters for that.
- **"No pagination markers" is evidence, not proof of completeness.** A server
  cap at some larger N would only show once a project exceeds it. Worth a
  re-check if a project ever approaches ~1000 workflows.
- **The reCAPTCHA action name is measured, not documented.** If Flow changes it,
  the direct upscale starts returning 403 while everything else keeps working.
  The error is distinctive (`PUBLIC_ERROR_UNUSUAL_ACTIVITY`) — catch it
  specifically and fall through to the UI path rather than surfacing it raw.
- **`userPaygateTier` was read off one account.** Prefer the live value; the
  captured constant is only a fallback.
- **Batch upscaling is now cheap enough to do by accident.** The bundle prices
  only 4K in credits ("Upscaled (4K - {{creditCost}} credits)" vs plain
  "Upscaled"), but a project-wide loop should still require an explicit opt-in
  rather than being a side effect of a sync.
- **Never add fingerprint spoofing to make this work.** It was not the problem,
  and the call already runs inside the real signed-in page.
