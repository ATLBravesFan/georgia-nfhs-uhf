# Free DVC reservation monitor

This replaces the current ChangeDetection DVC watches with a Cloudflare Worker plus two small GitHub Actions browser jobs. The two priority DVC Rental Store API watches and the Rental Store website backup run every minute. A separate DVC Rental Store all-reservations watch runs every 10 minutes. David's, DVC-Rental, and DVC Shop also run every 10 minutes.

## Watches reproduced

| Watch | Schedule | Alert rule | Price changes? |
|---|---:|---|---:|
| DVC Rental Store under $200 | Every minute | Current cutoff is nightly **< $201.00** | Yes |
| DVC Rental Store under $12 per point | Every minute | Price/point **< $12.00** | Yes |
| DVC Rental Store website backup | Every minute | Website-only listing nightly **< $201.00** | Yes |
| DVC Rental Store - All Reservations | Every 10 minutes | Every currently available confirmed reservation, no price filter | Yes |
| David's Vacation Rentals | Every 10 minutes | Any room **< $300/night** OR 1/2/3-bedroom **< $17/point** | Yes |
| DVC-Rental New Confirmed Reservations | Every 10 minutes | Any newly listed confirmed reservation, all pages, no price filter | No |
| DVC Shop | Every 10 minutes | Any newly listed available confirmed reservation | No |

The alert behavior mirrors the preferred ChangeDetection behavior:

- The first successful run establishes a baseline and sends no mass email.
- New qualifying reservations send an email.
- Genuine price changes send an email only on the watches configured for price changes.
- Removals never send an email.
- Unchanged reservations never repeat.
- DVC Rental Store API, all-reservations, and website snapshots share one alert-deduplication namespace, so the same reservation at the same price does not generate duplicate emails.
- If one DVC Rental Store reservation matches both priority filters, one email entry is sent and lists both matching watches.
- The 10-minute all-reservations watch still catches higher-priced reservations that do not qualify for either one-minute price filter.
- The all-reservations watch monitors the whole inventory; it does **not** resend the entire inventory every 10 minutes. It emails only newly added reservations and price changes.
- Every notification includes the direct booking URL when the source exposes one.
- No emojis are added to the reservation lines.

## Architecture

### Cloudflare Worker

`src/index.js` runs every minute.

Every minute it checks the Keyholder/DVC Rental Store API once and evaluates both priority filters from that single response. The API date window rolls automatically, so the monitor does not go stale because of a hard-coded end date.

Every 10 minutes, the same API snapshot is also evaluated by **DVC Rental Store - All Reservations**. That watch has its own comparison baseline, so it can detect newly added reservations and price changes across the entire Rental Store inventory without making a second API request. Its alert fingerprints are shared with the fast filters, so a cheap reservation already emailed by the one-minute watch is not emailed again by the 10-minute all-reservations watch.

Every 10 minutes the Worker also fetches and parses David's and DVC Shop directly.

Cloudflare KV stores:

- the last full snapshot for each source/watch;
- per-reservation alert fingerprints;
- the status/heartbeat record shown at the Worker root URL and `/health`.

### GitHub browser jobs

Two browser-backed workflows cover pages that need real rendering/pagination:

- `.github/workflows/dvc-rental-store-website-backup.yml` — dispatched by the Cloudflare Worker every minute to check the DVC Rental Store public browse page for website-only inventory. A five-minute GitHub cron remains as a safety fallback.
- `.github/workflows/dvc-browser-backups.yml` — walks every DVC-Rental results page every 10 minutes.

DVC-Rental snapshots are rejected instead of saved if the page advertises more reservations than the browser parser actually collected. That prevents an incomplete page load from being mistaken for dozens of removals.

## One-time setup

Keep ChangeDetection running until the replacement has established its baselines and the status page shows successful checks.

### 1. Create a Cloudflare KV namespace

Create one Workers KV namespace, for example:

`DVC_MONITOR_STATE`

Copy its namespace ID and replace this value in `wrangler.jsonc`:

`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`

### 2. Create a free Brevo transactional-email key

Verify the email address you want alerts sent **from**, then create a Brevo API key.

The Worker needs these values:

- `BREVO_API_KEY` — secret
- `EMAIL_TO` — destination email address
- `EMAIL_FROM` — Brevo-verified sender email
- `ADMIN_TOKEN` — any long random secret
- `INGEST_TOKEN` — a different long random secret
- `GITHUB_DISPATCH_TOKEN` — GitHub token used only to dispatch the one-minute Rental Store website backup workflow
- `EMAIL_FROM_NAME` — already defaults to `DVC Monitor`

Never commit the secret values to GitHub.

### 3. Deploy the Worker

From the `dvc-monitor` folder:

```bash
npm install
npx wrangler deploy
```

Then add the Worker secrets/variables in Cloudflare under **Settings → Variables and Secrets**. The one-minute cron trigger is already defined in `wrangler.jsonc`.

After deployment, opening the Worker URL should show the monitor status page.

### 4. Add GitHub Actions secrets for the browser jobs

Repository → **Settings → Secrets and variables → Actions**:

- `DVC_MONITOR_BASE_URL` — the deployed Worker URL
- `DVC_MONITOR_INGEST_TOKEN` — exactly the same value used for the Worker's `INGEST_TOKEN`

### 5. Establish baselines

Run both browser workflows once manually:

- **DVC Rental Store website backup**
- **DVC-Rental browser watch**

The Worker itself will establish the DVC Rental Store priority, all-reservations, David's, and DVC Shop baselines on its scheduled runs.

Existing reservations are intentionally treated as baseline data, not as new alerts.

### 6. Verify before disabling ChangeDetection

Run both systems in parallel for at least several checks. Confirm the Worker status page shows successful source counts and that the two GitHub browser workflows finish successfully. After that, the old DVC ChangeDetection watches can be disabled.

## Email example

```text
PRICE CHANGE
A0F... | Old Key West | Deluxe Studio | 2027-05-12 → 2027-05-15 | 3 nights | $200.33/night | $11.74/point | $601 total
Matches: DVC Rental Store under $200 + DVC Rental Store under $12 per point
Previous: $212/night | $12.50/point | $636 total
Book this reservation
https://dvcrentalstore.com/guests/reservations/A0F.../
```

For a higher-priced reservation found only by the 10-minute all-reservations watch, the subject is `DVC Rental Store - All Reservations` and the email contains the same reservation details and direct booking link.

## Files

- `src/config.js` — exact watch thresholds and source URLs
- `src/parsers.js` — source-specific parsing and clean reservation formatting
- `src/index.js` — scheduler, state, dedupe, price-change detection, email delivery, status page
- `scripts/browser-backups.mjs` — DVC Rental Store website and DVC-Rental browser collection
- `test/smoke.mjs` — tests exact threshold boundaries and watch behavior
- `wrangler.jsonc` — Cloudflare Worker, KV binding, and one-minute cron
- `.github/workflows/dvc-rental-store-website-backup.yml` — one-minute dispatched Rental Store website backup with five-minute cron fallback
- `.github/workflows/dvc-browser-backups.yml` — ten-minute DVC-Rental pagination
- `.github/workflows/dvc-monitor-check.yml` — syntax + smoke tests

## Failure behavior

- A source returning zero usable reservations errors instead of replacing a good baseline with an empty snapshot.
- DVC-Rental rejects incomplete pagination.
- Alert fingerprints are stored only after Brevo accepts the message, so an email outage does not silently mark an alert delivered.
- DVC Rental Store website, priority-filter, and all-reservations alerts dedupe against the same reservation ID + price fingerprint.
