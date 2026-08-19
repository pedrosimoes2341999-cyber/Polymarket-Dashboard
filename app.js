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
  const combos=r.combos||[];

  function legLabel(l){
    const outcome=String(l?.outcome||'').trim();
    const market=String(l?.market_title||'').trim();
    const event=String(l?.event_title||'').trim();
    const parts=[];
    if(outcome)parts.push(outcome);
    if(market && !parts.includes(market))parts.push(market);
    if(event && !parts.includes(event))parts.push(event);
    return parts.join(' — ')||'Leg sem descrição';
  }

  function isTargetLeg(l){
    return (r.event?.markets||[]).some(m=>
      String(m.conditionId||m.condition_id||'').toLowerCase()===
      String(l?.condition_id||'').toLowerCase()
    );
  }

  // -------- GLOBAL TOTALS --------
  const allRows=[];
  for(const c of combos){
    const targetLegs=(c.legs||[]).filter(isTargetLeg);
    const otherLegs=(c.legs||[]).filter(l=>!targetLegs.includes(l));

    for(const w of c.wallet_list||[]){
      allRows.push({
        combo_id:c.combo_id,
        wallet:w.wallet,
        placed:Number(w.placed_amount||0),
        confirmed:w.placed_source==="CONFIRMADO"?Number(w.placed_amount||0):0,
        estimated:w.placed_source==="ESTIMADO_ACTIVITY"?Number(w.placed_amount||0):0,
        source:w.placed_source||"SEM_DADOS",
        targetLegs,
        otherLegs
      });
    }
  }

  const total=allRows.reduce((a,x)=>a+x.placed,0);
  const confirmed=allRows.reduce((a,x)=>a+x.confirmed,0);
  const estimated=allRows.reduce((a,x)=>a+x.estimated,0);
  const wallets=new Set(allRows.map(x=>x.wallet));

  $('#trackMetrics').innerHTML=
    `<div class="metric"><span>Total colocado neste jogo</span><b>${money(total)}</b></div>`+
    `<div class="metric"><span>Confirmado</span><b>${money(confirmed)}</b></div>`+
    `<div class="metric"><span>Estimado via Activity</span><b>${money(estimated)}</b></div>`+
    `<div class="metric"><span>Wallets</span><b>${fmt(wallets.size)}</b></div>`+
    `<div class="metric"><span>Combos</span><b>${fmt(combos.length)}</b></div>`+
    `<div class="metric"><span>Execução</span><b style="font-size:14px">${r.incremental?'Incremental':'Primeira indexação'}</b></div>`;

  // -------- GROUP BY TARGET LEG --------
  const legGroups=new Map();

  for(const row of allRows){
    const targets=row.targetLegs.length?row.targetLegs:[null];

    for(const leg of targets){
      const key=leg
        ? `${String(leg.condition_id||'').toLowerCase()}|${String(leg.outcome||'').toLowerCase()}`
        : 'SEM_LEG';

      if(!legGroups.has(key)){
        legGroups.set(key,{
          label:leg?legLabel(leg):'Leg do jogo não identificada',
          total:0,
          confirmed:0,
          estimated:0,
          wallets:new Set(),
          combos:new Set(),
          rows:[]
        });
      }

      const g=legGroups.get(key);
      g.total+=row.placed;
      g.confirmed+=row.confirmed;
      g.estimated+=row.estimated;
      g.wallets.add(row.wallet);
      g.combos.add(row.combo_id);
      g.rows.push({...row,targetLeg:leg});
    }
  }

  const groups=[...legGroups.values()].sort((a,b)=>b.total-a.total);

  const groupCards=groups.map((g,gi)=>{
    const detailRows=g.rows
      .slice()
      .sort((a,b)=>b.placed-a.placed)
      .map((x,i)=>{
        const others=x.otherLegs.length
          ? x.otherLegs.map(l=>`<div class="pick">• ${esc(legLabel(l))}</div>`).join('')
          : '<span class="muted">Sem outras legs</span>';

        const quality=x.source==="CONFIRMADO"
          ? '<span class="open">Confirmado</span>'
          : x.source==="ESTIMADO_ACTIVITY"
            ? '<span class="closed">Estimado via Activity</span>'
            : '<span class="muted">Sem dados</span>';

        return `<tr>
          <td>${i+1}</td>
          <td><code class="walletcode">${esc(x.wallet)}</code></td>
          <td class="num positive"><b>${money(x.placed)}</b></td>
          <td>${quality}</td>
          <td><code>${esc(x.combo_id)}</code></td>
          <td>${others}</td>
        </tr>`;
      }).join('');

    return `<div class="combo" style="margin-bottom:16px">
      <div class="combohead">
        <b>#${gi+1}</b>
        <span style="flex:1"><b>${esc(g.label)}</b></span>
        <b class="positive">${money(g.total)}</b>
        <span>${fmt(g.wallets.size)} wallets</span>
        <span>${fmt(g.combos.size)} combos</span>
      </div>

      <div class="combo-grid">
        <div class="combo-section">
          <h3>Resumo da leg</h3>
          <div class="pick targetpick">🎯 <b>${esc(g.label)}</b></div>
        </div>
        <div class="combo-section">
          <h3>Valor colocado</h3>
          <div class="pick">Total: <b>${money(g.total)}</b></div>
          <div class="pick">Confirmado: <b>${money(g.confirmed)}</b></div>
          <div class="pick">Estimado via Activity: <b>${money(g.estimated)}</b></div>
        </div>
      </div>

      <div class="position-table-wrap">
        <table class="position-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Wallet</th>
              <th>Valor colocado</th>
              <th>Qualidade</th>
              <th>Combo ID</th>
              <th>Restantes legs da combo</th>
            </tr>
          </thead>
          <tbody>${detailRows||'<tr><td colspan="6">Sem detalhe.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  // -------- WALLET TOTAL ACROSS ALL TARGET LEGS --------
  const walletMap=new Map();
  for(const x of allRows){
    if(!walletMap.has(x.wallet)){
      walletMap.set(x.wallet,{
        wallet:x.wallet,total:0,confirmed:0,estimated:0,
        combos:new Set(),legs:new Set()
      });
    }
    const w=walletMap.get(x.wallet);
    w.total+=x.placed;
    w.confirmed+=x.confirmed;
    w.estimated+=x.estimated;
    w.combos.add(x.combo_id);
    for(const l of x.targetLegs)w.legs.add(legLabel(l));
  }

  const walletRows=[...walletMap.values()]
    .sort((a,b)=>b.total-a.total)
    .map((w,i)=>`<tr>
      <td>${i+1}</td>
      <td><code class="walletcode">${esc(w.wallet)}</code></td>
      <td class="num positive"><b>${money(w.total)}</b></td>
      <td class="num">${money(w.confirmed)}</td>
      <td class="num">${money(w.estimated)}</td>
      <td>${[...w.legs].map(x=>`<div class="pick">🎯 ${esc(x)}</div>`).join('')}</td>
      <td class="num">${fmt(w.combos.size)}</td>
    </tr>`).join('');

  $('#comboResults').innerHTML=`
    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-top:0">Resumo por wallet</h3>
      <div class="position-table-wrap">
        <table class="position-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Wallet</th>
              <th>Total colocado</th>
              <th>Confirmado</th>
              <th>Estimado via Activity</th>
              <th>Leg(s) do jogo</th>
              <th>N.º Combos</th>
            </tr>
          </thead>
          <tbody>${walletRows||'<tr><td colspan="7">Sem dados.</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div style="margin:18px 0 10px">
      <h2 style="margin:0">Detalhe agrupado por leg colocada</h2>
      <p class="muted" style="margin-top:6px">
        O valor pertence à combo inteira; a leg abaixo indica a seleção deste jogo presente nessa combo.
      </p>
    </div>

    ${groupCards||'<div class="card">Nenhuma leg encontrada.</div>'}`;

  status();
}
loadDashboard();
setInterval(loadDashboard,30000);
