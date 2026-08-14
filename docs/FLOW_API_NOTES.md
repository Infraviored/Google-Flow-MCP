# Google Flow — live pipeline notes

Captured by manually driving the real, logged-in Chrome (via claude-in-chrome, NOT the
MCP's copied-profile browser) through the full pipeline: login → select project → generate
image (Nano Banana Pro, 1:1) → download → edit/remix ("change last generation"). Every step's
network traffic was captured. Purpose: revise the MCP to prefer direct API calls over UI
automation wherever a stable, cookie-authenticated endpoint exists.

Session: 2026-08-13, account floschneider11111@gmail.com, project VibeVoice
(`d4177429-2e95-4e89-8944-c4667eada39e`).

## 1. Login is a real OAuth code flow, not a session check

Clicking "Create with Google Flow" on the marketing landing page (`labs.google/fx/en/tools/flow`
when logged out) does **not** just check a cookie — it redirects through a full OAuth
authorization-code flow:

```
accounts.google.com/v3/signin/accountchooser
  ?client_id=365941595420-v51i7q8ik0crmaoltkhuo5ogb1kekl6f.apps.googleusercontent.com
  &redirect_uri=https://labs.google/fx/api/auth/callback/google
  &response_type=code&scope=aisandbox+userinfo.profile+userinfo.email
  &flowName=GeneralOAuthFlow
```

- The OAuth **consent screen names the app "AI Test Kitchen"**, not "Google Flow" — that's
  the legacy Labs client name, not a bug/hijack.
- If the account is already authorized (our case), Google skips consent and redirects
  straight back to `labs.google/fx/api/auth/callback/google` (NextAuth-style callback), which
  sets the actual app session.
- **This is why the MCP's copied-profile approach (`launch-profile.js` copying
  `~/.config/google-chrome/Default` into a temp dir) lands on the marketing page with
  `account: null`**: copying the Google account cookie jar is not sufficient — the app-level
  session cookie on `labs.google` is either missing from the copy, scoped in a way that
  doesn't survive the copy, or expired. `flow_connect`'s `accountVerified: {method: "assumed"}`
  is fake (confirmed: `flow_status` right after connect showed `account: null` while connect
  had just claimed `verified: true`).
- **Action item**: either (a) fix the profile copy so the labs.google session cookie survives,
  or (b) detect the logged-out marketing page and drive the real OAuth handshake once, or
  (c) drop the copied-profile approach and connect CDP directly to the user's live Chrome
  instead (no copy, no cookie transplant needed) — this is what worked instantly in this
  session's manual walkthrough.

## 2. Project list: still no clean list API found

Checked three candidate sources, none panned out:
- `_next/data/{buildId}/en/tools/flow.json` (Next.js SSR data for the homepage) — only
  contains `{session, _nextI18Next}`, no project data.
- `window.__JOTAI_DEFAULT_STORE__` (Flow uses Jotai, not Redux) — mounted atoms are
  enumerable via `store.dev4_get_mounted_atoms()`, but none carry recognizable debug labels
  and none held a project list in a quick scan.
- tRPC/`aisandbox` XHR traffic on page load — only `videoFx.getUserSettings` and
  `general.submitBatchLog`, no project-list call visible in the network log at all.

Project cards are virtualized (confirmed again: only the 3 nearest-to-viewport project pages
got Next.js `_next/data/.../project/{id}.json` prefetch requests, out of 5 known projects).
**The scroll-and-accumulate approach already implemented in `listExistingProjects` remains
the only working method** — no shortcut found. If revisited, the thing worth trying next is
capturing the POST body of whatever call feeds the grid (may be a gRPC-Web / non-JSON
transport this network tool doesn't decode), not the endpoints checked here.

## 3. Selecting a project by URL works cleanly

`https://labs.google/fx/en/tools/flow/project/{projectId}` navigates directly into that
project — confirmed via tab title changing to `Google Flow - {projectName}`. This matches
`ensureProjectInContext`'s `project_id` path exactly. No extra network calls beyond normal
page load. This is the reliable path; project-by-*name* still depends on the scroll-list.

## 4. Composer state (model / ratio / count) is pure client state — zero network cost

Opening the model dropdown, switching model, and switching aspect ratio fired **no network
requests at all** except once: opening the model dropdown triggers
`GET https://aisandbox-pa.googleapis.com/v1/flow/models/statuses` (checks model
availability/quota, not required to just set the value). Everything else is local
React/Jotai state until the actual Generate click. Conclusion: DOM-driven selection (current
MCP approach) is already correct and cheap here — no API shortcut needed or possible.

**Bug found**: the real model dropdown offers exactly **Nano Banana Pro / Nano Banana 2 /
Nano Banana 2 Lite**. The MCP's `flow_generate_image` schema says
`"model: Nano Banana Pro, Nano Banana 2, or Imagen 4"` — Imagen 4 does not appear in the
Image-mode dropdown (may be Video-only or retired), and "Nano Banana 2 Lite" is missing
from the schema entirely. Schema needs updating to match.

Aspect ratio buttons match the MCP schema exactly: `16:9, 4:3, 1:1, 3:4, 9:16`. No changes
needed there.

## 5. The real generation endpoint

Clicking Generate (both for a fresh image and for an edit/remix — see §7) fires:

```
POST https://aisandbox-pa.googleapis.com/v1/projects/{projectId}/flowMedia:batchGenerateImages
```

This is the actual work-doing call — project-scoped REST-ish path, Google API `:action`
suffix convention. Request body was not captured (the claude-in-chrome network tool doesn't
expose POST bodies) — that's the next thing to inspect (via Chrome DevTools "Copy as fetch"
or CDP `Network.getResponseBody`/request-body events) if we ever want to call this directly
instead of driving the UI. Given it also requires a fresh reCAPTCHA Enterprise token (see
§6), a direct-API approach is unlikely to be worth it — UI automation is probably the
durable choice for this specific call.

Alongside it: `GET https://aisandbox-pa.googleapis.com/v1/flow/models/statuses` (already
noted) and `POST .../v1/flow:batchLogFrontendEvents` (telemetry, ignorable).

## 6. reCAPTCHA Enterprise gates generation

Every Generate click also fires:

```
POST https://www.google.com/recaptcha/enterprise/clr?k=6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV
```

(returned 503 in this session but generation still succeeded — likely a best-effort
client-log ping, not a hard gate on this particular call, but the presence of Enterprise
reCAPTCHA on the generate path means **any automation fingerprint (headless flags,
`navigator.webdriver`, the `--disable-blink-features=AutomationControlled` flag Chrome
itself warned about) is a real risk of silently failing or getting shadow-limited** here.
Reinforces launch-profile.js's existing anti-detection intent — just note it's specifically
the generate call that's exposed, not page load.

## 7. Download: no UI interaction needed at all

The size-picker UI (download icon → 1K "Original size" / 2K "Upscaled" (free) / 4K
"Upscaled" (behind an "Upgrade" paywall button, not available on the current plan)) is a red
herring for automation purposes. **Every generated image's `<img>` element already points at
the download URL**, same-origin, cookie-authenticated:

```
GET https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name={mediaId}
```

This 302s to a signed, time-limited CDN URL:

```
https://flow-content.google/image/{mediaId}?Expires=...&KeyName=labs-flow-prod-cdn-key&Signature=...
```

**Action item for `download-latest.js`**: skip clicking the download button/size-picker
entirely. Read the media id (from the card DOM, or from the `/edit/{mediaId}` URL once a
generation is opened) and `fetch()`
`/fx/api/trpc/media.getMediaUrlRedirect?name={mediaId}` directly inside the page context
(`page.evaluate` with `fetch(..., {credentials:'include'})`), then follow the redirect to get
bytes. No click, no size-menu race condition, no screenshot needed to confirm the click
landed.

Note: the `name` param is the **media id**, not the project id or the `/edit/{id}` route id
necessarily the same value — in this session they matched (`273373cd-...`), but confirm this
holds for older/imported media before relying on it universally.

## 8. Edit / remix ("change last generation")

Opening a generated image (click its card) navigates to:

```
/project/{projectId}/edit/{mediaId}
```

This is a clean, documentable deep-link — worth exposing directly rather than only reachable
by clicking a card. The edit view has a second composer ("What do you want to change?")
that, on submit, hits the **exact same** `flowMedia:batchGenerateImages` endpoint as a fresh
generation (§5), scoped to the same project. Difference is presumably in the request body
(reference to the source media + edit instruction) — not confirmed since bodies aren't
visible via this tool. The history sidebar chains every edit as a new entry, each with its
own thumbnail + prompt text, and each is independently downloadable via the same
`getMediaUrlRedirect` pattern.

**Action item**: this means `flow_generate_image` and a hypothetical "edit last generation"
tool can very likely share almost all of their MCP-side logic (same button, same endpoint,
same download path) — the only difference is whether a source media id is attached before
submitting. Worth designing `flow_edit_image` (or a `source_media_id` param on
`flow_generate_image`) around that instead of inventing a separate flow.

## Open items / not yet captured

- POST body of `flowMedia:batchGenerateImages` for both fresh-generate and edit — need
  DevTools body capture, not available via claude-in-chrome's `read_network_requests`.
- Whether `media.getMediaUrlRedirect` signed URLs are safe to cache/reuse before `Expires`,
  or must be re-fetched per download.
- Video generation pipeline — this session only covered images.
- Whether the OAuth session cookie can be persisted/reused across MCP Chrome relaunches
  (would fix §1 without needing full profile copy).
