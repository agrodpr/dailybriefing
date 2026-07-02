# Morning Briefing — Daily Pipeline

This repo is updated once a day by a scheduled Claude Code routine. The
routine writes one new file per day and must also update the manifest that
the reader (`index.html`) uses to discover briefings.

**Known failure modes, in order of severity:**

1. **2026-06-28: no repo write access at all.** The routine reported it
   could not push anything — `briefings/2026-06-28.html` was generated but
   lost, since it only ever existed in that session's transcript. Likely
   cause: the Claude GitHub App's repository grant for `agrodpr/dailybriefing`
   got narrowed or dropped, possibly from a `/web-setup` re-auth done from a
   different device/session selecting a different repo set. **This is a
   GitHub-App-connection problem, not something fixable by editing this
   repo.** Check at claude.ai/code/routines → the routine → Repositories,
   and at github.com → Settings → Applications → Installed GitHub Apps →
   Claude → Configure, that `agrodpr/dailybriefing` is still listed in both
   places before each session that's supposed to write here.
2. **2026-06-16 through 2026-06-27 (recurring): manifest update silently
   skipped.** The routine wrote `briefings/YYYY-MM-DD.html` correctly but
   never touched `briefings/index.json`, so those briefings existed in the
   repo but never appeared in the reader. This happened repeatedly even
   after Step B was rewritten as an idempotent resync — rewriting the
   *instructions* didn't help because nothing was forcing them to run.
   The fix below removes the failure mode structurally: Step A and Step B
   are now **one atomic commit**, so it is no longer possible to write the
   HTML file without also updating the manifest.

   **Root cause found 2026-07-02.** The live routine prompt was inspected
   directly and never touched `index.json` at all: its commit step was a
   single-file `PUT /contents/briefings/YYYY-MM-DD.html` followed by the
   literal instruction *"Do NOT create any other files."* The manifest was
   never skipped by accident — the prompt actively forbade writing it. The
   atomic Step A+B commit in this doc had only ever been documentation; it
   was finally ported into the routine prompt on 2026-07-02 (the same
   revision that expanded coverage to 26 stories across 9 sources and added
   the mobile-safety block and correct Slack channel). The manifest now
   advances on every run by construction.

## Sources and distribution (as of 2026-07-02)

Nine sources are fetched with native `fetch()` — HN (Algolia API),
BleepingComputer, The Register (Atom), Dark Reading, Engadget, the AWS and
Azure blogs (RSS), plus two US-region service-health feeds: AWS
(`status.aws.amazon.com/rss/all.rss`) and Azure
(`azurestatuscdn.azureedge.net/en-us/status/feed/`). A dead feed is skipped,
not fatal; a failed status feed means "no incidents." 26 stories total:
HN 3 · BleepingComputer 4 · The Register 3 · Dark Reading 3 · Engadget 2 ·
Cloud 11 (AWS ~6 / Azure ~5). The cloud block is sub-bucketed into **Service
Health · US Regions** (active US-region incidents, auto-flagged; a muted
"all operational" line when quiet), **Deprecations & Migrations**, and **New
& Noteworthy** — filled in that priority order to reach 11.

## Step A+B — Generate the briefing and resync the manifest, as one commit

Do this as a single multi-file commit via the Git Data API, not two
separate `PUT /contents` calls. Two separate calls is exactly how this has
failed before — if the session is interrupted, hits a rate limit, or simply
stops after step one, the HTML file lands without the manifest update.
One commit makes that impossible.

1. `GET /repos/{GITHUB_REPO}/git/ref/heads/{GITHUB_BRANCH}` → `latest_commit_sha`.
2. `GET /repos/{GITHUB_REPO}/git/commits/{latest_commit_sha}` → `base_tree_sha`.
3. `GET /repos/{GITHUB_REPO}/contents/briefings?ref={GITHUB_BRANCH}` — list
   every `briefings/YYYY-MM-DD.html` file that currently exists.
4. `GET /repos/{GITHUB_REPO}/contents/briefings/index.json?ref={GITHUB_BRANCH}`
   — read the current manifest.
5. Build the new manifest by **resyncing from the directory listing**, not
   just appending today's entry — that way a previously-missed day also
   self-heals in the same commit:
   - For today's new file plus any `.html` file in the listing from step 3
     with no matching `"date"` entry in the manifest, extract:
     - `weekday` / `label` from the `<div class="tagline">` text
     - `note` from the `editors-note` element (markup varies day to day —
       check `<p>`, `<div>`, and `<section>` with that class)
     - `flagged` = count of `on your radar` chip occurrences (case-insensitive)
     - `stories` = count of story cards (usually 26)
   - Add one manifest entry per missing date (schema below), sort the
     `briefings` array newest-first by date, and update the top-level
     `"updated"` field to the current UTC timestamp.
   ```json
   {
     "date": "YYYY-MM-DD",
     "file": "briefings/YYYY-MM-DD.html",
     "weekday": "{Day}",
     "label": "{Month DD, YYYY}",
     "stories": 26,
     "flagged": {N},
     "note": "{Editor's note, 2-3 sentences summarizing the day's themes}"
   }
   ```
6. `POST /repos/{GITHUB_REPO}/git/blobs` once for the new HTML content and
   once for the new `index.json` content (base64).
7. `POST /repos/{GITHUB_REPO}/git/trees` with `base_tree = base_tree_sha`
   and both files: `briefings/YYYY-MM-DD.html` and `briefings/index.json`,
   each pointing at its blob `sha`, `mode: "100644"`.
8. `POST /repos/{GITHUB_REPO}/git/commits` with the new tree `sha`, parent
   = `latest_commit_sha`, message `"Morning Briefing YYYY-MM-DD"`.
9. `PATCH /repos/{GITHUB_REPO}/git/refs/heads/{GITHUB_BRANCH}` with the new
   commit `sha` to move the branch forward.

If any step fails, nothing has been pushed yet — steps 6-9 only take effect
at step 9. There's no partial state to clean up.

### Required: mobile-safety CSS in every generated briefing

Every `<head>` must end with this exact block (after the page's own
`<style>`), regardless of the rest of that day's markup or class names.
Without it, the masthead `<h1>` (commonly styled at a fixed 80px with no
responsive sizing) overflows narrow viewports and the whole page becomes
horizontally scrollable — on iOS this causes the page to visibly slide
side to side while scrolling vertically. This was found and patched on all
existing briefings on 2026-06-30; it must not be reintroduced.

```html
<style>
html,body{overflow-x:hidden;overscroll-behavior-x:none;touch-action:pan-y;}
h1{font-size:clamp(32px,11vw,80px)!important;word-break:break-word;}
*{max-width:100vw;}
</style>
</head>
```

## Step C — Slack + console summary

Slack posts go to the **`dailybriefing`** channel (channel ID
`C0BACLM772M`). An earlier prompt targeted a `morning-briefing` channel that
does not exist in the workspace, so every run fell back with a warning — the
corrected channel name is part of the 2026-07-02 prompt revision. Console
summary prints the per-source counts, the number of US-region cloud
incidents, and the flagged count.

## Backup Routine — manifest resync (runs at 7:20 AM daily)

Because Step B has repeatedly been silently skipped even after documentation
changes, a second Claude Code Routine at 7:20 AM acts as a safety net: it
checks whether `briefings/index.json` is in sync with the actual files in
the repo and commits a correction if needed. Create this at
claude.ai/code/routines as a separate daily schedule. Use this exact prompt:

---

Read `briefings/index.json` and list the files under `briefings/` in the
`agrodpr/dailybriefing` repo (default branch). For each `briefings/YYYY-MM-DD.html`
that exists in the repo but has no matching entry in the manifest, add one entry
following this schema:
```
{"date":"YYYY-MM-DD","file":"briefings/YYYY-MM-DD.html","weekday":"…","label":"Month DD, YYYY","stories":N,"flagged":N,"note":"…"}
```
Extract `weekday` and `label` from the `<div class="tagline">` text, `note` from
the `editors-note` element (check `<p>`, `<div>`, and `<section>` with that class),
`flagged` from the count of "on your radar" chip occurrences (case-insensitive),
and `stories` from the count of `.card` elements.

After building the corrected manifest, commit **only `briefings/index.json`** via
the Git Data API as a single atomic commit (GET ref → GET commit → POST blob →
POST tree with base_tree → POST commit → PATCH ref). Do not touch any HTML files.
If the manifest is already fully in sync, do nothing and exit cleanly.

---

This routine is intentionally read-only except for `index.json`. It is safe to
run even if the primary briefing routine has already run that morning.

## Schema note

`briefings/sources.json` describes a newer v2 schema (30 stories across 14
sources, heat-ranked ordering, additional radar categories). The current
generator follows a 26-story / 9-source layout with a sub-bucketed cloud
block (see "Sources and distribution" above). Fully migrating to the v2
sources.json schema is a separate, larger change — not done by this doc.
