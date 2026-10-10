# Free DVC reservation monitor

This replaces the ChangeDetection DVC watches with a Cloudflare Worker plus a small GitHub Actions browser backup. The priority DVC Rental Store watches run every minute without a virtual-browser queue. The browser-backed watches run every 10 minutes.

## Watches reproduced

| Watch | Schedule | Alert rule | Price changes? |
|---|---:|---|---:|
| DVC Rental Store under $200 | Every minute | Nightly price < $200 | Yes |
| DVC Rental Store under $12 per point | Every minute | Price/point < $12 | Yes |
| David's Vacation Rentals | Every 10 minutes | < $300/night OR 1/2/3-bedroom < $17/point | Yes |
| DVC-Rental New Confirmed Reservations | Every 10 minutes | Any new confirmed reservation | No |
| DVC Shop | Every 10 minutes | Any new available confirmed reservation | No |
| DVC Rental Store website backup | Every 10 minutes | Website-only listing < $200/night | Yes |

Behavior is intentionally the same as the preferred ChangeDetection notifications:

- First successful run creates a baseline and sends **no mass email**.
- New qualifying reservations send an email.
- Price changes send an email only on watches configured for price changes.
- Removals do not send an email.
- Unchanged reservations never repeat.
- If one DVC Rental Store reservation matches both the nightly and point-price watches, it is sent once and the email lists both matches.
- The DVC Rental Store API and website backup share the same alert-deduplication key, so they do not double-notify the same reservation at the same price.
- Every email contains a clickable direct booking link when the source exposes one.

## Architecture

### Cloudflare Worker

`src/index.js` runs from a cron trigger every minute.

Every minute it checks the Keyholder/DVC Rental Store API once and evaluates both priority filters from that one response. Every ten minutes it also checks David's and DVC Shop using lightweight HTTP requests.

Cloudflare KV stores the current snapshot, alert fingerprints, and a small status/heartbeat record. The Worker exposes a simple status page at its root URL and JSON at `/health`.

### GitHub browser backup

`.github/workflows/dvc-browser-backups.yml` runs at minutes 3, 13, 23, 33, 43 and 53 of every hour. It uses the Chrome browser already present on GitHub's runner.

It handles two jobs that are better done with a browser:

1. DVC Rental Store website backup, including data the rendered page exposes outside the primary API.
2. DVC-Rental pagination so all confirmed reservations are collected, not just the first 50 shown on page 1.

The browser script refuses to ingest an incomplete DVC-Rental snapshot when the page advertises more reservations than it successfully parsed.

## One-time setup

Do not disable ChangeDetection until the new monitor has completed at least one baseline and one successful test cycle.

### 1. Create a Cloudflare KV namespace

In Cloudflare, create one Workers KV namespace named something like:

`DVC_MONITOR_STATE`

Copy its namespace ID. In `wrangler.jsonc`, replace:

`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`

with that ID.

The namespace ID is not a password, but the email/API secrets below are private and should never be committed to GitHub.

### 2. Create a free Brevo sender and API key

Create/verify the email address you want the alert to come **from**, then create a Brevo transactional-email API key.

The Worker needs these secrets/variables:

- `BREVO_API_KEY` — Secret
- `EMAIL_TO` — the address that should receive DVC alerts
- `EMAIL_FROM` — the verified sender address in Brevo
- `ADMIN_TOKEN` — Secret; any long random string
- `INGEST_TOKEN` — Secret; any different long random string
- `EMAIL_FROM_NAME` — already defaults to `DVC Monitor`

### 3. Deploy the Worker

From the `dvc-monitor` folder, the Wrangler deployment is:

```bash
npm install
npx wrangler deploy
```

Then add the variables/secrets in Cloudflare under the Worker's **Settings → Variables and Secrets**. The cron schedule is already in `wrangler.jsonc` as `* * * * *`.

After deployment, opening the Worker URL should show the DVC Monitor status page.

### 4. Add two GitHub Actions secrets

In this repository go to:

**Settings → Secrets and variables → Actions → New repository secret**

Add:

- `DVC_MONITOR_BASE_URL` — your Worker URL, such as `https://dvc-reservation-monitor.example.workers.dev`
- `DVC_MONITOR_INGEST_TOKEN` — exactly the same private value you used for the Worker's `INGEST_TOKEN`

### 5. Run a baseline

After the Worker is deployed, either wait for its first cron run or send an authorized POST to `/run?mode=all` using `ADMIN_TOKEN`.

The first successful snapshot for each source becomes its baseline. That is deliberate: existing reservations are not dumped into your inbox as if they were new.

For the browser-backed sources, open GitHub **Actions → DVC browser backups → Run workflow** once. Confirm it finishes with a green check.

### 6. Verify before canceling ChangeDetection

For a day or two, leave the old ChangeDetection watches enabled while this monitor runs in parallel. Check the Worker's status page periodically. Once the sources show successful checks and you receive a real/test email, the old DVC watches can be disabled.

## Email format

A DVC Rental Store alert is formatted along these lines:

```text
PRICE CHANGE
A0F... | Old Key West | Deluxe Studio | 2027-05-12 → 2027-05-15 | 3 nights | $189.33/night | $11.74/point | $568 total
Matches: DVC Rental Store under $200 + DVC Rental Store under $12 per point
Previous: $205/night | $12.50/point | $615 total
Book this reservation
https://dvcrentalstore.com/guests/reservations/A0F.../
```

No removals are emailed.

## Files

- `src/config.js` — watch thresholds and schedules
- `src/parsers.js` — source-specific parsing and formatting
- `src/index.js` — Worker scheduler, state, dedupe and email delivery
- `scripts/browser-backups.mjs` — real-browser collection for website backup and DVC-Rental pagination
- `wrangler.jsonc` — Cloudflare Worker/KV/cron configuration
- `.github/workflows/dvc-browser-backups.yml` — ten-minute browser backup schedule
- `.github/workflows/dvc-monitor-check.yml` — syntax check

## Safety / failure behavior

- A parser returning zero reservations is treated as an error instead of overwriting a good baseline with an empty snapshot.
- DVC-Rental's browser snapshot is rejected if the advertised total count is larger than the parsed count.
- Alert fingerprints are written only **after** Brevo accepts the email, so a temporary email failure will not silently mark the alert as delivered.
- The DVC Rental Store website and API share alert fingerprints to prevent duplicate emails.
