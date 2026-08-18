# MCP fails found during VibeVoice image-generation run

Tracking doc for bugs hit in google-flow-browser-mcp while running the VibeVoice
`ai_image_resources` black/white pair generation pipeline (started 2026-08-14).
Not a fix-everything log — just what broke and what was done about it.

## 1. Stale Chrome instance silently reused across `flow_connect` calls, ignoring `virtual_display`

`flow_connect` reuses an already-running Chrome bound to CDP port 9222 instead of relaunching,
even when the requested `virtual_display` differs from how that Chrome was originally launched.
A Chrome process launched earlier in the session with `virtual_display: true` (or the config
default `virtualDisplay: true`) kept running with `--ozone-platform=x11` rendering into the
off-screen Xvfb display. Every subsequent `flow_connect({ virtual_display: false })` call
returned `"status": "connected"` successfully — account verified, URL correct — while actually
just re-attaching to that same off-screen process. The user could not see the browser window on
their real screen despite requesting headed mode, with no error or warning surfaced.

**Fix applied this run**: manually found and killed the stale process (`ps aux | grep
remote-debugging-port=9222`, `kill <pid>`), then reconnected — new process correctly launched
with `--ozone-platform=wayland` on the real display.

**Real fix needed**: `flow_connect` should detect a display-mode mismatch between the requested
`virtual_display`/`headless` and the already-running Chrome's actual launch flags, and either
(a) kill + relaunch automatically, or (b) refuse and tell the caller to disconnect first — never
silently reuse a session on the wrong display.

## 2. `inlineSettingsTriggerLocator` regex missed the fresh-project Video-mode trigger text

`src/browser/agent-settings.js`'s composer settings-trigger locator matched
`/Nano|Banana|Omni|Veo|Imagen|Video\s*·/`. A brand-new, empty Flow project's composer defaults to
Video mode with the trigger showing **`"Video ▭ x1"`** — no middle dot character, no duration
segment. The regex required `Video` to be followed by `\s*·`, so it never matched, and
`flow_generate_image` failed with `"Settings trigger button (model/ratio/count summary) not
found in composer toolbar."` even though the button was on screen and visible.

This is the same class of bug fixed earlier this session for the *populated*-project Video-mode
case (`"Video · 8s ⬜ x1"`, matched) — the fresh-project empty state uses a third, shorter text
format that wasn't covered.

**Fix applied**: broadened the regex to `/Nano|Banana|Omni|Veo|Imagen|Video/` (drop the `\s*·`
requirement — matching the bare word `Video` is enough, the alternation already narrows this to
the one settings-trigger button). Requires an MCP restart to take effect (Node caches the loaded
module; the running server process still has the old regex in memory until relaunched).

## 3. `flow_generate_image` leaves job queue stuck when it fails before `startJob`/connection check

Calling `flow_generate_image` while the browser wasn't connected yet returned `"Browser not
connected. Call connectToBrowser() first."` as expected, but the job it had already created in
`jobQueue` (`createJob('image_generation', ...)`) was left in `status: "running"` forever —
`flow_queue_status` showed `hasActiveJob: true` with `progress: 0` and a `createdAt` matching the
failed call, and every subsequent `flow_generate_image` call failed with `"A job is already in
progress"` even after successfully connecting. Recovered via `flow_queue_reset` (no MCP restart
needed this time). Root cause is the same shape as the earlier `flow_create_character` stuck-queue
bug from this session's audit: `createJob` runs before the connection/precondition check, and that
early-return path doesn't call `failJob`. Needs the same fix pattern — guarantee `completeJob`/
`failJob` on every exit path, ideally by checking preconditions (browser connected) *before*
`createJob`, not after.

## 4. CRITICAL: `fillPrompt` typed literal newlines, each one firing an early Generate

`src/browser/composer.js`'s `fillPrompt` used `promptInput.type(text, { delay: 15 })` with the
raw multi-paragraph prompt text (real `\n` characters, one per line of the built prompt files —
dozens per prompt). Playwright's `.type()` sends real per-character keydown events, and Flow's
Slate-based composer treats bare Enter as **submit** (chat-input semantics), not newline-insert.
Every `\n` in the prompt fired Generate immediately with whatever partial prompt text had been
typed up to that point — one real multi-line prompt produced roughly 20 separate premature
generations in the VibeVoice project before this was caught mid-run by the user watching the
headed browser window.

**Fix applied**: `fillPrompt` now collapses all whitespace (`\s+`, including newlines) to single
spaces before typing, so no `\n` ever reaches `.type()`. Requires MCP restart to load.

**Damage from this run**: needs manual cleanup in the Flow "VibeVoice" project gallery —
an unknown number of garbage/partial-prompt generations were created and likely spent credits.
Not cleaned up automatically by this fix; someone should check the project gallery and delete
the junk entries.

## 5. `fillPrompt` timed out on long prompts (15ms/char delay > 30s default timeout)

After fixing #4 (collapsing newlines to spaces), a ~1900-character prompt (typical size for the
VibeVoice house-style prompts, which are long and detailed) hit `locator.type: Timeout 30000ms
exceeded` — 15ms/char × ~1900 chars ≈ 28.5s, right at Playwright's default 30s action timeout,
and it lost the race. This one failed clean (job queue correctly showed no stuck job afterward —
this exit path is inside the try/catch, unlike bug #3).

**Fix applied**: dropped `type()`'s `delay` from 15ms to 5ms and set an explicit `timeout: 60000`.
Requires MCP restart to load.

## 6. No 1400-char prompt limit enforced — Flow silently refuses instead of erroring

Flow enforces a **1400-character prompt limit**, for both image and video composers (confirmed
by the user watching the headed browser). The MCP had no awareness of this: `fillPrompt` would
attempt to type an over-limit prompt (our ~1900-char VibeVoice house-style prompts routinely
exceeded it) and either hang/time out (bug #5) or silently fail to be accepted by Flow with no
clear signal back to the caller — the user reported "last was also not sent bc of that."

**Fix applied**: `fillPrompt` (`src/browser/composer.js`) now checks `singleLine.length >
PROMPT_CHAR_LIMIT` (1400, exported const) before typing and throws `FlowError(INVALID_PARAMS, ...)`
with the actual length and the limit — fails fast and clean instead of a 60s timeout or a silent
no-op. Also updated the `prompt` param descriptions for `flow_generate_image`/`flow_generate_video`
in `src/index.js` to state the hard limit up front. Requires MCP restart to load.

**Consequence for the VibeVoice run**: all 20 house-style prompts (~1900–2500 chars each) need to
be condensed to ≤1400 chars before they can be sent — this is being done by hand-compressing the
boilerplate STYLE/AVOID/ALSO-WELCOME sections while preserving the subject-specific MAIN ELEMENTS
and COLOR PALETTE content.

## 7. `flow_generate_image`/`flow_generate_video` fail outright when the browser is still on a generation's `/edit/{id}` page

After a `flow_edit_generation` (follow-up white-background edit) + `flow_download_latest` on
subject 1, the very next `flow_generate_image` call for subject 2 (same project, fresh call)
failed with `"Could not find the Agent mode toggle button on the composer."` — confirmed via
screenshot: the browser was still sitting on the previous generation's `/edit/{id}` page (the
"What do you want to change?" edit composer), which has no Agent toggle button at all (that
control only exists on the plain project-root bottom composer).

Root cause: `ensureProjectInContext` (`src/navigation/project-navigator.js`) only compares the
`project_id` segment of the URL — `/project/{id}/edit/{genId}` still matches `{id}`, so it
short-circuits as "already in context" and never navigates anywhere. `flow_generate_image`'s
STEP 1.5 (`closeSidebar` — closes an open Agent-chat sidebar) doesn't cover this case either;
it's a different UI surface (a whole different page, not a sidebar overlay). Both generate tools'
documented "auto-detects and forces the plain bottom composer (fresh mode) first" claim was false
in this specific case.

**Fix applied**: both `src/tools/generate-image.js` and `src/tools/generate-video.js` now check
`page.url().includes('/edit/')` right after `ensureProjectInContext` and, if true, `page.goto()`
back to the project root (URL truncated at `/edit/`) before touching the sidebar/Agent-toggle
logic. Requires MCP restart to load. Duplicated in both files rather than factored into a shared
helper, matching this codebase's existing precedent of light duplication between the two generate
tools rather than a new abstraction.

## 8. `flow_edit_generation` follow-ups can silently change aspect ratio/dimensions

On subject 3 (`compare_hub`), the white-background follow-up edit (`flow_edit_generation` with
instruction "...change the black background to a solid pure white...") came back as 2816×1536
instead of the original 2048×2048 square — a different aspect ratio entirely, not just a
resolution change. Subjects 1 and 2 (same generic instruction wording, no explicit ratio
mention) came out correctly matched. Not deterministic — the edit composer apparently doesn't
strictly inherit/lock the source generation's aspect ratio, and the model's compliance with
"EXACT SAME image content" varies. This broke the two-pass alpha-diff tool downstream
(`Error: Dimension mismatch: Images must be identical size`).

**Not fixed at the MCP level this run** — `flow_edit_generation`'s composer (the "What do you
want to change?" bar on a generation's `/edit/` page) has no visible ratio/settings control at
all in the DOM (confirmed via screenshot), so there's no UI lever for the tool to enforce ratio
the way `applySettings` does for fresh generations. Worked around at the call-site instead: the
follow-up instruction now explicitly states "keeping the exact same 1:1 square aspect ratio and
composition as the original" — this fixed the retry. Every subject in this run now includes that
explicit ratio clause in its white-variant instruction. A real fix would need `flow_edit_generation`
to read back the resulting image's dimensions and auto-retry/warn on mismatch against the source.

## 9. `flow_connect` in-process reuse ignored a display-mode mismatch (real fix for bug #1)

Bug #1's fix (kill the stale process, reconnect) only fixed the symptom for that one incident.
Root cause: `launchChromeDirect` (`src/browser/connect.js`) checked only whether the in-process
`page`/`browser` handle was alive — if so it returned immediately ("Already connected, reusing
browser") regardless of whether the CURRENT request's `virtual_display`/`headless` differs from
how that live browser was actually launched. Within one long-running MCP process, a later
`flow_connect({ virtual_display: false })` after an earlier `{ virtual_display: true }` call
would silently keep reusing the off-screen browser — exactly bug #1's symptom, but reachable
without any restart or manual process kill.

**Fix applied**: added `lastLaunchMode` module state tracking `{ headless, virtualDisplay }` for
whichever browser is currently live. `launchChromeDirect` now compares the requested mode against
it and calls `closeBrowser()` before relaunching if they differ, instead of reusing. Also hardened
`closeBrowser()` itself: CDP `Browser.close()` was not reliably killing a directly-spawned (not
Playwright-launched) Chrome process (confirmed live — the process survived `flow_disconnect` and
needed a manual `kill`), so the spawned child process handle is now tracked and sent `SIGTERM` as
a backstop. Requires MCP restart to load.

## 10. `flow_edit_generation` ratio drift — now auto-detected and auto-retried inside the tool

Bug #8 above was only ever fixed at the call site (appending an explicit ratio-lock clause to
every white-variant instruction in this run's own prompts) — the tool itself had no awareness of
the problem. Fixed properly: `followUpEdit` (`src/browser/gallery.js`) now reads the hero
`<img>`'s natural pixel dimensions before and after the edit (same `img.width > 100` hero-image
filter `download-latest.js` already uses to distinguish it from thumbnail-strip images), and if
the aspect ratio changed, automatically retries once with an explicit ratio-lock clause appended
to the instruction — the same fix that worked reliably by hand in this run. If it still drifts
after the retry, `flow_edit_generation` now throws a clear `FlowError` (new media id included, so
the caller can decide whether to keep or discard the wrongly-shaped result) instead of silently
returning success. Requires MCP restart to load.

## 11. `flow_use_grid_architect` form fields — now actually wired up (real root cause: sandboxed iframe)

The reason theme_prompt/shot_prompts/engine/ratio/visual_logic were never wired up, and why
"Start Architecting" only ever got a `.catch(() => {})` best-effort click that silently did
nothing: Grid Architect's entire UI — confirmed live via `page.frames()` — runs inside a sandboxed
`<iframe title="Applet preview" sandbox="allow-scripts">`, a completely separate frame from the
top-level Flow page. Every previous selector was written against the main page, where none of
this UI exists at all (`page.locator('button', {hasText: 'Start Architecting'})` had 0 matches,
not a timing issue — the button simply isn't in that document).

Mapped live via `page.frameLocator('iframe[title="Applet preview"]')`: after "Start Architecting",
a CONFIGURATION panel has three dropdowns — **ENGINE** ("Nano Banana 2" / "Nano Banana Pro"),
**FORMAT RATIO** ("1:1" / "16:9" / "9:16" / "4:3" / "3:4"), **VISUAL LOGIC** ("Style from
References" / "Ultra Realistic" / "Cinematic Movie" / "Film Noir" / "Anime / Manga" / a "+ Custom
Style" option not wired up) — followed by a 3-way mode switch: **UNIFIED THEME** (one master-prompt
textarea), **SEQUENCE** (4 shot cards, each with a shot-type dropdown, camera-angle dropdown, and
a "Shot details..." textarea — the 4 textareas share an identical placeholder with no other
distinguishing attribute, so they're targeted by DOM order, which matches shot index), and
**PROMPT WIZARD** (not wired up — auto-storyboard-from-script, out of scope). Each dropdown's
option buttons required an anchored exact-text regex to select correctly, not a substring match —
once a value is picked, the trigger button's own text also contains that value as a substring
(e.g. trigger reads `"FORMAT RATIO\n\n16:9"`), so a substring-matching locator would re-hit the
trigger (re-opening the menu) instead of picking a different option on a second call.

**Not fixed**: reference-image upload (`references` param, and each shot's own "+ COMPOSITION"
button) — clicking the "+" under GLOBAL REFERENCES revealed no `<input type="file">` anywhere in
the page's DOM (checked explicitly), so whatever upload mechanism it uses is still unmapped. The
`references` param is accepted but logged-and-ignored rather than silently pretended-to-work.

**Fix applied**: `src/tools/grid-architect.js` rewritten to navigate the iframe, select all three
dropdowns via the exact-text-match helper, fill Unified Theme or Sequence mode based on whether
`shot_prompts` was given, and click Generate under the same `auto_confirm` credit-spend gate used
everywhere else in this codebase. `src/index.js`'s tool schema updated with the real option lists
(previously guessed and wrong — e.g. visual_logic previously described as "None, Colour Pop, Side
by Side, etc.", none of which are real options) and the sandboxed-iframe root cause. Requires MCP
restart to load; not yet re-verified live through the actual MCP tool call (only through raw
scripts against the same live browser) — needs one more pass after restart.

## 12. `launchChromeDirect`'s existing-port cleanup raced its own respawn (real root cause of #1/#9)

Bug #9's fix (detect a display-mode mismatch on the in-process handle) didn't cover the case
where the MISMATCH SURVIVES AN MCP RESTART — a fresh process has no `lastLaunchMode` to compare
against, so it always attempts to spawn fresh. Confirmed live: after a full MCP restart, a
`flow_connect({ virtual_display: true })` call still returned a real-screen (`ozone-platform=
wayland`) browser. Root cause: `existing.close()` (the CDP-based cleanup of whatever's on
`cdpPort` before spawning) doesn't reliably kill a directly-spawned Chrome process, and the code
immediately spawned a new Chrome + polled `/json/version` without ever confirming the port was
actually free — the new process's `--remote-debugging-port` bind silently lost the race, and the
poll happily talked to the OLD zombie process instead, with no error anywhere. This is the same
underlying defect as bug #1, just triggered by a process restart instead of an in-session
`flow_connect` call.

**Fix applied**: after `existing.close()`, actively poll whether `cdpPort` is still answering
before spawning; if so, shell out to `fuser -k <port>/tcp` and poll again; if it's *still* bound
after that, throw a clear `FlowError` with the manual kill command instead of silently reusing the
wrong browser. Requires MCP restart to load (not yet verified through a restart — this session's
generation batch proceeded after a manual `kill` of the stale PID, same workaround as bug #1).

## 13. `flow_download_latest` (2K) — `download.saveAs()` ENOENT despite the browser reporting success

Partway through the 26-subject regeneration batch (subject 24, `og_mark_coins`), 2K downloads
started failing with `download.saveAs: ENOENT: no such file or directory, copyfile '/tmp/
playwright-artifacts-.../{uuid}' -> 'outputs/images/...'` — repeatedly, across a fresh generation
and a fresh edit, not tied to one specific generation. Confirmed live: the Flow UI's own
"Upscaling complete, your image has been downloaded!" toast fired every time, and the real file
reliably landed in the OS `~/Downloads` folder (e.g. `Purple_glass_coins_in_row_202608142208.jpeg`,
correct 2048×2048) — so the download itself always succeeded; only Playwright's own tracked
artifact reference broke. This contradicts this codebase's earlier assumption (documented inline
in `download-latest.js`) that CDP download interception is exclusive and nothing reaches the real
Downloads folder — it isn't exclusive, at least not reliably under sustained use across many
downloads in one session.

Recovered manually mid-run by reading the leaked file straight from `~/Downloads` (matched by
filename prefix, newest by mtime) for the 2 affected subjects, then deleting the leaked copies to
avoid clutter.

**Fix applied**: `download.saveAs()` is now wrapped in try/catch; on failure, falls back to
scanning `~/Downloads` for a file matching `download.suggestedFilename()`'s base name (Chrome
appends " (1)" etc. on collision, so matched by prefix + newest mtime, not exact name), copies it
into the intended `outputs/images/` path, and deletes the leaked original. Throws a clear
`FlowError` only if no fallback match exists either. Requires MCP restart to load; the last 2
subjects of this run used the manual version of this same recovery by hand.

## 14. No support for a second Google account — added `profile` param to `flow_connect`

Needed to work around Nano Banana Pro's daily quota by connecting under a second Google account.
Found real gaps: `launch-profile.js` had a "try connecting to any existing Chrome instance first"
shortcut that bypassed all profile-awareness — it would blindly reuse whatever's on the CDP port
regardless of which profile it was launched under, so switching accounts while a browser was alive
under the first one would silently keep using the wrong account. `connect.js`'s reuse-vs-relaunch
decision (`lastLaunchMode`) also didn't track profile identity, only display mode — same bug from
a different angle. And `account-check.js`'s `verifyAccount` hard-threw `WRONG_GOOGLE_ACCOUNT` on
any mismatch against the single fixed `expectedAccount` from config, which would incorrectly fail
a deliberately-different second account. Also found while fixing this: both call sites of
`checkAccount` in `index.js` passed `page` as a first positional argument that `verifyAccount`'s
real signature (`{ enforceExpected } = {}`) doesn't accept — a pre-existing dead argument, harmless
before since the function always used the default, but would have silently swallowed the new
`enforceExpected` override too if left as-is.

**Fix applied**: `flow_connect` now takes a `profile` param (default `"kiara"`, the original
profile). Each key gets its own `chrome-profile-{key}/` directory, `lastLaunchMode` now includes
the profile dir so a profile switch forces a relaunch like a display-mode switch does, a non-
default profile starts completely empty (no seeding from the default account's session — same
one-time interactive sign-in flow that originally onboarded "kiara"), and `verifyAccount` accepts
`enforceExpected: false` for non-default profiles so it reports whichever account is signed in
instead of throwing. `.gitignore` updated to `chrome-profile-*/` (was the single literal name).
Requires MCP restart to load; not yet verified live (needs the actual second-account sign-in flow
run once headed).

## 15. Multi-profile architecture rework — `profiles` map replaces flat single-account config

Follow-up to #14. Config previously had flat `expectedAccount`/`chromeProfile`/`defaultProfileKey`
fields describing only ONE account, with any additional profile existing purely as runtime
`flow_connect` args and a directory on disk — no persistent record of which accounts existed or
where they came from. Also found while building this: 7 call sites across `generate-image.js`,
`generate-video.js`, `create-character.js`, `grid-architect.js` unconditionally reported
`account: get('expectedAccount')` in their result payloads — always the DEFAULT account, even when
actually running under a different profile. Latent bug, invisible until a second profile existed.

**Rewrite**: config now has `defaultProfile` (key) + `profiles` (map: `{ [key]: { sourceProfile,
expectedAccount } }`) as the single source of truth for every known account. `connect.js` tracks
the actually-active profile key (`activeProfileKey`, alongside the existing `lastLaunchMode`
display-mode tracking) via a new `getActiveProfileKey()`. `launch-profile.js` resolves
`sourceProfile` from config automatically (explicit arg still overrides) and exposes
`getActiveExpectedAccount()` so any tool can report the correct account for whichever profile is
actually live, not a hardcoded default. `account-check.js`'s `verifyAccount` no longer reads
config at all — pure DOM-reading utility, caller passes `expectedAccount` explicitly. `flow_connect`
self-registers: on a verified account for a profile with no recorded entry (or an outdated one), it
writes `config.profiles[key] = { sourceProfile, expectedAccount }` back to disk via a new
`updateConfig()` (backs up the previous file first — this was a README-advertised feature that
didn't actually exist in code until now). A re-seed or a fresh session never needs `source_profile`
handed over again once a profile has connected successfully once.

Also renamed the original default profile from the inherited codename `"kiara"` to `"fschneider496"`
(directory `chrome-profile-kiara/` → `chrome-profile-fschneider496/`, preserving its session) —
the key is genuinely arbitrary (nothing downstream requires it to be an email), but an opaque
codename was needless confusion.

Requires MCP restart to load. Not yet verified live — the actual second-profile connect (key
`joohnsmiitth618`, seeded from system `Profile 3`) is still pending this restart.

## Run outcome (round 1 — superseded)

All 20 missing subjects from `00_prompts/built/` (per `INDEX.md`, everything marked `[ ]`) were
generated black-first, edited to a matching white variant (explicit 1:1-ratio-lock instruction
per bug #8), downloaded in 2K, and diffed into `02_transparent/{name}/{name}_clean.png` via
`generate_transparent_image.ts --remove-watermark`. All 20 black/white pairs matched dimensions
(2048×2048) on the first or second attempt. `batch_upload` was skipped — no built prompt file
exists for it (not yet run through `build_prompts.py`), out of scope for this pass.

Bugs #1–#8 above were all found and fixed live during this run, each requiring an MCP restart to
verify. No known-broken behavior remains open in `flow_generate_image`/`flow_edit_generation`/
`flow_download_latest` as exercised by this pipeline; #8 (edit-page ratio drift) has a working
call-site mitigation but no proper fix inside the tool itself — flagged as a real follow-up.

## Run outcome (round 2 — full prompt-set rewrite, all 26 subjects)

VibeVoice's prompt set was rewritten from scratch (per-object unique house style, format-per-
composition instead of blanket 1:1 — 13 subjects at 16:9, 13 at 1:1). All round-1 local output
(`01_raw/`, `02_transparent/`) was discarded per explicit instruction, and all 26 `[ ]`-marked
subjects from the new `INDEX.md` were regenerated from scratch: `vs_*` (7), `compare_*` (5),
`use_case_rsi_dictation`, `research_whisper_benchmark`, `for_*` (4), `og_mark_*` (8). Ran on
`virtual_display: true` (Xvfb) this time, not headed-on-real-screen. Watermark removal is no
longer used at all — MCP-downloaded images have no Flow watermark baked in (confirmed: the flag
was already optional, just stopped passing it), so `--remove-watermark` was dropped from every
call; output is `{name}_raw.png` only, no `_clean.png` step.

All 26 pairs completed and matched dimensions. Two more real bugs found and fixed live during this
round (#12, #13 below) — both required workarounds mid-run before their code fixes could be
verified (a full MCP restart was pending for most of this round). Also hit, and worked around
without a code change: `og_mark_keyboard`'s first attempt failed with **"You've reached the daily
limit for 🍌 Nano Banana Pro generations"** — a real per-account daily quota, not an MCP bug;
retried with `model: "Nano Banana 2"` and it completed normally. Worth knowing before running
another large batch same-day.
