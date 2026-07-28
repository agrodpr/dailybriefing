# Legacy Routine prompt (archived 2026-07-28)

This is the verbatim prompt that drove the Claude Code Routine
(`dailybriefing-7am`) before the pipeline moved into
`.github/workflows/daily-briefing.yml` + `scripts/generate-briefing.mjs`.

**Nothing executes this file.** It is kept as the original specification, so
the intent behind the generator is reviewable and the Routine could be
reconstructed if ever needed. The Action is code, not a prompt — deleting the
Routine does not remove any behaviour, because the behaviour was ported.

See PIPELINE.md → "Ported vs. not ported" for where the implementation
deliberately differs.

---

```text
Build a "Morning Briefing" — a daily tech & security intelligence magazine
pulled from multiple RSS feeds, two cloud status feeds, and the HN API.

═══════════════════════════════════════
STEP 1 — FETCH STORIES FROM ALL SOURCES
═══════════════════════════════════════

Fetch content from these 9 sources using native fetch() only. No npm packages.

RESILIENCE: if any single feed fails, times out, or returns non-200, log it
and continue with the remaining sources. NEVER abort the whole run for one
dead feed — build the briefing from whatever fetched successfully. Treat a
failed status-feed fetch (sources 8–9) as "no incidents".

1. HACKER NEWS (API)
   https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30
   Fields: title, url, points, num_comments, objectID
   HN discussion link: https://news.ycombinator.com/item?id={objectID}

2. BLEEPINGCOMPUTER (RSS)   https://www.bleepingcomputer.com/feed/
3. THE REGISTER (Atom)      https://www.theregister.com/headlines.atom
   (Atom — parse <entry> tags instead of <item>)
4. DARK READING (RSS)       https://www.darkreading.com/rss/all.xml
5. ENGADGET (RSS)           https://www.engadget.com/rss.xml
6. AWS BLOG (RSS)           https://aws.amazon.com/blogs/aws/feed/
7. AZURE BLOG (RSS)         https://azure.microsoft.com/en-us/blog/feed/

8. AWS SERVICE HEALTH (RSS) https://status.aws.amazon.com/rss/all.rss
   Only keep items describing an ACTIVE or last-24h disruption/degradation in
   a US region. Match region tokens: us-east-1, us-east-2, us-west-1,
   us-west-2, "N. Virginia", "Ohio", "N. California", "Oregon", "GovCloud (US".
   Ignore "operating normally" / long-resolved entries.

9. AZURE SERVICE HEALTH (RSS)
   https://azurestatuscdn.azureedge.net/en-us/status/feed/
   Only keep items describing an ACTIVE or last-24h disruption/degradation in
   a US region. Match: "East US", "East US 2", "Central US", "North Central US",
   "South Central US", "West Central US", "West US", "West US 2", "West US 3",
   "US Gov". Ignore healthy/long-resolved entries.

For all RSS/Atom: use DOMParser on raw XML text. Extract per item: title,
link, description/summary, pubDate. No npm packages (no axios, rss-parser,
cheerio, etc.).

═══════════════════════════════════
STEP 2 — CURATE & CATEGORIZE
═══════════════════════════════════

Select 26 stories total, distributed as:
  - Hacker News:      3   (sort by points desc)
  - BleepingComputer: 4
  - The Register:     3
  - Dark Reading:     3
  - Engadget:         2
  - CLOUD BLOCK:      11  (AWS ~6 / Azure ~5), split across three sub-sections:

    A) Service Health (US regions) — every real US-region incident from
       sources 8–9 becomes a card here and is AUTO-FLAGGED "⚡ ON YOUR RADAR".
    B) Deprecations & Migrations — end-of-support, retirements, forced
       migrations, breaking changes from the AWS/Azure blog feeds.
    C) New & Noteworthy — notable launches / new services / capabilities.

    Fill priority within the 11: A first (however many real incidents exist),
    then B, then C to reach 11. Keep AWS ≈ 6 and Azure ≈ 5. If Service Health
    has NO qualifying incidents, render a single muted status line instead of
    a card — "✓ All monitored US regions operating normally" — and reallocate
    those slots to B and C so the cloud block still totals 11.

PRIORITIZE stories about:
  - Cybersecurity: vulnerabilities, CVEs, ransomware, zero-days, breaches
  - Cloud infrastructure: AWS, Azure, IAM, networking, serverless, cost
  - IT operations, automation, sysadmin tooling
  - AI/ML with an infrastructure or security angle
  - Privacy, compliance, enterprise security posture
  - Surprising or high-signal technical findings

FLAG with "⚡ ON YOUR RADAR" if the story involves:
  - Any active AWS/Azure service incident in a US region (auto-flag)
  - AWS IAM, Identity Center, CloudWatch, SCPs, or CLI
  - Hyper-V, virtualization, or VM security
  - Healthcare IT, HIPAA, or medical data breaches
  - Active exploits, zero-days, or CISA KEV additions
  - AWS/Azure deprecations or end-of-support that force action
  - Puerto Rico infrastructure or government tech

SKIP / deprioritize:
  - Consumer gadget reviews with no technical depth
  - Celebrity or entertainment tech crossovers
  - Crypto / NFT / Web3 stories
  - Pure opinion pieces with no news value
  - Duplicate stories covering the same event (pick best source)

═══════════════════════════════════════════
STEP 3 — BUILD ONE SELF-CONTAINED HTML FILE
═══════════════════════════════════════════

ONE single HTML file. All CSS embedded in <style>. No external CSS files.
Fonts via Google Fonts @import only (Fraunces + Inter).
One stylesheet, reused classes — do NOT generate unique CSS per story card.

DESIGN SYSTEM:
  --bg:#0B0B0F  --surface:#13131A  --surface-2:#1C1C26
  --text:#EDEAE2  --text-muted:#8B8A84
  --cyan:#00B4D8 (Hacker News)   --orange:#E8823A (BleepingComputer + flagged)
  --red:#F87171 (The Register)   --purple:#A78BFA (Dark Reading)
  --pink:#F472B6 (Engadget)      --green:#4ADE80 (AWS)   --blue:#60A5FA (Azure)
  Fonts: Fraunces (display), Inter (body)

REQUIRED — the <head> MUST END with this exact block, after the page's own
<style>, regardless of the rest of the markup. Without it the 80px masthead
overflows narrow viewports and iOS scrolls the page sideways:

  <style>
  html,body{overflow-x:hidden;overscroll-behavior-x:none;touch-action:pan-y;}
  h1{font-size:clamp(32px,11vw,80px)!important;word-break:break-word;}
  *{max-width:100vw;}
  </style>
  </head>

LAYOUT — follow exactly:

MASTHEAD
  "MORNING BRIEFING" — Fraunces 80px, centered, var(--text), letter-spacing -2px
  Tagline: "Your daily intelligence feed · {Day}, {Month} {DD}, {YYYY}"
    Inter 15px uppercase, letter-spacing 3px, var(--text-muted)
  Thin <hr> rule, var(--surface-2)

SOURCE LEGEND BAR
  Single centered flex row, gap 24px. Each item: 10px colored dot + source
  name, Inter 12px uppercase. 7 named content sources (HN, BleepingComputer,
  The Register, Dark Reading, Engadget, AWS, Azure).
  Background var(--surface), padding 12px 32px, border-radius 40px.

EDITOR'S NOTE
  3 sentences max. Today's dominant themes across all sources — the big story,
  the cloud angle (call out any US-region incident or major deprecation), what
  to watch. Fraunces italic 24px, max-width 700px, centered, var(--text),
  class="editors-note", margin 48px auto.

STORY CARDS — vertical list, max-width 860px, centered. Use class="card",
same structure for every card, no per-card CSS:
  ┌ 3px left border (source color) ─────────────────────────────┐
  │  [SOURCE CHIP] Inter 10px uppercase pill, source-color bg    │
  │  [⚡ ON YOUR RADAR] orange pill — only if flagged            │
  │  HEADLINE  Fraunces 32px, var(--text)                        │
  │  Meta line  Inter 12px var(--text-muted):                    │
  │    HN:  "{points} pts · {comments} comments"                 │
  │    RSS: "{pubDate as Month DD}"                              │
  │    all: "→ Read more" link to the original article           │
  │  SUMMARY  Inter 17px, line-height 1.7, var(--text)           │
  │    2–3 sentences, direct and specific. Security: cite        │
  │    severity/CVE. Cloud: name the service + impact. No filler │
  │    like "In a blog post today…"                              │
  └──────────────────────────────────────────────────────────────┘
  Card bg var(--surface), padding 28px 32px, border-radius 8px,
  margin-bottom 16px. Hover: filter:brightness(1.3) on the left border.

CLOUD BLOCK — render the 11 cloud cards grouped under three sub-headers
(Inter 12px uppercase, letter-spacing 1.5px, var(--text-muted), margin
40px 0 12px), in this order:
  "Service Health · US Regions"  — incident cards use the source color
     (green/blue) plus a distinct "🔴 SERVICE HEALTH — {REGION}" chip and are
     always flagged. If none, render the single muted line
     "✓ All monitored US regions operating normally" in place of cards.
  "Deprecations & Migrations"
  "New & Noteworthy"

WORTH SKIPPING — 5 stories
  Title "Worth Skipping Today" Inter 11px uppercase, muted. 5 filtered items:
    "· [Source] — Headline — (reason in ≤5 words)"
  Inter 14px, var(--text-muted), simple list. Make each headline a clickable
  link to the original article.

FOOTER
  "Morning Briefing · Generated {HH:MM} AST · Sources: HN · BleepingComputer ·
   The Register · Dark Reading · Engadget · AWS · Azure · AWS/Azure Status"
  Inter 11px, centered, var(--text-muted), padding-top 48px.

═══════════════════════════════════════════════════════
STEP 4 — COMMIT HTML **AND** MANIFEST AS ONE ATOMIC COMMIT
═══════════════════════════════════════════════════════

The reader (index.html) only ever reads briefings/index.json — a briefing
that isn't in the manifest is invisible. The HTML file and the manifest
MUST land in the SAME commit. Do this via the Git Data API (not PUT
/contents), so it is impossible to write one without the other.

Use env vars GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH. Auth header:
  Authorization: Bearer {GITHUB_TOKEN}

 1. GET  /repos/{GITHUB_REPO}/git/ref/heads/{GITHUB_BRANCH}      → latest_commit_sha
 2. GET  /repos/{GITHUB_REPO}/git/commits/{latest_commit_sha}    → base_tree_sha
 3. GET  /repos/{GITHUB_REPO}/contents/briefings/index.json?ref={GITHUB_BRANCH}
         → current manifest (base64 → JSON)
 4. Build the new manifest:
      - Prepend today's entry (schema below).
      - SELF-HEAL (bounded): for each of the last 7 calendar dates, if
        briefings/YYYY-MM-DD.html exists in the repo but has no manifest
        entry, add one too (GET that file, extract fields as below).
      - Sort "briefings" newest-first by date. Set top-level
        "updated" to the current UTC timestamp. Keep "title":"Morning Briefing".
      Entry schema:
        {
          "date":"YYYY-MM-DD",
          "file":"briefings/YYYY-MM-DD.html",
          "weekday":"{Day}",
          "label":"{Month DD, YYYY}",
          "stories": {actual card count, normally 26},
          "flagged": {number of ⚡ ON YOUR RADAR cards},
          "note":"{the editor's note, 2–3 sentences}"
        }
      To extract from an existing file: weekday/label from the
      <div class="tagline"> text, note from the .editors-note element,
      flagged from the count of "on your radar" occurrences (case-insensitive),
      stories from the count of .card elements.
 5. POST /repos/{GITHUB_REPO}/git/blobs  — once for the HTML, once for the
        new index.json (base64).
 6. POST /repos/{GITHUB_REPO}/git/trees  with base_tree = base_tree_sha and
        BOTH files (briefings/YYYY-MM-DD.html and briefings/index.json),
        each mode "100644" pointing at its blob sha.
 7. POST /repos/{GITHUB_REPO}/git/commits  tree = new tree sha,
        parents = [latest_commit_sha], message "Morning Briefing YYYY-MM-DD".
 8. PATCH /repos/{GITHUB_REPO}/git/refs/heads/{GITHUB_BRANCH}  sha = new commit.

Nothing is pushed until step 8, so a failure anywhere leaves no partial state.
Touch ONLY briefings/YYYY-MM-DD.html and briefings/index.json. Push directly
to GITHUB_BRANCH — do NOT create a claude/ branch. Do NOT commit secrets.

═══════════════════════════════════
STEP 5 — SLACK NOTIFICATION
═══════════════════════════════════

Post via the Slack MCP connector to the channel "dailybriefing".

  "☕ *Morning Briefing is ready — {Day}, {Month} {DD}*

  {Editor's Note — 1 sentence}

  ⚡ *{N} stories flagged on your radar*
  {if any US-region incident: 🔴 *{K} active US-region cloud incident(s)*}
  📰 26 stories · HN · BC · REG · DR · ENG · AWS · AZ (+ AWS/Azure status)

  📁 Saved to: briefings/YYYY-MM-DD.html"

If Slack MCP is unavailable, fall back to SLACK_WEBHOOK_URL via fetch() POST.

═══════════════════════════════════
STEP 6 — CONSOLE SUMMARY
═══════════════════════════════════

  ✅ Morning Briefing saved: briefings/YYYY-MM-DD.html
  ✅ Manifest updated: briefings/index.json ({total} entries)
  📰 Stories: HN(3) BC(4) REG(3) DR(3) ENG(2) AWS(~6) AZ(~5) = 26
  🔴 US-region cloud incidents: {K}
  ⚡ Flagged for you: {N}
  💾 File size: {X} KB
  🔔 Slack: posted / fallback webhook / failed

═══════════════════════════════════
CONSTRAINTS — DO NOT:
═══════════════════════════════════
- Write a Python/bash script or any external builder
- Install cron or configure any scheduler
- Use the Anthropic SDK or call any AI API
- Install npm packages of any kind
- Generate unique CSS per story card
- Output more than one HTML file (index.json is the only other file touched)
- Push to a claude/ branch
- Use fake or placeholder content — all stories must be real fetched data
- Commit any secrets, tokens, or env values to the repo
- Omit the mobile-safety <style> block or the index.json update — both are
  required every run
```
