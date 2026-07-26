#!/usr/bin/env node
// Optional Slack notification for the daily briefing workflow.
// Never fails the build: a Slack outage must not mark a successful
// generate-and-deploy run as red.

const url = process.env.SLACK_WEBHOOK_URL;
if (!url) {
  console.log("No SLACK_WEBHOOK_URL — skipping.");
  process.exit(0);
}

const { DATE = "", STORIES = "0", FLAGGED = "0", NOTE = "" } = process.env;
const text = [
  `*Morning Briefing ${DATE}* — ${STORIES} stories, ${FLAGGED} flagged`,
  NOTE,
  "https://agrodpr.github.io/dailybriefing/",
]
  .filter(Boolean)
  .join("\n");

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  console.log(res.ok ? "Posted to Slack." : `Slack responded ${res.status} — ignoring.`);
} catch (e) {
  console.warn(`Slack post failed (${e.message}) — ignoring.`);
}
