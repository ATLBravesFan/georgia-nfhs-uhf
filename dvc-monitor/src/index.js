import { URLS, WATCHES } from "./config.js";
import { parseKeyholder, parseExternalRentalStore, parseDavids, parseDvcShop, fingerprint, formatListing, priceSummary, byId } from "./parsers.js";

const RENTAL_STORE_BACKUP_WORKFLOW = "dvc-rental-store-website-backup.yml";
const GITHUB_REPO = "ATLBravesFan/georgia-nfhs-uhf";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, new Date(event.scheduledTime || Date.now())));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return statusResponse(env, url.pathname === "/");
    }

    if (url.pathname === "/run" && request.method === "POST") {
      if (!authorized(request, env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      const mode = url.searchParams.get("mode") || "all";
      return json(await runManual(env, mode));
    }

    if (url.pathname === "/ingest/dvc-rental-store-website" && request.method === "POST") {
      if (!authorized(request, env.INGEST_TOKEN || env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      const body = await request.json();
      const rows = Array.isArray(body) ? body : body.listings;
      if (!Array.isArray(rows)) return json({ ok: false, error: "Expected listings array" }, 400);
      return json({ ok: true, ...(await processRentalStoreWebsite(env, parseExternalRentalStore(rows))) });
    }

    if (url.pathname === "/ingest/dvc-rental" && request.method === "POST") {
      if (!authorized(request, env.INGEST_TOKEN || env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      const body = await request.json();
      const rows = Array.isArray(body) ? body : body.listings;
      if (!Array.isArray(rows) || !rows.length) return json({ ok: false, error: "Expected non-empty listings array" }, 400);
      return json({ ok: true, ...(await processStandardWatch(env, "dvc-rental", WATCHES.dvcRental, normalizeBrowserRows(rows, "DVC-Rental"))) });
    }

    return new Response("DVC monitor is running. Open / for status.");
  },
};

async function runScheduled(env, now) {
  const result = {};
  const tenMinuteCycle = now.getUTCMinutes() % 10 === 0;

  try {
    result.rentalStore = await pollRentalStore(env, tenMinuteCycle);
  } catch (error) {
    result.rentalStore = { ok: false, error: errorMessage(error) };
  }

  // Trigger the real-browser Rental Store website backup every minute.
  // GitHub's own cron remains a five-minute safety net in case a dispatch fails.
  result.rentalStoreWebsiteDispatch = await dispatchRentalStoreWebsiteBackup(env);

  // David's and DVC Shop are lightweight HTTP watches and run every 10 minutes.
  // DVC-Rental stays browser-backed on its own 10-minute workflow.
  if (tenMinuteCycle) result.slower = await pollSlowerHttpSources(env);

  // Limit KV status writes while still keeping a useful heartbeat.
  if (now.getUTCMinutes() % 3 === 0 || tenMinuteCycle) {
    await saveStatus(env, result);
  }
  return result;
}

async function runManual(env, mode) {
  if (mode === "rental-store") return { rentalStore: await pollRentalStore(env, true) };
  if (mode === "website-backup-dispatch") return { rentalStoreWebsiteDispatch: await dispatchRentalStoreWebsiteBackup(env) };
  if (mode === "slow") return { slower: await pollSlowerHttpSources(env) };
  return {
    rentalStore: await pollRentalStore(env, true),
    rentalStoreWebsiteDispatch: await dispatchRentalStoreWebsiteBackup(env),
    slower: await pollSlowerHttpSources(env),
  };
}

async function dispatchRentalStoreWebsiteBackup(env) {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    return { ok: false, skipped: true, error: "GITHUB_DISPATCH_TOKEN not configured" };
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${RENTAL_STORE_BACKUP_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "DVC-Reservation-Monitor",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  if (response.status === 204) {
    return { ok: true, dispatchedAt: new Date().toISOString() };
  }

  return {
    ok: false,
    status: response.status,
    error: (await response.text()).slice(0, 300),
  };
}

async function pollRentalStore(env, includeAllReservationsWatch = false) {
  const response = await fetch(URLS.rentalStoreApi, {
    headers: { Accept: "application/json", "User-Agent": "DVC-Monitor/1.0" },
  });
  if (!response.ok) throw new Error(`Keyholder API ${response.status}`);

  const rows = parseKeyholder(await response.json());
  if (!rows.length) throw new Error("Keyholder API returned zero usable reservations");

  const stateKey = "state:rental-store-api";
  const previous = await readState(env, stateKey);
  const current = byId(rows);
  let allReservations10m = null;

  if (!previous) {
    await putState(env, stateKey, current);
    if (includeAllReservationsWatch) allReservations10m = await processRentalStoreAllWatch(env, rows);
    return rentalStoreCounts(rows, true, 0, allReservations10m);
  }

  const events = [];
  for (const listing of rows) {
    const matches = rentalStoreMatches(listing);
    if (!matches.length) continue;
    const old = previous[listing.id];
    if (!old) {
      events.push({ type: "NEW", listing, matches });
    } else if (fingerprint(old) !== fingerprint(listing)) {
      events.push({ type: "PRICE CHANGE", listing, previous: old, matches });
    }
  }

  await putIfChanged(env, stateKey, previous, current);
  const sent = await sendEvents(env, "dvc-rental-store", "DVC Rental Store", events, true);

  if (includeAllReservationsWatch) {
    allReservations10m = await processRentalStoreAllWatch(env, rows);
  }

  return rentalStoreCounts(rows, false, sent, allReservations10m);
}

async function processRentalStoreAllWatch(env, rows) {
  const stateKey = "state:rental-store-all-10m";
  const previous = await readState(env, stateKey);
  const current = byId(rows);

  if (!previous) {
    await putState(env, stateKey, current);
    return { ok: true, count: rows.length, baseline: true, alerts: 0 };
  }

  const events = [];
  for (const listing of rows) {
    const old = previous[listing.id];
    if (!old) {
      events.push({ type: "NEW", listing });
    } else if (WATCHES.rentalStoreAll.priceChanges && fingerprint(old) !== fingerprint(listing)) {
      events.push({ type: "PRICE CHANGE", listing, previous: old });
    }
  }

  await putIfChanged(env, stateKey, previous, current);

  // Use the same Rental Store dedupe namespace as the fast filtered watches.
  // If a cheap reservation already triggered the 1-minute watch, the 10-minute
  // all-reservations watch will not send a duplicate email for the same price.
  const sent = await sendEvents(
    env,
    "dvc-rental-store",
    WATCHES.rentalStoreAll.title,
    events,
    false,
  );

  return { ok: true, count: rows.length, baseline: false, alerts: sent };
}

function rentalStoreCounts(rows, baseline, alerts, allReservations10m = null) {
  return {
    ok: true,
    count: rows.length,
    baseline,
    alerts,
    under200: rows.filter(WATCHES.rentalStoreNightly.match).length,
    under12pt: rows.filter(WATCHES.rentalStorePoints.match).length,
    ...(allReservations10m ? { allReservations10m } : {}),
  };
}

function rentalStoreMatches(listing) {
  const matches = [];
  if (WATCHES.rentalStoreNightly.match(listing)) matches.push(WATCHES.rentalStoreNightly.title);
  if (WATCHES.rentalStorePoints.match(listing)) matches.push(WATCHES.rentalStorePoints.title);
  return matches;
}

async function processRentalStoreWebsite(env, rows) {
  if (!rows.length) throw new Error("Rental Store website backup returned zero usable reservations");

  const stateKey = "state:rental-store-website";
  const previous = await readState(env, stateKey);
  const current = byId(rows);
  const qualifying = rows.filter(WATCHES.rentalStoreNightly.match);

  if (!previous) {
    await putState(env, stateKey, current);
    return { baseline: true, count: rows.length, under200: qualifying.length, alerts: 0 };
  }

  const events = [];
  for (const listing of qualifying) {
    const old = previous[listing.id];
    if (!old) {
      events.push({ type: "NEW", listing, matches: [WATCHES.rentalStoreNightly.title] });
    } else if (fingerprint(old) !== fingerprint(listing)) {
      events.push({ type: "PRICE CHANGE", listing, previous: old, matches: [WATCHES.rentalStoreNightly.title] });
    }
  }

  await putIfChanged(env, stateKey, previous, current);
  // Shared dedupe namespace with the API prevents duplicate website/API alerts.
  const sent = await sendEvents(env, "dvc-rental-store", "DVC Rental Store", events, true);
  await mergeStatus(env, {
    rentalStoreWebsiteBackup: {
      interval: "1 minute",
      checkedAt: new Date().toISOString(),
      count: rows.length,
      under200: qualifying.length,
      alerts: sent,
    },
  });
  return { baseline: false, count: rows.length, under200: qualifying.length, alerts: sent };
}

async function pollSlowerHttpSources(env) {
  const jobs = [
    ["davids", WATCHES.davids, async () => parseDavids(await fetchText(URLS.davids))],
    ["dvc-shop", WATCHES.dvcShop, async () => parseDvcShop(await fetchText(URLS.dvcShop))],
  ];

  const result = {};
  await Promise.all(jobs.map(async ([key, watch, getRows]) => {
    try {
      const rows = await getRows();
      if (!rows.length) throw new Error("parser returned zero reservations");
      result[key] = await processStandardWatch(env, key, watch, rows);
    } catch (error) {
      result[key] = { ok: false, error: errorMessage(error) };
    }
  }));
  return result;
}

async function processStandardWatch(env, key, watch, rows) {
  const stateKey = `state:${key}`;
  const previous = await readState(env, stateKey);
  const current = byId(rows);

  if (!previous) {
    await putState(env, stateKey, current);
    return { ok: true, count: rows.length, baseline: true, alerts: 0 };
  }

  const events = [];
  for (const listing of rows) {
    if (!watch.match(listing)) continue;
    const old = previous[listing.id];
    if (!old) {
      events.push({ type: "NEW", listing });
    } else if (watch.priceChanges && fingerprint(old) !== fingerprint(listing)) {
      events.push({ type: "PRICE CHANGE", listing, previous: old });
    }
  }

  await putIfChanged(env, stateKey, previous, current);
  const sent = await sendEvents(env, key, watch.title, events, false);

  const summary = { ok: true, count: rows.length, baseline: false, alerts: sent };
  if (key === "dvc-rental") {
    await mergeStatus(env, { dvcRentalBrowser: { ...summary, checkedAt: new Date().toISOString() } });
  }
  return summary;
}

async function sendEvents(env, source, title, events, showMatches) {
  const fresh = [];
  for (const event of events) {
    if (!(await env.STATE.get(alertKey(source, event.listing)))) fresh.push(event);
  }
  if (!fresh.length) return 0;

  // Email first. Only mark dedupe keys after Brevo accepts the message.
  await sendEmail(env, title, fresh, showMatches);
  for (const event of fresh) {
    await env.STATE.put(alertKey(source, event.listing), new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 60 });
  }
  return fresh.length;
}

function alertKey(source, listing) {
  return `alert:${source}:${listing.id}:${fingerprint(listing)}`;
}

async function sendEmail(env, title, events, showMatches) {
  if (!env.BREVO_API_KEY || !env.EMAIL_TO || !env.EMAIL_FROM) {
    throw new Error("Email is not configured: BREVO_API_KEY, EMAIL_TO and EMAIL_FROM are required");
  }

  const newCount = events.filter((event) => event.type === "NEW").length;
  const changedCount = events.length - newCount;
  const subjectBits = [
    newCount ? `${newCount} new` : null,
    changedCount ? `${changedCount} price change${changedCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean);

  const blocks = events.map((event) => {
    const listing = event.listing;
    return `<div style="border-bottom:1px solid #ddd;padding:14px 0;line-height:1.45">
      <strong>${escapeHtml(event.type)}</strong>
      <div>${escapeHtml(formatListing(listing))}</div>
      ${showMatches && event.matches?.length ? `<div><strong>Matches:</strong> ${event.matches.map(escapeHtml).join(" + ")}</div>` : ""}
      ${event.previous ? `<div style="color:#555">Previous: ${escapeHtml(priceSummary(event.previous))}</div>` : ""}
      ${listing.bookingUrl ? `<div style="margin-top:7px"><a href="${escapeHtml(listing.bookingUrl)}">Book this reservation</a><br><span style="font-size:12px;color:#666">${escapeHtml(listing.bookingUrl)}</span></div>` : ""}
    </div>`;
  }).join("");

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-key": env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || "DVC Monitor" },
      to: [{ email: env.EMAIL_TO }],
      subject: `${title} — ${subjectBits.join(", ")}`,
      htmlContent: `<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;padding:18px"><h2>${escapeHtml(title)}</h2>${blocks}</body></html>`,
      tags: ["dvc-monitor"],
    }),
  });

  if (!response.ok) throw new Error(`Brevo ${response.status}: ${(await response.text()).slice(0, 250)}`);
}

function normalizeBrowserRows(rows, source) {
  return rows.map((row) => ({
    id: String(row.id || "").trim(),
    source,
    resort: String(row.resort || "").trim(),
    room: String(row.room || row.roomType || "").trim(),
    checkIn: row.checkIn || null,
    checkOut: row.checkOut || null,
    nights: numberOrNull(row.nights),
    total: numberOrNull(row.total),
    nightly: numberOrNull(row.nightly),
    pointPrice: numberOrNull(row.pointPrice),
    points: numberOrNull(row.points),
    status: row.status || "Available",
    bookingUrl: row.bookingUrl || null,
  })).filter((row) => row.id && (row.resort || row.room || row.checkIn));
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(number) ? number : null;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; DVC-Monitor/1.0)",
    },
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.text();
}

async function readState(env, key) {
  const raw = await env.STATE.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function putState(env, key, value) {
  await env.STATE.put(key, JSON.stringify(value));
}

async function putIfChanged(env, key, previous, current) {
  if (JSON.stringify(previous) !== JSON.stringify(current)) await putState(env, key, current);
}

async function saveStatus(env, patch) {
  const previous = (await readState(env, "status")) || {};
  await putState(env, "status", { ...previous, ...patch, updatedAt: new Date().toISOString() });
}

async function mergeStatus(env, patch) {
  return saveStatus(env, patch);
}

async function statusResponse(env, html) {
  const stored = (await readState(env, "status")) || {};
  const payload = {
    ok: true,
    cron: "every minute",
    rentalStoreWebsiteBackup: {
      interval: "1 minute",
      trigger: "Cloudflare Worker dispatches GitHub browser workflow",
      githubCronFallback: "5 minutes",
    },
    watches: Object.values(WATCHES).map((watch) => ({
      title: watch.title,
      interval: watch.interval,
      priceChanges: watch.priceChanges,
    })),
    ...stored,
  };

  if (!html) return json(payload);
  return new Response(
    `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>DVC Monitor</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;max-width:900px;margin:30px auto;padding:0 16px"><h1>DVC Monitor</h1><p>DVC Rental Store API + website backup: every minute. DVC Rental Store all-reservations watch and other watches: every 10 minutes.</p><pre style="white-space:pre-wrap;background:#f5f5f5;padding:16px;border-radius:8px">${escapeHtml(JSON.stringify(payload, null, 2))}</pre></body></html>`,
    { headers: { "content-type": "text/html;charset=utf-8" } },
  );
}

function authorized(request, token) {
  return Boolean(token) && (request.headers.get("authorization") || "") === `Bearer ${token}`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}