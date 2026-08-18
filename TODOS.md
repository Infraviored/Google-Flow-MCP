## See also: docs/FLOW_API_NOTES.md

Full manual walkthrough (login → select project → generate → download → edit/remix) done
2026-08-13 via real Chrome (not the MCP's browser), with network capture at every step.
Covers the OAuth login bug (§1, explains `account: null` after `flow_connect`), the real
generation endpoint, the no-UI download shortcut via `media.getMediaUrlRedirect`, and the
edit/remix flow sharing the same endpoint as fresh generation. Read that file before touching
`launch-profile.js`, `connect.js`, `generate-image.js`, or `download-latest.js`.

# MCP weaknesses — found during live use

Logged each time a real interaction hit a gap in the tool surface. Not code review, just field
notes. Entries are removed once fixed and confirmed — check git log for history, not this file.

## Account verification is fake, confirmed live

`flow_connect` returned `accountVerified: {verified: true, method: "assumed"}`. Calling
`flow_status` immediately after showed `account: null`. The MCP's copied Chrome profile was
never actually logged in — it was sitting on the marketing landing page the whole time. See
docs/FLOW_API_NOTES.md §1 for why (OAuth session cookie doesn't survive the profile copy).
`account-check.js` needs to actually check for a signed-in indicator, not assume.

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
