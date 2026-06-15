# Morning Briefing — Daily Pipeline

This repo is updated once a day by a scheduled Claude Code routine. The
routine writes one new file per day and must also update the manifest that
the reader (`index.html`) uses to discover briefings.

## Step A — Generate and push the briefing

`PUT /repos/{GITHUB_REPO}/contents/briefings/YYYY-MM-DD.html`
(base64 content, branch = `{GITHUB_BRANCH}`)

## Step B — Update the manifest (`briefings/index.json`)

**This step is required.** `index.html` never lists the `briefings/`
directory — it only reads `briefings/index.json`. If this step is skipped,
today's briefing exists in the repo but never appears in the reader, even
if the URL hash is set to today's date.

1. `GET /repos/{GITHUB_REPO}/contents/briefings/index.json?ref={GITHUB_BRANCH}`
   — read current content + `sha`.
2. Decode the JSON and prepend a new entry to the `briefings` array:
   ```json
   {
     "date": "YYYY-MM-DD",
     "file": "briefings/YYYY-MM-DD.html",
     "weekday": "{Day}",
     "label": "{Month DD, YYYY}",
     "stories": 20,
     "flagged": {N},
     "note": "{Editor's note, 2-3 sentences summarizing the day's themes}"
   }
   ```
3. Update the top-level `"updated"` field to the current UTC timestamp
   (`YYYY-MM-DDTHH:MM:SSZ`).
4. `PUT /repos/{GITHUB_REPO}/contents/briefings/index.json` with the `sha`
   from step 1, `branch: {GITHUB_BRANCH}`, commit message
   `"Add YYYY-MM-DD briefing to index"`.

## Step C — Slack + console summary

Unchanged from the existing routine instructions.

## Schema note

`briefings/sources.json` describes a newer v2 schema (30 stories across 14
sources, heat-ranked ordering, additional radar categories). The current
generator still follows the older 20-story / 7-source / grouped-by-source
layout. Migrating to v2 is a separate, larger change — not done by this doc.
