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
$('#refreshDash').onclick=async()=>{const d=await api('/api/dashboard/refresh',{method:'POST'});poll(d.job,$('#dashProgress'),r=>{renderDashboard(r.rows||[]);renderAuto(r.auto)})};async function loadDashboard(){const d=await api('/api/dashboard');renderDashboard(d.rows||[])}function renderDashboard(data){
  const rows=Array.isArray(data)?data:(data?.rows||[]);
  const body=document.querySelector('#dashTable tbody');
  if(!body)return;
  if(!rows.length){
    body.innerHTML='<tr><td colspan="6"><b>Ainda sem dados. Clica em “Atualizar agora”.</b></td></tr>';
    return;
  }
  body.innerHTML=rows.map(r=>`
    <tr>
      <td><b>${esc(r.title||r.jogo||r.event_slug||'')}</b>${r.event_slug?`<div class="muted"><code>${esc(r.event_slug)}</code></div>`:''}</td>
      <td>${esc(r.start_time||r.hora||'')}</td>
      <td class="num"><b>${fmt(r.combo_count??r.combos??0)}</b></td>
      <td class="num"><b>${fmt(r.wallet_count??r.wallets??0)}</b></td>
      <td class="num"><b>${fmt(r.position_count??r.positions??0)}</b></td>
      <td class="num positive"><b>${money(r.open_entry??r.entry_cost_aberto??0)}</b></td>
    </tr>`).join('');
}

function renderTrack(r){
  const combos=r.combos||[];

  function isTargetLeg(l){
    return (r.event?.markets||[]).some(m=>
      String(m.conditionId||m.condition_id||'').toLowerCase()===
      String(l?.condition_id||'').toLowerCase()
    );
  }

  function legLabel(l){
    const outcome=String(l?.outcome||'').trim();
    const market=String(l?.market_title||'').trim();
    const event=String(l?.event_title||'').trim();
    const parts=[];
    if(outcome)parts.push(outcome);
    if(market&&!parts.includes(market))parts.push(market);
    if(event&&!parts.includes(event))parts.push(event);
    return parts.join(' — ')||'Seleção não identificada';
  }

  const detail=[];
  for(const c of combos){
    const target=(c.legs||[]).filter(isTargetLeg);
    const other=(c.legs||[]).filter(l=>!target.includes(l));
    for(const w of c.wallet_list||[]){
      for(const t of (target.length?target:[null])){
        detail.push({
          wallet:w.wallet,
          combo_id:c.combo_id,
          selection:t?legLabel(t):'Seleção não identificada',
          entry:Number(w.entry_cost||w.initial_value||0),
          other
        });
      }
    }
  }

  const totalGame=detail.reduce((a,x)=>a+x.entry,0);
  const wallets=new Set(detail.map(x=>x.wallet));
  const uniqueCombos=new Set(detail.map(x=>x.combo_id));

  $('#trackMetrics').innerHTML=
    `<div class="metric"><span>Total colocado no jogo</span><b>${money(totalGame)}</b></div>`+
    `<div class="metric"><span>Wallets</span><b>${fmt(wallets.size)}</b></div>`+
    `<div class="metric"><span>Combos</span><b>${fmt(uniqueCombos.size)}</b></div>`+
    `<div class="metric"><span>Execução</span><b style="font-size:14px">${r.incremental?'Incremental':'Primeira indexação'}</b></div>`;

  const rows=detail.sort((a,b)=>b.entry-a.entry||a.wallet.localeCompare(b.wallet)).map((x,i)=>{
    const others=x.other.length
      ? x.other.map(l=>`<div class="pick">• ${esc(legLabel(l))}</div>`).join('')
      : '<span class="muted">Sem outras legs</span>';

    return `<tr>
      <td>${i+1}</td>
      <td><code class="walletcode">${esc(x.wallet)}</code></td>
      <td><div class="pick targetpick">🎯 <b>${esc(x.selection)}</b></div></td>
      <td class="num ${x.entry>0?'positive':''}"><b>${x.entry>0?money(x.entry):'—'}</b></td>
      <td>${x.entry>0?'<span class="open">Confirmado</span>':'<span class="closed">Só Activity</span>'}</td>
      <td><code>${esc(x.combo_id)}</code></td>
      <td>${others}</td>
    </tr>`;
  }).join('');

  $('#comboResults').innerHTML=`
    <div class="card">
      <h3 style="margin-top:0">Detalhe por wallet e seleção</h3>
      <div class="position-table-wrap">
        <table class="position-table">
          <thead><tr>
            <th>#</th>
            <th>Wallet</th>
            <th>Seleção / Leg do jogo</th>
            <th>Entry Position / Cost</th>
            <th>Estado do valor</th>
            <th>Combo ID</th>
            <th>Restantes legs da combo</th>
          </tr></thead>
          <tbody>${rows||'<tr><td colspan="7">Sem dados.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  status();
}
loadDashboard();
setInterval(loadDashboard,30000);
