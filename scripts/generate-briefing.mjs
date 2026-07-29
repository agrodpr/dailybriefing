#!/usr/bin/env node
// Morning Briefing generator — runs inside the GitHub Action (see
// .github/workflows/daily-briefing.yml). Zero npm dependencies: uses Node's
// built-in fetch. Pipeline contract lives in PIPELINE.md / CLAUDE.md.
//
// Design principle: this pipeline is fully deterministic. It fetches feeds,
// renders the briefing from the feed text, flags "on your radar" items by
// keyword match, resyncs the manifest, and lets the workflow commit. There is
// no LLM call and no API key, so there is nothing that can rate-limit, refuse,
// or bill. Summaries are the publishers' own words rather than rewritten prose.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const BRIEFINGS = join(REPO, "briefings");

// ---------------------------------------------------------------------------
// Date handling (UTC — the Action runs on a UTC cron)
// ---------------------------------------------------------------------------
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function resolveDate() {
  const override = process.env.BRIEFING_DATE || process.argv[2];
  const d = override ? new Date(`${override}T12:00:00Z`) : new Date();
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const dd = new Date(`${iso}T12:00:00Z`);
  return {
    iso,
    weekday: WEEKDAYS[dd.getUTCDay()],
    label: `${MONTHS[dd.getUTCMonth()]} ${dd.getUTCDate()}, ${dd.getUTCFullYear()}`,
  };
}

// ---------------------------------------------------------------------------
// Tiny HTML/XML helpers (no dependencies)
// ---------------------------------------------------------------------------
function decodeEntities(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'").replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}
function stripTags(s = "") {
  // Unwrap CDATA *before* stripping tags: `<![CDATA[<p>` otherwise matches the
  // tag regex as a single tag and orphans the trailing `]]>` in the output.
  const unwrapped = String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "");
  return decodeEntities(unwrapped.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function truncate(s, n) {
  s = (s || "").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

// ---------------------------------------------------------------------------
// Feed fetching + parsing
// ---------------------------------------------------------------------------
async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "dailybriefing-bot/1.0 (+github-actions)", Accept: "*/*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function parseXmlFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const title = stripTags(tag(b, "title"));
    let url = stripTags(tag(b, "link"));
    if (!url) {
      const href = b.match(/<link[^>]*href="([^"]+)"/i);
      if (href) url = decodeEntities(href[1]);
    }
    const summary = stripTags(tag(b, "description") || tag(b, "summary") || tag(b, "content"));
    const published = stripTags(tag(b, "pubDate") || tag(b, "updated") || tag(b, "published"));
    if (title && url) items.push({ title, url, summary, published });
  }
  return items;
}

function parseHn(text) {
  const data = JSON.parse(text);
  return (data.hits || [])
    .filter((h) => h.title)
    .map((h) => ({
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      summary: "",
      points: h.points || 0,
      comments: h.num_comments || 0,
      hnId: h.objectID,
    }));
}

function parseKev(text) {
  const data = JSON.parse(text);
  return (data.vulnerabilities || [])
    .slice()
    .sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)))
    .map((v) => ({
      title: `${v.cveID}: ${v.vulnerabilityName}`,
      url: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
      summary: `${v.shortDescription || ""} (Vendor: ${v.vendorProject}; added to CISA KEV ${v.dateAdded}).`.trim(),
      published: v.dateAdded,
    }));
}

// AWS/Azure service-health feeds. Keeps only items that name a US region AND
// still read as active. A failed fetch means "no incidents", never a failure —
// same rule the original routine used.
function parseStatusFeed(xml, regions = []) {
  const RESOLVED = /(operating normally|resolved|service is operating|no longer|has been mitigated|post-?mortem)/i;
  const DAY_MS = 24 * 60 * 60 * 1000;
  return parseXmlFeed(xml).filter((it) => {
    const hay = `${it.title} ${it.summary}`;
    if (!regions.some((r) => hay.toLowerCase().includes(r.toLowerCase()))) return false;
    if (RESOLVED.test(hay)) return false;
    const ts = Date.parse(it.published || "");
    if (!Number.isNaN(ts) && Date.now() - ts > DAY_MS) return false; // last 24h only
    return true;
  });
}

async function collectCandidates(sources) {
  const candidates = [];
  await Promise.all(
    sources
      .filter((s) => (s.target ?? 0) > 0)
      .map(async (s) => {
        const urls = [s.url, ...(s.extra_urls || [])];
        let items = [];
        for (const u of urls) {
          try {
            const text = await fetchText(u);
            if (s.type === "hn-api") items = items.concat(parseHn(text));
            else if (s.type === "json-kev") items = items.concat(parseKev(text));
            else if (s.type === "status-rss") items = items.concat(parseStatusFeed(text, s.regions));
            else items = items.concat(parseXmlFeed(text));
          } catch (e) {
            console.warn(`  ! ${s.name} (${u}): ${e.message}`);
          }
        }
        if (s.type === "hn-api") items.sort((a, b) => (b.points || 0) - (a.points || 0));
        const picked = items.slice(0, s.target);
        console.log(`  ✓ ${s.name}: ${picked.length}/${items.length}`);
        for (const it of picked) {
          candidates.push({
            sourceKey: s.key,
            sourceName: s.name,
            color: s.color,
            isStatus: s.type === "status-rss",
            title: it.title,
            url: it.url,
            summary: it.summary || "",
            meta: it.points != null
              ? `${it.points} pts · ${it.comments} comments · <a href="https://news.ycombinator.com/item?id=${it.hnId}">HN discussion</a>`
              : (it.published ? stripTags(it.published) : ""),
          });
        }
      })
  );
  return candidates;
}

// ---------------------------------------------------------------------------
// "On your radar" flagging — deterministic keyword match
//
// Replaces what an LLM used to judge. Keywords are configured per category in
// briefings/sources.json (`radar_keywords`) so they can be tuned without
// touching this script. Matching is case-insensitive over title + summary,
// with word boundaries so "kev" doesn't fire on "Kevin".
// ---------------------------------------------------------------------------
function buildRadarMatcher(radarKeywords) {
  const entries = Object.entries(radarKeywords || {}).flatMap(([category, words]) =>
    (words || []).map((w) => {
      // A trailing `*` makes it a prefix match: "deprecat*" catches
      // deprecated / deprecating / deprecation. Otherwise the word must end
      // there (plus an optional plural, so "banks" and "exploits" match).
      const prefix = w.endsWith("*");
      const bare = prefix ? w.slice(0, -1) : w;
      const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tail = prefix ? "" : "s?([^a-z0-9]|$)";
      return { category, word: w, re: new RegExp(`(^|[^a-z0-9])${esc}${tail}`, "i") };
    })
  );
  return (candidate) => {
    const hay = `${candidate.title} ${stripTags(candidate.summary)}`;
    for (const e of entries) if (e.re.test(hay)) return e.category;
    return null;
  };
}
// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderCard(c, flagged) {
  const chips =
    `<span class="chip" style="--source-color:${c.color}">${escapeHtml(c.sourceName)}</span>` +
    (c.isStatus ? `<span class="chip health">🔴 Service Health</span>` : "") +
    (flagged ? `<span class="chip radar">⚡ On Your Radar</span>` : "");
  const meta = `${c.meta ? c.meta + " · " : ""}<a href="${escapeHtml(c.url)}">→ Read more</a>`;
  return `  <div class="card" style="--source-color:${c.color}">
    <div class="chips">${chips}</div>
    <h2 class="card-headline">${escapeHtml(c.title)}</h2>
    <div class="card-meta">${meta}</div>
    <p class="card-summary">${escapeHtml(c.summary)}</p>
  </div>`;
}

async function render({ date, css, sources, candidates, isRadar }) {
  const cards = [];
  const flaggedCategories = new Set();
  // Service-health incidents render in their own section and are always
  // flagged, regardless of keyword match.
  const statusItems = candidates.filter((c) => c.isStatus);
  const newsItems = candidates.filter((c) => !c.isStatus);

  for (const c of newsItems) {
    const category = isRadar(c);
    if (category) flaggedCategories.add(category);
    const summary = truncate(stripTags(c.summary), 320) || "—";
    cards.push(renderCard({ ...c, summary }, Boolean(category)));
  }

  const statusCards = statusItems.map((c) =>
    renderCard({ ...c, summary: truncate(stripTags(c.summary), 320) || "—" }, true)
  );
  if (statusItems.length) flaggedCategories.add("Active US-region cloud incidents");

  const statusBlock =
    `  <div class="cloud-subhead">Service Health · US Regions</div>\n` +
    (statusCards.length
      ? statusCards.join("\n\n")
      : `  <div class="status-ok">✓ All monitored US regions operating normally</div>`);

  const legend = sources
    .filter((s) => (s.target ?? 0) > 0)
    .map((s) => `  <div class="legend-item"><span class="dot" style="background:${s.color}"></span>${escapeHtml(s.name)}</div>`)
    .join("\n");

  const allCards = [...cards, ...statusCards];
  const flaggedCount = allCards.filter((c) => c.includes("On Your Radar")).length;
  const activeSources = sources.filter((s) => (s.target ?? 0) > 0).length;

  // Deterministic stand-in for the old LLM editor's note: says what was
  // collected and, more usefully, which radar categories actually fired today.
  const cats = [...flaggedCategories].map((c) => c.replace(/,.*$/, "").trim());
  const incidentLine = statusItems.length
    ? `${statusItems.length} active US-region cloud incident${statusItems.length > 1 ? "s" : ""}.`
    : "No active US-region cloud incidents.";
  const note = flaggedCount
    ? `${allCards.length} stories across ${activeSources} sources. ${incidentLine} ${flaggedCount} flagged on your radar, touching ${cats.join("; ")}.`
    : `${allCards.length} stories across ${activeSources} sources. ${incidentLine} Nothing matched your radar categories today.`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Morning Briefing &middot; ${date.label}</title>
<style>
${css}
</style>
<style>
html,body{overflow-x:hidden;overscroll-behavior-x:none;touch-action:pan-y;}
h1{font-size:clamp(32px,11vw,80px)!important;word-break:break-word;}
*{max-width:100vw;}
</style>
</head>
<body>

<div class="masthead">
  <h1 class="title">MORNING BRIEFING</h1>
  <div class="tagline">Your daily intelligence feed · ${date.weekday}, ${date.label}</div>
</div>
<hr class="rule">

<div class="legend">
${legend}
</div>

<p class="editors-note">${escapeHtml(note)}</p>

<div class="container">

${cards.join("\n\n")}

${statusBlock}

  <div class="footer">
    Morning Briefing · Generated by GitHub Actions · Sources: ${sources.filter((s) => (s.target ?? 0) > 0).map((s) => escapeHtml(s.name)).join(" · ")}
  </div>

</div>
</body>
</html>
`;
  return { html, storyCount: allCards.length, flaggedCount, incidents: statusItems.length, note };
}

// ---------------------------------------------------------------------------
// Manifest resync (deterministic; self-heals any missing .html on disk).
// Mirrors PIPELINE.md Step B / the backup routine, but runs in-process so the
// HTML and manifest are always written in the same commit.
// ---------------------------------------------------------------------------
function taglineOf(html) {
  const m = html.match(/<div class="tagline">([\s\S]*?)<\/div>/i);
  if (!m) return { weekday: "", label: "" };
  const txt = stripTags(m[1]);
  const after = txt.includes("·") ? txt.split("·").pop().trim() : txt;
  const comma = after.indexOf(",");
  return comma > -1
    ? { weekday: after.slice(0, comma).trim(), label: after.slice(comma + 1).trim() }
    : { weekday: "", label: after };
}

// IMPORTANT: this is additive. Existing manifest entries are preserved
// byte-for-byte — older briefings use different markup (no `class="card"`,
// no `class="tagline"`), so re-deriving them would zero out `stories` and
// blank `weekday`/`label`. We only append entries for .html files that have
// no manifest entry at all, which is the self-healing behaviour PIPELINE.md
// specifies without rewriting history.
async function resyncManifest(current) {
  const manifestPath = join(BRIEFINGS, "index.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const existing = new Map((manifest.briefings || []).map((b) => [b.date, b]));

  // The entry for the date we just generated is always refreshed from this
  // run's real values. Without this, regenerating an existing date (a backfill,
  // or re-running today) would leave a stale note and story count pointing at
  // freshly rewritten HTML.
  let refreshed = false;
  if (current) {
    refreshed = existing.has(current.date);
    existing.set(current.date, {
      date: current.date,
      file: `briefings/${current.date}.html`,
      weekday: current.weekday,
      label: current.label,
      stories: current.stories,
      flagged: current.flagged,
      note: current.note,
    });
  }

  const files = (await readdir(BRIEFINGS)).filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f));
  let added = 0;
  for (const f of files) {
    const date = f.replace(/\.html$/, "");
    if (existing.has(date)) continue;
    const html = await readFile(join(BRIEFINGS, f), "utf8");
    const { weekday, label } = taglineOf(html);
    const noteM = html.match(/<p class="editors-note">([\s\S]*?)<\/p>/i) ||
      html.match(/class="editors-note"[^>]*>([\s\S]*?)<\//i);
    existing.set(date, {
      date,
      file: `briefings/${f}`,
      weekday,
      label: label || date,
      stories: (html.match(/class="card"/g) || []).length,
      flagged: (html.match(/on your radar/gi) || []).length,
      note: noteM ? stripTags(noteM[1]) : "",
    });
    added++;
  }

  const entries = [...existing.values()].sort((a, b) => b.date.localeCompare(a.date));
  manifest.briefings = entries;
  manifest.updated = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { total: entries.length, added, refreshed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const date = resolveDate();
  console.log(`Generating briefing for ${date.iso} (${date.weekday}, ${date.label})`);

  const css = await readFile(join(__dirname, "assets", "briefing.css"), "utf8");
  // SOURCES_FILE lets the test harness point at local fixtures.
  const sourcesFile = process.env.SOURCES_FILE || join(BRIEFINGS, "sources.json");
  const cfg = JSON.parse(await readFile(sourcesFile, "utf8"));
  const sources = cfg.sources || [];

  console.log("Fetching feeds...");
  const candidates = await collectCandidates(sources);
  if (candidates.length === 0) {
    console.error("No candidate stories fetched — aborting without writing (would produce an empty briefing).");
    process.exit(1);
  }

  const isRadar = buildRadarMatcher(cfg.radar_keywords);
  const { html, storyCount, flaggedCount, incidents, note } = await render({ date, css, sources, candidates, isRadar });
  const outPath = join(BRIEFINGS, `${date.iso}.html`);
  await writeFile(outPath, html);
  console.log(`Wrote ${outPath} (${storyCount} stories, ${flaggedCount} flagged, ${incidents} US-region incidents)`);

  const { total, added, refreshed } = await resyncManifest({
    date: date.iso,
    weekday: date.weekday,
    label: date.label,
    stories: storyCount,
    flagged: flaggedCount,
    note,
  });
  console.log(
    `Resynced manifest: ${total} briefings ` +
    `(${refreshed ? "refreshed" : "added"} ${date.iso}${added ? `, ${added} backfilled` : ""}).`
  );

  // Hand a summary to the workflow (Slack step + logs).
  const gho = process.env.GITHUB_OUTPUT;
  if (gho) {
    const nl = (s) => String(s).replace(/\n/g, " ");
    await writeFile(gho, [
      `date=${date.iso}`,
      `stories=${storyCount}`,
      `flagged=${flaggedCount}`,
      `note<<EOF_NOTE`,
      nl(note),
      `EOF_NOTE`,
    ].join("\n") + "\n", { flag: "a" });
  }
}

// Only run when executed directly, so tests can import the helpers above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
