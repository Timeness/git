
require("dotenv").config();

const express = require("express");
const crypto = require("node:crypto");
const { Octokit } = require("@octokit/rest");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_PATCH_BYTES = Number(process.env.MAX_PATCH_BYTES || 1_000_000);

const required = [
  "GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ALLOWED_REPOS",
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const allowedRepos = new Set(
  process.env.ALLOWED_REPOS.split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
);

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const seenDeliveries = new Map();
const MAX_SEEN_DELIVERIES = 10_000;

function verifySignature(rawBody, signature) {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expected = Buffer.from(
    "sha256=" +
      crypto
        .createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex"),
    "utf8"
  );

  const received = Buffer.from(signature, "utf8");

  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

async function telegram(method, body, file) {
  const url =
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

  let response;

  if (file) {
    const form = new FormData();

    for (const [key, value] of Object.entries(body)) {
      form.append(key, String(value));
    }

    form.append(
      "document",
      new Blob([file.buffer], { type: "text/x-patch" }),
      file.name
    );

    response = await fetch(url, {
      method: "POST",
      body: form,
    });
  } else {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API error: ${result.description || response.status}`);
  }

  return result;
}

async function processCommit(owner, repo, sha, branch, deliveryId) {
  const { data: commit } = await octokit.rest.repos.getCommit({
    owner,
    repo,
    ref: sha,
  });

  const files = commit.files || [];

  const additions = files.reduce((sum, f) => sum + (f.additions || 0), 0);
  const deletions = files.reduce((sum, f) => sum + (f.deletions || 0), 0);

  const shortSha = sha.slice(0, 7);
  const commitUrl = `https://github.com/${owner}/${repo}/commit/${sha}`;

  const fileList = files.length
    ? files.slice(0, 40).map((file) => {
        const status = file.status || "changed";
        return `${status}: ${file.filename}`;
      }).join("\n")
    : "File details unavailable.";

  const summary = [
    "🚀 <b>GitHub Push</b>",
    "",
    `<b>Repository:</b> ${escapeHtml(owner)}/${escapeHtml(repo)}`,
    `<b>Branch:</b> ${escapeHtml(branch)}`,
    `<b>Commit:</b> <code>${escapeHtml(shortSha)}</code>`,
    `<b>Author:</b> ${escapeHtml(commit.commit.author?.name || "Unknown")}`,
    "",
    `<b>Message:</b> ${escapeHtml(commit.commit.message || "(no message)")}`,
    "",
    `<b>Files:</b> ${files.length}`,
    `<b>Changes:</b> +${additions} / -${deletions}`,
    "",
    "<b>Changed files</b>",
    escapeHtml(fileList),
    "",
    `<a href="${commitUrl}">View commit on GitHub</a>`,
    `<i>Delivery: ${escapeHtml(deliveryId)}</i>`,
  ].join("\n");

  await telegram("sendMessage", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: summary.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  // Collect the actual textual patches supplied by GitHub.
  const patchParts = [];
  let omittedFiles = 0;

  for (const file of files) {
    if (typeof file.patch !== "string") {
      omittedFiles++;
      continue;
    }

    const section =
      `\n\n--- ${file.filename} (${file.status || "modified"}) ---\n` +
      file.patch;

    const currentSize = Buffer.byteLength(patchParts.join(""), "utf8");
    const sectionSize = Buffer.byteLength(section, "utf8");

    if (currentSize + sectionSize > MAX_PATCH_BYTES) {
      omittedFiles++;
      continue;
    }

    patchParts.push(section);
  }

  if (patchParts.length) {
    const header = [
      `# ${owner}/${repo}`,
      `# Commit: ${sha}`,
      `# Branch: ${branch}`,
      `# Commit URL: ${commitUrl}`,
      "",
    ].join("\n");

    const patch = header + patchParts.join("");

    await telegram(
      "sendDocument",
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        caption:
          `Diff for ${owner}/${repo}@${shortSha}` +
          (omittedFiles ? `; ${omittedFiles} file(s) omitted` : ""),
      },
      {
        name: `${repo}-${shortSha}.patch`,
        buffer: Buffer.from(patch, "utf8"),
      }
    );
  } else {
    await telegram("sendMessage", {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text:
        `No textual patch was available for ${owner}/${repo}@${shortSha}. ` +
        `This can happen with binary files or files without a patch. ` +
        `Omitted files: ${omittedFiles}.`,
    });
  }

  console.log(`Processed ${owner}/${repo}@${shortSha}`);
}

app.get("/", (_req, res) => {
  res.status(200).send("GitHub Telegram notifier is running.");
});

app.post(
  "/github/webhook",
  express.raw({ type: "application/json", limit: "10mb" }),
  (req, res) => {
    const rawBody = req.body;
    const signature = req.get("X-Hub-Signature-256");

    if (!Buffer.isBuffer(rawBody) ||
        !verifySignature(rawBody, signature)) {
      return res.status(401).send("Invalid webhook signature");
    }

    const event = req.get("X-GitHub-Event");
    const deliveryId = req.get("X-GitHub-Delivery");

    if (!deliveryId) {
      return res.status(400).send("Missing delivery ID");
    }

    if (seenDeliveries.has(deliveryId)) {
      return res.status(200).send("Duplicate delivery ignored");
    }

    let payload;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    if (event !== "push") {
      return res.status(200).send("Event ignored");
    }

    const fullName = payload.repository?.full_name?.toLowerCase();

    if (!fullName || !allowedRepos.has(fullName)) {
      return res.status(200).send("Repository not allowlisted");
    }

    const [owner, repo] = fullName.split("/");

    if (!owner || !repo) {
      return res.status(400).send("Invalid repository name");
    }

    const branch = (payload.ref || "").replace(/^refs\/heads\//, "");

    // A branch deletion has no new commit to fetch.
    if (payload.deleted || !payload.after ||
        /^0+$/.test(payload.after)) {
      seenDeliveries.set(deliveryId, Date.now());
      return res.status(200).send("No commit to process");
    }

    seenDeliveries.set(deliveryId, Date.now());

    if (seenDeliveries.size > MAX_SEEN_DELIVERIES) {
      const oldestKey = seenDeliveries.keys().next().value;
      seenDeliveries.delete(oldestKey);
    }

    // Acknowledge quickly; GitHub does not need to wait for Telegram.
    res.status(202).send("Push accepted");

    const commits = Array.isArray(payload.commits)
      ? payload.commits
      : [];

    // For very large pushes, fall back to the tip commit.
    const shas = [...new Set(
      (commits.length ? commits.map((c) => c.id) : [payload.after])
        .filter((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha))
    )];

    (async () => {
      for (const sha of shas) {
        try {
          await processCommit(owner, repo, sha, branch, deliveryId);
        } catch (error) {
          console.error("Commit processing failed:", error.message);
          try {
            await telegram("sendMessage", {
              chat_id: process.env.TELEGRAM_CHAT_ID,
              text:
                `⚠️ Notification failed for ${owner}/${repo}@${sha.slice(0, 7)}. ` +
                `Check server logs.`,
            });
          } catch (notifyError) {
            console.error("Telegram error notification failed:", notifyError.message);
          }
        }
      }
    })().catch((error) => {
      console.error("Push processing failed:", error.message);
    });
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Notifier listening on port ${PORT}`);
});
