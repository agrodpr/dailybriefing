#!/usr/bin/env node
// Morning Briefing generator — runs inside the GitHub Action (see
// .github/workflows/daily-briefing.yml). Zero npm dependencies: uses Node's
// built-in fetch. Pipeline contract lives in PIPELINE.md / CLAUDE.md.
//
// Design principle: the deploy must never depend on the LLM. We always fetch
// feeds, render a valid briefing, resync the manifest, and let the workflow
// commit. The Anthropic call is best-effort enrichment (editor's note,
// rewritten summaries, "on your radar" flags). If it errors, is rate-limited,
// or refuses, we fall back to feed-description summaries and still ship.

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
// Best-effort enrichment via the Anthropic API (never fatal)
// ---------------------------------------------------------------------------
export async function enrich(candidates, radarFlags) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log("  (no ANTHROPIC_API_KEY — skipping enrichment, using feed text)");
    return null;
  }
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5";
  const list = candidates.map((c, i) => ({
    i,
    source: c.sourceName,
    title: c.title,
    blurb: truncate(stripTags(c.summary), 400),
  }));
  const prompt =
`You are the editor of a daily cybersecurity + cloud "Morning Briefing". Below is today's candidate story list as JSON (each has an index i, source, title, and a raw blurb from the feed).

Return ONLY a JSON object, no prose, with this exact shape:
{
  "editors_note": "2-3 sentence editor's note summarizing the day's dominant themes",
  "items": [ { "i": <index>, "summary": "1-2 sentence factual summary", "flagged": <true|false> } ],
  "skip": [ { "i": <index>, "reason": "short reason" } ]
}

Rules:
- Write one entry in "items" for every story you keep, and put clearly off-topic / low-signal ones in "skip" instead.
- "summary" must be grounded only in the title/blurb provided; do not invent facts, numbers, or URLs.
- Set "flagged": true when a story hits the reader's radar: ${radarFlags.join("; ")}.
- Keep the editor's note concrete and specific to today's stories.

Candidates:
${JSON.stringify(list)}`;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120000);
    const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        // Refusal fallback: this is a benign security-news digest, but Opus 5's
        // safeguards can occasionally false-positive; route cyber refusals to a
        // fallback model server-side instead of failing.
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        fallbacks: "default",
        messages: [{ role: "user", content: prompt }],
      }),
    }).finally(() => clearTimeout(t));

    if (!res.ok) throw new Error(`API HTTP ${res.status}: ${truncate(await res.text(), 200)}`);
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new Error("model refused");
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json);
    console.log(`  ✓ enriched via ${data.model || model} (${(parsed.items || []).length} items, ${(parsed.skip || []).length} skipped)`);
    return parsed;
  } catch (e) {
    console.warn(`  ! enrichment failed (${e.message}) — falling back to feed text`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderCard(c, flagged) {
  const chips =
    `<span class="chip" style="--source-color:${c.color}">${escapeHtml(c.sourceName)}</span>` +
    (flagged ? `<span class="chip radar">⚡ On Your Radar</span>` : "");
  const meta = `${c.meta ? c.meta + " · " : ""}<a href="${escapeHtml(c.url)}">→ Read more</a>`;
  return `  <div class="card" style="--source-color:${c.color}">
    <div class="chips">${chips}</div>
    <h2 class="card-headline">${escapeHtml(c.title)}</h2>
    <div class="card-meta">${meta}</div>
    <p class="card-summary">${escapeHtml(c.summary)}</p>
  </div>`;
}

async function render({ date, css, sources, candidates, enriched }) {
  const byIndex = new Map();
  const skip = [];
  if (enriched) {
    for (const it of enriched.items || []) {
      if (candidates[it.i]) byIndex.set(it.i, { summary: it.summary, flagged: !!it.flagged });
    }
    for (const s of enriched.skip || []) {
      if (candidates[s.i]) skip.push({ ...candidates[s.i], reason: s.reason || "" });
    }
  }

  const cards = [];
  candidates.forEach((c, i) => {
    if (skip.some((s) => s.url === c.url)) return;
    const e = byIndex.get(i);
    const summary = (e && e.summary) || truncate(stripTags(c.summary), 320) || "—";
    cards.push(renderCard({ ...c, summary }, e ? e.flagged : false));
  });

  const legend = sources
    .filter((s) => (s.target ?? 0) > 0)
    .map((s) => `  <div class="legend-item"><span class="dot" style="background:${s.color}"></span>${escapeHtml(s.name)}</div>`)
    .join("\n");

  const note = (enriched && enriched.editors_note) ||
    `Today's briefing collects ${cards.length} stories across ${sources.filter((s) => (s.target ?? 0) > 0).length} sources.`;

  const skipHtml = skip.length
    ? `\n  <div class="skip-title">Worth Skipping Today</div>
  <ul class="skip-list">
${skip.map((s) => `    <li>· [${escapeHtml(s.sourceName)}] — <a href="${escapeHtml(s.url)}">${escapeHtml(truncate(s.title, 90))}</a>${s.reason ? ` — (${escapeHtml(s.reason)})` : ""}</li>`).join("\n")}
  </ul>\n`
    : "";

  const flaggedCount = cards.filter((c) => c.includes("On Your Radar")).length;

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
${skipHtml}
  <div class="footer">
    Morning Briefing · Generated by GitHub Actions · Sources: ${sources.filter((s) => (s.target ?? 0) > 0).map((s) => escapeHtml(s.name)).join(" · ")}
  </div>

</div>
</body>
</html>
`;
  return { html, storyCount: cards.length, flaggedCount, note };
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
async function resyncManifest() {
  const manifestPath = join(BRIEFINGS, "index.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const existing = new Map((manifest.briefings || []).map((b) => [b.date, b]));

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
  return { total: entries.length, added };
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
  const radarFlags = cfg.radar_flags || [];

  console.log("Fetching feeds...");
  const candidates = await collectCandidates(sources);
  if (candidates.length === 0) {
    console.error("No candidate stories fetched — aborting without writing (would produce an empty briefing).");
    process.exit(1);
  }

  console.log("Enriching...");
  const enriched = await enrich(candidates, radarFlags);

  const { html, storyCount, flaggedCount, note } = await render({ date, css, sources, candidates, enriched });
  const outPath = join(BRIEFINGS, `${date.iso}.html`);
  await writeFile(outPath, html);
  console.log(`Wrote ${outPath} (${storyCount} stories, ${flaggedCount} flagged)`);

  const { total, added } = await resyncManifest();
  console.log(`Resynced manifest: ${total} briefings (${added} newly added).`);

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
