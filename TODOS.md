## See also: docs/FLOW_API_NOTES.md

Full manual walkthrough (login → select project → generate → download → edit/remix) done
2026-08-13 via real Chrome (not the MCP's browser), with network capture at every step.
Covers the OAuth login bug (§1, explains `account: null` after `flow_connect`), the real
generation endpoint, the no-UI download shortcut via `media.getMediaUrlRedirect`, and the
edit/remix flow sharing the same endpoint as fresh generation. Read that file before touching
`launch-profile.js`, `connect.js`, `generate-image.js`, or `download-latest.js`.

# MCP weaknesses — found during live use

Logged each time a real interaction hit a gap in the tool surface. Not code review, just field notes.

## FIXED (confirmed in current code, 2026-08-18): list-projects, locale, Lite model

Re-checked all three against the actual source rather than trusting the summary that
claimed them fixed: `flow_list_projects` tool exists and works, `flow.config.example.json`'s
default `flowUrl` is already `/fx/en/tools/flow`, and `config.js` already deletes the
nonexistent "Imagen 4" entry and adds "Nano Banana 2 Lite". No further action needed on
any of the three items originally below this note.

## Missing: fetch/list projects

No tool returns project names/ids as data. The only way to know what projects exist, or
which one is currently open, was `flow_screenshot` + visually reading the page — which is
slow, error-prone, and was called out as unacceptable. `flow_discover_ui` returns button
labels and `visible_ratios` timestamps but not project names or ids reliably (project cards
often show only a date, not a title).

Need: a `flow_list_projects` (or similar) tool that returns
`[{id, name, thumbnail_url?, last_modified}]` as structured data, plus a way to know which
project the browser is currently sitting in (id, not just page title/url scraping).

## Locale defaults to FR, not EN

`flow_connect` lands on `https://labs.google/fx/fr/tools/flow` — French locale — even though
the account/session should default to English. Selector maps and any text-matching logic
built against English UI strings are at risk of silently breaking on this locale. Need a way
to force `en` (locale param on `flow_connect`, or a `?hl=en` query param on the nav URL).

## Account verification is fake, confirmed live

`flow_connect` returned `accountVerified: {verified: true, method: "assumed"}`. Calling
`flow_status` immediately after showed `account: null`. The MCP's copied Chrome profile was
never actually logged in — it was sitting on the marketing landing page the whole time. See
docs/FLOW_API_NOTES.md §1 for why (OAuth session cookie doesn't survive the profile copy).
`account-check.js` needs to actually check for a signed-in indicator, not assume.

## `flow_generate_image` model list doesn't match the real UI

Schema says `model: Nano Banana Pro, Nano Banana 2, or Imagen 4`. The real Image-mode
dropdown offers `Nano Banana Pro / Nano Banana 2 / Nano Banana 2 Lite` — no Imagen 4, and
Lite is missing from the schema. Fix the enum.

## `flow_edit_generation` destroys the pre-edit version — no way to get it back at 2K

Ran `flow_generate_image` (white bg) then `flow_edit_generation` (black bg, in place) on
the same generation id. After the edit, `flow_download_latest` with the ORIGINAL editId
silently returned the black (post-edit) file — not an error, just the wrong image, same
byte-identical file as downloading with no id at all. Confirmed by md5sum. Trying the raw
imageUuid instead threw: "Flow redirected back to https://.../project/{id} — edit view did
not load" — the white version's edit page is genuinely gone, not just hard to address.

Net effect: once you edit-in-place, the pre-edit state is unrecoverable through this MCP.
The only surviving copy is whatever `flow_generate_image` auto-saved at 1K before the edit
ran — there is no way to get the pre-edit version at 2K/4K after the fact.

Workaround until fixed: always `flow_download_latest` (2K) the white/original result
immediately after `flow_generate_image`, BEFORE calling `flow_edit_generation` on it.
Doing the edit first and downloading both after (the natural order) loses the original.

Real fix needed in the MCP: either `flow_edit_generation` should preserve/version the
pre-edit generation so it stays downloadable by its own id, or the tool should warn loudly
that this is destructive before it fires.

**Partially addressed (2026-08-18)**: the tool description now states this explicitly and
tells the caller to download the pre-edit version first — cheap, immediate, prevents the
mistake going forward. Still open: no actual preservation/versioning was built, so the
underlying data loss is only prevented by the caller reading and following the warning, not
by the tool itself. A real fix (auto-download pre-edit at 2K before an edit fires, or find
a way to keep the pre-edit generation addressable) is still real follow-up work.

## FIXED: "Agent-chat sidebar did not close" error bounces out of the project

Root cause found live (2026-08-18), and it wasn't the sidebar-close logic at all — that
was a downstream symptom. `ensureProjectInContext`'s `project_name` branch
(`src/navigation/project-navigator.js`) unconditionally called `listExistingProjects(page)`
on EVERY call, and `listExistingProjects` itself unconditionally navigates to the bare
Flow landing page first whenever the browser is currently inside any project
(`currentUrl.includes('/project/')` — true essentially every time this runs, since callers
are normally already inside a project when "ensuring" one). So every single tool call
passing `project_name` (which is most of them, all session) did a full bounce to the
landing page and back — slow, and if anything raced or threw mid-bounce, the browser was
left stranded on the landing page. Whatever DOM logic ran next (e.g. `closeSidebar`'s
page-wide "Close"-text button search) then operated on the wrong page entirely, which is
what produced the confusing "sidebar did not close" error — the sidebar wasn't even the
real problem.

Fix applied: the `project_name` branch now checks the local `flow.projects.json` cache
first — if the browser is already sitting in the project a matching cached name last
resolved to, it returns immediately with zero navigation. The `project_id` branch and the
live-scan fallback now persist their resolution into that cache too, so the fast path
actually has data after the first real lookup. Needs an MCP restart to load; not yet
re-verified through a full generate/edit call live (the live-DOM investigation that found
this used raw scripts against the shared browser, not the MCP tools themselves).

## CORRECTED — was misdiagnosed as "chat contamination", actual bug is wrong id/file returned

Original theory (below, kept for the record) was wrong. Root cause, confirmed via
`flow_list_generations`: a `flow_generate_image` call requesting 3 variants of
`speed_typing_vs_speaking` returned `editIds` [`c36a06e9`, `1910c5be`, `bcf32ba8`] with
downloaded files that showed unrelated scenes (a dragon+bird, a patch-bay panel, a frozen
laptop). NONE of those 3 ids appear in `flow_list_generations`' most recent 10 entries for
the same project. The actual newest gallery entry was a completely different id, `0ca3e669`,
which `flow_list_generations` couldn't even backfill a title for (not in this MCP process's
own job history either). Downloading `0ca3e669` directly produced the CORRECT on-prompt
image (keycaps/ribbon/stopwatch/document, matching the prompt exactly).

So: the tool's own generation call fabricated/mismatched ids that don't correspond to what
Flow actually put in the gallery — this is an id-tracking bug inside `generate-image.js`
(probably: reads gallery tile ids too early, before the just-generated tile is actually
inserted/settled in the DOM, and grabs 3 stale neighbouring tiles instead), not a prompt/
context problem. The 3 misreported images were NOT garbage/hallucinations either — one was
confirmed, by the user recognising its exact prompt text, to be the real `vs_superwhisper`
dark-variant asset ("Modern 3D illustration on pure black... a laptop that stays cool
because the work happens on a server") — a completely legitimate, correctly-generated image
from EARLIER work in this project, just misattributed to this call. So the failure mode is
precisely: correct old gallery tiles, wrong new-generation attribution — not corrupted or
nonsensical output.

**FIXED (2026-08-18)**: `verifyNewestTileIds` added to `gallery.js`, called from
`generate-image.js` right after `editIds` is computed — cross-checks against a fresh
`listGenerations` scan and throws (rather than returning the wrong files silently) if NONE
of the returned ids trace back to the newest gallery entries; logs a warning on a partial
mismatch instead of hard-failing, to avoid false positives from a slow-settling tile.
`followUpEdit` (the `flow_edit_generation` path) got the equivalent guard too, via a new
`getMainPreviewMediaId` that reads the edit page's largest-rendered `<img>`'s own current
src directly — the one signal that can't be fooled by the version-history side panel's
thumbnails mounting/unmounting independently of the actual edit. Needs an MCP restart to
load; not yet re-verified through a real generate/edit call (this fix and the landing-page
bounce fix above were done in the same investigation, without spending credits to test).

--- original (wrong) theory, kept for context ---
Suspected "long project chat history contaminates generations" — a brand-new project would
avoid it, prior turns bleeding into Nano Banana Pro's context despite fresh-mode. Discarded:
the actual mechanism is the id-mapping bug above, confirmed by direct gallery cross-check.

## `rclone` not installed — CLAUDE.md's Nextcloud instructions don't work on this machine

`/home/schneider/.claude/CLAUDE.md` documents a pre-configured `claude-homeserver:` rclone
remote for pushing generated images to Nextcloud (`ai_image_resources/README.md` also
assumes it). `which rclone` / `command -v rclone` / a filesystem search all found nothing —
not on PATH, not in any common bin dir. The upload step in the documented workflow is
currently a no-op that would silently fail if not checked (it did fail loudly here:
`/bin/bash: line 9: rclone: command not found`). Needs rclone actually installed on this
host, or the docs corrected to say where it really lives / how to get it.

## Job queue gets stuck at 0% progress, blocks all future generations

Seen at least twice this session: `flow_queue_status` reports `hasActiveJob: true` with
`progress: 0` on a job whose originating tool call had already returned (success or error)
minutes earlier. Every subsequent `flow_generate_image`/`flow_edit_generation` call then
hard-fails with `"A job is already in progress: {id}. Wait for it to complete."` and it never
clears on its own. Reconnecting the browser (`flow_disconnect`+`flow_connect`) does NOT clear
it — the lock is process-local MCP state, not browser/page state. The new `flow_queue_reset`
tool force-clears it and works, but it's a workaround for a queue that isn't actually
tracking job completion correctly — root cause (why the queue doesn't see the job as
resolved) is still unknown.

## Requested ratio silently ignored on one generation, not others (same call shape)

`flow_generate_image` for `whatsapp_transcription_1x1` was called with `ratio: "1:1"`; the
API response echoed back `"ratio": "1:1"`. The downloaded 2K file (both white and black
variants) is actually 2752x1536 (16:9-ish), not square — confirmed via direct pixel
measurement, not a display artifact. `landing_every_platform_1x1`, generated moments later
with the identical `ratio: "1:1"` param, correctly came out 2048x2048. Same call shape, same
model, same project — one honored the ratio, one didn't, and the tool reported success with
the wrong ratio both times (no mismatch warning, unlike `flow_edit_generation`'s ratio-drift
detection, which only guards its own edit path, not fresh `flow_generate_image` calls).

**FIXED (2026-08-18)**: `generate-image.js` now reads each new tile's actual rendered
`naturalWidth`/`naturalHeight` from the DOM (same signal `followUpEdit` already used) right
after `waitForNewMedia` resolves, compares against the requested ratio with a 3% tolerance,
and surfaces a `ratio_warning` + `ratioMismatches` array in the job result on mismatch —
warns rather than retries, so a real mismatch is visible to the caller instead of silently
trusted from the API's echoed-back (and apparently unreliable) ratio field. Needs an MCP
restart to load; not yet re-verified live.

## MCP-launched Chrome process died mid-session, no recovery

`flow_screenshot` and `flow_account_check` both failed with `page.$: Target page, context or
browser has been closed` after the underlying Chrome process exited (unrelated external kill
in this case, but the failure mode matters). `flow_connect` called again then also failed
(`page.goto: Target page, context or browser has been closed`) — connect doesn't detect a
dead browser handle and start fresh, it tries to reuse the dead one. Needs a liveness check
that discards the stale browser/context before attempting reconnect.
