import fs from "node:fs/promises";
import crypto from "node:crypto";

const UNITY_BASE = "https://unity.nfhsnetwork.com";
const EVENT_ID = process.env.TARGET_EVENT_ID || "gam015745122d";
const START_SLOT = Number(process.env.START_SLOT || 3500);
const END_SLOT = Number(process.env.END_SLOT || 3650);
const CONTROL_SLOTS = String(process.env.CONTROL_SLOTS || "464")
  .split(",").map(x => Number(x.trim())).filter(Number.isFinite);
const SAMPLE_BYTES = Number(process.env.SAMPLE_BYTES || 262144);
const OFFICIAL_REFRESH_EVERY = Number(process.env.OFFICIAL_REFRESH_EVERY || 5);

function cleanSpace(s="") { return String(s).replace(/\s+/g," ").trim(); }
function sha20(v) {
  if (v === null || v === undefined) return null;
  return crypto.createHash("sha256").update(v).digest("hex").slice(0,20);
}
async function fetchText(url, timeoutMs=15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "Georgia-NFHS-Live-Fingerprint/1.0" }});
    const txt = await r.text();
    if (!r.ok) throw new Error("HTTP_"+r.status);
    return txt;
  } finally { clearTimeout(t); }
}
async function fetchJson(url, timeoutMs=15000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}
async function fetchMaybeJson(url, timeoutMs=15000) {
  const txt = await fetchText(url, timeoutMs);
  try { return JSON.parse(txt); } catch { return txt; }
}
async function fetchLimitedBytes(url, maxBytes=SAMPLE_BYTES, timeoutMs=5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ac.signal,
      headers: { "User-Agent": "Georgia-NFHS-Live-Fingerprint/1.0" }
    });
    if (!r.ok || !r.body) return { ok:false, status:r.status, bytes:null };
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const need = Math.min(value.length, maxBytes-total);
      chunks.push(Buffer.from(value.subarray(0, need)));
      total += need;
    }
    try { await reader.cancel(); } catch {}
    return { ok: total > 0, status:r.status, bytes:Buffer.concat(chunks, total), content_type:r.headers.get("content-type")||null };
  } catch {
    return { ok:false, status:null, bytes:null };
  } finally { clearTimeout(t); }
}
function extractUrls(value, out=[]) {
  if (typeof value === "string") {
    const m = value.match(/https?:\/\/[^"'\s]+/g);
    if (m) out.push(...m);
  } else if (Array.isArray(value)) {
    for (const v of value) extractUrls(v,out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) extractUrls(v,out);
  }
  return out;
}
function resolveUrl(base, rel) {
  try { return new URL(rel, base).toString(); } catch { return null; }
}
async function resolveOfficialMediaUrl(eventId) {
  const event = await fetchJson(`${UNITY_BASE}/v2/game_or_event/${encodeURIComponent(eventId)}`, 20000);
  const pubs = Array.isArray(event?.publishers) ? event.publishers : [];
  const pairs = pubs.flatMap(pub => (Array.isArray(pub?.broadcasts)?pub.broadcasts:[]).map(b=>({pub,b})));
  const livePair = pairs.find(x => x.b?.is_live || /live/i.test(String(x.b?.status||""))) || pairs[0];
  if (!livePair?.b?.key) return { ok:false, reason:"no_broadcast_key" };
  let playback;
  try {
    playback = await fetchMaybeJson(`${UNITY_BASE}/v2/broadcasts/${encodeURIComponent(livePair.b.key)}/url`, 20000);
  } catch {
    return { ok:false, reason:"playback_unavailable" };
  }
  const urls = extractUrls(playback);
  const u = urls.find(x=>/\.m3u8(?:\?|$)/i.test(x)) || urls[0] || (typeof playback==="string" && /^https?:\/\//i.test(playback.trim()) ? playback.trim() : null);
  if (!u) return { ok:false, reason:"no_public_media_url" };
  return {
    ok:true,
    media_url:u,
    broadcast_key_hash:sha20(String(livePair.b.key)),
    status:livePair.b?.status||null,
    is_live:Boolean(livePair.b?.is_live)
  };
}
function parseMaster(text, base) {
  const lines=text.split(/\r?\n/);
  const vars=[];
  for(let i=0;i<lines.length;i++){
    if(!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const bw=Number((lines[i].match(/BANDWIDTH=(\d+)/)||[])[1]||0);
    let j=i+1; while(j<lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
    if(j<lines.length){
      const url=resolveUrl(base,lines[j].trim());
      if(url) vars.push({bw,url});
    }
  }
  return vars.sort((a,b)=>b.bw-a.bw);
}
async function getOfficialSample(eventId) {
  const routing = await resolveOfficialMediaUrl(eventId);
  if (!routing.ok) return { ok:false, reason:routing.reason };
  let mediaUrl=routing.media_url;
  let pl;
  try { pl=await fetchText(mediaUrl,12000); } catch { return {ok:false,reason:"playlist_fetch_failed"}; }
  if (pl.includes("#EXT-X-STREAM-INF")) {
    const vars=parseMaster(pl,mediaUrl);
    if(!vars.length) return {ok:false,reason:"master_without_variant"};
    mediaUrl=vars[0].url;
    try { pl=await fetchText(mediaUrl,12000); } catch { return {ok:false,reason:"variant_fetch_failed"}; }
  }
  const segs=pl.split(/\r?\n/).map(x=>x.trim()).filter(x=>x && !x.startsWith("#")).slice(-3);
  if(!segs.length) return {ok:false,reason:"no_media_segments"};
  const bufs=[];
  for(const seg of segs){
    const u=resolveUrl(mediaUrl,seg);
    if(!u) continue;
    const got=await fetchLimitedBytes(u,524288,10000);
    if(got.ok && got.bytes?.length) bufs.push(got.bytes);
  }
  if(!bufs.length) return {ok:false,reason:"segment_fetch_failed"};
  const bytes=Buffer.concat(bufs);
  return {
    ok:true,
    bytes,
    broadcast_key_hash:routing.broadcast_key_hash,
    status:routing.status,
    is_live:routing.is_live,
    byte_count:bytes.length
  };
}
function tsPacketHashes(buf) {
  if (!buf || buf.length < 188*5) return {is_ts:false, hashes:new Set(), packet_count:0};
  let offset=-1;
  for(let o=0;o<188;o++){
    let good=0;
    for(let k=0;k<5;k++) if(o+k*188<buf.length && buf[o+k*188]===0x47) good++;
    if(good>=4){offset=o;break;}
  }
  if(offset<0) return {is_ts:false, hashes:new Set(), packet_count:0};
  const hashes=new Set();
  let count=0;
  for(let p=offset;p+188<=buf.length;p+=188){
    if(buf[p]!==0x47) continue;
    const pid=((buf[p+1]&0x1f)<<8)|buf[p+2];
    if(pid===0x1fff || pid===0x0000) continue;
    const pkt=Buffer.from(buf.subarray(p,p+188));
    pkt[3]=pkt[3]&0xF0; // mask continuity counter
    hashes.add(sha20(pkt));
    count++;
  }
  return {is_ts:true, hashes, packet_count:count};
}
function overlap(a,b){
  if(!a.size || !b.size) return {intersection:0,coverage:0,jaccard:0};
  let inter=0;
  for(const x of a) if(b.has(x)) inter++;
  const cov=inter/Math.min(a.size,b.size);
  const jac=inter/(a.size+b.size-inter);
  return {intersection:inter,coverage:Number(cov.toFixed(6)),jaccard:Number(jac.toFixed(6))};
}
async function getProvider() {
  const base=cleanSpace(process.env.XTREAM_BASE_URL||"").replace(/\/+$/,"");
  const username=process.env.XTREAM_USERNAME||"";
  const password=process.env.XTREAM_PASSWORD||"";
  if(!base||!username||!password) throw new Error("Missing provider credentials.");
  const auth=`username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const cats=await fetchJson(`${base}/player_api.php?${auth}&action=get_live_categories`);
  let cat=cats.find(c=>/nfhs/i.test(String(c.category_name||"")));
  if(!cat) throw new Error("NFHS category not found.");
  const rows=await fetchJson(`${base}/player_api.php?${auth}&action=get_live_streams&category_id=${encodeURIComponent(cat.category_id)}`);
  const streams=(Array.isArray(rows)?rows:[]).map(s=>{
    const m=String(s.name||"").match(/^NFHS\s+Network\s+(\d+)/i);
    return m?{slot:Number(m[1]),stream_id:Number(s.stream_id),title:String(s.name||"")}:null;
  }).filter(Boolean);
  return {base,username,password,streams};
}
async function main(){
  const provider=await getProvider();
  const bySlot=new Map(provider.streams.map(s=>[s.slot,s]));
  const slots=[...new Set([...CONTROL_SLOTS,...Array.from({length:Math.max(0,END_SLOT-START_SLOT+1)},(_,i)=>START_SLOT+i)])]
    .filter(x=>bySlot.has(x)).sort((a,b)=>a-b);

  console.log(`Live fingerprint diagnostic for ${EVENT_ID}: probing ${slots.length} provider slots sequentially.`);
  console.log("No raw provider or NFHS media URLs will be written.");

  let official=null, officialFp=null;
  const results=[];
  let officialRefreshes=0;

  for(let i=0;i<slots.length;i++){
    if(!official || i%OFFICIAL_REFRESH_EVERY===0){
      official=await getOfficialSample(EVENT_ID);
      officialRefreshes++;
      if(official.ok) officialFp=tsPacketHashes(official.bytes);
      else officialFp=null;
    }

    const slot=slots[i], row=bySlot.get(slot);
    const target=`${provider.base}/live/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${row.stream_id}.ts`;
    const got=await fetchLimitedBytes(target,SAMPLE_BYTES,5000);
    const pfp=got.ok?tsPacketHashes(got.bytes):{is_ts:false,hashes:new Set(),packet_count:0};
    const cmp=officialFp?.is_ts && pfp.is_ts ? overlap(officialFp.hashes,pfp.hashes) : {intersection:0,coverage:0,jaccard:0};
    results.push({
      slot,
      stream_id:row.stream_id,
      provider_title:row.title,
      provider_http_ok:Boolean(got.ok),
      provider_status:got.status,
      provider_bytes:got.bytes?.length||0,
      provider_is_ts:pfp.is_ts,
      provider_ts_packets:pfp.packet_count,
      official_sample_ok:Boolean(official?.ok),
      official_is_ts:Boolean(officialFp?.is_ts),
      packet_hash_intersection:cmp.intersection,
      packet_hash_coverage:cmp.coverage,
      packet_hash_jaccard:cmp.jaccard
    });
    if((i+1)%20===0) console.log(`Probed ${i+1}/${slots.length}`);
  }

  const ranked=[...results].sort((a,b)=>
    b.packet_hash_coverage-a.packet_hash_coverage ||
    b.packet_hash_intersection-a.packet_hash_intersection ||
    a.slot-b.slot
  );

  const payload={
    generated_at:new Date().toISOString(),
    diagnostic_only:true,
    modifies_epg:false,
    target_event_id:EVENT_ID,
    scan:{start_slot:START_SLOT,end_slot:END_SLOT,control_slots:CONTROL_SLOTS,slots_probed:slots.length,provider_connections_sequential:true},
    official:{refreshes:officialRefreshes,last_sample_ok:Boolean(official?.ok),last_reason:official?.ok?null:official?.reason||"unknown",broadcast_key_hash:official?.broadcast_key_hash||null,status:official?.status||null,is_live:official?.is_live??null,last_sample_is_ts:Boolean(officialFp?.is_ts),last_sample_packets:officialFp?.packet_count||0},
    best_matches:ranked.slice(0,20),
    positive_overlap_matches:ranked.filter(x=>x.packet_hash_intersection>0).slice(0,50),
    totals:{
      provider_http_ok:results.filter(x=>x.provider_http_ok).length,
      provider_ts_ok:results.filter(x=>x.provider_is_ts).length,
      positive_overlap:results.filter(x=>x.packet_hash_intersection>0).length
    }
  };
  await fs.mkdir("public",{recursive:true});
  await fs.writeFile("public/nfhs-live-fingerprint.json",JSON.stringify(payload,null,2)+"\n","utf8");
  console.log(JSON.stringify({official:payload.official,totals:payload.totals,best_matches:payload.best_matches.slice(0,5).map(x=>({slot:x.slot,intersection:x.packet_hash_intersection,coverage:x.packet_hash_coverage,http_ok:x.provider_http_ok}))},null,2));
  console.log("public/events.json was NOT modified.");
}
main().catch(err=>{ console.error(String(err?.message||err).slice(0,300)); process.exit(1); });
