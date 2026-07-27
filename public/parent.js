const token = location.pathname.split('/').pop();
const box = document.getElementById('parentContent');
const fmtDate = s => new Date(String(s).slice(0,10)+'T12:00:00').toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'});
async function load(){
  const r=await fetch('/api/public/response/'+encodeURIComponent(token));
  const d=await r.json();
  if(!r.ok){box.innerHTML=`<div class="notice error">${d.error||'Unable to load response.'}</div>`;return;}
  const wait=d.enrollment_type==='waitlist';
  box.innerHTML=`<h1 style="margin-bottom:4px">${d.player_first_name} ${d.player_last_name}</h1><p class="muted">${d.program_name}</p><div class="card" style="box-shadow:none;margin:14px 0"><strong>${fmtDate(d.session_date)}</strong><br>${String(d.start_time||'').slice(0,5)}–${String(d.end_time||'').slice(0,5)}<br>${d.arena||''}</div><h2>${wait?'Is your player available for this opening?':'Will your player attend?'}</h2><div class="response-buttons"><button class="yes" data-status="${wait?'wants_spot':'attending'}">${wait?'YES — WANT THE SPOT':'ATTENDING'}</button><button class="no-btn" data-status="${wait?'not_available':'not_attending'}">${wait?'NOT AVAILABLE':'NOT ATTENDING'}</button></div><div style="margin-top:18px"><label>Payment method</label><select id="payment"><option value="">Select if applicable</option><option value="etransfer" ${d.payment_method==='etransfer'?'selected':''}>E-transfer</option><option value="cash" ${d.payment_method==='cash'?'selected':''}>Cash</option></select></div><div id="saved" style="margin-top:12px"></div>`;
  box.querySelectorAll('[data-status]').forEach(b=>b.onclick=()=>save(b.dataset.status));
}
async function save(status){
  const payment=document.getElementById('payment')?.value||'';
  const r=await fetch('/api/public/response/'+encodeURIComponent(token),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,payment_method:payment})});
  const d=await r.json();
  document.getElementById('saved').innerHTML=r.ok?'<div class="notice">Response saved. Thank you.</div>':`<div class="notice error">${d.error||'Could not save response.'}</div>`;
}
load();
