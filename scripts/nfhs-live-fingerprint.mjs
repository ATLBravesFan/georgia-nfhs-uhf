import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const UNITY_BASE = "https://unity.nfhsnetwork.com";
const EVENT_ID = process.env.TARGET_EVENT_ID || "gam0afdf9a583";
const START_SLOT = Number(process.env.START_SLOT || 3353);
const END_SLOT = Number(process.env.END_SLOT || 3405);
const SAMPLE_BYTES = Number(process.env.SAMPLE_BYTES || 196608);
const SLOT_LIST = String(process.env.SLOT_LIST || "").trim();
const FAST_SWEEP = String(process.env.FAST_SWEEP || "").toLowerCase() === "true";

function cleanSpace(s="") { return String(s).replace(/\s+/g," ").trim(); }
function sha20(v) {
  if (v === null || v === undefined || v === "") return null;
  return crypto.createHash("sha256").update(String(v)).digest("hex").slice(0,20);
}
async function fetchText(url, timeoutMs=15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "User-Agent":"Georgia-NFHS-Live-Provider-Probe/2.0" }});
    const txt = await r.text();
    if (!r.ok) throw new Error("HTTP_"+r.status);
    return txt;
  } finally { clearTimeout(t); }
}
async function fetchJson(url, timeoutMs=15000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}
async function fetchLimitedBytes(url, maxBytes=SAMPLE_BYTES, timeoutMs=3500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(url, {
      redirect:"follow",
      signal:ac.signal,
      headers:{ "User-Agent":"Georgia-NFHS-Live-Provider-Probe/2.0" }
    });
    if (!r.ok || !r.body) return {ok:false,status:r.status,bytes:null,latency_ms:Date.now()-started,content_type:r.headers.get("content-type")||null};
    const reader=r.body.getReader();
    const chunks=[]; let total=0;
    while(total<maxBytes){
      const {value,done}=await reader.read();
      if(done) break;
      if(!value?.length) continue;
      const need=Math.min(value.length,maxBytes-total);
      chunks.push(Buffer.from(value.subarray(0,need))); total+=need;
    }
    try { await reader.cancel(); } catch {}
    return {ok:total>0,status:r.status,bytes:Buffer.concat(chunks,total),latency_ms:Date.now()-started,content_type:r.headers.get("content-type")||null};
  } catch {
    return {ok:false,status:null,bytes:null,latency_ms:Date.now()-started,content_type:null};
  } finally { clearTimeout(t); }
}
function safeTag(v){
  const s=cleanSpace(v||"");
  if(!s) return null;
  if(/https?:\/\/|[?&](?:token|auth|key|sig|signature)=/i.test(s)) return {hash:sha20(s),redacted:true};
  return s.slice(0,160);
}
function findTsOffset(buf){
  if(!buf||buf.length<188*4) return -1;
  for(let o=0;o<188;o++){
    let good=0;
    for(let k=0;k<4;k++) if(o+k*188<buf.length && buf[o+k*188]===0x47) good++;
    if(good>=4) return o;
  }
  return -1;
}
function tsSummary(buf){
  const off=findTsOffset(buf);
  if(off<0) return {is_ts:false,packet_count:0,pids:[]};
  const counts=new Map(); let packets=0;
  for(let p=off;p+188<=buf.length;p+=188){
    if(buf[p]!==0x47) continue;
    const pid=((buf[p+1]&0x1f)<<8)|buf[p+2];
    counts.set(pid,(counts.get(pid)||0)+1); packets++;
  }
  const pids=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,16).map(([pid,count])=>({pid,count}));
  return {is_ts:true,packet_count:packets,pids,pid_set_hash:sha20([...counts.keys()].sort((a,b)=>a-b).join(","))};
}
async function ffprobeSummary(buf, slot){
  if(!buf?.length) return null;
  const tmp=path.join(os.tmpdir(),`nfhs-${process.pid}-${slot}.ts`);
  try{
    await fs.writeFile(tmp,buf);
    const {stdout}=await execFileP("ffprobe",[
      "-v","error","-show_programs","-show_streams","-print_format","json",tmp
    ],{timeout:7000,maxBuffer:2_000_000});
    const j=JSON.parse(stdout||"{}");
    const programs=(Array.isArray(j.programs)?j.programs:[]).map(p=>({
      program_id:p.program_id??p.program_num??null,
      program_num:p.program_num??null,
      service_name:safeTag(p.tags?.service_name),
      service_provider:safeTag(p.tags?.service_provider)
    }));
    const streams=(Array.isArray(j.streams)?j.streams:[]).map(s=>({
      codec_type:s.codec_type||null,
      codec_name:s.codec_name||null,
      profile:s.profile||null,
      width:s.width??null,
      height:s.height??null,
      r_frame_rate:s.r_frame_rate||null,
      sample_rate:s.sample_rate||null,
      channels:s.channels??null,
      channel_layout:s.channel_layout||null,
      language:safeTag(s.tags?.language)
    }));
    return {programs,streams,signature_hash:sha20(JSON.stringify({programs,streams}))};
  }catch{
    return null;
  }finally{
    try{await fs.unlink(tmp);}catch{}
  }
}
function ingestFingerprint(v){
  if(!v) return null;
  try{
    const u=new URL(String(v));
    return sha20([u.hostname,u.pathname.split("/").filter(Boolean).slice(0,3).join("/")].join("|"));
  }catch{return sha20(v);}
}
async function getOfficialMetadata(eventId){
  try{
    const event=await fetchJson(`${UNITY_BASE}/v2/game_or_event/${encodeURIComponent(eventId)}`,20000);
    const pubs=Array.isArray(event?.publishers)?event.publishers:[];
    const pairs=pubs.flatMap(pub=>(Array.isArray(pub?.broadcasts)?pub.broadcasts:[]).map(b=>({pub,b})));
    const pair=pairs.find(x=>x.b?.is_live)||pairs[0]||null;
    return {
      ok:true,
      event_key:eventId,
      event_title:event?.title||null,
      local_start_time:event?.local_start_time||event?.start_time||null,
      sport:event?.sport||null,
      publisher_slug:pair?.pub?.slug||null,
      association:pair?.pub?.state_association_acronym||null,
      subheadline:pair?.b?.subheadline||null,
      broadcast_status:pair?.b?.status||null,
      broadcast_is_live:Boolean(pair?.b?.is_live),
      publisher_key_hash:sha20(pair?.pub?.key||pair?.pub?.publisher_key),
      producer_key_hash:sha20(pair?.b?.producer_key),
      ingest_fingerprint:ingestFingerprint(pair?.b?.ingest_point)
    };
  }catch(err){
    return {ok:false,event_key:eventId,error:String(err?.message||err).slice(0,200)};
  }
}
async function getProvider(){
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
    return m?{slot:Number(m[1]),stream_id:Number(s.stream_id),title:cleanSpace(s.name||""),container_extension:cleanSpace(s.container_extension||"ts").replace(/^\\./,"")||"ts"}:null;
  }).filter(Boolean);
  return {base,username,password,streams};
}

function runProcess(command,args,timeoutMs=5000){
  return new Promise(resolve=>{
    let settled=false;
    const stdout=[];
    const stderr=[];
    const child=spawn(command,args,{stdio:["ignore","pipe","pipe"]});
    const finish=v=>{if(settled)return; settled=true; resolve(v);};
    const timer=setTimeout(()=>{try{child.kill("SIGKILL");}catch{}},timeoutMs);
    child.stdout.on("data",b=>stdout.push(b));
    child.stderr.on("data",b=>stderr.push(b));
    child.on("error",err=>{clearTimeout(timer);finish({code:null,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr).toString(),error:String(err?.message||err)});});
    child.on("close",code=>{clearTimeout(timer);finish({code,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr).toString()});});
  });
}

async function curlIpv4QuickSample(url){
  const started=Date.now();
  const r=await runProcess("curl",[
    "-4","-L",
    "--connect-timeout","1",
    "--max-time","1",
    "--silent","--show-error",
    "--user-agent","Mozilla/5.0 Georgia-NFHS-Sweep/1.0",
    "--range","0-3760",
    url
  ],1800);
  const bytes=r.stdout||Buffer.alloc(0);
  return {
    ok:bytes.length>0,
    status:null,
    latency_ms:Date.now()-started,
    bytes,
    content_type:null,
    curl_exit_code:r.code,
    error:r.stderr||r.error||null
  };
}

async function main(){
  const official=await getOfficialMetadata(EVENT_ID);
  const provider=await getProvider();
  const bySlot=new Map(provider.streams.map(s=>[s.slot,s]));
  const explicitSlots = SLOT_LIST
    ? [...new Set(SLOT_LIST.split(",").map(x=>Number(x.trim())).filter(Number.isFinite))].sort((a,b)=>a-b)
    : [];
  const slots=(FAST_SWEEP
    ? Array.from({length:5000},(_,i)=>i+1)
    : explicitSlots.length
      ? explicitSlots
      : Array.from({length:Math.max(0,END_SLOT-START_SLOT+1)},(_,i)=>START_SLOT+i)
  ).filter(x=>bySlot.has(x));

  console.log(`Provider-only live probe for ${EVENT_ID}: ${FAST_SWEEP ? "full NFHS activity sweep 1-5000" : explicitSlots.length ? "explicit candidate slots" : `slots ${START_SLOT}-${END_SLOT}`} (${slots.length} total), ${FAST_SWEEP ? "3-way IPv4 curl probe" : "sequential probe"}.`);
  console.log("Official NFHS video is NOT accessed. Only public event metadata and the user's authorized provider streams are used.");

  const results=[];
  let nextIndex=0;
  let completed=0;
  const CONCURRENCY=FAST_SWEEP?3:1;

  async function probeOne(slot){
    const row=bySlot.get(slot);
    const ext=row.container_extension||"ts";
    const target=`${provider.base}/live/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${row.stream_id}.${ext}`;
    const got=FAST_SWEEP ? await curlIpv4QuickSample(target) : await fetchLimitedBytes(target,SAMPLE_BYTES,1500);
    const ts=got.ok?tsSummary(got.bytes):{is_ts:false,packet_count:0,pids:[]};
    const probe=(got.ok && !FAST_SWEEP)?await ffprobeSummary(got.bytes,slot):null;
    return {
      slot,
      stream_id:row.stream_id,
      provider_title:row.title,
      container_extension:row.container_extension,
      active:Boolean(got.ok&&got.bytes?.length),
      http_status:got.status,
      latency_ms:got.latency_ms,
      bytes:got.bytes?.length||0,
      content_type:got.content_type,
      ts,
      ffprobe:probe
    };
  }

  async function worker(){
    while(true){
      const i=nextIndex++;
      if(i>=slots.length) return;
      const result=await probeOne(slots[i]);
      results.push(result);
      completed++;
      const step=FAST_SWEEP?250:10;
      if(completed%step===0) console.log(`Probed ${completed}/${slots.length}`);
    }
  }

  await Promise.all(Array.from({length:CONCURRENCY},()=>worker()));
  results.sort((a,b)=>a.slot-b.slot);

  const active=results.filter(x=>x.active).sort((a,b)=>a.slot-b.slot);
  const payload={
    generated_at:new Date().toISOString(),
    diagnostic_only:true,
    modifies_epg:false,
    safety:{
      official_video_accessed:false,
      provider_connections_sequential:true,
      raw_provider_urls_saved:false,
      credentials_saved:false
    },
    target_official_event:official,
    scan:{transport:FAST_SWEEP?"curl_ipv4_1s":"node_fetch",mode:FAST_SWEEP?"full_activity_sweep":explicitSlots.length?"explicit_slots":"range",start_slot:(FAST_SWEEP||explicitSlots.length)?null:START_SLOT,end_slot:(FAST_SWEEP||explicitSlots.length)?null:END_SLOT,explicit_slots:explicitSlots.length?slots:null,slots_probed:slots.length},
    totals:{active_slots:active.length,inactive_slots:results.length-active.length,ts_slots:active.filter(x=>x.ts?.is_ts).length},
    active_slots:active,
    all_results:FAST_SWEEP?active:results
  };

  await fs.mkdir("public",{recursive:true});
  await fs.writeFile("public/nfhs-live-fingerprint.json",JSON.stringify(payload,null,2)+"\n","utf8");
  console.log(JSON.stringify({
    target:official,
    totals:payload.totals,
    active_slots:active.map(x=>({slot:x.slot,latency_ms:x.latency_ms,signature:x.ffprobe?.signature_hash||x.ts?.pid_set_hash||null,title:x.provider_title})).slice(0,80)
  },null,2));
  console.log("public/events.json was NOT modified.");
}
main().catch(err=>{console.error(String(err?.message||err).slice(0,300));process.exit(1);});
