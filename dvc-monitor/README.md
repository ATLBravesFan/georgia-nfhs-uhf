# Free DVC reservation monitor

This replaces the ChangeDetection DVC watches with a Cloudflare Worker plus GitHub Actions browser jobs. Both priority DVC Rental Store watches **and the DVC Rental Store website backup** run every minute. The remaining browser/HTTP watches run every 10 minutes.

## Watches reproduced

| Watch | Schedule | Alert rule | Price changes? |
|---|---:|---|---:|
| DVC Rental Store under $200 | Every minute | Nightly price < $200 | Yes |
| DVC Rental Store under $12 per point | Every minute | Price/point < $12 | Yes |
| DVC Rental Store website backup | Every minute | Website-only listing < $200/night | Yes |
| David's Vacation Rentals | Every 10 minutes | < $300/night OR 1/2/3-bedroom < $17/point | Yes |
| DVC-Rental New Confirmed Reservations | Every 10 minutes | Any new confirmed reservation | No |
| DVC Shop | Every 10 minutes | Any new available confirmed reservation | No |

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

Every minute it:

1. checks the Keyholder/DVC Rental Store API once and evaluates both priority filters from that response; and
2. dispatches the **DVC Rental Store website backup** GitHub browser workflow.

Every ten minutes it also checks David's and DVC Shop using lightweight HTTP requests.

Cloudflare KV stores the current snapshot, alert fingerprints, and a small status/heartbeat record. The Worker exposes a status page at its root URL and JSON at `/health`.

### GitHub browser jobs

There are now two separate browser workflows:

- `.github/workflows/dvc-rental-store-website-backup.yml` — the Rental Store website backup. The Cloudflare Worker dispatches it **every minute**. Its own GitHub cron also runs every five minutes as a safety fallback.
- `.github/workflows/dvc-browser-backups.yml` — DVC-Rental pagination, every 10 minutes.

The browser script supports separate jobs using `DVC_BROWSER_JOB`, so the every-minute Rental Store backup does not need to re-run the heavier DVC-Rental pagination each time.

The DVC-Rental browser snapshot is rejected if the page advertises more reservations than the parser successfully collected.

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
- `GITHUB_DISPATCH_TOKEN` — Secret; a fine-grained GitHub token allowed to run Actions in `ATLBravesFan/georgia-nfhs-uhf`
- `EMAIL_FROM_NAME` — already defaults to `DVC Monitor`

`GITHUB_DISPATCH_TOKEN` is what lets the Worker start the Rental Store browser workflow every minute. Do not paste the token into source code or into chat; add it directly as a Cloudflare secret.

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

For the browser-backed sources, run both workflows once manually:

- **DVC Rental Store website backup**
- **DVC-Rental browser watch**

Confirm both finish with a green check.

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

- `src/config.js` — watch thresholds and rolling Rental Store API date window
- `src/parsers.js` — source-specific parsing and formatting
- `src/index.js` — Worker scheduler, one-minute website-workflow dispatch, state, dedupe and email delivery
- `scripts/browser-backups.mjs` — real-browser collection with separate Rental Store and DVC-Rental modes
- `wrangler.jsonc` — Cloudflare Worker/KV/cron configuration
- `.github/workflows/dvc-rental-store-website-backup.yml` — every-minute-dispatched Rental Store website backup, plus five-minute cron fallback
- `.github/workflows/dvc-browser-backups.yml` — ten-minute DVC-Rental pagination workflow
- `.github/workflows/dvc-monitor-check.yml` — syntax check

## Safety / failure behavior

- A parser returning zero reservations is treated as an error instead of overwriting a good baseline with an empty snapshot.
- DVC-Rental's browser snapshot is rejected if the advertised total count is larger than the parsed count.
- Alert fingerprints are written only **after** Brevo accepts the email, so a temporary email failure will not silently mark the alert as delivered.
- The DVC Rental Store website and API share alert fingerprints to prevent duplicate emails.
- If the one-minute GitHub dispatch is unavailable, the website backup still has a five-minute GitHub cron fallback.
