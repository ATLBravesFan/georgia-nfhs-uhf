import { URLS } from "./config.js";

export function parseKeyholder(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.data || payload?.results || payload?.reservations || payload?.items || []);
  return dedupe(rows.map(r => {
    const id = first(r.reservationID, r.reservationId, r.reservation_id, r.id, r.Id, r.sfid);
    const checkIn = iso(first(r.checkInString, r.checkIn, r.check_in, r.startDate, r.arrivalDate));
    const checkOut = iso(first(r.checkOutString, r.checkOut, r.check_out, r.endDate, r.departureDate));
    const nights = numFirst(r.nights, r.numberOfNights, r.number_of_nights, diffNights(checkIn, checkOut));
    const total = numFirst(r.price, r.totalPrice, r.total_price, r.total, r.totalCost, r.cost);
    const points = numFirst(r.points, r.totalPoints, r.total_points);
    return make({
      id, source: "DVC Rental Store", resort: first(r.resort, r.resortName, r.resort_name), room: first(r.roomType, r.room, r.roomName, r.room_type),
      checkIn, checkOut, nights, total, points,
      nightly: numFirst(r.pricePerNight, r.nightlyPrice, r.nightly, div(total, nights)),
      pointPrice: numFirst(r.pricePerPoint, r.pointPrice, r.price_per_point, div(total, points)),
      status: first(r.status),
      bookingUrl: id ? `https://dvcrentalstore.com/guests/reservations/${encodeURIComponent(id)}/` : null,
    });
  }));
}

export function parseExternalRentalStore(rows) {
  return dedupe((rows || []).map(r => {
    const id = first(r.id, r.reservationID, r.reservationId);
    const checkIn = iso(first(r.checkIn, r.checkInString));
    const checkOut = iso(first(r.checkOut, r.checkOutString));
    const nights = numFirst(r.nights, diffNights(checkIn, checkOut));
    const total = numFirst(r.total, r.price, r.totalPrice);
    const points = numFirst(r.points, r.totalPoints);
    return make({
      id, source: "DVC Rental Store", resort: r.resort, room: r.room || r.roomType, checkIn, checkOut, nights, total, points,
      nightly: numFirst(r.nightly, r.pricePerNight, div(total, nights)), pointPrice: numFirst(r.pointPrice, r.pricePerPoint, div(total, points)),
      status: r.status || "Available", bookingUrl: r.bookingUrl || (id ? `https://dvcrentalstore.com/guests/reservations/${encodeURIComponent(id)}/` : null),
    });
  }));
}

export function parseDavids(html) {
  const links = anchors(html).filter(a => /request\s*now/i.test(a.text)).map(a => abs(a.href, URLS.davids));
  const text = htmlText(html);
  const re = /([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*-\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+(\d+)\s+nights?\s+(.+?)\s+Request\s+Now\s+Total\s+Cost\s*\(Points\):\s*([\d,]+)\s+Price\s+Per\s+Point:\s*\$([\d.]+)(?:\s+Image)?\s+Total\s+Cost\s*\(USD\):\s*\$([\d,.]+)\s+Sleeps:\s*(\d+)/gi;
  const out = []; let m; let i = 0;
  while ((m = re.exec(text))) {
    const [resort, room] = splitRoom(m[4]);
    const checkIn = iso(m[1]), checkOut = iso(m[2]), nights = num(m[3]), points = num(m[5]), pointPrice = num(m[6]), total = num(m[7]);
    const bookingUrl = links[i++] || URLS.davids;
    const id = bookingUrl.match(/(?:id|reservation|res)[=\/-]([A-Za-z0-9_-]+)/i)?.[1] || `DAVIDS-${hash([checkIn, checkOut, resort, room, points].join("|"))}`;
    out.push(make({ id, source: "David's", resort, room, checkIn, checkOut, nights, points, pointPrice, total, nightly: div(total, nights), sleeps: num(m[8]), status: "Available", bookingUrl }));
  }
  return dedupe(out);
}

export function parseDvcRental(html) {
  const out = [];
  for (const a of anchors(html).filter(a => /DVC\d+/i.test(a.text) || /\/deals\/DVC\d+/i.test(a.href))) {
    const text = clean(a.text.replace(/Reduced/gi, " "));
    const id = (text.match(/\b(DVC\d+)\b/i)?.[1] || a.href.match(/\b(DVC\d+)\b/i)?.[1])?.toUpperCase();
    if (!id) continue;
    const at = text.search(/\bDVC\d+\b/i), [resort, room] = splitRoom(text.slice(0, at)), after = text.slice(at + id.length);
    const total = num(after.match(/\$([\d,]+(?:\.\d+)?)/)?.[1]);
    const dates = after.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*(?:→|-|to)\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/i);
    const checkIn = dates ? iso(dates[1]) : null, checkOut = dates ? iso(dates[2]) : null, nights = num(after.match(/(\d+)\s*nights?/i)?.[1]) || diffNights(checkIn, checkOut);
    out.push(make({ id, source: "DVC-Rental", resort, room, checkIn, checkOut, nights, total, nightly: div(total, nights), pointPrice: null, status: "Available", bookingUrl: abs(a.href || `/deals/${id}`, URLS.dvcRental) }));
  }
  return dedupe(out);
}

export function parseDvcShop(html) {
  const out = [];
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const c = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => clean(strip(m[1])));
    if (c.length < 7) continue;
    const id = (c.join(" ").match(/#?(\d{5,})\b/) || row.match(/post_id=(\d+)/i))?.[1];
    if (!id) continue;
    const checkIn = iso(c[0]), nights = num(c[1]), total = num(c[5]);
    const href = row.match(/href=["']([^"']*(?:post_id=\d+|confirmed-reservation)[^"']*)["']/i)?.[1];
    out.push(make({ id, source: "DVC Shop", resort: c[2], room: c[3], checkIn, checkOut: addDays(checkIn, nights), nights, total, nightly: div(total, nights), sleeps: num(c[4]), status: c[6], bookingUrl: href ? abs(href, URLS.dvcShop) : `https://rentals.dvcshop.com/product/confirmed-reservation/?post_id=${id}` }));
  }
  return dedupe(out);
}

export function fingerprint(r) { return [round(r.total), round(r.nightly), round(r.pointPrice), round(r.points)].join("|"); }
export function formatListing(r) {
  return [r.id, r.resort, r.room, r.checkIn && r.checkOut ? `${r.checkIn} → ${r.checkOut}` : r.checkIn, Number.isFinite(r.nights) ? `${r.nights} night${r.nights === 1 ? "" : "s"}` : null, Number.isFinite(r.nightly) ? `${money(r.nightly)}/night` : null, Number.isFinite(r.pointPrice) ? `${money(r.pointPrice)}/point` : null, Number.isFinite(r.total) ? `${money(r.total)} total` : null].filter(Boolean).join(" | ");
}
export function priceSummary(r) { return [Number.isFinite(r.nightly) ? `${money(r.nightly)}/night` : null, Number.isFinite(r.pointPrice) ? `${money(r.pointPrice)}/point` : null, Number.isFinite(r.total) ? `${money(r.total)} total` : null].filter(Boolean).join(" | "); }
export function byId(rows) { return Object.fromEntries(rows.map(r => [String(r.id), r])); }

function make(r) { r.resort = clean(r.resort); r.room = clean(r.room); return r?.id && (r.resort || r.room || r.checkIn) ? r : null; }
function dedupe(rows) { const m = new Map(); for (const r of rows.filter(Boolean)) m.set(String(r.id), r); return [...m.values()].sort((a,b)=>String(a.checkIn||"").localeCompare(String(b.checkIn||"")) || String(a.id).localeCompare(String(b.id))); }
function anchors(html) { const out=[]; const re=/<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi; let m; while((m=re.exec(html))) out.push({href:decode(m[2]),text:clean(strip(m[4]))}); return out; }
function htmlText(html) { return clean(decode(String(html).replace(/<script\b[\s\S]*?<\/script>/gi," ").replace(/<style\b[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," "))); }
function strip(s="") { return decode(String(s).replace(/<[^>]+>/g," ")); }
function decode(s="") { return String(s).replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&rarr;|&#8594;/gi,"→").replace(/&ndash;|&#8211;/gi,"–").replace(/&mdash;|&#8212;/gi,"—").replace(/&lt;/gi,"<").replace(/&gt;/gi,">"); }
function splitRoom(text="") { const s=clean(text); const re=/\b(Deluxe\s+Studio|Resort\s+Studio|Tower\s*-?\s*(?:Deluxe|Duo)?\s*Studio|Duo\s+Studio|Studio\b|One\s+Bedroom|Two\s+Bedroom|Three\s+Bedroom|1[- ]Bedroom|2[- ]Bedroom|3[- ]Bedroom|Grand\s+Villa|Cabin|Bungalow|Treehouse\s+Villas?|Deluxe\s+Inn\s+Room)\b/i; const m=re.exec(s); return m ? [clean(s.slice(0,m.index)), clean(s.slice(m.index))] : [s,""]; }
function first(...v) { for (const x of v) if (x!==undefined && x!==null && String(x).trim()) return String(x).trim(); return null; }
function numFirst(...v) { for (const x of v) { const n=num(x); if(Number.isFinite(n)) return n; } return null; }
function num(v) { if(v===undefined||v===null||v==="") return null; const n=Number(String(v).replace(/[$,\s]/g,"")); return Number.isFinite(n)?n:null; }
function div(a,b) { return Number.isFinite(a)&&Number.isFinite(b)&&b ? a/b : null; }
function iso(v) { if(!v) return null; const s=String(v).trim(); const i=s.match(/^(\d{4}-\d{2}-\d{2})/); if(i) return i[1]; const md=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(md) return `${md[3]}-${md[1].padStart(2,"0")}-${md[2].padStart(2,"0")}`; const d=new Date(`${s} 12:00:00 UTC`); return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10); }
function diffNights(a,b) { if(!a||!b) return null; const n=Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000); return n>0?n:null; }
function addDays(a,n) { if(!a||!Number.isFinite(n)) return null; const d=new Date(`${a}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function clean(v) { return String(v??"").replace(/\s+/g," ").trim(); }
function abs(h,b) { try { return new URL(h,b).toString(); } catch { return h||b; } }
function round(v) { return Number.isFinite(v)?Math.round(v*100)/100:""; }
function money(v) { const n=round(v); return Number.isFinite(n)?`$${n.toLocaleString("en-US",{minimumFractionDigits:n%1?2:0,maximumFractionDigits:2})}`:""; }
function hash(s) { let h=2166136261; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);} return (h>>>0).toString(36).toUpperCase(); }
