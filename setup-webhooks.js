
require("dotenv").config();
const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const secret = process.env.GITHUB_WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL;

// Optional allowlist: owner/repo,owner/repo2
const allowlist = process.env.ALLOWED_REPOS
  ? new Set(
      process.env.ALLOWED_REPOS.split(",")
        .map((x) => x.trim().toLowerCase())
    )
  : null;

async function main() {
  if (!secret || !url || !process.env.GITHUB_TOKEN) {
    throw new Error("Set GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET and WEBHOOK_URL");
  }

  if (!url.startsWith("https://")) {
    throw new Error("WEBHOOK_URL must use HTTPS");
  }

  const repos = await octokit.paginate(
    octokit.rest.repos.listForAuthenticatedUser,
    { per_page: 100, affiliation: "owner,collaborator,organization_member" }
  );

  for (const repo of repos) {
    const fullName = repo.full_name.toLowerCase();

    if (allowlist && !allowlist.has(fullName)) continue;
    if (repo.archived || repo.disabled) continue;

    try {
      const hooks = await octokit.paginate(
        octokit.rest.repos.listWebhooks,
        { owner: repo.owner.login, repo: repo.name, per_page: 100 }
      );

      const existing = hooks.find(
        (h) => h.config?.url === url
      );

      if (existing) {
        await octokit.rest.repos.updateWebhook(
          {
            owner: repo.owner.login,
            repo: repo.name,
            hook_id: existing.id,
            active: true,
            events: ["push"],
            config: {
              url,
              content_type: "json",
              secret,
              insecure_ssl: "0",
            },
          }
        );

        console.log(`Updated: ${fullName}`);
        continue;
      }

      await octokit.rest.repos.createWebhook({
        owner: repo.owner.login,
        repo: repo.name,
        name: "web",
        active: true,
        events: ["push"],
        config: {
          url,
          content_type: "json",
          secret,
          insecure_ssl: "0",
        },
      });

      console.log(`Created: ${fullName}`);
    } catch (err) {
      console.error(`Failed: ${fullName}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
