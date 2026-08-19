const logoutBtn=document.getElementById('logoutBtn');if(logoutBtn)logoutBtn.onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.href='/login'};
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];const money=x=>new Intl.NumberFormat('pt-PT',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(x||0)),fmt=x=>new Intl.NumberFormat('pt-PT').format(Number(x||0)),esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
$$('.nav').forEach(b=>b.onclick=()=>{$$('.nav').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('.page').forEach(x=>x.classList.remove('active'));$('#'+b.dataset.page).classList.add('active');if(b.dataset.page==='dashboard')loadDashboard()});
async function api(u,o){const r=await fetch(u,o);return r.json()}
function shortTime(v){
  if(!v)return '—';
  const d=new Date(v);
  if(Number.isNaN(d.getTime()))return '—';
  return d.toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function renderAuto(auto){
  if(!auto)return;
  $('#autoLast').textContent=shortTime(auto.lastFinished);
  $('#autoNext').textContent=shortTime(auto.nextRun);
  $('#autoCombos').textContent=fmt(auto.lastNewCombos||0);
  $('#autoWallets').textContent=fmt(auto.lastNewWallets||0);
  const strip=document.querySelector('.auto-strip');
  if(strip)strip.classList.toggle('running',!!auto.running);
  const box=document.getElementById('dashProgress');
  if(box){
    if(auto.running){
      box.classList.remove('hidden');
      box.textContent=auto.message||'Atualização automática em curso...';
    }else if(auto.lastError){
      box.classList.remove('hidden');
      box.textContent='Erro: '+auto.lastError;
    }else if(auto.lastFinished){
      box.classList.add('hidden');
    }
  }
}
async function status(){
  try{
    const s=await api('/api/status');
    $('#dbStatus').innerHTML=`<b>${fmt(s.combos)} combos indexadas</b><br>${fmt(s.wallets)} wallets · ${fmt(s.positions)} posições<br>${fmt(s.tracked)} jogos em tracking`;
    renderAuto(s.auto);
  }catch{
    $('#dbStatus').textContent='Servidor offline'
  }
}
status();
setInterval(status,15000);
async function poll(job,box,done){box.classList.remove('hidden');for(;;){const d=await api('/api/jobs/'+job);box.textContent=d.message||d.status;if(d.status==='done'){done(d.result);return}if(d.status==='error'){box.textContent='Erro: '+d.message;return}await new Promise(r=>setTimeout(r,700))}}
$('#refreshDash').onclick=async()=>{const d=await api('/api/dashboard/refresh',{method:'POST'});poll(d.job,$('#dashProgress'),r=>{renderDashboard(r.rows||[]);renderAuto(r.auto)})};async function loadDashboard(){const d=await api('/api/dashboard');renderDashboard(d.rows||[])}function renderDashboard(rows){$('#dashBody').innerHTML=rows.map(r=>`<tr><td><b>${esc(r.title)}</b><br><small>${esc(r.event_slug||'')}</small></td><td>${esc(r.start_time||'')}</td><td class="num">${fmt(r.combo_count)}</td><td class="num">${fmt(r.wallet_count)}</td><td class="num">${fmt(r.position_count)}</td><td class="num ${Number(r.open_entry)>0?'positive':'zero'}"><b>${money(r.open_entry)}</b></td></tr>`).join('')||'<tr><td colspan="6">Ainda sem dados. Clica em “Atualizar agora”.</td></tr>';status()}
$('#trackBtn').onclick=async()=>{const input=$('#gameInput').value.trim();if(!input)return;$('#comboResults').innerHTML='';$('#trackMetrics').innerHTML='';const d=await api('/api/track',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input})});poll(d.job,$('#trackProgress'),renderTrack)};
function renderTrack(r){
  const combos=r.combos||[],wallets=new Set(combos.flatMap(c=>(c.wallet_list||[]).map(w=>w.wallet)));
  const sum=k=>combos.reduce((a,c)=>a+Number(c[k]||0),0);
  $('#trackMetrics').innerHTML=
    `<div class="metric"><span>Combos acumuladas</span><b>${fmt(combos.length)}</b></div>`+
    `<div class="metric"><span>Novas nesta execução</span><b>${fmt(r.newCombos||0)}</b></div>`+
    `<div class="metric"><span>Wallets</span><b>${fmt(wallets.size)}</b></div>`+
    `<div class="metric"><span>Entry Cost aberto</span><b>${money(sum('open_entry'))}</b></div>`+
    `<div class="metric"><span>Activity Amount</span><b>${money(sum('activity_amount'))}</b></div>`+
    `<div class="metric"><span>Current Value</span><b>${money(sum('current_value'))}</b></div>`+
    `<div class="metric"><span>Realized PnL</span><b>${money(sum('realized_pnl'))}</b></div>`+
    `<div class="metric"><span>Unrealized PnL</span><b>${money(sum('unrealized_pnl'))}</b></div>`+
    `<div class="metric"><span>Execução</span><b style="font-size:14px">${r.incremental?'Incremental':'Primeira indexação'}</b></div>`;
  const show=(ok,v,type='money')=>ok?(type==='num'?fmt(v):money(v)):'—';
  $('#comboResults').innerHTML=combos.map((c,i)=>{
    const target=(c.legs||[]).filter(l=>(r.event?.markets||[]).some(m=>String(m.conditionId||m.condition_id||'').toLowerCase()===String(l.condition_id||'').toLowerCase()));
    const other=(c.legs||[]).filter(l=>!target.includes(l));
    return `<div class="combo"><div class="combohead"><b>#${i+1}</b><code>${esc(c.combo_id)}</code><b class="positive">${money(c.open_entry||0)} aberto</b><span>${fmt(c.wallets)} wallets</span><span>${money(c.activity_amount||0)} activity</span></div>
    <div class="combo-grid"><div class="combo-section"><h3>Seleção no jogo</h3>${target.map(l=>`<div class="pick targetpick">🎯 <b>${esc(l.outcome)}</b> — ${esc(l.market_title||l.event_title)}</div>`).join('')}</div>
    <div class="combo-section"><h3>Restantes legs</h3>${other.map(l=>`<div class="pick">• <b>${esc(l.outcome)}</b> — ${esc(l.event_title)} · ${esc(l.market_title)}</div>`).join('')||'<div class="pick muted">Sem outras legs</div>'}</div></div>
    <div class="position-table-wrap"><table class="position-table"><thead><tr><th>Wallet</th><th>Fonte</th><th>Estado</th><th>Entry / Initial</th><th>Activity Amount</th><th>Total Bought</th><th>Avg Price</th><th>Current Value</th><th>Shares</th><th>Realized PnL</th><th>Unrealized PnL</th><th>Payout</th><th>1.ª entrada/activity</th></tr></thead><tbody>
    ${(c.wallet_list||[]).map(w=>{const ok=!!w.enriched,state=w.status==='Aberta'?'<span class="open">Aberta</span>':w.status==='Fechada'?'<span class="closed">Fechada</span>':'<span class="closed">Só Activity</span>';
      return `<tr><td><code class="walletcode">${esc(w.wallet)}</code></td><td><code>${esc(w.data_source||w.source||'ACTIVITY')}</code></td><td>${state}</td>
      <td class="num"><b>${show(ok,w.entry_cost)}</b></td><td class="num positive"><b>${money(w.activity_amount||0)}</b></td><td class="num">${show(ok,w.total_bought)}</td>
      <td class="num">${ok?Number(w.avg_price||0).toFixed(4):'—'}</td><td class="num">${show(ok,w.current_value)}</td><td class="num">${show(ok,w.shares,'num')}</td>
      <td class="num">${show(ok,w.realized_pnl)}</td><td class="num">${show(ok,w.unrealized_pnl)}</td><td class="num">${money(w.activity_payout||0)}</td><td>${esc(w.first_entry_at||w.first_activity_at||'')}</td></tr>`}).join('')}
    </tbody></table></div></div>`}).join('')||'<div class="card">Nenhuma combo encontrada na cobertura indexada.</div>';
  status();
}
loadDashboard();
setInterval(loadDashboard,30000);
