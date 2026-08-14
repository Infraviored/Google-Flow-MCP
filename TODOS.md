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

## MCP-launched Chrome process died mid-session, no recovery

`flow_screenshot` and `flow_account_check` both failed with `page.$: Target page, context or
browser has been closed` after the underlying Chrome process exited (unrelated external kill
in this case, but the failure mode matters). `flow_connect` called again then also failed
(`page.goto: Target page, context or browser has been closed`) — connect doesn't detect a
dead browser handle and start fresh, it tries to reuse the dead one. Needs a liveness check
that discards the stale browser/context before attempting reconnect.
