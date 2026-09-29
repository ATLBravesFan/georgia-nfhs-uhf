# Georgia NFHS → UHF: free GitHub + Cloudflare replacement

This replaces the Pipedream workflow. GitHub does the heavier Georgia matching every 30 minutes. Cloudflare serves the M3U and XMLTV files to UHF and keeps the Xtream login out of the public repository.

## Before deleting Pipedream
Keep the old Pipedream project until the new UHF playlist works. You may delete the broken UHF playlist now.

You will need these three Xtream values:
- XTREAM_BASE_URL
- XTREAM_USERNAME
- XTREAM_PASSWORD

You can use the same provider values you already use in UHF / Pipedream.

## Part 1 — GitHub

### A. Create the repository
1. Go to GitHub and create a repository named `georgia-nfhs-uhf`.
2. Make it **Public**. The repository will contain no Xtream username/password or stream URLs. Only event metadata and stream IDs are published.
3. Upload everything from this package **except the `worker` folder** to the root of the repository, preserving the folders.

The repository should contain:
- `.github/workflows/update-nfhs.yml`
- `scripts/update-nfhs.mjs`
- `public/events.json`
- `package.json`

### B. Add the three GitHub secrets
Repository → Settings → Secrets and variables → Actions → Secrets → New repository secret.

Add exactly:
- `XTREAM_BASE_URL` = provider base URL only, with no `/get.php` or `/player_api.php`
- `XTREAM_USERNAME` = Xtream username
- `XTREAM_PASSWORD` = Xtream password

Do NOT put these values in the code or events.json.

### C. Run it once
1. Open the repository's **Actions** tab.
2. Open **Update Georgia NFHS data**.
3. Choose **Run workflow**.
4. Wait for the green check.
5. Open `public/events.json`. `generated_at` should now contain a timestamp.

The action then runs automatically every 30 minutes.

## Part 2 — Cloudflare Worker

### A. Create the Worker
1. Sign in at Cloudflare.
2. Go to **Workers & Pages**.
3. Create a Worker and name it `georgia-nfhs-uhf`.
4. Open the code editor, replace the sample code with the contents of `worker/index.js`, then Deploy.

### B. Add one normal variable
Worker → Settings → Variables and Secrets → Add.

Type: **Text / Variable**

Name:
`DATA_URL`

Value:
`https://raw.githubusercontent.com/YOUR-GITHUB-USERNAME/georgia-nfhs-uhf/main/public/events.json`

Replace YOUR-GITHUB-USERNAME with your actual GitHub username.

### C. Add four secrets
In the same Variables and Secrets area, add each as **Secret**:
- `XTREAM_BASE_URL`
- `XTREAM_USERNAME`
- `XTREAM_PASSWORD`
- `ACCESS_KEY`

For `ACCESS_KEY`, make up a long random value. Example format only: `nfhs-4d6e....` Do not use the example itself.

Deploy the variable/secret changes.

## Part 3 — Test before UHF

Suppose Cloudflare gives you this Worker address:
`https://georgia-nfhs-uhf.YOUR-SUBDOMAIN.workers.dev`

Open:
`https://georgia-nfhs-uhf.YOUR-SUBDOMAIN.workers.dev?format=json&key=YOUR_ACCESS_KEY`

You should see JSON with fields such as:
- `generated_at`
- `source_stream_count`
- `total_georgia_matches_found`
- `georgia_channel_count`
- `directory_sources`
- `channels`

Then test:
`https://georgia-nfhs-uhf.YOUR-SUBDOMAIN.workers.dev?format=m3u&key=YOUR_ACCESS_KEY`

It must begin with `#EXTM3U`.

## Part 4 — Add to UHF

Create a new M3U playlist called `NFHS | Georgia`.

M3U URL:
`https://georgia-nfhs-uhf.YOUR-SUBDOMAIN.workers.dev?format=m3u&key=YOUR_ACCESS_KEY`

EPG/XMLTV URL:
`https://georgia-nfhs-uhf.YOUR-SUBDOMAIN.workers.dev?format=xml&key=YOUR_ACCESS_KEY`

Refresh the playlist and EPG.

## Part 5 — Delete Pipedream

Only after the new playlist imports and refreshes correctly:
1. Delete or disable the old Pipedream workflow.
2. Remove the old Pipedream playlist from UHF if you did not already delete it.

## What happens when there are no Georgia games?
The Cloudflare Worker deliberately returns a valid placeholder channel named **No Georgia NFHS Events** instead of an empty M3U. This prevents UHF from rejecting the playlist simply because no Georgia event is currently available.

## Privacy
The public GitHub data file does NOT contain:
- Xtream username
- Xtream password
- provider base URL
- playable Xtream stream URLs

Those values are stored as GitHub/Cloudflare secrets. The final private M3U returned to UHF does contain the provider stream URL because UHF needs it to play the event, so keep your Worker `ACCESS_KEY` private.
