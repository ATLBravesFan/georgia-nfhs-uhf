const KEYHOLDER_BASE = "https://api.keyholdervacations.com/v2/dvc/rental/confirmed-reservations";

export const URLS = {
  get rentalStoreApi() {
    // Keep the API window rolling so the watch never goes stale. The previous
    // ChangeDetection URL used the same broad occupancy/night/price limits but
    // fixed dates; this generates current dates on every run instead.
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date();
    end.setUTCDate(end.getUTCDate() + 420);

    const url = new URL(KEYHOLDER_BASE);
    url.searchParams.set("dateRangeStart", start.toISOString().slice(0, 10));
    url.searchParams.set("dateRangeEnd", end.toISOString().slice(0, 10));
    url.searchParams.set("minimumOccupancy", "1");
    url.searchParams.set("maxNumberOfNights", "30");
    url.searchParams.set("minNumberOfNights", "1");
    url.searchParams.set("maxTotalPrice", "150000");
    return url.toString();
  },
  davids: "https://dvcrequest.com/dvc-guests/confirmed-reservations-for-rent/",
  dvcRental: "https://dvc-rental.com/deals/",
  dvcShop: "https://rentals.dvcshop.com/confirmed-reservations/",
};

export const WATCHES = {
  rentalStoreNightly: {
    title: "DVC Rental Store under $200",
    interval: "1 minute",
    priceChanges: true,
    // This mirrors the current ChangeDetection cutoff: strictly below $201.
    // It therefore includes $200.xx listings and excludes $201.00 exactly.
    match: r => Number.isFinite(r.nightly) && r.nightly < 201,
  },
  rentalStorePoints: {
    title: "DVC Rental Store under $12 per point",
    interval: "1 minute",
    priceChanges: true,
    // Current watch is strict "under $12", not $12-or-less.
    match: r => Number.isFinite(r.pointPrice) && r.pointPrice < 12,
  },
  rentalStoreAll: {
    title: "DVC Rental Store - All Reservations",
    interval: "10 minutes",
    priceChanges: true,
    // Every currently available confirmed reservation, regardless of price.
    match: () => true,
  },
  davids: {
    title: "David's Vacation Rentals",
    interval: "10 minutes",
    priceChanges: true,
    // Any room below $300/night OR a 1/2/3-bedroom villa below $17/point.
    match: r => (Number.isFinite(r.nightly) && r.nightly < 300) ||
      (/(?:one|two|three|1|2|3)[ -]?bedroom/i.test(r.room || "") && Number.isFinite(r.pointPrice) && r.pointPrice < 17),
  },
  dvcRental: {
    title: "DVC-Rental New Confirmed Reservations",
    interval: "10 minutes",
    priceChanges: false,
    // All new reservations from all pages; no price filter and no removals.
    match: () => true,
  },
  dvcShop: {
    title: "DVC Shop",
    interval: "10 minutes",
    priceChanges: false,
    // Current watch is new available reservations only; no removals.
    match: r => !r.status || /available/i.test(r.status),
  },
};
