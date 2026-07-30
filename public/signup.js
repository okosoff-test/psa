const $=s=>document.querySelector(s);let programs=[];
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function message(text,error=false){$('#signupMsg').innerHTML=`<div class="notice ${error?'error':''}">${esc(text)}</div>`;}
function dateOnly(v){return v?String(v).slice(0,10):'';}
function prettyDate(v){if(!v)return'';const d=new Date(`${dateOnly(v)}T12:00:00`);return Number.isNaN(d.getTime())?dateOnly(v):d.toLocaleDateString('en-CA',{month:'long',day:'numeric',year:'numeric'});}
function prettyTime(v){if(!v)return'';const [h,m]=String(v).slice(0,5).split(':').map(Number);if(Number.isNaN(h))return String(v).slice(0,5);const d=new Date();d.setHours(h,m||0,0,0);return d.toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'});}
function showProgram(p){
  if(!p){
    $('#programDates').textContent='Choose a program below';$('#programLocation').textContent='Pavel Hockey Academy';$('#programTime').textContent='Program details will appear here';$('#spotsLeft').textContent='--';$('#programCapacity').textContent='--';$('#waitlistAlert').hidden=true;$('#programInfo').textContent='';return;
  }
  const capacity=Number(p.capacity||0),enrolled=Number(p.enrolled_count||0),remaining=capacity>0?Math.max(0,capacity-enrolled):null,full=capacity>0&&enrolled>=capacity;
  $('#programDates').textContent=[prettyDate(p.start_date),p.end_date&&dateOnly(p.end_date)!==dateOnly(p.start_date)?`to ${prettyDate(p.end_date)}`:''].filter(Boolean).join(' ');
  $('#programLocation').textContent=p.arena||p.name||'Pavel Hockey Academy';
  $('#programTime').textContent=[p.name+(p.season?` — ${p.season}`:''),[prettyTime(p.default_start_time),prettyTime(p.default_end_time)].filter(Boolean).join(' – ')].filter(Boolean).join(' • ');
  $('#spotsLeft').textContent=remaining===null?'Open':remaining;
  $('#programCapacity').textContent=capacity||'Open';
  $('#waitlistAlert').hidden=!full;
  $('#programInfo').textContent=[p.skill_level?`Level: ${p.skill_level}`:'',p.min_birth_year||p.max_birth_year?`Birth years: ${p.min_birth_year||'Any'}–${p.max_birth_year||'Any'}`:'',full?'Registration will be placed on the waiting list.':remaining!==null?`${remaining} spot${remaining===1?'':'s'} currently available.`:'Enrollment is open.'].filter(Boolean).join(' • ');
}
async function loadPrograms(){try{const r=await fetch('/api/public/programs');const data=await r.json();if(!r.ok)throw new Error(data.error||'Could not load programs.');programs=data;$('#program').innerHTML='<option value="">Choose a program</option>'+data.map(p=>`<option value="${p.id}">${esc(p.name)}${p.season?' — '+esc(p.season):''}</option>`).join('');if(!data.length){$('#program').innerHTML='<option value="">No programs currently available</option>';$('#submitBtn').disabled=true;message('There are no programs open for registration right now.',true);}}catch(e){message(e.message,true);}}
$('#program').onchange=()=>showProgram(programs.find(x=>String(x.id)===$('#program').value));
$('#signupForm').onsubmit=async e=>{e.preventDefault();const payment=document.querySelector('input[name="payment"]:checked')?.value;const body={player_first_name:$('#playerFirst').value,player_last_name:$('#playerLast').value,dob:$('#dob').value,skill_level:$('#skill').value,parent_first_name:$('#parentFirst').value,parent_last_name:$('#parentLast').value,email:$('#email').value,phone:$('#phone').value,program_id:$('#program').value,payment_method:payment,notes:$('#notes').value,website:$('#website').value};$('#submitBtn').disabled=true;$('#submitBtn').textContent='Submitting…';try{const r=await fetch('/api/public/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Registration failed.');const wait=data.enrollment_type==='waitlist';$('#signupForm').reset();showProgram(null);message(wait?`Registration received. ${data.program_name} is full, so the player has been added to the waiting list.`:`Registration received for ${data.program_name}. Payment is recorded as owing until confirmed by the academy.`);}catch(err){message(err.message,true);}finally{$('#submitBtn').disabled=false;$('#submitBtn').textContent='Register Player';window.scrollTo({top:0,behavior:'smooth'});}};
showProgram(null);loadPrograms();
