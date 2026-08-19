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
const LOG_CHUNK=5000,TOPIC_FALLBACK_MIN=25,TX_FALLBACK_MAX=3000;

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
  lastRows:0
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
function setP(id,x){progress.set(id,{...x,updated:now()})}function slugOf(x){x=String(x||"").trim();if(/^https?:\/\//i.test(x)){const u=new URL(x);return u.pathname.replace(/\/+$/,"").split("/").pop()}return x.replace(/\/+$/,"").split("/").pop()}
async function fetchJ(url,opt={},retries=4){let last;for(let i=0;i<retries;i++){try{const c=new AbortController(),t=setTimeout(()=>c.abort(),opt.timeout||15000);const r=await fetch(url,{...opt,signal:c.signal,headers:{Accept:"application/json",...(opt.headers||{})}});clearTimeout(t);if(r.status===429||r.status>=500){await sleep(Math.min(500*2**i,5000));continue}if(!r.ok)throw Error(`${r.status} ${r.statusText}`);return await r.json()}catch(e){last=e;await sleep(Math.min(400*2**i,4000))}}throw last||Error("request failed")}
async function rpc(method,params){let last;for(let a=0;a<5;a++){for(let j=0;j<RPCS.length;j++){const idx=(rpcIdx+j)%RPCS.length;try{const d=await fetchJ(RPCS[idx],{method:"POST",timeout:15000,headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})},1);if(d.error)throw Error(JSON.stringify(d.error));rpcIdx=idx;return d.result}catch(e){last=e}}await sleep(500*(a+1))}throw last}
async function latest(){return parseInt(await rpc("eth_blockNumber",[]),16)}async function blockTs(n){const b=await rpc("eth_getBlockByNumber",["0x"+n.toString(16),false]);return parseInt(b.timestamp,16)}async function findBlock(ts,hi){let lo=1;while(lo<hi){const m=Math.floor((lo+hi)/2);if(await blockTs(m)<ts)lo=m+1;else hi=m}return lo}
function topicAddr(t){if(typeof t!=="string"||!/^0x[a-fA-F0-9]{64}$/.test(t))return null;const r=t.slice(2).toLowerCase();if(r.slice(0,24)!=="0".repeat(24))return null;const a="0x"+r.slice(-40);return /^0x[a-f0-9]{40}$/.test(a)&&!IGNORE.has(a)?a:null}
async function scanLogs(lo,hi,cb){if(lo>hi)return{wallets:[],txs:[],logs:0};const ranges=[];for(let s=lo;s<=hi;s+=LOG_CHUNK)ranges.push([s,Math.min(s+LOG_CHUNK-1,hi)]);const ws=new Set(),txs=new Set();let logs=0,done=0;const queue=[...ranges];async function worker(){while(queue.length){const [s,e]=queue.shift();try{const rows=await rpc("eth_getLogs",[{fromBlock:"0x"+s.toString(16),toBlock:"0x"+e.toString(16),address:CONTRACTS}])||[];logs+=rows.length;for(const row of rows){if(row.transactionHash)txs.add(String(row.transactionHash).toLowerCase());for(const t of (row.topics||[]).slice(1)){const a=topicAddr(t);if(a)ws.add(a)}}}catch{}done++;cb&&cb({done,total:ranges.length,wallets:ws.size,logs})}}await Promise.all(Array.from({length:Math.min(5,ranges.length||1)},worker));return{wallets:[...ws],txs:[...txs],logs}}
async function txSender(h){try{const t=await rpc("eth_getTransactionByHash",[h]),a=String(t?.from||"").toLowerCase();return /^0x[a-f0-9]{40}$/.test(a)&&!IGNORE.has(a)?a:null}catch{return null}}
async function txFallback(txs,cb){const list=[...txs].sort().slice(0,TX_FALLBACK_MAX),out=new Set();let done=0;await mapPool(list,8,async h=>{const a=await txSender(h);if(a)out.add(a);done++;cb&&cb(done,list.length,out.size);return a});return[...out]}
async function positions(w){const out=[];let c=null;do{const u=new URL(`${DATA}/v1/positions/combos`);u.searchParams.set("user",w);u.searchParams.set("limit","1000");u.searchParams.set("sort","first_entry_desc");if(c)u.searchParams.set("cursor",c);let d;try{d=await fetchJ(u.toString(),{timeout:12000},3)}catch{break}out.push(...(d.combos||[]));c=(d.pagination||{}).has_more?(d.pagination||{}).next_cursor:null}while(c);return out}
async function activity(w){const out=[];let c=null;do{const u=new URL(`${DATA}/v1/activity/combos`);u.searchParams.set("user",w);u.searchParams.set("limit","500");if(c)u.searchParams.set("cursor",c);let d;try{d=await fetchJ(u.toString(),{timeout:12000},3)}catch{break}out.push(...(d.activity||[]));c=(d.pagination||{}).has_more?(d.pagination||{}).next_cursor:null}while(c);return out}
function legCid(l){return String(l.leg_condition_id||"").toLowerCase()}function legLabel(l){const m=l.market||{},e=m.event||{};return{condition_id:legCid(l),event_slug:String(e.event_slug||""),event_title:String(e.event_title||""),market_slug:String(m.slug||""),market_title:String(m.title||""),outcome:String(l.leg_outcome_label||m.outcome||"")}}
function saveLegs(cid,legs){let i=0;for(const l of legs||[]){i++;const x=legLabel(l);if(!x.condition_id)continue;q.leg.run(cid,Number(l.leg_index||i),x.condition_id,x.event_slug,x.event_title,x.market_slug,x.market_title,x.outcome)}}
function comboMatch(c,target){return(c.legs||[]).some(l=>target.has(legCid(l)))}
async function refreshActivityWallet(w,target,slug){const rows=await activity(w);let matches=0;for(const a of rows){if(!comboMatch(a,target))continue;matches++;const cid=String(a.combo_condition_id||"");if(!cid)continue;q.act.run(w,cid,String(a.combo_position_id||""),String(a.tx_hash||""),String(a.log_index??""),String(a.event_kind||""),String(a.module_kind||""),num(a.amount_usdc),num(a.payout_usdc),String(a.tx_dttm||a.timestamp||""),now());saveLegs(cid,a.legs||[]);db.prepare("INSERT OR IGNORE INTO tracked_matches(slug,wallet) VALUES(?,?)").run(slug,w);db.prepare("INSERT OR IGNORE INTO tracked_combo_seen(slug,combo_id,first_seen_utc) VALUES(?,?,?)").run(slug,cid,now())}return matches}
async function refreshPositionsWallet(w,target,slug){const rows=await positions(w);let matches=0;for(const c of rows){if(!comboMatch(c,target))continue;matches++;const cid=String(c.combo_condition_id||c.combo_position_id||"");if(!cid)continue;q.pos.run(w,cid,String(c.combo_position_id||cid),num(c.entry_cost_usdc),num(c.total_cost_usdc),num(c.current_value_usdc),num(c.shares_balance),String(c.status||""),String(c.first_entry_at||""),String(c.resolved_at||""),String(c.updated_at||""),now());saveLegs(cid,c.legs||[]);db.prepare("INSERT OR IGNORE INTO tracked_matches(slug,wallet) VALUES(?,?)").run(slug,w);db.prepare("INSERT OR IGNORE INTO tracked_combo_seen(slug,combo_id,first_seen_utc) VALUES(?,?,?)").run(slug,cid,now())}return matches}
async function mapPool(items,limit,fn,cb){const qx=[...items];let done=0,hits=0;async function w(){while(qx.length){const x=qx.shift();try{if(await fn(x))hits++}catch{}done++;cb&&cb({done,total:items.length,hits})}}await Promise.all(Array.from({length:Math.min(limit,items.length||1)},w))}
async function eventBySlug(s){return await fetchJ(`${GAMMA}/events/slug/${encodeURIComponent(s)}`,{timeout:10000},3)}
async function relatedEvents(main){const out=new Map([[String(main.slug||""),main]]),gid=main.gameId||main.game_id||(main.sports||{}).gameId;if(!gid)return[...out.values()];let c=null;for(let i=0;i<5;i++){const u=new URL(`${GAMMA}/events/keyset`);u.searchParams.set("game_id",String(gid));u.searchParams.set("limit","100");if(c)u.searchParams.set("after_cursor",c);let d;try{d=await fetchJ(u.toString(),{timeout:10000},3)}catch{break}for(const e of(d.events||d.items||[])){const s=String(e.slug||"");if(!s)continue;try{out.set(s,await eventBySlug(s))}catch{out.set(s,e)}}c=d.next_cursor||d.nextCursor||null;if(!c)break}return[...out.values()]}
function marketRows(events){const rows=[];for(const e of events)for(const m of e.markets||[]){const cid=String(m.conditionId||m.condition_id||"").toLowerCase();if(cid)rows.push({condition_id:cid,market_slug:String(m.slug||""),market_title:String(m.question||m.title||"")})}return rows}
function startMs(events){const xs=[];for(const e of events)for(const k of["creationDate","createdAt","startDate"]){const x=Date.parse(e[k]||"");if(Number.isFinite(x))xs.push(x)}return Math.max(xs.length?Math.min(...xs)-4*3600e3:Date.now()-5*86400e3,Date.now()-30*86400e3)}
function trackedResult(slug,main,target){const ids=[...target],marks=ids.map(()=>"?").join(",");if(!ids.length)return{event:main,combos:[],newCombos:0};const combos=db.prepare(`WITH m AS(SELECT DISTINCT combo_id FROM combo_legs WHERE condition_id IN (${marks})),p AS(SELECT p.combo_id,COUNT(DISTINCT p.wallet) wallets,COUNT(*) positions,SUM(CASE WHEN (p.resolved_at IS NULL OR p.resolved_at='') AND p.shares>0.0001 THEN p.entry_cost ELSE 0 END) open_entry,SUM(p.entry_cost) total_entry FROM combo_positions p JOIN m ON m.combo_id=p.combo_id GROUP BY p.combo_id),a AS(SELECT a.combo_id,COUNT(*) activity_events,SUM(a.amount_usdc) activity_amount FROM combo_activity a JOIN m ON m.combo_id=a.combo_id GROUP BY a.combo_id) SELECT p.*,COALESCE(a.activity_events,0) activity_events,COALESCE(a.activity_amount,0) activity_amount FROM p LEFT JOIN a ON a.combo_id=p.combo_id ORDER BY open_entry DESC,total_entry DESC`).all(...ids);for(const c of combos){c.legs=db.prepare("SELECT leg_index,condition_id,event_title,market_title,outcome,event_slug,market_slug FROM combo_legs WHERE combo_id=? ORDER BY leg_index").all(c.combo_id);c.wallet_list=db.prepare("SELECT wallet,position_id,entry_cost,total_cost,current_value,shares,status,first_entry_at,resolved_at FROM combo_positions WHERE combo_id=? ORDER BY entry_cost DESC").all(c.combo_id);c.first_seen=db.prepare("SELECT first_seen_utc FROM tracked_combo_seen WHERE slug=? AND combo_id=?").get(slug,c.combo_id)?.first_seen_utc||""}return{event:main,combos}}
async function trackJob(id,input){try{const slug=slugOf(input);setP(id,{status:"running",message:"A identificar o jogo..."});const main=await eventBySlug(slug),events=await relatedEvents(main),mrs=marketRows(events),target=new Set(mrs.map(x=>x.condition_id));db.prepare("INSERT INTO tracked_games(slug,event_id,title,start_time,last_scanned_block,last_run_utc) VALUES(?,?,?,?,0,?) ON CONFLICT(slug) DO UPDATE SET event_id=excluded.event_id,title=excluded.title,start_time=excluded.start_time").run(slug,String(main.id||""),String(main.title||slug),String(main.startDate||main.endDate||""),now());for(const m of mrs)db.prepare("INSERT OR REPLACE INTO tracked_markets(slug,condition_id,market_slug,market_title) VALUES(?,?,?,?)").run(slug,m.condition_id,m.market_slug,m.market_title);
const tg=db.prepare("SELECT last_scanned_block FROM tracked_games WHERE slug=?").get(slug),hi=await latest();let lo=Number(tg?.last_scanned_block||0);const first=!lo;if(first)lo=await findBlock(Math.floor(startMs(events)/1000),hi);else lo++;
const before=new Set(db.prepare("SELECT combo_id FROM tracked_combo_seen WHERE slug=?").all(slug).map(r=>r.combo_id));setP(id,{status:"running",message:first?"Primeira indexação on-chain...":"A procurar atividade nova..."});const sc=await scanLogs(lo,hi,p=>setP(id,{status:"running",message:`Blockchain ${p.done}/${p.total} · ${p.wallets} wallets`,...p}));let discovered=new Set(sc.wallets);if(discovered.size<TOPIC_FALLBACK_MIN&&sc.txs.length){setP(id,{status:"running",message:"Poucas wallets nos topics; fallback tx.from limitado..."});for(const w of await txFallback(sc.txs,(d,t,n)=>setP(id,{status:"running",message:`Fallback TX ${d}/${t} · ${n} wallets`})) )discovered.add(w)}const oldCand=new Set(db.prepare("SELECT wallet FROM tracked_candidates WHERE slug=?").all(slug).map(r=>r.wallet)),newCand=[...discovered].filter(w=>!oldCand.has(w));for(const w of discovered)db.prepare("INSERT OR IGNORE INTO tracked_candidates(slug,wallet) VALUES(?,?)").run(slug,w);
const knownMatch=db.prepare("SELECT wallet FROM tracked_matches WHERE slug=?").all(slug).map(r=>r.wallet);setP(id,{status:"running",message:`Activity: ${newCand.length} novas + ${knownMatch.length} wallets conhecidas`});const actWallets=[...new Set([...newCand,...knownMatch])];await mapPool(actWallets,12,w=>refreshActivityWallet(w,target,slug),p=>setP(id,{status:"running",message:`Activity ${p.done}/${p.total}`,...p}));const matches=db.prepare("SELECT wallet FROM tracked_matches WHERE slug=?").all(slug).map(r=>r.wallet);setP(id,{status:"running",message:`Positions: ${matches.length} wallets relevantes`});await mapPool(matches,14,w=>refreshPositionsWallet(w,target,slug),p=>setP(id,{status:"running",message:`Positions ${p.done}/${p.total}`,...p}));db.prepare("UPDATE tracked_games SET last_scanned_block=?,last_run_utc=? WHERE slug=?").run(hi,now(),slug);const result=trackedResult(slug,main,target),after=new Set(result.combos.map(c=>c.combo_id));result.newCombos=[...after].filter(x=>!before.has(x)).length;result.incremental=!first;result.newCandidateWallets=newCand.length;setP(id,{status:"done",message:`Concluído: ${result.combos.length} combos · ${result.newCombos} novas`,result})}catch(e){setP(id,{status:"error",message:String(e.message||e)})}}
async function activeCS2(){const found=new Map();for(const query of["CS2","Counter-Strike 2","Counter Strike"]){for(let page=1;page<=5;page++){const u=new URL(`${GAMMA}/public-search`);u.searchParams.set("q",query);u.searchParams.set("limit_per_type","50");u.searchParams.set("page",String(page));u.searchParams.set("keep_closed_markets","0");u.searchParams.set("search_profiles","false");u.searchParams.set("search_tags","false");let d;try{d=await fetchJ(u.toString(),{timeout:10000},3)}catch{break}for(const e of d.events||[]){const s=String(e.slug||""),t=String(e.title||"").toLowerCase();if(s&&e.closed!==true&&(s.toLowerCase().startsWith("cs2-")||t.includes("counter strike")||t.includes("counter-strike")))found.set(s,e)}if(!(d.pagination||{}).hasMore)break}}return[...found.values()]}
async function refreshActive(){const events=await activeCS2(),ts=now();db.exec("DELETE FROM active_games;DELETE FROM active_game_markets;");for(const e0 of events){let e=e0;if(!e.markets){try{e=await eventBySlug(e.slug)}catch{}}const key=String(e.id?`event:${e.id}`:`slug:${e.slug}`);db.prepare("INSERT OR REPLACE INTO active_games(game_key,event_id,event_slug,title,start_time,refreshed_at) VALUES(?,?,?,?,?,?)").run(key,String(e.id||""),String(e.slug||""),String(e.title||""),String(e.startDate||e.endDate||""),ts);for(const m of marketRows([e]))db.prepare("INSERT OR REPLACE INTO active_game_markets(game_key,condition_id,market_slug,market_title) VALUES(?,?,?,?)").run(key,m.condition_id,m.market_slug,m.market_title)}return events.length}

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

function dashboardRows(){return db.prepare(`WITH linked AS(SELECT ag.game_key,ag.event_slug,ag.title,ag.start_time,cl.combo_id FROM active_games ag JOIN active_game_markets gm ON gm.game_key=ag.game_key JOIN combo_legs cl ON cl.condition_id=gm.condition_id GROUP BY ag.game_key,cl.combo_id),agg AS(SELECT l.game_key,l.event_slug,l.title,l.start_time,COUNT(DISTINCT l.combo_id) combo_count,COUNT(DISTINCT p.wallet) wallet_count,COUNT(p.position_id) position_count,SUM(CASE WHEN (p.resolved_at IS NULL OR p.resolved_at='') AND p.shares>0.0001 THEN p.entry_cost ELSE 0 END) open_entry FROM linked l LEFT JOIN combo_positions p ON p.combo_id=l.combo_id GROUP BY l.game_key) SELECT * FROM agg ORDER BY open_entry DESC,combo_count DESC`).all()}
async function dashboardJob(id,source="manual"){
  if(dashboardRunning){
    setP(id,{status:"done",message:"Já existe uma atualização do Dashboard em curso.",result:{rows:dashboardRows(),auto:autoState}});
    return;
  }

  dashboardRunning=true;
  autoState.running=true;
  autoState.lastStarted=now();
  autoState.lastError=null;

  const combosBefore=Number(db.prepare("SELECT COUNT(DISTINCT combo_id) n FROM combo_positions").get().n||0);
  const walletsBefore=Number(db.prepare("SELECT COUNT(*) n FROM dashboard_match_wallets").get().n||0);

  try{
    setP(id,{status:"running",message:source==="auto"?"Auto-refresh: a atualizar jogos CS2 ativos...":"A atualizar jogos CS2 ativos..."});
    await refreshActive();
    cleanupDatabase();

    const hi=await latest();
    let lo=Number(q.getMeta.get("dashboard_last_block")?.value||0);

    if(!lo){
      lo=await findBlock(Math.floor((Date.now()-5*86400e3)/1000),hi);
    }else{
      lo++;
    }

    setP(id,{status:"running",message:"A procurar novas wallets Combo..."});
    const sc=await scanLogs(
      lo,
      hi,
      p=>setP(id,{status:"running",message:`Blockchain ${p.done}/${p.total} · ${p.wallets} wallets`,...p})
    );

    q.setMeta.run("dashboard_last_block",String(hi));

    const known=db.prepare(
      "SELECT wallet FROM dashboard_match_wallets UNION SELECT wallet FROM tracked_matches"
    ).all().map(r=>r.wallet);

    const wallets=[...new Set([...sc.wallets,...known])];

    setP(id,{status:"running",message:`A atualizar ${wallets.length} wallets (novas + relevantes)...`});

    await mapPool(
      wallets,
      18,
      async w=>{
        const rows=await positions(w);
        let matched=false;

        for(const c of rows){
          const cid=String(c.combo_condition_id||c.combo_position_id||"");
          if(!cid)continue;

          // CRITICAL v6 optimization:
          // Do NOT persist every combo held by the wallet.
          // Only persist a combo when at least one leg belongs to an active CS2 game.
          const hits=(c.legs||[]).some(l=>
            db.prepare("SELECT 1 FROM active_game_markets WHERE condition_id=? LIMIT 1").get(legCid(l))
          );

          if(!hits)continue;

          matched=true;
          saveLegs(cid,c.legs||[]);

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
        }

        if(matched){
          db.prepare(
            "INSERT OR REPLACE INTO dashboard_match_wallets(wallet,last_match_utc) VALUES(?,?)"
          ).run(w,now());
        }

        return matched;
      },
      p=>setP(id,{status:"running",message:`Wallets ${p.done}/${p.total}`,...p})
    );

    cleanupDatabase();
    const rows=dashboardRows();
    const combosAfter=Number(db.prepare("SELECT COUNT(DISTINCT combo_id) n FROM combo_positions").get().n||0);
    const walletsAfter=Number(db.prepare("SELECT COUNT(*) n FROM dashboard_match_wallets").get().n||0);

    autoState.lastNewCombos=Math.max(0,combosAfter-combosBefore);
    autoState.lastNewWallets=Math.max(0,walletsAfter-walletsBefore);
    autoState.lastRows=rows.length;
    autoState.lastFinished=now();

    setP(id,{
      status:"done",
      message:`Dashboard atualizado: ${rows.length} jogos · +${autoState.lastNewCombos} combos · +${autoState.lastNewWallets} wallets`,
      result:{rows,auto:autoState}
    });

  }catch(e){
    autoState.lastError=String(e.message||e);
    autoState.lastFinished=now();
    setP(id,{status:"error",message:autoState.lastError});
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
console.log(`\nCS2 Combo Tracker ONLINE v6 OPTIMIZED: http://${HOST}:${PORT}\nDB: ${DB_PATH}\nDashboard automático: 10 em 10 minutos\n`);
startDashboardAuto();
});
