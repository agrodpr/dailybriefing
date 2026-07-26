#!/usr/bin/env node
// Optional Slack notification for the daily briefing workflow.
//
// Accepts EITHER credential, whichever you configured:
//   SLACK_BOT_TOKEN  (xoxb-…, needs chat:write) + SLACK_CHANNEL
//   SLACK_WEBHOOK_URL (https://hooks.slack.com/services/…)
// Bot token wins if both are set.
//
// Never fails the build: a Slack outage must not turn a successful
// generate-and-deploy run red.

const {
  SLACK_BOT_TOKEN,
  SLACK_WEBHOOK_URL,
  SLACK_CHANNEL = "C0BACLM772M", // #dailybriefing
  DATE = "",
  STORIES = "0",
  FLAGGED = "0",
  NOTE = "",
} = process.env;

if (!SLACK_BOT_TOKEN && !SLACK_WEBHOOK_URL) {
  console.log("No Slack credential configured — skipping.");
  process.exit(0);
}

const text = [
  `*Morning Briefing ${DATE}* — ${STORIES} stories, ${FLAGGED} flagged`,
  NOTE,
  "https://agrodpr.github.io/dailybriefing/",
]
  .filter(Boolean)
  .join("\n");

try {
  let res, detail = "";
  if (SLACK_BOT_TOKEN) {
    const api = process.env.SLACK_API_URL || "https://slack.com/api/chat.postMessage";
    res = await fetch(api, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false }),
    });
    // chat.postMessage returns HTTP 200 even on failure — check the body.
    const body = await res.json().catch(() => ({}));
    if (!body.ok) detail = ` (${body.error || "unknown error"})`;
    console.log(body.ok ? "Posted to Slack." : `Slack rejected the message${detail} — ignoring.`);
  } else {
    res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    console.log(res.ok ? "Posted to Slack." : `Slack responded ${res.status} — ignoring.`);
  }
} catch (e) {
  console.warn(`Slack post failed (${e.message}) — ignoring.`);
}
