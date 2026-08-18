## See also: docs/FLOW_API_NOTES.md

Full manual walkthrough (login → select project → generate → download → edit/remix) done
2026-08-13 via real Chrome (not the MCP's browser), with network capture at every step.
Covers the OAuth login bug (§1, explains `account: null` after `flow_connect`), the real
generation endpoint, the no-UI download shortcut via `media.getMediaUrlRedirect`, and the
edit/remix flow sharing the same endpoint as fresh generation. Read that file before touching
`launch-profile.js`, `connect.js`, `generate-image.js`, or `download-latest.js`.

# MCP weaknesses — found during live use

Logged each time a real interaction hit a gap in the tool surface. Not code review, just field notes.

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

## MCP-launched Chrome process died mid-session, no recovery

`flow_screenshot` and `flow_account_check` both failed with `page.$: Target page, context or
browser has been closed` after the underlying Chrome process exited (unrelated external kill
in this case, but the failure mode matters). `flow_connect` called again then also failed
(`page.goto: Target page, context or browser has been closed`) — connect doesn't detect a
dead browser handle and start fresh, it tries to reuse the dead one. Needs a liveness check
that discards the stale browser/context before attempting reconnect.
