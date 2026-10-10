import { URLS, WATCHES } from "./config.js";
import { parseKeyholder, parseExternalRentalStore, parseDavids, parseDvcRental, parseDvcShop, fingerprint, formatListing, priceSummary, byId } from "./parsers.js";

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env, new Date(event.scheduledTime || Date.now()))); },
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === "/" || u.pathname === "/health") return status(env, u.pathname === "/");
    if (u.pathname === "/run" && request.method === "POST") {
      if (!auth(request, env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      const mode = u.searchParams.get("mode") || "all";
      return json(await manual(env, mode));
    }
    if (u.pathname === "/ingest/dvc-rental-store-website" && request.method === "POST") {
      if (!auth(request, env.INGEST_TOKEN || env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      const body = await request.json(), rows = Array.isArray(body) ? body : body.listings;
      if (!Array.isArray(rows)) return json({ ok:false, error:"Expected listings array" }, 400);
      return json({ ok:true, ...(await rentalStoreWebsite(env, parseExternalRentalStore(rows))) });
    }
    return new Response("DVC monitor is running. Open / for status.");
  },
};

async function run(env, now) {
  const result = {};
  try { result.rentalStore = await rentalStore(env); } catch (e) { result.rentalStore = { ok:false, error:msg(e) }; }
  if (now.getUTCMinutes() % 10 === 0) result.slower = await slower(env);
  if (now.getUTCMinutes() % 3 === 0 || now.getUTCMinutes() % 10 === 0) await saveStatus(env, result);
  return result;
}
async function manual(env, mode) { if(mode==="rental-store") return {rentalStore:await rentalStore(env)}; if(mode==="slow") return {slower:await slower(env)}; return {rentalStore:await rentalStore(env),slower:await slower(env)}; }

async function rentalStore(env) {
  const r = await fetch(URLS.rentalStoreApi,{headers:{Accept:"application/json","User-Agent":"DVC-Monitor/1.0"}}); if(!r.ok) throw new Error(`Keyholder API ${r.status}`);
  const rows = parseKeyholder(await r.json()); if(!rows.length) throw new Error("Keyholder API returned zero usable reservations");
  const prev = await read(env,"state:rental-store-api"), cur = byId(rows);
  if(!prev){ await put(env,"state:rental-store-api",cur); return counts(rows,true,0); }
  const events=[];
  for(const x of rows){ const matches=drsMatches(x); if(!matches.length) continue; const old=prev[x.id]; if(!old) events.push({type:"NEW",listing:x,matches}); else if(fingerprint(old)!==fingerprint(x)) events.push({type:"PRICE CHANGE",listing:x,previous:old,matches}); }
  await putIfChanged(env,"state:rental-store-api",prev,cur);
  const sent=await sendEvents(env,"dvc-rental-store","DVC Rental Store",events,true);
  return counts(rows,false,sent);
}
function counts(rows,baseline,alerts){ return {ok:true,count:rows.length,baseline,alerts,under200:rows.filter(WATCHES.rentalStoreNightly.match).length,under12pt:rows.filter(WATCHES.rentalStorePoints.match).length}; }
function drsMatches(r){ const a=[]; if(WATCHES.rentalStoreNightly.match(r))a.push(WATCHES.rentalStoreNightly.title); if(WATCHES.rentalStorePoints.match(r))a.push(WATCHES.rentalStorePoints.title); return a; }

async function rentalStoreWebsite(env, rows) {
  if(!rows.length) throw new Error("Website backup returned zero usable reservations");
  const prev=await read(env,"state:rental-store-website"),cur=byId(rows),qual=rows.filter(WATCHES.rentalStoreNightly.match);
  if(!prev){ await put(env,"state:rental-store-website",cur); return {baseline:true,count:rows.length,under200:qual.length,alerts:0}; }
  const events=[]; for(const x of qual){const old=prev[x.id]; if(!old)events.push({type:"NEW",listing:x,matches:[WATCHES.rentalStoreNightly.title]}); else if(fingerprint(old)!==fingerprint(x))events.push({type:"PRICE CHANGE",listing:x,previous:old,matches:[WATCHES.rentalStoreNightly.title]});}
  await putIfChanged(env,"state:rental-store-website",prev,cur); const sent=await sendEvents(env,"dvc-rental-store","DVC Rental Store",events,true); return {baseline:false,count:rows.length,under200:qual.length,alerts:sent};
}

async function slower(env) {
  const jobs=[
    ["davids",WATCHES.davids,async()=>parseDavids(await text(URLS.davids))],
    ["dvc-rental",WATCHES.dvcRental,async()=>{const pages=await Promise.all([URLS.dvcRental,`${URLS.dvcRental}?page=2`,`${URLS.dvcRental}?paged=2`].map(u=>text(u).catch(()=>""))); return uniq(pages.flatMap(parseDvcRental));}],
    ["dvc-shop",WATCHES.dvcShop,async()=>parseDvcShop(await text(URLS.dvcShop))],
  ];
  const out={}; await Promise.all(jobs.map(async([key,watch,get])=>{try{const rows=await get(); if(!rows.length)throw new Error("parser returned zero reservations"); out[key]=await standard(env,key,watch,rows);}catch(e){out[key]={ok:false,error:msg(e)};}})); return out;
}
async function standard(env,key,watch,rows){const sk=`state:${key}`,prev=await read(env,sk),cur=byId(rows); if(!prev){await put(env,sk,cur); return {ok:true,count:rows.length,baseline:true,alerts:0};} const events=[]; for(const x of rows){if(!watch.match(x))continue;const old=prev[x.id];if(!old)events.push({type:"NEW",listing:x});else if(watch.priceChanges&&fingerprint(old)!==fingerprint(x))events.push({type:"PRICE CHANGE",listing:x,previous:old});} await putIfChanged(env,sk,prev,cur); const sent=await sendEvents(env,key,watch.title,events,false); return {ok:true,count:rows.length,baseline:false,alerts:sent};}

async function sendEvents(env,source,title,events,showMatches){const fresh=[];for(const e of events){if(!await env.STATE.get(alertKey(source,e.listing)))fresh.push(e);}if(!fresh.length)return 0; await email(env,title,fresh,showMatches); for(const e of fresh)await env.STATE.put(alertKey(source,e.listing),new Date().toISOString(),{expirationTtl:5184000}); return fresh.length;}
function alertKey(source,r){return `alert:${source}:${r.id}:${fingerprint(r)}`;}
async function email(env,title,events,showMatches){if(!env.BREVO_API_KEY||!env.EMAIL_TO||!env.EMAIL_FROM)throw new Error("Email is not configured");const n=events.filter(e=>e.type==="NEW").length,c=events.length-n;const subject=`${title} — ${[n?`${n} new`:null,c?`${c} price change${c===1?"":"s"}`:null].filter(Boolean).join(", ")}`;const blocks=events.map(e=>{const r=e.listing,old=e.previous;return `<div style="border-bottom:1px solid #ddd;padding:14px 0;line-height:1.45"><strong>${esc(e.type)}</strong><div>${esc(formatListing(r))}</div>${showMatches&&e.matches?.length?`<div><strong>Matches:</strong> ${e.matches.map(esc).join(" + ")}</div>`:""}${old?`<div style="color:#555">Previous: ${esc(priceSummary(old))}</div>`:""}${r.bookingUrl?`<div style="margin-top:7px"><a href="${esc(r.bookingUrl)}">Book this reservation</a><br><span style="font-size:12px;color:#666">${esc(r.bookingUrl)}</span></div>`:""}</div>`;}).join("");const res=await fetch("https://api.brevo.com/v3/smtp/email",{method:"POST",headers:{Accept:"application/json","Content-Type":"application/json","api-key":env.BREVO_API_KEY},body:JSON.stringify({sender:{email:env.EMAIL_FROM,name:env.EMAIL_FROM_NAME||"DVC Monitor"},to:[{email:env.EMAIL_TO}],subject,htmlContent:`<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;padding:18px"><h2>${esc(title)}</h2>${blocks}</body></html>`,tags:["dvc-monitor"]})});if(!res.ok)throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0,250)}`);}

async function text(url){const r=await fetch(url,{headers:{Accept:"text/html,application/xhtml+xml","User-Agent":"Mozilla/5.0 (compatible; DVC-Monitor/1.0)"}});if(!r.ok)throw new Error(`${url} ${r.status}`);return r.text();}
function uniq(rows){const m=new Map();for(const r of rows)m.set(String(r.id),r);return[...m.values()];}
async function read(env,k){const s=await env.STATE.get(k);if(!s)return null;try{return JSON.parse(s)}catch{return null}}
async function put(env,k,v){await env.STATE.put(k,JSON.stringify(v));}
async function putIfChanged(env,k,a,b){if(JSON.stringify(a)!==JSON.stringify(b))await put(env,k,b);}
async function saveStatus(env,patch){const old=await read(env,"status")||{};await put(env,"status",{...old,...patch,updatedAt:new Date().toISOString()});}
async function status(env,html){const s=await read(env,"status")||{};const p={ok:true,cron:"every minute",watches:Object.values(WATCHES).map(w=>({title:w.title,interval:w.interval,priceChanges:w.priceChanges})),...s};if(!html)return json(p);return new Response(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>DVC Monitor</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;max-width:900px;margin:30px auto;padding:0 16px"><h1>DVC Monitor</h1><p>Rental Store priority watches: every minute. Other watches: every 10 minutes.</p><pre style="white-space:pre-wrap;background:#f5f5f5;padding:16px">${esc(JSON.stringify(p,null,2))}</pre></body></html>`,{headers:{"content-type":"text/html;charset=utf-8"}});}
function auth(req,token){return !!token&&(req.headers.get("authorization")||"")===`Bearer ${token}`;}
function json(v,status=200){return new Response(JSON.stringify(v,null,2),{status,headers:{"content-type":"application/json;charset=utf-8"}});}
function esc(v){return String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}
function msg(e){return e instanceof Error?e.message:String(e);}
