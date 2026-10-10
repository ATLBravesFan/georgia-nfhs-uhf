export const URLS = {
  rentalStoreApi: "https://api.keyholdervacations.com/v2/dvc/rental/confirmed-reservations",
  davids: "https://dvcrequest.com/dvc-guests/confirmed-reservations-for-rent/",
  dvcRental: "https://dvc-rental.com/deals/",
  dvcShop: "https://rentals.dvcshop.com/confirmed-reservations/",
};

export const WATCHES = {
  rentalStoreNightly: {
    title: "DVC Rental Store under $200",
    interval: "1 minute",
    priceChanges: true,
    match: r => Number.isFinite(r.nightly) && r.nightly < 200,
  },
  rentalStorePoints: {
    title: "DVC Rental Store under $12 per point",
    interval: "1 minute",
    priceChanges: true,
    match: r => Number.isFinite(r.pointPrice) && r.pointPrice < 12,
  },
  davids: {
    title: "David's Vacation Rentals",
    interval: "10 minutes",
    priceChanges: true,
    match: r => (Number.isFinite(r.nightly) && r.nightly < 300) ||
      (/(?:one|two|three|1|2|3)[ -]?bedroom/i.test(r.room || "") && Number.isFinite(r.pointPrice) && r.pointPrice < 17),
  },
  dvcRental: {
    title: "DVC-Rental New Confirmed Reservations",
    interval: "10 minutes",
    priceChanges: false,
    match: () => true,
  },
  dvcShop: {
    title: "DVC Shop",
    interval: "10 minutes",
    priceChanges: false,
    match: r => !r.status || /available/i.test(r.status),
  },
};
