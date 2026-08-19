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

  const byWallet=new Map();
  for(const c of combos){
    for(const w of c.wallet_list||[]){
      const key=w.wallet;
      if(!byWallet.has(key)){
        byWallet.set(key,{
          wallet:key,
          total:0,
          confirmed:0,
          estimated:0,
          combos:0,
          sources:new Set()
        });
      }
      const g=byWallet.get(key);
      g.total+=Number(w.placed_amount||0);
      if(w.placed_source==="CONFIRMADO")g.confirmed+=Number(w.placed_amount||0);
      if(w.placed_source==="ESTIMADO_ACTIVITY")g.estimated+=Number(w.placed_amount||0);
      if(Number(w.placed_amount||0)>0)g.combos+=1;
      g.sources.add(w.placed_source||"SEM_DADOS");
    }
  }

  const wallets=[...byWallet.values()].sort((a,b)=>b.total-a.total);
  const total=wallets.reduce((a,w)=>a+w.total,0);
  const confirmed=wallets.reduce((a,w)=>a+w.confirmed,0);
  const estimated=wallets.reduce((a,w)=>a+w.estimated,0);

  $('#trackMetrics').innerHTML=
    `<div class="metric"><span>Total colocado neste jogo</span><b>${money(total)}</b></div>`+
    `<div class="metric"><span>Confirmado</span><b>${money(confirmed)}</b></div>`+
    `<div class="metric"><span>Estimado via Activity</span><b>${money(estimated)}</b></div>`+
    `<div class="metric"><span>Wallets</span><b>${fmt(wallets.length)}</b></div>`+
    `<div class="metric"><span>Combos</span><b>${fmt(combos.length)}</b></div>`+
    `<div class="metric"><span>Execução</span><b style="font-size:14px">${r.incremental?'Incremental':'Primeira indexação'}</b></div>`;

  const comboBlocks=combos.map((c,i)=>`
    <div class="combo">
      <div class="combohead">
        <b>#${i+1}</b>
        <code>${esc(c.combo_id)}</code>
        <b class="positive">${money(c.total_placed||0)}</b>
        <span>${fmt((c.wallet_list||[]).length)} wallets</span>
        <span>${fmt(c.wallets_confirmed||0)} confirmadas</span>
        <span>${fmt(c.wallets_estimated||0)} estimadas</span>
      </div>
    </div>`).join('');

  const rows=wallets.map((w,i)=>{
    let quality="Sem dados";
    if(w.confirmed>0 && w.estimated>0)quality="Misto";
    else if(w.confirmed>0)quality="Confirmado";
    else if(w.estimated>0)quality="Estimado via Activity";

    return `<tr>
      <td>${i+1}</td>
      <td><code class="walletcode">${esc(w.wallet)}</code></td>
      <td class="num positive"><b>${money(w.total)}</b></td>
      <td class="num">${money(w.confirmed)}</td>
      <td class="num">${money(w.estimated)}</td>
      <td class="num">${fmt(w.combos)}</td>
      <td>${esc(quality)}</td>
    </tr>`;
  }).join('');

  $('#comboResults').innerHTML=`
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0">Valor colocado por wallet</h3>
      <div class="position-table-wrap">
        <table class="position-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Wallet</th>
              <th>Total colocado</th>
              <th>Confirmado</th>
              <th>Estimado via Activity</th>
              <th>N.º Combos</th>
              <th>Qualidade</th>
            </tr>
          </thead>
          <tbody>${rows||'<tr><td colspan="7">Sem dados.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    ${comboBlocks}`;

  status();
}
loadDashboard();
setInterval(loadDashboard,30000);
