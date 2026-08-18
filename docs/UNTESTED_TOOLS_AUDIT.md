# Untested tools audit

These tools were flagged UNVERIFIED in their descriptions (predate this session's live-testing work). Testing each headed, one at a time, against the "Tests" project. Verdict is either **WORKS** (ship, remove the caveat), **BROKEN** (needs a fix — root cause noted below, not fixed yet), or **UNTESTABLE** (couldn't reach a real test, e.g. missing prerequisite).

This is a tracking document, not a fix log — issues found here feed a later fix pass. Don't fix inline while auditing.

## Status — audit complete, 9/9 tested

| Tool | Verdict | Notes |
|---|---|---|
| flow_discover_ui | **WORKS** | Generic diagnostic dump, does exactly what it says. Ship as-is (drop the caveat). |
| flow_create_character | **BROKEN + CRITICAL** | Stops after landing on the real composer instead of using it; also never completes/fails its job, permanently blocking the (single-slot) job queue for every other job-based tool until reset/restart. `flow_queue_reset` (added this session) now recovers without a restart. |
| flow_import_character | **BROKEN, worse than it looks** | Navigates to a dead URL (same 404 as flow_open_characters). Separately, and regardless of that: `file_path` — the tool's one documented, only param — is never read anywhere in the handler. It uses undocumented `image_path`/`description` params instead. The schema and implementation don't match; nobody could use this as documented even if the URL were fixed. |
| flow_open_characters | **BROKEN** | Navigates to a dead URL (404-style "nothing here" page) |
| flow_create_scene | **BROKEN, unsafe** | Silently operates on the wrong page (leftover Characters page from a prior call) while reporting success-like status — real risk of submitting a scene prompt into the character composer |
| flow_open_tools_gallery | **BROKEN** | `navigateToSidebar(page, 'Tools')` finds nothing, fails silently, tool reports `status: 'opened'` on a completely stale page |
| flow_use_grid_architect | **BROKEN** | Lands on the generic "Explore Tools" community-tools browsing page (confirmed via screenshot), never reaches an actual Grid Architect config page, reports fake `status: 'ready_for_confirmation'` |
| flow_use_tool | **BROKEN** | Direct-URL fallback (`/fx/tools/flow/tools/{slug}`) 404s (confirmed: page showed `H1: ERROR: 404`), reports fake `status: 'tool_opened'` |
| flow_generate_video | **BROKEN, but fails loud (good)** | Correctly throws `Model option "Veo 3.1 - Fast" not found` instead of faking success. Root cause confirmed via screenshot: the settings menu never switches from the "Image" tab to "Video" before trying to pick a video model — it's picking from the *image* model list. Model codenames (`veo_3_1_fast` etc.) remain unverified on top of that, since it never got far enough to test them. |

## Correction after retesting from a clean page (post-audit)

Two verdicts above were wrong — both failures turned out to be caused by starting from an already-broken/stale page left over from a *previous* tool's test, not a real bug in the tool itself:

- **flow_open_tools_gallery** — retested from a clean project page: navigates correctly to the real project-scoped `/tools` page, lands on the genuine "Explore Tools" UI (My Tools / Community / Templates, "My creations" section). **Actually WORKS.** Restored to the tool surface.
- **flow_create_scene** — retested from a clean page: `navigateToSidebar(page, 'Scenes')` *does* find and click a real "View scenes" sidebar button this time (unlike the original test, which inherited a dead page). But what opens is a **media-library asset picker/filter** (Images/Videos/Voices/Characters/Uploads tabs), not a dedicated "create a scene from characters + a prompt" composer — "Scenes" is a category filter over your existing generations, not a compositional creation feature. Separately, Tools → Templates has a *different* built-in template called "Scene Explorer" (also not what this tool assumes). **The tool's entire premise doesn't match any current Flow feature.** Removed (file deleted, not re-added).

This is itself a lesson for the fix pass: several of these tools never re-establish a clean baseline (e.g. `ensureProjectInContext` back to the base project URL) before navigating, so one broken/stale call can cascade into false failures on the next.

## Decisions after audit

- **Removed** (no longer registered, source deleted): `flow_import_character` (schema/impl mismatch, dead URL, no evidence Flow has JSON character import), `flow_create_scene` (see above), `flow_use_tool` (generic catch-all, unreliable dead-URL fallback, redundant now that Grid Architect gets its own real tool).
- **Kept, fix dispatched**: `flow_generate_video` (Image→Video tab-switch bug), `flow_create_character` (use the real composer instead of a nonexistent button), `flow_use_grid_architect` (real navigation path found: Tools → Templates tab → click "Grid Architect" tile → creates a remix at `/tool/{uuid}` → "Start Architecting" button, not yet mapped past that point).
- **Kept, no fix needed**: `flow_discover_ui` (works), `flow_open_characters` (works — was never the issue, `flow_create_character`'s composer-handling was), `flow_open_tools_gallery` (works, see correction above).

**Net: 1 works, 8 broken.** Two failure shapes worth generalizing when fixing:
1. **Fake success** (5 of 8): tool returns a normal-looking `status` while actually sitting on the wrong page/a 404/a stale leftover page. Every one of these should verify it actually reached the intended page (URL check, or a page-specific marker element) before returning success — same "fail loud" discipline already applied to flow_generate_image/flow_download_latest/flow_edit_generation this session.
2. **Shared broken navigation helper**: `navigateToSidebar` (src/navigation/project-navigator.js) is the common dependency behind flow_open_tools_gallery, flow_use_grid_architect (indirectly, via grid-architect.js), flow_create_character, flow_create_scene — see root cause below.

## Root cause: `navigateToSidebar` (src/navigation/project-navigator.js)

Tries a list of generic guessed selectors (`nav button:has-text("Tools")`, `[class*="sidebar"] a:has-text("Characters")`, etc.) against the CURRENT Flow UI, which is icon-only in the places this session actually mapped live (composer, gallery tiles, settings menu — see docs/UI_STATE_MACHINE.md). "Characters" happens to still text-match something; "Tools"/"Scenes" do not. On no match it returns without throwing — every caller (5 tools: create-character, create-scene, grid-architect, open-tools-gallery, use-flow-tool) proceeds as if navigation succeeded, silently acting on whatever page was already open. This single helper is the shared root cause behind most of the failures above.

## Root cause: stuck job queue (src/tools/create-character.js + src/queue/job-queue.js)

`create-character.js`'s early-return path (`status: 'ui_discovered'`, hit when the expected "New Character" button isn't found) returns straight from the handler without calling `jobQueue.completeJob()` or `jobQueue.failJob()`. `JobQueue` is single-slot (`createJob` throws `JOB_IN_PROGRESS` while any job is `running`) and purely in-memory with no enforcement of `jobTimeoutMs` anywhere in the codebase, so a job stuck like this blocks every other job-based tool (flow_generate_image included) for the rest of the process's life — the only recovery is restarting the MCP. Likely other early-return paths across the tools have the same gap; worth auditing every handler for a guaranteed completeJob/failJob on every exit path, not just the try/catch's own catch block.

## Root cause: dead URLs (`/characters`, `/tools/flow/tools/{slug}`)

`flow_open_characters`/`flow_import_character` hard-navigate to `.../characters`; `flow_use_tool`'s fallback hard-navigates to `https://labs.google/fx/tools/flow/tools/{slug}`. Both 404 against the current Flow UI (confirmed live via screenshot for both). Whatever these paths pointed to has moved or been removed. Needs live discovery of the real current URL/navigation path (same DOM-first-then-verify-live method used throughout this session for gallery/composer/settings), not a guessed URL.

## Root cause: settings menu stuck on "Image" tab (flow_generate_video)

The Agent-OFF settings menu (see docs/UI_STATE_MACHINE.md) has an `IMAGE | VIDEO` mode-tab pair at the top, confirmed live. `agent-settings.js`'s `applySettings` — used by both flow_generate_image and flow_generate_video — never clicks the `VIDEO` tab before looking for a model in the dropdown, so a video generation call is silently reading/writing the *image* model list. Needs an explicit `mode: 'image' | 'video'` concept threaded through `ensureSettingsPanelOpen`/`applySettings`, defaulting to whichever the caller needs, with a tab click before touching ratio/model/quantity.
