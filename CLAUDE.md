# dailybriefing — standing context

Static GitHub Pages site (no backend, no server-side code). A daily
Claude Code **Routine** (separate from this repo, editable only at
claude.ai/code/routines) generates `briefings/YYYY-MM-DD.html` and is
supposed to update `briefings/index.json` in the same commit. See
`PIPELINE.md` for the exact process and known failure history.

## Hard constraints

- **`index.html` only ever reads `briefings/index.json`.** It never lists
  the `briefings/` directory. A `.html` file that exists in the repo but
  isn't in the manifest is invisible to readers. Any fix that touches one
  must touch the other in the same commit — never split them.
- **Every briefing's `<head>` must end with the mobile-safety CSS block**
  defined in `PIPELINE.md` (`overflow-x:hidden`, clamped `h1`, etc.). Past
  files had a fixed 80px `h1` with no responsive sizing, which made iOS
  rubber-band the whole page sideways on scroll. Don't reintroduce that.
- **`main` is touched directly by the live automation**, often mid-session.
  Always `git fetch origin main` and rebase/ff before merging — don't
  assume the base hasn't moved.
- **Never push to `main` without asking first**, even if a similar change
  was approved earlier in the conversation. Approval is scoped to the
  specific change discussed, not blanket. Work on a `claude/`-prefixed
  feature branch, push there, then ask before merging.
- **Routines, by default, can only push `claude/`-prefixed branches** to
  this repo unless "Allow unrestricted branch pushes" is enabled. This
  repo has no `.github/workflows` or trigger config — the schedule and
  prompt live entirely in the Routine, not in this repo.

## If briefings stop appearing on the site

1. Check `briefings/index.json` — is the latest date actually listed?
   (Most common cause: manifest update silently skipped.)
2. Check whether the `.html` file exists in the repo at all — if Slack
   says it was generated but it's missing from `main`, suspect a
   repo-access/permissions problem (see PIPELINE.md's 2026-06-28 case),
   not a code bug. That's fixed at claude.ai/code/routines → Repositories
   and github.com → Settings → Applications → Installed GitHub Apps →
   Claude → Configure — not by editing this repo.

## Read/unread tracking

Implemented client-side via `localStorage` in `index.html` (`READ_KEY =
"mb_read_dates"`). Per-browser/device only, no sync. This is intentional
— there's no backend or per-user accounts to do better, and a pageview
analytics tool (GA etc.) wouldn't capture "did *this* visitor read *this*
date" anyway.
