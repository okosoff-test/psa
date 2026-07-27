'use strict';

const crypto = require('crypto');

module.exports = function createSchoolModule({ app, pool, isAuthorizedAdminRequest }) {
  const requireDb = (res) => {
    if (!pool) {
      res.status(503).json({ error: 'Skating School requires DATABASE_URL / PostgreSQL.' });
      return false;
    }
    return true;
  };
  const requireAdmin = (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return requireDb(res);
  };
  const clean = (v, n = 500) => String(v == null ? '' : v).trim().slice(0, n);
  const intOrNull = v => (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Math.trunc(Number(v));
  const bool = v => v === true || v === 'true' || v === 1 || v === '1';
  const token = () => crypto.randomBytes(24).toString('hex');
  const baseUrl = req => clean(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`, 500).replace(/\/$/, '');

  async function initSchoolDatabase() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS school_contacts (
        id BIGSERIAL PRIMARY KEY,
        player_first_name VARCHAR(100) NOT NULL,
        player_last_name VARCHAR(100) NOT NULL,
        date_of_birth DATE,
        birth_year INTEGER,
        skill_level VARCHAR(80),
        parent_name VARCHAR(160),
        parent_email VARCHAR(254),
        parent_phone VARCHAR(30),
        notes TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS school_groups (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        description TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS school_group_members (
        group_id BIGINT REFERENCES school_groups(id) ON DELETE CASCADE,
        contact_id BIGINT REFERENCES school_contacts(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS school_programs (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(180) NOT NULL,
        season VARCHAR(100),
        location VARCHAR(220),
        default_start_time TIME,
        default_end_time TIME,
        capacity INTEGER,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS school_enrollments (
        id BIGSERIAL PRIMARY KEY,
        program_id BIGINT NOT NULL REFERENCES school_programs(id) ON DELETE CASCADE,
        contact_id BIGINT NOT NULL REFERENCES school_contacts(id) ON DELETE CASCADE,
        enrollment_status VARCHAR(30) DEFAULT 'full_time',
        payment_method VARCHAR(30),
        payment_status VARCHAR(30) DEFAULT 'owing',
        payment_amount NUMERIC(10,2),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(program_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS school_sessions (
        id BIGSERIAL PRIMARY KEY,
        program_id BIGINT NOT NULL REFERENCES school_programs(id) ON DELETE CASCADE,
        session_date DATE NOT NULL,
        start_time TIME,
        end_time TIME,
        location VARCHAR(220),
        title VARCHAR(220),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS school_attendance (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES school_sessions(id) ON DELETE CASCADE,
        contact_id BIGINT NOT NULL REFERENCES school_contacts(id) ON DELETE CASCADE,
        status VARCHAR(30) DEFAULT 'no_reply',
        response_token VARCHAR(80) UNIQUE,
        requested_at TIMESTAMP,
        responded_at TIMESTAMP,
        response_channel VARCHAR(20),
        UNIQUE(session_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS school_messages (
        id BIGSERIAL PRIMARY KEY,
        contact_id BIGINT REFERENCES school_contacts(id) ON DELETE SET NULL,
        session_id BIGINT REFERENCES school_sessions(id) ON DELETE SET NULL,
        channel VARCHAR(20) NOT NULL,
        destination VARCHAR(254),
        subject VARCHAR(240),
        body TEXT,
        status VARCHAR(30) DEFAULT 'pending',
        provider_message_id VARCHAR(255),
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_school_contacts_birth_year ON school_contacts(birth_year);
      CREATE INDEX IF NOT EXISTS idx_school_contacts_skill ON school_contacts(skill_level);
      CREATE INDEX IF NOT EXISTS idx_school_sessions_date ON school_sessions(session_date);
      CREATE INDEX IF NOT EXISTS idx_school_attendance_session_status ON school_attendance(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_school_enrollments_program_status ON school_enrollments(program_id, enrollment_status);
    `);
  }

  async function sendEmail({ to, subject, html, text }) {
    const apiKey = clean(process.env.RESEND_API_KEY, 500);
    const from = clean(process.env.SCHOOL_FROM_EMAIL, 254);
    if (!apiKey || !from) return { ok: false, notConfigured: true, error: 'Email not configured (RESEND_API_KEY and SCHOOL_FROM_EMAIL).' };
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text })
      });
      const data = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, id: data.id || null } : { ok: false, error: data.message || `Email provider returned ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function sendSms({ to, body }) {
    const sid = clean(process.env.TWILIO_ACCOUNT_SID, 200);
    const auth = clean(process.env.TWILIO_AUTH_TOKEN, 300);
    const from = clean(process.env.TWILIO_FROM_NUMBER, 50);
    if (!sid || !auth || !from) return { ok: false, notConfigured: true, error: 'SMS not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).' };
    try {
      const form = new URLSearchParams({ To: to, From: from, Body: body });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      const data = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, id: data.sid || null } : { ok: false, error: data.message || `SMS provider returned ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  app.get('/api/school/public/config', (req, res) => res.json({ enabled: !!pool, name: clean(process.env.SCHOOL_NAME || 'Hockey Skating School', 160) }));

  app.get('/api/school/respond/:token', async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const q = await pool.query(`SELECT a.id,a.status,a.responded_at,c.player_first_name,c.player_last_name,s.session_date,s.start_time,s.end_time,COALESCE(s.location,p.location) location,COALESCE(s.title,p.name) title FROM school_attendance a JOIN school_contacts c ON c.id=a.contact_id JOIN school_sessions s ON s.id=a.session_id JOIN school_programs p ON p.id=s.program_id WHERE a.response_token=$1`, [clean(req.params.token, 80)]);
      if (!q.rows[0]) return res.status(404).json({ error: 'Attendance request not found or expired.' });
      res.json(q.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/school/respond/:token', async (req, res) => {
    if (!requireDb(res)) return;
    const status = clean(req.body?.status, 30);
    if (!['attending','not_attending'].includes(status)) return res.status(400).json({ error: 'Invalid attendance response.' });
    try {
      const q = await pool.query(`UPDATE school_attendance SET status=$1,responded_at=NOW(),response_channel=$2 WHERE response_token=$3 RETURNING id,status`, [status, clean(req.body?.channel || 'web', 20), clean(req.params.token, 80)]);
      if (!q.rows[0]) return res.status(404).json({ error: 'Attendance request not found.' });
      res.json({ success: true, status });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Parent-selected payment method for the program tied to an attendance request.
  app.post('/api/school/respond/:token/payment-method', async (req, res) => {
    if (!requireDb(res)) return;
    const method = clean(req.body?.paymentMethod, 30);
    if (!['E-Transfer','Cash'].includes(method)) return res.status(400).json({ error: 'Choose E-Transfer or Cash.' });
    try {
      const q = await pool.query(`
        UPDATE school_enrollments e
        SET payment_method=$1
        FROM school_attendance a
        JOIN school_sessions s ON s.id=a.session_id
        WHERE a.response_token=$2
          AND e.program_id=s.program_id
          AND e.contact_id=a.contact_id
        RETURNING e.id,e.payment_method,e.payment_status
      `, [method, clean(req.params.token, 80)]);
      if (!q.rows[0]) return res.status(404).json({ error: 'Enrollment not found for this attendance request.' });
      res.json({ success: true, paymentMethod: method, paymentStatus: q.rows[0].payment_status });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/school/calendar', async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const q = await pool.query(`SELECT s.id,s.session_date,s.start_time,s.end_time,COALESCE(s.location,p.location) location,COALESCE(s.title,p.name) title,p.name program_name,p.id program_id FROM school_sessions s JOIN school_programs p ON p.id=s.program_id WHERE s.session_date >= CURRENT_DATE - INTERVAL '14 days' ORDER BY s.session_date,s.start_time`);
      res.json({ sessions: q.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/school/admin/contacts', async (req, res) => {
    if (!requireAdmin(req,res)) return;
    try {
      const params=[]; const where=[];
      if (req.query.birthYear) { params.push(intOrNull(req.query.birthYear)); where.push(`c.birth_year=$${params.length}`); }
      if (req.query.skill) { params.push(clean(req.query.skill,80)); where.push(`c.skill_level=$${params.length}`); }
      if (req.query.groupId) { params.push(intOrNull(req.query.groupId)); where.push(`EXISTS(SELECT 1 FROM school_group_members gm WHERE gm.contact_id=c.id AND gm.group_id=$${params.length})`); }
      const q=await pool.query(`SELECT c.*,COALESCE(json_agg(json_build_object('id',g.id,'name',g.name)) FILTER (WHERE g.id IS NOT NULL),'[]') groups FROM school_contacts c LEFT JOIN school_group_members gm ON gm.contact_id=c.id LEFT JOIN school_groups g ON g.id=gm.group_id ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY c.id ORDER BY c.player_last_name,c.player_first_name`,params);
      res.json({ contacts:q.rows });
    } catch(e){res.status(500).json({error:e.message});}
  });

  app.post('/api/school/admin/contacts', async (req,res)=>{
    if(!requireAdmin(req,res)) return;
    const b=req.body||{}; const first=clean(b.playerFirstName,100), last=clean(b.playerLastName,100);
    if(!first||!last) return res.status(400).json({error:'Player first and last name are required.'});
    try{
      const dob=clean(b.dateOfBirth,20)||null; let by=intOrNull(b.birthYear); if(!by&&dob) by=Number(dob.slice(0,4))||null;
      const q=await pool.query(`INSERT INTO school_contacts(player_first_name,player_last_name,date_of_birth,birth_year,skill_level,parent_name,parent_email,parent_phone,notes,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[first,last,dob,by,clean(b.skillLevel,80)||null,clean(b.parentName,160)||null,clean(b.parentEmail,254)||null,clean(b.parentPhone,30)||null,clean(b.notes,3000)||null,b.active===undefined?true:bool(b.active)]);
      res.json({success:true,contact:q.rows[0]});
    }catch(e){res.status(500).json({error:e.message});}
  });

  app.put('/api/school/admin/contacts/:id', async(req,res)=>{
    if(!requireAdmin(req,res)) return; const b=req.body||{};
    try{const dob=clean(b.dateOfBirth,20)||null; let by=intOrNull(b.birthYear); if(!by&&dob) by=Number(dob.slice(0,4))||null;
      const q=await pool.query(`UPDATE school_contacts SET player_first_name=$1,player_last_name=$2,date_of_birth=$3,birth_year=$4,skill_level=$5,parent_name=$6,parent_email=$7,parent_phone=$8,notes=$9,active=$10,updated_at=NOW() WHERE id=$11 RETURNING *`,[clean(b.playerFirstName,100),clean(b.playerLastName,100),dob,by,clean(b.skillLevel,80)||null,clean(b.parentName,160)||null,clean(b.parentEmail,254)||null,clean(b.parentPhone,30)||null,clean(b.notes,3000)||null,b.active===undefined?true:bool(b.active),intOrNull(req.params.id)]); if(!q.rows[0]) return res.status(404).json({error:'Contact not found.'}); res.json({success:true,contact:q.rows[0]});
    }catch(e){res.status(500).json({error:e.message});}}
  );

  app.delete('/api/school/admin/contacts/:id', async(req,res)=>{if(!requireAdmin(req,res))return;try{await pool.query('DELETE FROM school_contacts WHERE id=$1',[intOrNull(req.params.id)]);res.json({success:true});}catch(e){res.status(500).json({error:e.message});}});

  app.get('/api/school/admin/groups',async(req,res)=>{if(!requireAdmin(req,res))return;try{const q=await pool.query(`SELECT g.*,COUNT(gm.contact_id)::int member_count FROM school_groups g LEFT JOIN school_group_members gm ON gm.group_id=g.id GROUP BY g.id ORDER BY g.name`);res.json({groups:q.rows});}catch(e){res.status(500).json({error:e.message});}});
  app.post('/api/school/admin/groups',async(req,res)=>{if(!requireAdmin(req,res))return;try{const q=await pool.query('INSERT INTO school_groups(name,description) VALUES($1,$2) RETURNING *',[clean(req.body?.name,160),clean(req.body?.description,2000)||null]);res.json({success:true,group:q.rows[0]});}catch(e){res.status(500).json({error:e.message});}});
  app.post('/api/school/admin/groups/:id/members',async(req,res)=>{if(!requireAdmin(req,res))return;try{const gid=intOrNull(req.params.id); const ids=Array.isArray(req.body?.contactIds)?req.body.contactIds.map(intOrNull).filter(Boolean):[]; await pool.query('BEGIN'); await pool.query('DELETE FROM school_group_members WHERE group_id=$1',[gid]); for(const id of ids) await pool.query('INSERT INTO school_group_members(group_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[gid,id]); await pool.query('COMMIT');res.json({success:true,count:ids.length});}catch(e){try{await pool.query('ROLLBACK');}catch{}res.status(500).json({error:e.message});}});

  app.get('/api/school/admin/programs',async(req,res)=>{if(!requireAdmin(req,res))return;try{const q=await pool.query(`SELECT p.*,COUNT(e.id) FILTER(WHERE e.enrollment_status='full_time')::int full_time_count,COUNT(e.id) FILTER(WHERE e.enrollment_status='waitlist')::int waitlist_count FROM school_programs p LEFT JOIN school_enrollments e ON e.program_id=p.id GROUP BY p.id ORDER BY p.created_at DESC`);res.json({programs:q.rows});}catch(e){res.status(500).json({error:e.message});}});
  app.post('/api/school/admin/programs',async(req,res)=>{if(!requireAdmin(req,res))return;const b=req.body||{};try{const q=await pool.query(`INSERT INTO school_programs(name,season,location,default_start_time,default_end_time,capacity,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[clean(b.name,180),clean(b.season,100)||null,clean(b.location,220)||null,clean(b.defaultStartTime,10)||null,clean(b.defaultEndTime,10)||null,intOrNull(b.capacity),b.active===undefined?true:bool(b.active)]);res.json({success:true,program:q.rows[0]});}catch(e){res.status(500).json({error:e.message});}});
  app.post('/api/school/admin/programs/:id/enroll',async(req,res)=>{if(!requireAdmin(req,res))return;const b=req.body||{};try{const q=await pool.query(`INSERT INTO school_enrollments(program_id,contact_id,enrollment_status,payment_method,payment_status,payment_amount,notes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(program_id,contact_id) DO UPDATE SET enrollment_status=EXCLUDED.enrollment_status,payment_method=EXCLUDED.payment_method,payment_status=EXCLUDED.payment_status,payment_amount=EXCLUDED.payment_amount,notes=EXCLUDED.notes RETURNING *`,[intOrNull(req.params.id),intOrNull(b.contactId),clean(b.enrollmentStatus||'full_time',30),clean(b.paymentMethod,30)||null,clean(b.paymentStatus||'owing',30),b.paymentAmount===''||b.paymentAmount==null?null:Number(b.paymentAmount),clean(b.notes,2000)||null]);res.json({success:true,enrollment:q.rows[0]});}catch(e){res.status(500).json({error:e.message});}});
  app.get('/api/school/admin/programs/:id/enrollments',async(req,res)=>{if(!requireAdmin(req,res))return;try{const q=await pool.query(`SELECT e.*,c.player_first_name,c.player_last_name,c.birth_year,c.skill_level,c.parent_name,c.parent_email,c.parent_phone FROM school_enrollments e JOIN school_contacts c ON c.id=e.contact_id WHERE e.program_id=$1 ORDER BY CASE e.enrollment_status WHEN 'full_time' THEN 0 WHEN 'drop_in' THEN 1 ELSE 2 END,c.player_last_name,c.player_first_name`,[intOrNull(req.params.id)]);res.json({enrollments:q.rows});}catch(e){res.status(500).json({error:e.message});}});
  app.put('/api/school/admin/enrollments/:id/payment',async(req,res)=>{if(!requireAdmin(req,res))return;const b=req.body||{};try{const q=await pool.query(`UPDATE school_enrollments SET payment_method=$1,payment_status=$2,payment_amount=$3 WHERE id=$4 RETURNING *`,[clean(b.paymentMethod,30)||null,clean(b.paymentStatus,30)||'owing',b.paymentAmount===''||b.paymentAmount==null?null:Number(b.paymentAmount),intOrNull(req.params.id)]);res.json({success:true,enrollment:q.rows[0]});}catch(e){res.status(500).json({error:e.message});}});

  app.get('/api/school/admin/sessions',async(req,res)=>{if(!requireAdmin(req,res))return;try{const params=[];let where='';if(req.query.programId){params.push(intOrNull(req.query.programId));where='WHERE s.program_id=$1';}const q=await pool.query(`SELECT s.*,p.name program_name,COALESCE(s.location,p.location) display_location,(SELECT COUNT(*) FROM school_attendance a WHERE a.session_id=s.id AND a.status='attending')::int attending,(SELECT COUNT(*) FROM school_attendance a WHERE a.session_id=s.id AND a.status='not_attending')::int not_attending,(SELECT COUNT(*) FROM school_attendance a WHERE a.session_id=s.id AND a.status='no_reply')::int no_reply FROM school_sessions s JOIN school_programs p ON p.id=s.program_id ${where} ORDER BY s.session_date DESC,s.start_time`,params);res.json({sessions:q.rows});}catch(e){res.status(500).json({error:e.message});}});
  app.post('/api/school/admin/sessions',async(req,res)=>{if(!requireAdmin(req,res))return;const b=req.body||{};try{const q=await pool.query(`INSERT INTO school_sessions(program_id,session_date,start_time,end_time,location,title,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[intOrNull(b.programId),clean(b.sessionDate,20),clean(b.startTime,10)||null,clean(b.endTime,10)||null,clean(b.location,220)||null,clean(b.title,220)||null,clean(b.notes,3000)||null]);res.json({success:true,session:q.rows[0]});}catch(e){res.status(500).json({error:e.message});}});
  app.post('/api/school/admin/programs/:id/generate-sessions',async(req,res)=>{if(!requireAdmin(req,res))return;const b=req.body||{};const weeks=Math.max(1,Math.min(20,Number(b.weeks)||1));try{const p=(await pool.query('SELECT * FROM school_programs WHERE id=$1',[intOrNull(req.params.id)])).rows[0];if(!p)return res.status(404).json({error:'Program not found.'});const start=new Date(`${clean(b.firstDate,20)}T12:00:00`);if(Number.isNaN(start.getTime()))return res.status(400).json({error:'Valid first date required.'});let created=0;for(let i=0;i<weeks;i++){const d=new Date(start);d.setDate(start.getDate()+i*7);const ds=d.toISOString().slice(0,10);await pool.query(`INSERT INTO school_sessions(program_id,session_date,start_time,end_time,location,title) VALUES($1,$2,$3,$4,$5,$6)`,[p.id,ds,clean(b.startTime,10)||p.default_start_time,clean(b.endTime,10)||p.default_end_time,clean(b.location,220)||p.location,clean(b.title,220)||p.name]);created++;}res.json({success:true,created});}catch(e){res.status(500).json({error:e.message});}});
  app.get('/api/school/admin/sessions/:id/attendance',async(req,res)=>{if(!requireAdmin(req,res))return;try{const q=await pool.query(`SELECT a.*,c.player_first_name,c.player_last_name,c.parent_name,c.parent_email,c.parent_phone,e.enrollment_status FROM school_attendance a JOIN school_contacts c ON c.id=a.contact_id LEFT JOIN school_sessions s ON s.id=a.session_id LEFT JOIN school_enrollments e ON e.program_id=s.program_id AND e.contact_id=a.contact_id WHERE a.session_id=$1 ORDER BY CASE a.status WHEN 'attending' THEN 0 WHEN 'not_attending' THEN 1 ELSE 2 END,c.player_last_name,c.player_first_name`,[intOrNull(req.params.id)]);res.json({attendance:q.rows});}catch(e){res.status(500).json({error:e.message});}});

  app.post('/api/school/admin/sessions/:id/request-attendance',async(req,res)=>{
    if(!requireAdmin(req,res))return; const sid=intOrNull(req.params.id); const b=req.body||{}; const channels=Array.isArray(b.channels)?b.channels:['email']; const onlyNoReply=bool(b.onlyNoReply);
    try{
      const s=(await pool.query(`SELECT s.*,p.name program_name,COALESCE(s.location,p.location) display_location FROM school_sessions s JOIN school_programs p ON p.id=s.program_id WHERE s.id=$1`,[sid])).rows[0]; if(!s)return res.status(404).json({error:'Session not found.'});
      const enrol=await pool.query(`SELECT e.contact_id,e.enrollment_status,c.* FROM school_enrollments e JOIN school_contacts c ON c.id=e.contact_id WHERE e.program_id=$1 AND e.enrollment_status IN ('full_time','drop_in','waitlist') ORDER BY e.created_at`,[s.program_id]);
      const selectedStatuses=Array.isArray(b.enrollmentStatuses)&&b.enrollmentStatuses.length?b.enrollmentStatuses:['full_time','drop_in']; let sent=0,failed=0,skipped=0; const details=[];
      for(const c of enrol.rows){ if(!selectedStatuses.includes(c.enrollment_status)){skipped++;continue;} let a=(await pool.query(`INSERT INTO school_attendance(session_id,contact_id,status,response_token,requested_at) VALUES($1,$2,'no_reply',$3,NOW()) ON CONFLICT(session_id,contact_id) DO UPDATE SET requested_at=NOW() RETURNING *`,[sid,c.contact_id,token()])).rows[0]; if(!a.response_token){a=(await pool.query('UPDATE school_attendance SET response_token=$1 WHERE id=$2 RETURNING *',[token(),a.id])).rows[0];} if(onlyNoReply&&a.status!=='no_reply'){skipped++;continue;}
        const link=`${baseUrl(req)}/school.html?attendance=${encodeURIComponent(a.response_token)}`; const player=`${c.player_first_name} ${c.player_last_name}`; const date=String(s.session_date).slice(0,10); const subject=clean(b.subject||`${s.program_name} attendance - ${date}`,240); const text=clean(b.body||`Please confirm ${player}'s attendance for ${s.program_name} on ${date}.`,5000)+`\n\nRespond here: ${link}`; const html=`<p>${text.replace(/\n/g,'<br>')}</p>`;
        for(const channel of channels){let dest='',result;if(channel==='email'){dest=c.parent_email; if(!dest){failed++;details.push({player,channel,error:'No parent email'});continue;} result=await sendEmail({to:dest,subject,html,text});}else if(channel==='sms'){dest=c.parent_phone;if(!dest){failed++;details.push({player,channel,error:'No parent phone'});continue;}result=await sendSms({to:dest,body:text});}else continue;
          await pool.query(`INSERT INTO school_messages(contact_id,session_id,channel,destination,subject,body,status,provider_message_id,error_message,sent_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $7='sent' THEN NOW() ELSE NULL END)`,[c.contact_id,sid,channel,dest,subject,text,result.ok?'sent':(result.notConfigured?'not_configured':'failed'),result.id||null,result.error||null]); if(result.ok)sent++;else failed++; details.push({player,channel,ok:result.ok,error:result.error||null,link});
        }
      }
      res.json({success:true,sent,failed,skipped,details,emailConfigured:!!(process.env.RESEND_API_KEY&&process.env.SCHOOL_FROM_EMAIL),smsConfigured:!!(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_FROM_NUMBER)});
    }catch(e){res.status(500).json({error:e.message});}
  });

  app.post('/api/school/admin/message',async(req,res)=>{
    if(!requireAdmin(req,res))return; const b=req.body||{}; const channels=Array.isArray(b.channels)?b.channels:['email'];
    try{const params=[];const where=['c.active=true'];if(b.birthYear){params.push(intOrNull(b.birthYear));where.push(`c.birth_year=$${params.length}`);}if(b.skillLevel){params.push(clean(b.skillLevel,80));where.push(`c.skill_level=$${params.length}`);}if(b.groupId){params.push(intOrNull(b.groupId));where.push(`EXISTS(SELECT 1 FROM school_group_members gm WHERE gm.contact_id=c.id AND gm.group_id=$${params.length})`);}if(b.programId){params.push(intOrNull(b.programId));where.push(`EXISTS(SELECT 1 FROM school_enrollments e WHERE e.contact_id=c.id AND e.program_id=$${params.length}${b.enrollmentStatus?` AND e.enrollment_status='${clean(b.enrollmentStatus,30).replace(/'/g,"''")}'`:''})`);}if(Array.isArray(b.contactIds)&&b.contactIds.length){const ids=b.contactIds.map(intOrNull).filter(Boolean);params.push(ids);where.push(`c.id=ANY($${params.length}::bigint[])`);}const q=await pool.query(`SELECT c.* FROM school_contacts c WHERE ${where.join(' AND ')} ORDER BY c.player_last_name,c.player_first_name`,params);let sent=0,failed=0;for(const c of q.rows){for(const ch of channels){const subject=clean(b.subject,240)||'Hockey Skating School';const text=clean(b.body,5000);let dest,result;if(ch==='email'){dest=c.parent_email;if(!dest){failed++;continue;}result=await sendEmail({to:dest,subject,text,html:`<p>${text.replace(/\n/g,'<br>')}</p>`});}else{dest=c.parent_phone;if(!dest){failed++;continue;}result=await sendSms({to:dest,body:text});}await pool.query(`INSERT INTO school_messages(contact_id,channel,destination,subject,body,status,provider_message_id,error_message,sent_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $6='sent' THEN NOW() ELSE NULL END)`,[c.id,ch,dest,subject,text,result.ok?'sent':(result.notConfigured?'not_configured':'failed'),result.id||null,result.error||null]);if(result.ok)sent++;else failed++;}}res.json({success:true,recipients:q.rows.length,sent,failed,emailConfigured:!!(process.env.RESEND_API_KEY&&process.env.SCHOOL_FROM_EMAIL),smsConfigured:!!(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_FROM_NUMBER)});}catch(e){res.status(500).json({error:e.message});}});

  app.get('/api/school/admin/dashboard',async(req,res)=>{if(!requireAdmin(req,res))return;try{const [c,p,s,a,w]=await Promise.all([pool.query('SELECT COUNT(*)::int n FROM school_contacts WHERE active=true'),pool.query('SELECT COUNT(*)::int n FROM school_programs WHERE active=true'),pool.query(`SELECT COUNT(*)::int n FROM school_sessions WHERE session_date>=CURRENT_DATE`),pool.query(`SELECT COUNT(*) FILTER(WHERE status='attending')::int attending,COUNT(*) FILTER(WHERE status='not_attending')::int not_attending,COUNT(*) FILTER(WHERE status='no_reply')::int no_reply FROM school_attendance a JOIN school_sessions s ON s.id=a.session_id WHERE s.session_date=CURRENT_DATE`),pool.query(`SELECT COUNT(*)::int n FROM school_enrollments WHERE enrollment_status='waitlist'`)]);res.json({contacts:c.rows[0].n,programs:p.rows[0].n,upcomingSessions:s.rows[0].n,today:a.rows[0],waitlist:w.rows[0].n,messaging:{emailConfigured:!!(process.env.RESEND_API_KEY&&process.env.SCHOOL_FROM_EMAIL),smsConfigured:!!(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_FROM_NUMBER)}});}catch(e){res.status(500).json({error:e.message});}});

  return { initSchoolDatabase };
};
