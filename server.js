"use strict";
const http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const {URL}=require("node:url");
const {DatabaseSync}=require("node:sqlite");
const crypto=require("node:crypto");

const PORT=Number(process.env.PORT||8787),HOST=process.env.HOST||"0.0.0.0",BASE=__dirname;
const DATA_DIR=process.env.DATA_DIR||BASE;
if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true});
const DB_PATH=process.env.DB_PATH||path.join(DATA_DIR,"combo_tracker.sqlite");
const APP_USER=process.env.APP_USER||"admin";
const APP_PASSWORD=process.env.APP_PASSWORD||"change-me";
const SESSION_SECRET=process.env.SESSION_SECRET||"local-dev-secret-change-me";
const SESSION_TTL_MS=7*24*60*60*1000;
const GAMMA="https://gamma-api.polymarket.com",DATA="https://data-api.polymarket.com";
const RPCS=["https://polygon-bor-rpc.publicnode.com","https://polygon-rpc.com","https://rpc.ankr.com/polygon"];
const CONTRACTS=[
"0x006F54F7f9A22e0000CC2AB60031000000ae9fEF","0x1000008dD9001B968442c1000017eaE6E0dA00Ba",
"0x200000900045e3B6259600682756002200028933","0x30000034706C7d8e12009DAB006Be20000c031A8",
"0xe3333700cA9d93003F00f0F71f8515005F6c00Aa","0xa1200000d0002264C9a1698e001292D00E1b00af"].map(x=>x.toLowerCase());
const IGNORE=new Set([...CONTRACTS,"0x0000000000000000000000000000000000000000"]);
const LOG_CHUNK=3500,TOPIC_FALLBACK_MIN=25,TX_FALLBACK_MAX=3000;
const TRACK_ACTIVITY_CONCURRENCY=14,TRACK_POSITION_CONCURRENCY=14,DASHBOARD_ACTIVITY_CONCURRENCY=14,DASHBOARD_POSITION_CONCURRENCY=14;
const MAX_COMBO_PAGES_PER_WALLET=100;
const MAX_INITIAL_SCAN_DAYS=30;
const PRE_EVENT_MARGIN_HOURS=4;

// Dashboard automático: 10 minutos.
const DASHBOARD_AUTO_MS=10*60*1000;
let dashboardRunning=false;
let autoTimer=null;
let autoState={
  enabled:true,
  intervalMs:DASHBOARD_AUTO_MS,
  running:false,
  lastStarted:null,
  lastFinished:null,
  nextRun:null,
  lastError:null,
  lastNewCombos:0,
  lastNewWallets:0,
  lastRows:0,
  phase:"idle",
  message:"A aguardar próxima atualização"
};

const db=new DatabaseSync(DB_PATH);db.exec(`PRAGMA journal_mode=DELETE;PRAGMA synchronous=NORMAL;PRAGMA temp_store=MEMORY;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wallets(wallet TEXT PRIMARY KEY,first_seen_utc TEXT,last_seen_utc TEXT);
CREATE TABLE IF NOT EXISTS combo_positions(wallet TEXT,combo_id TEXT,position_id TEXT,entry_cost REAL DEFAULT 0,total_cost REAL DEFAULT 0,current_value REAL DEFAULT 0,shares REAL DEFAULT 0,status TEXT,first_entry_at TEXT,resolved_at TEXT,updated_at TEXT,fetched_at TEXT,PRIMARY KEY(wallet,combo_id,position_id));
CREATE TABLE IF NOT EXISTS combo_legs(combo_id TEXT,leg_index INTEGER,condition_id TEXT,event_slug TEXT,event_title TEXT,market_slug TEXT,market_title TEXT,outcome TEXT,PRIMARY KEY(combo_id,leg_index,condition_id));
CREATE TABLE IF NOT EXISTS combo_activity(wallet TEXT,combo_id TEXT,position_id TEXT,tx_hash TEXT,log_index TEXT,event_kind TEXT,module_kind TEXT,amount_usdc REAL DEFAULT 0,payout_usdc REAL DEFAULT 0,tx_dttm TEXT,fetched_at TEXT,PRIMARY KEY(wallet,combo_id,tx_hash,log_index,event_kind));
CREATE TABLE IF NOT EXISTS tracked_games(slug TEXT PRIMARY KEY,event_id TEXT,title TEXT,start_time TEXT,last_scanned_block INTEGER DEFAULT 0,last_run_utc TEXT);
CREATE TABLE IF NOT EXISTS tracked_markets(slug TEXT,condition_id TEXT,market_slug TEXT,market_title TEXT,PRIMARY KEY(slug,condition_id));
CREATE TABLE IF NOT EXISTS tracked_candidates(slug TEXT,wallet TEXT,PRIMARY KEY(slug,wallet));
CREATE TABLE IF NOT EXISTS tracked_matches(slug TEXT,wallet TEXT,PRIMARY KEY(slug,wallet));
CREATE TABLE IF NOT EXISTS tracked_combo_seen(slug TEXT,combo_id TEXT,first_seen_utc TEXT,PRIMARY KEY(slug,combo_id));
CREATE TABLE IF NOT EXISTS active_games(game_key TEXT PRIMARY KEY,event_id TEXT,event_slug TEXT,title TEXT,start_time TEXT,refreshed_at TEXT);
CREATE TABLE IF NOT EXISTS active_game_markets(game_key TEXT,condition_id TEXT,market_slug TEXT,market_title TEXT,PRIMARY KEY(game_key,condition_id));
CREATE TABLE IF NOT EXISTS dashboard_match_wallets(wallet TEXT PRIMARY KEY,last_match_utc TEXT);
CREATE INDEX IF NOT EXISTS idx_legs_condition ON combo_legs(condition_id);CREATE INDEX IF NOT EXISTS idx_pos_combo ON combo_positions(combo_id);CREATE INDEX IF NOT EXISTS idx_act_combo ON combo_activity(combo_id);`);
const q={
 getMeta:db.prepare("SELECT value FROM meta WHERE key=?"),setMeta:db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
 wallet:db.prepare("INSERT INTO wallets(wallet,first_seen_utc,last_seen_utc) VALUES(?,?,?) ON CONFLICT(wallet) DO UPDATE SET last_seen_utc=excluded.last_seen_utc"),
 pos:db.prepare(`INSERT INTO combo_positions(wallet,combo_id,position_id,entry_cost,total_cost,current_value,shares,status,first_entry_at,resolved_at,updated_at,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(wallet,combo_id,position_id) DO UPDATE SET entry_cost=excluded.entry_cost,total_cost=excluded.total_cost,current_value=excluded.current_value,shares=excluded.shares,status=excluded.status,first_entry_at=excluded.first_entry_at,resolved_at=excluded.resolved_at,updated_at=excluded.updated_at,fetched_at=excluded.fetched_at`),
 leg:db.prepare(`INSERT INTO combo_legs(combo_id,leg_index,condition_id,event_slug,event_title,market_slug,market_title,outcome) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(combo_id,leg_index,condition_id) DO UPDATE SET event_slug=excluded.event_slug,event_title=excluded.event_title,market_slug=excluded.market_slug,market_title=excluded.market_title,outcome=excluded.outcome`),
 act:db.prepare(`INSERT INTO combo_activity(wallet,combo_id,position_id,tx_hash,log_index,event_kind,module_kind,amount_usdc,payout_usdc,tx_dttm,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(wallet,combo_id,tx_hash,log_index,event_kind) DO UPDATE SET position_id=excluded.position_id,module_kind=excluded.module_kind,amount_usdc=excluded.amount_usdc,payout_usdc=excluded.payout_usdc,tx_dttm=excluded.tx_dttm,fetched_at=excluded.fetched_at`)
};
const progress=new Map();let rpcIdx=0;
const now=()=>new Date().toISOString(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),num=v=>Number.isFinite(Number(v))?Number(v):0;

async function withTimeout(promise,ms,label="operation"){
  let timer;
  try{
    return await Promise.race([
      promise,
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timeout after ${ms}ms`)),ms)})
    ]);
  }finally{
    clearTimeout(timer);
  }
}

function setP(id,x){
  const row={...x,updated:now()};
  progress.set(id,row);
  if(String(id).startsWith("auto_")){
    if(x.message)autoState.message=x.message;
    if(x.phase)autoState.phase=x.phase;
    if(x.status==="running")autoState.running=true;
    if(x.status==="done"){autoState.running=false;autoState.phase="done";autoState.message=x.message||"Concluído";}
    if(x.status==="error"){autoState.running=false;autoState.phase="error";autoState.message=x.message||"Erro";}
  }
}function slugOf(x){x=String(x||"").trim();if(/^https?:\/\//i.test(x)){const u=new URL(x);return u.pathname.replace(/\/+$/,"").split("/").pop()}return x.replace(/\/+$/,"").split("/").pop()}
async function fetchJ(url,opt={},retries=4){let last;for(let i=0;i<retries;i++){try{const c=new AbortController(),t=setTimeout(()=>c.abort(),opt.timeout||15000);const r=await fetch(url,{...opt,signal:c.signal,headers:{Accept:"application/json",...(opt.headers||{})}});clearTimeout(t);if(r.status===429||r.status>=500){await sleep(Math.min(500*2**i,5000));continue}if(!r.ok)throw Error(`${r.status} ${r.statusText}`);return await r.json()}catch(e){last=e;await sleep(Math.min(400*2**i,4000))}}throw last||Error("request failed")}
async function rpc(method,params){let last;for(let a=0;a<5;a++){for(let j=0;j<RPCS.length;j++){const idx=(rpcIdx+j)%RPCS.length;try{const d=await fetchJ(RPCS[idx],{method:"POST",timeout:15000,headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})},1);if(d.error)throw Error(JSON.stringify(d.error));rpcIdx=idx;return d.result}catch(e){last=e}}await sleep(500*(a+1))}throw last}
async function latest(){return parseInt(await rpc("eth_blockNumber",[]),16)}async function blockTs(n){const b=await rpc("eth_getBlockByNumber",["0x"+n.toString(16),false]);return parseInt(b.timestamp,16)}async function findBlock(ts,hi){let lo=1;while(lo<hi){const m=Math.floor((lo+hi)/2);if(await blockTs(m)<ts)lo=m+1;else hi=m}return lo}
function topicAddr(t){if(typeof t!=="string"||!/^0x[a-fA-F0-9]{64}$/.test(t))return null;const r=t.slice(2).toLowerCase();if(r.slice(0,24)!=="0".repeat(24))return null;const a="0x"+r.slice(-40);return /^0x[a-f0-9]{40}$/.test(a)&&!IGNORE.has(a)?a:null}
async function scanLogs(lo,hi,cb){if(lo>hi)return{wallets:[],txs:[],logs:0};const ranges=[];for(let s=lo;s<=hi;s+=LOG_CHUNK)ranges.push([s,Math.min(s+LOG_CHUNK-1,hi)]);const ws=new Set(),txs=new Set();let logs=0,done=0;const queue=[...ranges];async function worker(){while(queue.length){const [s,e]=queue.shift();try{const rows=await rpc("eth_getLogs",[{fromBlock:"0x"+s.toString(16),toBlock:"0x"+e.toString(16),address:CONTRACTS}])||[];logs+=rows.length;for(const row of rows){if(row.transactionHash)txs.add(String(row.transactionHash).toLowerCase());for(const t of (row.topics||[]).slice(1)){const a=topicAddr(t);if(a)ws.add(a)}}}catch{}done++;cb&&cb({done,total:ranges.length,wallets:ws.size,logs})}}await Promise.all(Array.from({length:Math.min(5,ranges.length||1)},worker));return{wallets:[...ws],txs:[...txs],logs}}
async function txSender(h){try{const t=await rpc("eth_getTransactionByHash",[h]),a=String(t?.from||"").toLowerCase();return /^0x[a-f0-9]{40}$/.test(a)&&!IGNORE.has(a)?a:null}catch{return null}}
async function txFallback(txs,cb){const list=[...txs].sort().slice(0,TX_FALLBACK_MAX),out=new Set();let done=0;await mapPool(list,8,async h=>{const a=await txSender(h);if(a)out.add(a);done++;cb&&cb(done,list.length,out.size);return a});return[...out]}
async function comboPages(kind,w,onPage){
  let c=null,pages=0,total=0;
  const limit=kind==="positions"?"250":"250";
  do{
    const u=new URL(`${DATA}/v1/${kind}/combos`);
    u.searchParams.set("user",w);
    u.searchParams.set("limit",limit);
    if(kind==="positions")u.searchParams.set("sort","first_entry_desc");
    if(c)u.searchParams.set("cursor",c);
    let d;
    try{d=await fetchJ(u.toString(),{timeout:12000},3)}catch{break}
    const rows=kind==="positions"?(d.combos||[]):(d.activity||[]);
    total+=rows.length;
    await onPage(rows);
    pages++;
    c=(d.pagination||{}).has_more?(d.pagination||{}).next_cursor:null;
    if(pages>=MAX_COMBO_PAGES_PER_WALLET)break;
    await new Promise(r=>setImmediate(r));
  }while(c);
  return total;
}
async function positions(w){
  const out=[];
  await comboPages("positions",w,rows=>{out.push(...rows)});
  return out;
}
async function activity(w){
  const out=[];
  await comboPages("activity",w,rows=>{out.push(...rows)});
  return out;
}
function legCid(l){return String(l.leg_condition_id||"").toLowerCase()}function legLabel(l){const m=l.market||{},e=m.event||{};return{condition_id:legCid(l),event_slug:String(e.event_slug||""),event_title:String(e.event_title||""),market_slug:String(m.slug||""),market_title:String(m.title||""),outcome:String(l.leg_outcome_label||m.outcome||"")}}
function saveLegs(cid,legs){let i=0;for(const l of legs||[]){i++;const x=legLabel(l);if(!x.condition_id)continue;q.leg.run(cid,Number(l.leg_index||i),x.condition_id,x.event_slug,x.event_title,x.market_slug,x.market_title,x.outcome)}}
function comboMatch(c,target){return(c.legs||[]).some(l=>target.has(legCid(l)))}
async function refreshActivityWallet(w,target,slug){
  let matches=0;
  await comboPages("activity",w,async rows=>{
    for(const a of rows){
      if(!comboMatch(a,target))continue;
      matches++;
      const cid=String(a.combo_condition_id||"");
      if(!cid)continue;
      q.act.run(w,cid,String(a.combo_position_id||""),String(a.tx_hash||""),String(a.log_index??""),String(a.event_kind||""),String(a.module_kind||""),num(a.amount_usdc),num(a.payout_usdc),String(a.tx_dttm||a.timestamp||""),now());
      saveLegs(cid,a.legs||[]);
      db.prepare("INSERT OR IGNORE INTO tracked_matches(slug,wallet) VALUES(?,?)").run(slug,w);
      db.prepare("INSERT OR IGNORE INTO tracked_combo_seen(slug,combo_id,first_seen_utc) VALUES(?,?,?)").run(slug,cid,now());
    }
  });
  return matches;
}

async function refreshActivityWalletDashboard(w,target){
  const rows=await activity(w);
  let matches=0;

  for(const a of rows){
    if(!comboMatch(a,target))continue;

    matches++;
    const cid=String(a.combo_condition_id||"");
    if(!cid)continue;

    q.act.run(
      w,
      cid,
      String(a.combo_position_id||""),
      String(a.tx_hash||""),
      String(a.log_index??""),
      String(a.event_kind||""),
      String(a.module_kind||""),
      num(a.amount_usdc),
      num(a.payout_usdc),
      String(a.tx_dttm||a.timestamp||""),
      now()
    );

    saveLegs(cid,a.legs||[]);

    db.prepare(
      "INSERT OR REPLACE INTO dashboard_match_wallets(wallet,last_match_utc) VALUES(?,?)"
    ).run(w,now());
  }

  return matches;
}

async function refreshPositionsWalletDashboard(w,target){
  const rows=await positions(w);
  let matches=0;

  for(const c of rows){
    if(!comboMatch(c,target))continue;

    matches++;
    const cid=String(c.combo_condition_id||c.combo_position_id||"");
    if(!cid)continue;

    q.pos.run(
      w,
      cid,
      String(c.combo_position_id||cid),
      num(c.entry_cost_usdc),
      num(c.total_cost_usdc),
      num(c.current_value_usdc),
      num(c.shares_balance),
      String(c.status||""),
      String(c.first_entry_at||""),
      String(c.resolved_at||""),
      String(c.updated_at||""),
      now()
    );

    saveLegs(cid,c.legs||[]);
  }

  return matches;
}

async function refreshPositionsWallet(w,target,slug){
  let matches=0;
  await comboPages("positions",w,async rows=>{
    for(const c of rows){
      if(!comboMatch(c,target))continue;
      matches++;
      const cid=String(c.combo_condition_id||c.combo_position_id||"");
      if(!cid)continue;
      q.pos.run(w,cid,String(c.combo_position_id||cid),num(c.entry_cost_usdc),num(c.total_cost_usdc),num(c.current_value_usdc),num(c.shares_balance),String(c.status||""),String(c.first_entry_at||""),String(c.resolved_at||""),String(c.updated_at||""),now());
      saveLegs(cid,c.legs||[]);
      db.prepare("INSERT OR IGNORE INTO tracked_matches(slug,wallet) VALUES(?,?)").run(slug,w);
      db.prepare("INSERT OR IGNORE INTO tracked_combo_seen(slug,combo_id,first_seen_utc) VALUES(?,?,?)").run(slug,cid,now());
    }
  });
  return matches;
}
async function mapPool(items,limit,fn,cb){const qx=[...items];let done=0,hits=0;async function w(){while(qx.length){const x=qx.shift();try{if(await fn(x))hits++}catch{}done++;cb&&cb({done,total:items.length,hits})}}await Promise.all(Array.from({length:Math.min(limit,items.length||1)},w))}
async function eventBySlug(s){return await fetchJ(`${GAMMA}/events/slug/${encodeURIComponent(s)}`,{timeout:10000},3)}
async function relatedEvents(main){const out=new Map([[String(main.slug||""),main]]),gid=main.gameId||main.game_id||(main.sports||{}).gameId;if(!gid)return[...out.values()];let c=null;for(let i=0;i<5;i++){const u=new URL(`${GAMMA}/events/keyset`);u.searchParams.set("game_id",String(gid));u.searchParams.set("limit","100");if(c)u.searchParams.set("after_cursor",c);let d;try{d=await fetchJ(u.toString(),{timeout:10000},3)}catch{break}for(const e of(d.events||d.items||[])){const s=String(e.slug||"");if(!s)continue;try{out.set(s,await eventBySlug(s))}catch{out.set(s,e)}}c=d.next_cursor||d.nextCursor||null;if(!c)break}return[...out.values()]}
function marketRows(events){const rows=[];for(const e of events)for(const m of e.markets||[]){const cid=String(m.conditionId||m.condition_id||"").toLowerCase();if(cid)rows.push({condition_id:cid,market_slug:String(m.slug||""),market_title:String(m.question||m.title||"")})}return rows}
function startMs(events){
  const nowMs=Date.now();
  const creations=[],starts=[];
  for(const e of events||[]){
    for(const k of ["creationDate","createdAt","created_at"]){
      const x=Date.parse(e?.[k]||"");
      if(Number.isFinite(x))creations.push(x);
    }
    for(const k of ["startDate","start_date"]){
      const x=Date.parse(e?.[k]||"");
      if(Number.isFinite(x))starts.push(x);
    }
  }

  let start;
  if(creations.length)start=Math.min(...creations);
  else if(starts.length)start=Math.min(...starts)-24*3600e3;
  else start=nowMs-5*86400e3;

  start-=PRE_EVENT_MARGIN_HOURS*3600e3;
  return Math.max(start,nowMs-MAX_INITIAL_SCAN_DAYS*86400e3);
}

const ENRICH_CACHE=new Map();
const ENRICH_TTL=30*60*1000;
const ENRICH_CONCURRENCY=10;
function eNum(v){const n=Number(v);return Number.isFinite(n)?n:0}
function eLow(v){return String(v||"").toLowerCase()}
function eGet(k){const x=ENRICH_CACHE.get(k);return x&&Date.now()-x.t<ENRICH_TTL?x.v:undefined}
function eSet(k,v){ENRICH_CACHE.set(k,{t:Date.now(),v});return v}
const ENRICH_INFLIGHT=new Map();
async function eFetch(url){
  if(ENRICH_INFLIGHT.has(url))return ENRICH_INFLIGHT.get(url);

  const p=(async()=>{
    try{
      const r=await fetch(url,{
        headers:{accept:"application/json","user-agent":"cs2-combo-tracker/20.1"},
        signal:AbortSignal.timeout(12000)
      });
      return r.ok?await r.json():null;
    }catch{
      return null;
    }finally{
      ENRICH_INFLIGHT.delete(url);
    }
  })();

  ENRICH_INFLIGHT.set(url,p);
  return p;
}
async function ePool(items,limit,fn){
  const out=new Array(items.length);let next=0;
  async function w(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}
  await Promise.all(Array.from({length:Math.min(limit,Math.max(1,items.length))},w));return out
}
function eBest(rows,cid,outcome){
  const a=(rows||[]).filter(x=>eLow(x.conditionId||x.condition_id)===eLow(cid));
  return a.find(x=>!outcome||eLow(x.outcome)===eLow(outcome))||a[0]||null
}
async function eCurrent(wallet,cid,outcome){
  const k=`c:${eLow(wallet)}:${eLow(cid)}:${eLow(outcome)}`,q=eGet(k);if(q!==undefined)return q;
  const rows=await eFetch(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(wallet)}&market=${encodeURIComponent(cid)}&sizeThreshold=0&limit=500`);
  return eSet(k,eBest(Array.isArray(rows)?rows:[],cid,outcome))
}
async function eClosed(wallet,cid,outcome){
  const k=`x:${eLow(wallet)}:${eLow(cid)}:${eLow(outcome)}`,q=eGet(k);if(q!==undefined)return q;
  let all=[];
  for(let off=0;off<=100000;off+=50){
    const rows=await eFetch(`https://data-api.polymarket.com/closed-positions?user=${encodeURIComponent(wallet)}&market=${encodeURIComponent(cid)}&limit=50&offset=${off}&sortBy=TIMESTAMP&sortDirection=DESC`);
    if(!Array.isArray(rows))break;all.push(...rows);if(rows.length<50)break
  }
  return eSet(k,eBest(all,cid,outcome))
}
async function eMarket(wallet,cid,outcome){
  const k=`m:${eLow(wallet)}:${eLow(cid)}:${eLow(outcome)}`,q=eGet(k);if(q!==undefined)return q;
  const groups=await eFetch(`https://data-api.polymarket.com/v1/market-positions?market=${encodeURIComponent(cid)}&user=${encodeURIComponent(wallet)}&status=ALL&limit=500&sortBy=TOTAL_PNL&sortDirection=DESC`);
  const rows=[];if(Array.isArray(groups))for(const g of groups)if(Array.isArray(g.positions))rows.push(...g.positions);
  return eSet(k,eBest(rows,cid,outcome))
}
async function eWallet(w,c){
  let best=null;
  for(const leg of (c.legs||[]).filter(l=>l.condition_id)){
    const [cur,mkt,closed]=await Promise.all([eCurrent(w.wallet,leg.condition_id,leg.outcome),eMarket(w.wallet,leg.condition_id,leg.outcome),eClosed(w.wallet,leg.condition_id,leg.outcome)]);
    if(cur||mkt||closed){best={leg,cur,mkt,closed};if(cur)break}
  }
  if(!best)return{...w,enriched:false,data_source:w.source||"ACTIVITY"};
  const {leg,cur,mkt,closed}=best,src=cur||mkt||closed;
  const avg=eNum(src.avgPrice),size=eNum(cur?.size??mkt?.size??w.shares);
  const initial=eNum(cur?.initialValue)||(avg&&size?avg*size:0);
  const bought=eNum(cur?.totalBought??mkt?.totalBought??closed?.totalBought);
  const hist=initial||(avg&&bought?avg*bought:0);
  const realized=eNum(cur?.realizedPnl??mkt?.realizedPnl??closed?.realizedPnl);
  const unreal=eNum(cur?.cashPnl??mkt?.cashPnl);
  return{...w,enriched:true,data_source:cur?"CURRENT":(mkt?"MARKET ALL":"CLOSED"),
    matched_condition_id:leg.condition_id,matched_outcome:leg.outcome||"",
    avg_price:avg,initial_value:initial,historical_entry:hist,total_bought:bought,
    current_value:eNum(cur?.currentValue??mkt?.currentValue??w.current_value),
    shares:size,realized_pnl:realized,unrealized_pnl:unreal,
    total_pnl:eNum(mkt?.totalPnl)||(realized+unreal),
    current_price:eNum(cur?.curPrice??mkt?.currPrice??closed?.curPrice),
    entry_cost:eNum(w.entry_cost)||hist,total_cost:eNum(w.total_cost)||hist,
    position_id:w.position_id||src.asset||"",status:cur?"Aberta":"Fechada"}
}
async function enrichTrackedResult(result){
  if(!result?.combos)return result;

  await ePool(
    result.combos,
    Math.min(4,Math.max(1,result.combos.length)),
    async c=>{
      c.wallet_list=await ePool(
        c.wallet_list||[],
        ENRICH_CONCURRENCY,
        async w=>{
        const x=await eWallet(w,c);

        const confirmedEntry=eNum(x.entry_cost);
        const activity=eNum(x.activity_amount);

        // "Valor colocado" prioritizes a real reconstructed entry/initial value.
        // If unavailable, use Activity Amount as a fallback estimate and mark it clearly.
        if(confirmedEntry>0){
          x.placed_amount=confirmedEntry;
          x.placed_source="CONFIRMADO";
        }else if(activity>0){
          x.placed_amount=activity;
          x.placed_source="ESTIMADO_ACTIVITY";
        }else{
          x.placed_amount=0;
          x.placed_source="SEM_DADOS";
        }

        return x;
      }
    );

    c.total_placed_confirmed=c.wallet_list
      .filter(w=>w.placed_source==="CONFIRMADO")
      .reduce((a,w)=>a+eNum(w.placed_amount),0);

    c.total_placed_estimated=c.wallet_list
      .filter(w=>w.placed_source==="ESTIMADO_ACTIVITY")
      .reduce((a,w)=>a+eNum(w.placed_amount),0);

    c.total_placed=c.wallet_list.reduce((a,w)=>a+eNum(w.placed_amount),0);

    c.wallets_confirmed=c.wallet_list.filter(w=>w.placed_source==="CONFIRMADO").length;
    c.wallets_estimated=c.wallet_list.filter(w=>w.placed_source==="ESTIMADO_ACTIVITY").length;

      c.wallet_list.sort((a,b)=>eNum(b.placed_amount)-eNum(a.placed_amount));
      return c;
    }
  );

  result.total_placed=result.combos.reduce((a,c)=>a+eNum(c.total_placed),0);
  result.total_placed_confirmed=result.combos.reduce((a,c)=>a+eNum(c.total_placed_confirmed),0);
  result.total_placed_estimated=result.combos.reduce((a,c)=>a+eNum(c.total_placed_estimated),0);

  return result;
}

function trackedResult(slug,main,target){
  const ids=[...target];
  if(!ids.length)return{event:main,combos:[],newCombos:0};

  const marks=ids.map(()=>"?").join(",");

  // A combo is relevant if its saved legs match the target.
  // IMPORTANT: do not require a current combo_position.
  // The proven Python watcher aggregates Activity + Positions, so historical/closed
  // combos detected in Activity must remain visible even when Positions is empty.
  const combos=db.prepare(`
    WITH m AS(
      SELECT DISTINCT combo_id
      FROM combo_legs
      WHERE condition_id IN (${marks})
    ),
    p AS(
      SELECT
        p.combo_id,
        COUNT(DISTINCT p.wallet) position_wallets,
        COUNT(*) positions,
        SUM(
          CASE
            WHEN (p.resolved_at IS NULL OR p.resolved_at='')
             AND p.shares>0.0001
            THEN p.entry_cost
            ELSE 0
          END
        ) open_entry,
        SUM(p.entry_cost) total_entry
      FROM combo_positions p
      JOIN m ON m.combo_id=p.combo_id
      GROUP BY p.combo_id
    ),
    a AS(
      SELECT
        a.combo_id,
        COUNT(DISTINCT a.wallet) activity_wallets,
        COUNT(*) activity_events,
        SUM(a.amount_usdc) activity_amount,
        SUM(a.payout_usdc) activity_payout
      FROM combo_activity a
      JOIN m ON m.combo_id=a.combo_id
      GROUP BY a.combo_id
    )
    SELECT
      m.combo_id,
      COALESCE(p.position_wallets,0) position_wallets,
      COALESCE(a.activity_wallets,0) activity_wallets,
      COALESCE(p.positions,0) positions,
      COALESCE(p.open_entry,0) open_entry,
      COALESCE(p.total_entry,0) total_entry,
      COALESCE(a.activity_events,0) activity_events,
      COALESCE(a.activity_amount,0) activity_amount,
      COALESCE(a.activity_payout,0) activity_payout
    FROM m
    LEFT JOIN p ON p.combo_id=m.combo_id
    LEFT JOIN a ON a.combo_id=m.combo_id
    WHERE p.combo_id IS NOT NULL OR a.combo_id IS NOT NULL
    ORDER BY
      COALESCE(p.open_entry,0) DESC,
      COALESCE(a.activity_amount,0) DESC,
      COALESCE(a.activity_events,0) DESC
  `).all(...ids);

  for(const c of combos){
    c.legs=db.prepare(`
      SELECT leg_index,condition_id,event_title,market_title,outcome,event_slug,market_slug
      FROM combo_legs
      WHERE combo_id=?
      ORDER BY leg_index
    `).all(c.combo_id);

    const activityByWallet=db.prepare(`
      SELECT
        wallet,
        COUNT(*) activity_events,
        COALESCE(SUM(amount_usdc),0) activity_amount,
        COALESCE(SUM(payout_usdc),0) activity_payout,
        MIN(CASE WHEN tx_dttm IS NOT NULL AND tx_dttm<>'' THEN tx_dttm END) first_activity_at,
        MAX(CASE WHEN tx_dttm IS NOT NULL AND tx_dttm<>'' THEN tx_dttm END) last_activity_at
      FROM combo_activity
      WHERE combo_id=?
      GROUP BY wallet
    `).all(c.combo_id);

    const actMap=new Map(activityByWallet.map(x=>[x.wallet,x]));

    const posWallets=db.prepare(`
      SELECT
        wallet,position_id,entry_cost,total_cost,current_value,shares,status,
        first_entry_at,resolved_at,
        'POSITION' source
      FROM combo_positions
      WHERE combo_id=?
      ORDER BY entry_cost DESC
    `).all(c.combo_id).map(x=>{
      const a=actMap.get(x.wallet)||{};
      return {
        ...x,
        activity_events:Number(a.activity_events||0),
        activity_amount:Number(a.activity_amount||0),
        activity_payout:Number(a.activity_payout||0),
        first_activity_at:a.first_activity_at||"",
        last_activity_at:a.last_activity_at||""
      };
    });

    const posSet=new Set(posWallets.map(x=>x.wallet));

    const activityOnly=activityByWallet
      .filter(a=>!posSet.has(a.wallet))
      .map(a=>({
        wallet:a.wallet,
        position_id:"",
        entry_cost:0,
        total_cost:0,
        current_value:0,
        shares:0,
        status:"Sem posição atual",
        first_entry_at:a.first_activity_at||"",
        resolved_at:"",
        source:"ACTIVITY",
        activity_events:Number(a.activity_events||0),
        activity_amount:Number(a.activity_amount||0),
        activity_payout:Number(a.activity_payout||0),
        first_activity_at:a.first_activity_at||"",
        last_activity_at:a.last_activity_at||""
      }))
      .sort((a,b)=>Number(b.activity_amount||0)-Number(a.activity_amount||0));

    c.wallet_list=[...posWallets,...activityOnly];
    c.wallets=new Set(c.wallet_list.map(x=>x.wallet)).size;
    c.first_seen=db.prepare(
      "SELECT first_seen_utc FROM tracked_combo_seen WHERE slug=? AND combo_id=?"
    ).get(slug,c.combo_id)?.first_seen_utc||"";
  }

  return{event:main,combos};
}
async function trackJob(id,input){
  try{
    const slug=slugOf(input);

    setP(id,{status:"running",message:"[1/6] Evento e mercados..."});
    const main=await eventBySlug(slug);
    const events=await relatedEvents(main);
    const mrs=marketRows(events);
    const target=new Set(mrs.map(x=>x.condition_id));

    if(!target.size)throw new Error("Sem condition IDs para este jogo.");

    db.prepare(`
      INSERT INTO tracked_games(slug,event_id,title,start_time,last_scanned_block,last_run_utc)
      VALUES(?,?,?,?,0,?)
      ON CONFLICT(slug) DO UPDATE SET
        event_id=excluded.event_id,
        title=excluded.title,
        start_time=excluded.start_time
    `).run(
      slug,
      String(main.id||""),
      String(main.title||slug),
      String(main.startDate||main.endDate||""),
      now()
    );

    for(const m of mrs){
      db.prepare(`
        INSERT OR REPLACE INTO tracked_markets(slug,condition_id,market_slug,market_title)
        VALUES(?,?,?,?)
      `).run(slug,m.condition_id,m.market_slug,m.market_title);
    }

    const tg=db.prepare("SELECT last_scanned_block FROM tracked_games WHERE slug=?").get(slug);
    const lastScanned=Number(tg?.last_scanned_block||0);
    const firstRun=lastScanned<=0;

    setP(id,{status:"running",message:"[2/6] Definir scan incremental..."});

    const hi=await latest();
    let lo;

    if(firstRun){
      lo=await findBlock(Math.floor(startMs(events)/1000),hi);
    }else{
      lo=lastScanned+1;
    }

    const previousCandidates=new Set(
      db.prepare("SELECT wallet FROM tracked_candidates WHERE slug=?").all(slug).map(r=>r.wallet)
    );

    const previousMatches=new Set(
      db.prepare("SELECT wallet FROM tracked_matches WHERE slug=?").all(slug).map(r=>r.wallet)
    );

    const beforeCombos=new Set(
      db.prepare("SELECT combo_id FROM tracked_combo_seen WHERE slug=?").all(slug).map(r=>r.combo_id)
    );

    setP(id,{status:"running",message:"[3/6] Novos logs Combo..."});

    const sc=await scanLogs(lo,hi,p=>{
      const msg=`Logs ${p.done}/${p.total} · ${p.logs} eventos · ${p.wallets} wallets`;
      setP(id,{status:"running",message:msg,...p});
      if(p.done===1||p.done%10===0||p.done===p.total)console.log(`TRACK ${slug}: ${msg}`);
    });

    let newlySeen=new Set(sc.wallets);

    if(newlySeen.size<TOPIC_FALLBACK_MIN && sc.txs.length){
      setP(id,{
        status:"running",
        message:`Topics só deram ${newlySeen.size} wallets. Fallback tx.from até ${TX_FALLBACK_MAX} TXs...`
      });

      const txw=await txFallback(sc.txs,(d,t,n)=>{
        setP(id,{status:"running",message:`TX fallback ${d}/${t} · ${n} senders`});
      });

      for(const w of txw)newlySeen.add(w);
    }

    for(const w of newlySeen){
      db.prepare("INSERT OR IGNORE INTO tracked_candidates(slug,wallet) VALUES(?,?)").run(slug,w);
      q.wallet.run(w,now(),now());
    }

    const allCandidates=new Set([...previousCandidates,...newlySeen]);
    const newCandidates=[...newlySeen].filter(w=>!previousCandidates.has(w));

    // FAST v2:
    // first run -> all candidate wallets
    // incremental -> only new candidate wallets
    const activityScan=firstRun?[...allCandidates]:newCandidates;

    setP(id,{
      status:"running",
      message:`[4/6] Activity relevante: ${activityScan.length} wallets`
    });

    await mapPool(
      activityScan,
      TRACK_ACTIVITY_CONCURRENCY,
      w=>refreshActivityWallet(w,target,slug),
      p=>{
        const msg=`Activity ${p.done}/${p.total} · ${p.hits} wallets match`;
        setP(id,{status:"running",message:msg,...p});
        if(p.done===1||p.done%50===0||p.done===p.total)console.log(`TRACK ${slug}: ${msg}`);
      }
    );

    // Refresh known match wallets every run, as in FAST v2.
    if(!firstRun && previousMatches.size){
      const old=[...previousMatches];

      setP(id,{
        status:"running",
        message:`A refrescar Activity de ${old.length} wallets já conhecidas com match...`
      });

      await mapPool(
        old,
        TRACK_ACTIVITY_CONCURRENCY,
        w=>refreshActivityWallet(w,target,slug),
        p=>{
          if(p.done===1||p.done%50===0||p.done===p.total){
            setP(id,{status:"running",message:`Refresh Activity ${p.done}/${p.total}`,...p});
          }
        }
      );
    }

    const allMatches=new Set(
      db.prepare("SELECT wallet FROM tracked_matches WHERE slug=?").all(slug).map(r=>r.wallet)
    );

    setP(id,{
      status:"running",
      message:`[5/6] Positions: ${allMatches.size} wallets relevantes`
    });

    await mapPool(
      [...allMatches],
      TRACK_POSITION_CONCURRENCY,
      w=>refreshPositionsWallet(w,target,slug),
      p=>{
        const msg=`Positions ${p.done}/${p.total} · ${p.hits} rows match`;
        setP(id,{status:"running",message:msg,...p});
        if(p.done===1||p.done%25===0||p.done===p.total)console.log(`TRACK ${slug}: ${msg}`);
      }
    );

    const result=await enrichTrackedResult(trackedResult(slug,main,target));
    const after=new Set(result.combos.map(c=>c.combo_id));

    result.newCombos=[...after].filter(x=>!beforeCombos.has(x)).length;
    result.incremental=!firstRun;
    result.newCandidateWallets=newCandidates.length;

    // Only checkpoint after successful end-to-end execution.
    db.prepare(
      "UPDATE tracked_games SET last_scanned_block=?,last_run_utc=? WHERE slug=?"
    ).run(hi,now(),slug);

    setP(id,{
      status:"done",
      message:`Concluído: ${result.combos.length} combos · ${result.newCombos} novas · ${allMatches.size} wallets com match`,
      result
    });

  }catch(e){
    setP(id,{status:"error",message:String(e.message||e)});
  }
}

async function activeCS2(){
  const found=new Map();

  // Primary path: official Gamma events endpoint filtered directly by CS2 tag.
  // This is more reliable than public-search for the dashboard.
  for(const tagSlug of ["cs2","counter-strike-2","counter-strike"]){
    for(let offset=0;offset<3000;offset+=500){
      const u=new URL(`${GAMMA}/events`);
      u.searchParams.set("tag_slug",tagSlug);
      u.searchParams.set("active","true");
      u.searchParams.set("closed","false");
      u.searchParams.set("limit","500");
      u.searchParams.set("offset",String(offset));
      u.searchParams.set("order","start_date");
      u.searchParams.set("ascending","true");

      let rows;
      try{
        rows=await fetchJ(u.toString(),{timeout:12000},3);
      }catch{
        break;
      }

      if(!Array.isArray(rows)||!rows.length)break;

      for(const e of rows){
        const slug=String(e.slug||"");
        if(!slug||e.closed===true)continue;
        found.set(slug,e);
      }

      if(rows.length<500)break;
      await new Promise(r=>setImmediate(r));
    }

    if(found.size)break;
  }

  // Fallback 1: active events, then filter by slug/title/embedded tags.
  if(!found.size){
    for(let offset=0;offset<5000;offset+=500){
      const u=new URL(`${GAMMA}/events`);
      u.searchParams.set("active","true");
      u.searchParams.set("closed","false");
      u.searchParams.set("limit","500");
      u.searchParams.set("offset",String(offset));
      u.searchParams.set("order","start_date");
      u.searchParams.set("ascending","true");

      let rows;
      try{
        rows=await fetchJ(u.toString(),{timeout:12000},3);
      }catch{
        break;
      }

      if(!Array.isArray(rows)||!rows.length)break;

      for(const e of rows){
        const slug=String(e.slug||"").toLowerCase();
        const title=String(e.title||"").toLowerCase();
        const tags=(e.tags||[]).map(t=>String(t.slug||t.label||"").toLowerCase());

        const isCS2=
          slug.startsWith("cs2-") ||
          slug.includes("/cs2/") ||
          title.includes("counter-strike") ||
          title.includes("counter strike") ||
          tags.some(t=>t==="cs2"||t.includes("counter-strike"));

        if(isCS2&&e.closed!==true)found.set(String(e.slug||""),e);
      }

      if(rows.length<500)break;
      await new Promise(r=>setImmediate(r));
    }
  }

  // Fallback 2: original public-search route.
  if(!found.size){
    for(const query of ["CS2","Counter-Strike 2","Counter Strike"]){
      for(let page=1;page<=5;page++){
        const u=new URL(`${GAMMA}/public-search`);
        u.searchParams.set("q",query);
        u.searchParams.set("limit_per_type","50");
        u.searchParams.set("page",String(page));
        u.searchParams.set("keep_closed_markets","0");
        u.searchParams.set("search_profiles","false");
        u.searchParams.set("search_tags","false");

        let d;
        try{
          d=await fetchJ(u.toString(),{timeout:10000},3);
        }catch{
          break;
        }

        for(const e of d.events||[]){
          const slug=String(e.slug||"");
          const title=String(e.title||"").toLowerCase();

          if(
            slug &&
            e.closed!==true &&
            (
              slug.toLowerCase().startsWith("cs2-") ||
              title.includes("counter strike") ||
              title.includes("counter-strike")
            )
          ){
            found.set(slug,e);
          }
        }

        if(!(d.pagination||{}).hasMore)break;
      }
    }
  }

  console.log(`CS2 discovery: ${found.size} active events`);
  return [...found.values()];
}

async function refreshActive(progressCb){
  const events=await activeCS2();
  const ts=now();

  db.exec("DELETE FROM active_games;DELETE FROM active_game_markets;");

  let done=0,marketCount=0,failed=0;
  const queue=[...events];
  const concurrency=Math.min(6,Math.max(1,events.length));

  console.log(`CS2 refreshActive: ${events.length} eventos | concorrência ${concurrency}`);

  async function worker(){
    while(queue.length){
      const e0=queue.shift();
      let e=e0;

      try{
        if(!e.markets){
          e=await withTimeout(
            eventBySlug(e.slug),
            8000,
            `event ${e.slug}`
          );
        }

        const key=String(e.id?`event:${e.id}`:`slug:${e.slug}`);
        db.prepare("INSERT OR REPLACE INTO active_games(game_key,event_id,event_slug,title,start_time,refreshed_at) VALUES(?,?,?,?,?,?)")
          .run(
            key,
            String(e.id||""),
            String(e.slug||""),
            String(e.title||""),
            String(e.startDate||e.endDate||""),
            ts
          );

        const rows=marketRows([e]);
        marketCount+=rows.length;

        for(const m of rows){
          db.prepare("INSERT OR REPLACE INTO active_game_markets(game_key,condition_id,market_slug,market_title) VALUES(?,?,?,?)")
            .run(key,m.condition_id,m.market_slug,m.market_title);
        }
      }catch(err){
        failed++;
        console.log(`CS2 evento falhou: ${String(e0.slug||e0.id||"?")} | ${String(err.message||err)}`);
      }finally{
        done++;
        const msg=`CS2 jogos ${done}/${events.length} | mercados ${marketCount} | falhas ${failed}`;
        console.log(msg);
        if(progressCb)progressCb({done,total:events.length,markets:marketCount,failed,message:msg});
        await new Promise(r=>setImmediate(r));
      }
    }
  }

  await Promise.all(Array.from({length:concurrency},()=>worker()));

  console.log(`CS2 refreshActive concluído: ${events.length} eventos | ${marketCount} mercados | ${failed} falhas`);
  return {events:events.length,markets:marketCount,failed};
}

function cleanupDatabase(){
  try{
    // Keep only combos that are relevant to:
    // 1) currently active CS2 game markets, or
    // 2) markets belonging to a game explicitly tracked by the user.
    //
    // tracked_combo_seen is also preserved, even if a leg record is temporarily missing.
    db.exec(`
      DELETE FROM combo_activity
      WHERE combo_id NOT IN (
        SELECT DISTINCT cl.combo_id
        FROM combo_legs cl
        WHERE cl.condition_id IN (
          SELECT condition_id FROM active_game_markets
          UNION
          SELECT condition_id FROM tracked_markets
        )
        UNION
        SELECT combo_id FROM tracked_combo_seen
      );

      DELETE FROM combo_positions
      WHERE combo_id NOT IN (
        SELECT DISTINCT cl.combo_id
        FROM combo_legs cl
        WHERE cl.condition_id IN (
          SELECT condition_id FROM active_game_markets
          UNION
          SELECT condition_id FROM tracked_markets
        )
        UNION
        SELECT combo_id FROM tracked_combo_seen
      );

      DELETE FROM combo_legs
      WHERE combo_id NOT IN (
        SELECT DISTINCT combo_id FROM combo_positions
        UNION
        SELECT DISTINCT combo_id FROM combo_activity
        UNION
        SELECT combo_id FROM tracked_combo_seen
      );

      DELETE FROM wallets
      WHERE wallet NOT IN (
        SELECT DISTINCT wallet FROM combo_positions
        UNION
        SELECT DISTINCT wallet FROM combo_activity
        UNION
        SELECT wallet FROM tracked_matches
        UNION
        SELECT wallet FROM tracked_candidates
        UNION
        SELECT wallet FROM dashboard_match_wallets
      );
    `);

    try{ db.exec("PRAGMA optimize;"); }catch{}
  }catch(e){
    console.error("Cleanup DB falhou:", e?.message || e);
  }
}

function dashboardRows(){
  return db.prepare(`
    WITH linked AS(
      SELECT
        ag.game_key,
        ag.event_slug,
        ag.title,
        ag.start_time,
        cl.combo_id
      FROM active_games ag
      JOIN active_game_markets gm ON gm.game_key=ag.game_key
      JOIN combo_legs cl ON cl.condition_id=gm.condition_id
      GROUP BY ag.game_key,cl.combo_id
    ),
    pos AS(
      SELECT
        combo_id,
        COUNT(*) positions,
        SUM(
          CASE
            WHEN (resolved_at IS NULL OR resolved_at='')
             AND shares>0.0001
            THEN entry_cost
            ELSE 0
          END
        ) open_entry
      FROM combo_positions
      GROUP BY combo_id
    ),
    wallets AS(
      SELECT combo_id,wallet FROM combo_positions
      UNION
      SELECT combo_id,wallet FROM combo_activity
    ),
    wagg AS(
      SELECT combo_id,COUNT(DISTINCT wallet) wallet_count
      FROM wallets
      GROUP BY combo_id
    )
    SELECT
      l.game_key,
      l.event_slug,
      l.title,
      l.start_time,
      COUNT(DISTINCT l.combo_id) combo_count,
      COALESCE(SUM(DISTINCT COALESCE(w.wallet_count,0)),0) wallet_count,
      COALESCE(SUM(COALESCE(p.positions,0)),0) position_count,
      COALESCE(SUM(COALESCE(p.open_entry,0)),0) open_entry
    FROM linked l
    LEFT JOIN pos p ON p.combo_id=l.combo_id
    LEFT JOIN wagg w ON w.combo_id=l.combo_id
    GROUP BY l.game_key,l.event_slug,l.title,l.start_time
    ORDER BY open_entry DESC,combo_count DESC
  `).all();
}
async function dashboardJob(id,source="manual"){
  if(dashboardRunning){
    setP(id,{
      status:"done",
      message:"Já existe uma atualização do Dashboard em curso.",
      result:{rows:dashboardRows(),auto:autoState}
    });
    return;
  }

  dashboardRunning=true;
  autoState.running=true;
  autoState.lastStarted=now();
  autoState.lastError=null;

  const combosBefore=Number(
    db.prepare("SELECT COUNT(DISTINCT combo_id) n FROM combo_positions").get().n||0
  );

  const walletsBefore=Number(
    db.prepare("SELECT COUNT(*) n FROM dashboard_match_wallets").get().n||0
  );

  try{
    // 1) Active CS2 games
    setP(id,{
      status:"running",
      phase:"games",
      message:"[1/5] A atualizar jogos CS2 ativos..."
    });

    const activeInfo=await refreshActive(p=>{
      setP(id,{
        status:"running",
        phase:"games",
        message:`Jogos CS2 ${p.done}/${p.total} · ${p.markets} mercados`
      });
    });

    if(!activeInfo.markets)throw new Error("Foram encontrados jogos CS2, mas 0 mercados.");

    const target=new Set(
      db.prepare("SELECT DISTINCT condition_id FROM active_game_markets").all().map(r=>r.condition_id)
    );

    // 2) Incremental blockchain window.
    const hi=await latest();
    let lo=Number(q.getMeta.get("dashboard_last_block")?.value||0);
    const firstRun=lo<=0;

    if(firstRun){
      // Mirror Watcher MAX_INITIAL_SCAN_DAYS coverage for initial dashboard build.
      lo=await findBlock(
        Math.floor((Date.now()-MAX_INITIAL_SCAN_DAYS*86400e3)/1000),
        hi
      );
    }else{
      lo++;
    }

    setP(id,{
      status:"running",
      phase:"blockchain",
      message:`[2/5] Logs Combo ${lo} → ${hi}...`
    });

    const sc=await scanLogs(lo,hi,p=>{
      const msg=`Logs ${p.done}/${p.total} · ${p.logs} eventos · ${p.wallets} wallets`;
      setP(id,{status:"running",phase:"blockchain",message:msg,...p});
      if(p.done===1||p.done%10===0||p.done===p.total)console.log(`DASH: ${msg}`);
    });

    let newlySeen=new Set(sc.wallets);

    if(newlySeen.size<TOPIC_FALLBACK_MIN && sc.txs.length){
      setP(id,{
        status:"running",
        phase:"blockchain",
        message:`Topics só deram ${newlySeen.size} wallets. Fallback tx.from...`
      });

      const txw=await txFallback(sc.txs,(d,t,n)=>{
        setP(id,{
          status:"running",
          phase:"blockchain",
          message:`TX fallback ${d}/${t} · ${n} senders`
        });
      });

      for(const w of txw)newlySeen.add(w);
    }

    for(const w of newlySeen)q.wallet.run(w,now(),now());

    const knownMatches=new Set(
      db.prepare("SELECT wallet FROM dashboard_match_wallets").all().map(r=>r.wallet)
    );

    // On first run, all discovered wallets need Activity scan.
    // On incremental runs, scan only newly seen wallets + refresh known matches.
    const activityScan=firstRun?[...newlySeen]:[...newlySeen].filter(w=>!knownMatches.has(w));

    setP(id,{
      status:"running",
      phase:"activity",
      message:`[3/5] Activity: ${activityScan.length} novas/candidatas`
    });

    await mapPool(
      activityScan,
      DASHBOARD_ACTIVITY_CONCURRENCY,
      w=>refreshActivityWalletDashboard(w,target),
      p=>{
        const msg=`Activity ${p.done}/${p.total} · ${p.hits} wallets match`;
        setP(id,{status:"running",phase:"activity",message:msg,...p});
        if(p.done===1||p.done%50===0||p.done===p.total)console.log(`DASH: ${msg}`);
      }
    );

    // Refresh wallets already proven relevant.
    if(!firstRun && knownMatches.size){
      const old=[...knownMatches];

      await mapPool(
        old,
        DASHBOARD_ACTIVITY_CONCURRENCY,
        w=>refreshActivityWalletDashboard(w,target),
        p=>{
          if(p.done===1||p.done%50===0||p.done===p.total){
            setP(id,{
              status:"running",
              phase:"activity",
              message:`Refresh Activity ${p.done}/${p.total}`
            });
          }
        }
      );
    }

    const matchedWallets=new Set(
      db.prepare("SELECT wallet FROM dashboard_match_wallets").all().map(r=>r.wallet)
    );

    setP(id,{
      status:"running",
      phase:"positions",
      message:`[4/5] Positions: ${matchedWallets.size} wallets relevantes`
    });

    await mapPool(
      [...matchedWallets],
      DASHBOARD_POSITION_CONCURRENCY,
      w=>refreshPositionsWalletDashboard(w,target),
      p=>{
        const msg=`Positions ${p.done}/${p.total} · ${p.hits} rows match`;
        setP(id,{status:"running",phase:"positions",message:msg,...p});
        if(p.done===1||p.done%25===0||p.done===p.total)console.log(`DASH: ${msg}`);
      }
    );

    // Checkpoint only on success.
    q.setMeta.run("dashboard_last_block",String(hi));

    cleanupDatabase();

    const rows=dashboardRows();
    const combosAfter=Number(
      db.prepare("SELECT COUNT(DISTINCT combo_id) n FROM combo_positions").get().n||0
    );
    const walletsAfter=Number(
      db.prepare("SELECT COUNT(*) n FROM dashboard_match_wallets").get().n||0
    );

    autoState.lastNewCombos=Math.max(0,combosAfter-combosBefore);
    autoState.lastNewWallets=Math.max(0,walletsAfter-walletsBefore);
    autoState.lastRows=rows.length;
    autoState.lastFinished=now();
    autoState.phase="done";

    setP(id,{
      status:"done",
      phase:"done",
      message:`[5/5] Dashboard: ${rows.length} jogos · ${combosAfter} combos · ${walletsAfter} wallets com match`,
      result:{rows,auto:autoState}
    });

  }catch(e){
    autoState.lastError=String(e.message||e);
    autoState.lastFinished=now();
    setP(id,{status:"error",phase:"error",message:autoState.lastError});
  }finally{
    dashboardRunning=false;
    autoState.running=false;
  }
}

function scheduleNextDashboardAuto(){
  if(autoTimer)clearTimeout(autoTimer);

  autoState.nextRun=new Date(Date.now()+DASHBOARD_AUTO_MS).toISOString();

  autoTimer=setTimeout(async()=>{
    const id=`auto_${Date.now()}`;
    setP(id,{status:"queued",message:"Auto-refresh agendado..."});
    await dashboardJob(id,"auto");
    scheduleNextDashboardAuto();
  },DASHBOARD_AUTO_MS);
}

function startDashboardAuto(){
  // Primeira atualização automática 15 segundos após arrancar o servidor.
  autoState.nextRun=new Date(Date.now()+15000).toISOString();

  setTimeout(async()=>{
    const id=`auto_start_${Date.now()}`;
    setP(id,{status:"queued",message:"Primeira atualização automática..."});
    await dashboardJob(id,"auto");
    scheduleNextDashboardAuto();
  },15000);
}


function parseCookies(req){const out={};for(const part of String(req.headers.cookie||"").split(";")){const i=part.indexOf("=");if(i<0)continue;const k=part.slice(0,i).trim(),v=part.slice(i+1).trim();if(k)out[k]=decodeURIComponent(v)}return out}
function signSession(user,exp){const payload=`${user}|${exp}`;const sig=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("hex");return Buffer.from(`${payload}|${sig}`,"utf8").toString("base64url")}
function verifySession(token){try{const raw=Buffer.from(String(token||""),"base64url").toString("utf8");const [user,expStr,sig]=raw.split("|");const exp=Number(expStr);if(!user||!sig||!Number.isFinite(exp)||Date.now()>exp)return false;const expected=crypto.createHmac("sha256",SESSION_SECRET).update(`${user}|${exp}`).digest("hex");if(sig.length!==expected.length)return false;if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;return user===APP_USER}catch{return false}}
function isAuthed(req){return verifySession(parseCookies(req).combo_session)}
function setSessionCookie(res,user){const token=signSession(user,Date.now()+SESSION_TTL_MS);res.setHeader("set-cookie",`combo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`)}
function clearSessionCookie(res){res.setHeader("set-cookie","combo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")}

function json(res,s,o){
  res.writeHead(s,{
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store"
  });
  res.end(JSON.stringify(o));
}

function text(res,status,body,type="text/html; charset=utf-8"){
  res.writeHead(status,{
    "content-type":type,
    "cache-control":"no-store"
  });
  res.end(body);
}

async function body(req){
  let s="";
  for await(const c of req)s+=c;
  return s?JSON.parse(s):{};
}

const jid=()=>`${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
const pub=BASE;
http.createServer(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host||"localhost"}`);
if(req.method==="GET"&&u.pathname==="/login")return text(res,200,fs.readFileSync(path.join(pub,"login.html")),"text/html; charset=utf-8");
if(req.method==="POST"&&u.pathname==="/api/login"){const payload=await body(req);const user=String(payload.user||""),pass=String(payload.password||"");const ua=Buffer.from(user),ub=Buffer.from(APP_USER),pa=Buffer.from(pass),pb=Buffer.from(APP_PASSWORD);const okUser=ua.length===ub.length&&crypto.timingSafeEqual(ua,ub),okPass=pa.length===pb.length&&crypto.timingSafeEqual(pa,pb);if(!okUser||!okPass)return json(res,401,{ok:false,error:"Credenciais inválidas"});setSessionCookie(res,user);return json(res,200,{ok:true})}
if(req.method==="POST"&&u.pathname==="/api/logout"){clearSessionCookie(res);return json(res,200,{ok:true})}
if(!isAuthed(req)){if(u.pathname.startsWith("/api/"))return json(res,401,{error:"unauthorized"});res.writeHead(302,{location:"/login"});return res.end()}
if(req.method==="GET"&&u.pathname==="/api/status")return json(res,200,{
wallets:db.prepare("SELECT COUNT(*) n FROM wallets").get().n,
combos:db.prepare("SELECT COUNT(DISTINCT combo_id) n FROM combo_positions").get().n,
positions:db.prepare("SELECT COUNT(*) n FROM combo_positions").get().n,
tracked:db.prepare("SELECT COUNT(*) n FROM tracked_games").get().n,
dbBytes:(()=>{try{return fs.statSync(DB_PATH).size}catch{return 0}})(),
auto:autoState
});
if(req.method==="GET"&&u.pathname==="/api/dashboard/auto")return json(res,200,{auto:autoState});if(req.method==="POST"&&u.pathname==="/api/track"){const b=await body(req),id=jid();setP(id,{status:"queued",message:"A iniciar..."});trackJob(id,b.input);return json(res,202,{job:id})}if(req.method==="GET"&&u.pathname==="/api/tracked")return json(res,200,{rows:db.prepare("SELECT slug,title,start_time,last_run_utc FROM tracked_games ORDER BY last_run_utc DESC").all()});if(req.method==="POST"&&u.pathname==="/api/dashboard/refresh"){const id=jid();setP(id,{status:"queued",message:"A iniciar..."});dashboardJob(id,"manual");return json(res,202,{job:id})}if(req.method==="GET"&&u.pathname==="/api/dashboard")return json(res,200,{rows:dashboardRows()});if(req.method==="GET"&&u.pathname.startsWith("/api/jobs/"))return json(res,200,progress.get(u.pathname.split("/").pop())||{status:"unknown"});let f=u.pathname==="/"?"index.html":u.pathname.replace(/^\/+/,"");const fp=path.join(pub,f);if(!fp.startsWith(pub)||!fs.existsSync(fp))return json(res,404,{error:"not found"});const ext=path.extname(fp),types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8"};res.writeHead(200,{"content-type":types[ext]||"application/octet-stream","cache-control":"no-store"});res.end(fs.readFileSync(fp))}catch(e){json(res,500,{error:String(e.message||e)})}}).listen(PORT,HOST,()=>{
console.log(`\nCS2 Combo Tracker ONLINE v20.1 SAFE TURBO: http://${HOST}:${PORT}\nDB: ${DB_PATH}\nDashboard automático: 10 em 10 minutos | v9 progress\n`);
startDashboardAuto();
});
