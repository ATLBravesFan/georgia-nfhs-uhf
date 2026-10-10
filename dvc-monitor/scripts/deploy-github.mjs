import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const required = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "BREVO_API_KEY",
  "EMAIL_TO", "EMAIL_FROM", "DVC_MONITOR_INGEST_TOKEN", "GITHUB_DISPATCH_TOKEN"];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length) throw new Error("Missing GitHub Actions secrets: " + missing.join(", "));
const account = process.env.CLOUDFLARE_ACCOUNT_ID.trim();
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID");
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
if (config.name !== "dvc-reservation-monitor") throw new Error("Unexpected Worker name");
const root = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function api(path, options = {}) {
  const response = await fetch(root + path, {
    ...options,
    headers: { Authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN,
      "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    // Do not put API response bodies or credentials in the Actions log.
    throw new Error("Cloudflare API failed: HTTP " + response.status +
      " (codes: " + (body.errors || []).map(e => e.code).join(",") + ")");
  }
  return body;
}

let namespace;
for (let page = 1; ; page++) {
  const body = await api("/storage/kv/namespaces?per_page=100&page=" + page);
  const found = body.result.filter(row => row.title === "DVC_MONITOR_STATE");
  if (found.length > 1 || (namespace && found.length)) throw new Error("Ambiguous DVC namespace");
  namespace ||= found[0];
  if (body.result.length < 100) break;
}
if (!namespace) {
  namespace = (await api("/storage/kv/namespaces", {
    method: "POST", body: JSON.stringify({ title: "DVC_MONITOR_STATE" }),
  })).result;
}
config.kv_namespaces = [{ binding: "STATE", id: namespace.id }];
config.account_id = account;
config.workers_dev = true;
writeFileSync("wrangler.deploy.json", JSON.stringify(config, null, 2));
const secretDir = mkdtempSync(join(tmpdir(), "dvc-deploy-"));
try {
  const secretsPath = join(secretDir, "secrets.json");
  const secrets = {
    BREVO_API_KEY: process.env.BREVO_API_KEY,
    EMAIL_TO: process.env.EMAIL_TO,
    EMAIL_FROM: process.env.EMAIL_FROM,
    INGEST_TOKEN: process.env.DVC_MONITOR_INGEST_TOKEN,
    GITHUB_DISPATCH_TOKEN: process.env.GITHUB_DISPATCH_TOKEN,
    ADMIN_TOKEN: process.env.DVC_MONITOR_ADMIN_TOKEN || randomBytes(32).toString("hex"),
  };
  // Secrets are sent with the first deployed version, before cron becomes active.
  writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
  const result = spawnSync("npx", ["--no-install", "wrangler", "deploy",
    "--config", "wrangler.deploy.json", "--secrets-file", secretsPath],
    { stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) throw new Error("Worker deployment failed");
  console.log("Worker deployed. Verify source baselines and browser workflow secrets before retiring ChangeDetection.");
} finally {
  rmSync(secretDir, { recursive: true, force: true });
  rmSync("wrangler.deploy.json", { force: true });
}
