# Morning Briefing — Daily Pipeline

This repo is updated once a day by a scheduled Claude Code routine. The
routine writes one new file per day and must also update the manifest that
the reader (`index.html`) uses to discover briefings.

**Known failure mode:** for several days (2026-06-16 through 2026-06-22)
the routine wrote `briefings/YYYY-MM-DD.html` correctly but skipped the
manifest update below, so those briefings existed in the repo but never
appeared in the reader. They were backfilled by hand on 2026-06-23. To
prevent recurrence, Step B is now written as an idempotent resync rather
than a one-time append, and should run as its own routine — see
[Recommended: split Step B into its own routine](#recommended-split-step-b-into-its-own-routine)
below.

## Step A — Generate and push the briefing

`PUT /repos/{GITHUB_REPO}/contents/briefings/YYYY-MM-DD.html`
(base64 content, branch = `{GITHUB_BRANCH}`)

## Step B — Resync the manifest (`briefings/index.json`)

**This step is required.** `index.html` never lists the `briefings/`
directory — it only reads `briefings/index.json`. If this step is skipped,
today's briefing exists in the repo but never appears in the reader, even
if the URL hash is set to today's date.

Do not just append today's entry — that's exactly the step that has been
silently skipped before. Instead, **rebuild the manifest from the actual
directory contents** so a missed day self-heals the next time this runs:

1. `GET /repos/{GITHUB_REPO}/contents/briefings?ref={GITHUB_BRANCH}` — list
   every `briefings/YYYY-MM-DD.html` file that exists.
2. `GET /repos/{GITHUB_REPO}/contents/briefings/index.json?ref={GITHUB_BRANCH}`
   — read current content + `sha`.
3. For every `.html` file in the directory listing that has no matching
   `"date"` entry in `index.json`, fetch that file's content and extract:
   - `weekday` / `label` from the `<div class="tagline">` text
   - `note` from the `<div class="editors-note">` /
     `<p class="editors-note">` / `<section class="editors-note">` text
     (markup has varied day to day — check all three)
   - `flagged` = count of `ON YOUR RADAR` chip occurrences
   - `stories` = count of story cards (usually 20)
4. Add one manifest entry per missing date (schema below), then sort the
   `briefings` array newest-first by date.
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
5. Update the top-level `"updated"` field to the current UTC timestamp
   (`YYYY-MM-DDTHH:MM:SSZ`).
6. If anything changed, `PUT /repos/{GITHUB_REPO}/contents/briefings/index.json`
   with the `sha` from step 2, `branch: {GITHUB_BRANCH}`, commit message
   `"Sync briefings index"`. If nothing was missing, skip the write —
   no-op runs should not create empty commits.

### Recommended: split Step B into its own routine

Step A and Step B have been bundled into one daily routine, which is how
a content-generation glitch silently took the manifest update down with
it. Routines are managed at claude.ai/code/routines (not from inside a
session) — create a second, independent routine there:

- **Prompt:** "Run Step B from `PIPELINE.md` in agrodpr/dailybriefing —
  resync `briefings/index.json` against the actual contents of the
  `briefings/` directory. Do not touch any `.html` files."
- **Repository:** `agrodpr/dailybriefing`
- **Schedule:** daily, 15–30 minutes after the existing briefing-generation
  routine, so Step A has had time to land first.

Because Step B is now a full resync rather than an append, this second
routine is safe to run even on days when Step A's content already has a
manifest entry — it's a no-op then.

## Step C — Slack + console summary

Unchanged from the existing routine instructions.

## Schema note

`briefings/sources.json` describes a newer v2 schema (30 stories across 14
sources, heat-ranked ordering, additional radar categories). The current
generator still follows the older 20-story / 7-source / grouped-by-source
layout. Migrating to v2 is a separate, larger change — not done by this doc.
