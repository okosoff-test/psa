require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-me';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 }));
app.use('/api/public/signup', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const q = (text, params = []) => pool.query(text, params);
const clean = (v) => typeof v === 'string' ? v.trim() : v;
const nullable = (v) => (v === '' || v === undefined ? null : v);
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

function adminOnly(req, res, next) {
  try {
    const token = req.cookies.school_admin;
    if (!token) return res.status(401).json({ error: 'Not signed in.' });
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('bad role');
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      player_first_name TEXT NOT NULL,
      player_last_name TEXT NOT NULL,
      dob DATE,
      skill_level TEXT,
      parent_first_name TEXT,
      parent_last_name TEXT,
      email TEXT,
      phone TEXT,
      notes TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contact_groups (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contact_group_members (
      group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS programs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      season TEXT,
      skill_level TEXT,
      min_birth_year INTEGER,
      max_birth_year INTEGER,
      arena TEXT,
      default_start_time TIME,
      default_end_time TIME,
      capacity INTEGER,
      start_date DATE,
      end_date DATE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      enrollment_type TEXT NOT NULL DEFAULT 'full_time' CHECK (enrollment_type IN ('full_time','drop_in','waitlist')),
      payment_method TEXT CHECK (payment_method IN ('etransfer','cash') OR payment_method IS NULL),
      payment_status TEXT NOT NULL DEFAULT 'owing' CHECK (payment_status IN ('owing','paid','partial','complimentary')),
      amount_due NUMERIC(10,2),
      amount_paid NUMERIC(10,2),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(program_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      session_date DATE NOT NULL,
      start_time TIME,
      end_time TIME,
      arena TEXT,
      title TEXT,
      notes TEXT,
      cancelled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(program_id, session_date, start_time)
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'no_reply' CHECK (status IN ('no_reply','attending','not_attending','wants_spot','not_available')),
      response_token TEXT UNIQUE NOT NULL,
      responded_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(session_id, enrollment_id)
    );

    CREATE TABLE IF NOT EXISTS message_log (
      id SERIAL PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
      subject TEXT,
      body TEXT NOT NULL,
      recipient_count INTEGER NOT NULL DEFAULT 0,
      filter_json JSONB,
      status TEXT NOT NULL DEFAULT 'created',
      provider_response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const existing = await q('SELECT id FROM admins WHERE email=$1', [ADMIN_EMAIL]);
  if (!existing.rowCount) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await q('INSERT INTO admins(email,password_hash) VALUES($1,$2)', [ADMIN_EMAIL, hash]);
  }
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const result = await q('SELECT * FROM admins WHERE email=$1', [email]);
    if (!result.rowCount || !(await bcrypt.compare(password, result.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const token = jwt.sign({ role: 'admin', email }, JWT_SECRET, { expiresIn: '12h' });
    res.cookie('school_admin', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600000 });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed.' });
  }
});
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('school_admin'); res.json({ ok: true }); });
app.get('/api/auth/me', adminOnly, (req, res) => res.json({ email: req.admin.email }));

app.get('/api/dashboard', adminOnly, async (_req, res) => {
  try {
    const [contacts, programs, nextSessions, outstanding, noReply] = await Promise.all([
      q('SELECT COUNT(*)::int n FROM contacts WHERE active=TRUE'),
      q('SELECT COUNT(*)::int n FROM programs WHERE active=TRUE'),
      q(`SELECT s.*, p.name program_name,
        COUNT(a.id) FILTER (WHERE a.status='attending')::int attending,
        COUNT(a.id) FILTER (WHERE a.status='not_attending')::int not_attending,
        COUNT(a.id) FILTER (WHERE a.status='no_reply')::int no_reply
        FROM sessions s JOIN programs p ON p.id=s.program_id
        LEFT JOIN attendance a ON a.session_id=s.id
        WHERE s.session_date >= CURRENT_DATE AND s.cancelled=FALSE
        GROUP BY s.id,p.name ORDER BY s.session_date,s.start_time LIMIT 8`),
      q(`SELECT COUNT(*)::int n FROM enrollments WHERE payment_status IN ('owing','partial')`),
      q(`SELECT COUNT(*)::int n FROM attendance a JOIN sessions s ON s.id=a.session_id WHERE s.session_date >= CURRENT_DATE AND a.status='no_reply'`)
    ]);
    res.json({ contacts: contacts.rows[0].n, programs: programs.rows[0].n, outstanding: outstanding.rows[0].n, noReply: noReply.rows[0].n, nextSessions: nextSessions.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load dashboard.' }); }
});

app.get('/api/contacts', adminOnly, async (req, res) => {
  try {
    const params = [];
    const where = ['c.active=TRUE'];
    if (req.query.birthYear) { params.push(Number(req.query.birthYear)); where.push(`EXTRACT(YEAR FROM c.dob)=$${params.length}`); }
    if (req.query.skill) { params.push(req.query.skill); where.push(`c.skill_level=$${params.length}`); }
    if (req.query.groupId) { params.push(Number(req.query.groupId)); where.push(`EXISTS(SELECT 1 FROM contact_group_members gm WHERE gm.contact_id=c.id AND gm.group_id=$${params.length})`); }
    if (req.query.search) { params.push(`%${req.query.search}%`); where.push(`(c.player_first_name||' '||c.player_last_name||' '||COALESCE(c.parent_first_name,'')||' '||COALESCE(c.parent_last_name,'')||' '||COALESCE(c.email,'')) ILIKE $${params.length}`); }
    const result = await q(`SELECT c.*, EXTRACT(YEAR FROM c.dob)::int birth_year FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.player_first_name,c.player_last_name`, params);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load contacts.' }); }
});

app.post('/api/contacts', adminOnly, async (req, res) => {
  try {
    const b = req.body;
    if (!clean(b.player_first_name) || !clean(b.player_last_name)) return res.status(400).json({ error: 'Player first and last name are required.' });
    const result = await q(`INSERT INTO contacts(player_first_name,player_last_name,dob,skill_level,parent_first_name,parent_last_name,email,phone,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [clean(b.player_first_name), clean(b.player_last_name), nullable(b.dob), nullable(clean(b.skill_level)), nullable(clean(b.parent_first_name)), nullable(clean(b.parent_last_name)), nullable(clean(b.email)), nullable(clean(b.phone)), nullable(clean(b.notes))]);
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not create contact.' }); }
});

app.put('/api/contacts/:id', adminOnly, async (req, res) => {
  try {
    const b=req.body;
    const result=await q(`UPDATE contacts SET player_first_name=$1,player_last_name=$2,dob=$3,skill_level=$4,parent_first_name=$5,parent_last_name=$6,email=$7,phone=$8,notes=$9,updated_at=NOW() WHERE id=$10 RETURNING *`, [clean(b.player_first_name),clean(b.player_last_name),nullable(b.dob),nullable(clean(b.skill_level)),nullable(clean(b.parent_first_name)),nullable(clean(b.parent_last_name)),nullable(clean(b.email)),nullable(clean(b.phone)),nullable(clean(b.notes)),Number(req.params.id)]);
    if(!result.rowCount) return res.status(404).json({error:'Contact not found.'});
    res.json(result.rows[0]);
  } catch(err){console.error(err);res.status(500).json({error:'Could not update contact.'});}
});
app.delete('/api/contacts/:id', adminOnly, async (req,res)=>{ await q('UPDATE contacts SET active=FALSE,updated_at=NOW() WHERE id=$1',[Number(req.params.id)]); res.json({ok:true}); });

app.get('/api/groups', adminOnly, async (_req,res)=>{
  const r=await q(`SELECT g.*,COUNT(gm.contact_id)::int member_count FROM contact_groups g LEFT JOIN contact_group_members gm ON gm.group_id=g.id GROUP BY g.id ORDER BY g.name`); res.json(r.rows);
});
app.post('/api/groups', adminOnly, async(req,res)=>{
  try { const r=await q('INSERT INTO contact_groups(name,description) VALUES($1,$2) RETURNING *',[clean(req.body.name),nullable(clean(req.body.description))]); res.status(201).json(r.rows[0]); }
  catch(err){ if(err.code==='23505') return res.status(409).json({error:'That group already exists.'}); console.error(err);res.status(500).json({error:'Could not create group.'}); }
});
app.post('/api/groups/:id/members', adminOnly, async(req,res)=>{
  const groupId=Number(req.params.id); const ids=Array.isArray(req.body.contactIds)?req.body.contactIds.map(Number):[];
  const client=await pool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM contact_group_members WHERE group_id=$1',[groupId]); for(const id of ids) await client.query('INSERT INTO contact_group_members(group_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[groupId,id]); await client.query('COMMIT'); res.json({ok:true,count:ids.length}); } catch(err){await client.query('ROLLBACK');console.error(err);res.status(500).json({error:'Could not update group.'});} finally{client.release();}
});
app.get('/api/groups/:id/members',adminOnly,async(req,res)=>{const r=await q('SELECT contact_id FROM contact_group_members WHERE group_id=$1',[Number(req.params.id)]);res.json(r.rows.map(x=>x.contact_id));});

app.get('/api/programs', adminOnly, async (_req,res)=>{
  const r=await q(`SELECT p.*,COUNT(e.id) FILTER(WHERE e.enrollment_type='full_time')::int full_time_count,COUNT(e.id) FILTER(WHERE e.enrollment_type='drop_in')::int drop_in_count,COUNT(e.id) FILTER(WHERE e.enrollment_type='waitlist')::int waitlist_count FROM programs p LEFT JOIN enrollments e ON e.program_id=p.id WHERE p.active=TRUE GROUP BY p.id ORDER BY p.start_date DESC NULLS LAST,p.name`); res.json(r.rows);
});
app.post('/api/programs',adminOnly,async(req,res)=>{
  try{const b=req.body;const r=await q(`INSERT INTO programs(name,season,skill_level,min_birth_year,max_birth_year,arena,default_start_time,default_end_time,capacity,start_date,end_date,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[clean(b.name),nullable(clean(b.season)),nullable(clean(b.skill_level)),nullable(b.min_birth_year),nullable(b.max_birth_year),nullable(clean(b.arena)),nullable(b.default_start_time),nullable(b.default_end_time),nullable(b.capacity),nullable(b.start_date),nullable(b.end_date),nullable(clean(b.notes))]);res.status(201).json(r.rows[0]);}catch(err){console.error(err);res.status(500).json({error:'Could not create program.'});}
});
app.put('/api/programs/:id',adminOnly,async(req,res)=>{
  try{const b=req.body;const r=await q(`UPDATE programs SET name=$1,season=$2,skill_level=$3,min_birth_year=$4,max_birth_year=$5,arena=$6,default_start_time=$7,default_end_time=$8,capacity=$9,start_date=$10,end_date=$11,notes=$12,updated_at=NOW() WHERE id=$13 RETURNING *`,[clean(b.name),nullable(clean(b.season)),nullable(clean(b.skill_level)),nullable(b.min_birth_year),nullable(b.max_birth_year),nullable(clean(b.arena)),nullable(b.default_start_time),nullable(b.default_end_time),nullable(b.capacity),nullable(b.start_date),nullable(b.end_date),nullable(clean(b.notes)),Number(req.params.id)]);res.json(r.rows[0]);}catch(err){console.error(err);res.status(500).json({error:'Could not update program.'});}
});

app.get('/api/programs/:id/enrollments',adminOnly,async(req,res)=>{
  const r=await q(`SELECT e.*,c.player_first_name,c.player_last_name,c.parent_first_name,c.parent_last_name,c.email,c.phone,EXTRACT(YEAR FROM c.dob)::int birth_year,c.skill_level FROM enrollments e JOIN contacts c ON c.id=e.contact_id WHERE e.program_id=$1 ORDER BY CASE e.enrollment_type WHEN 'full_time' THEN 1 WHEN 'drop_in' THEN 2 ELSE 3 END,c.player_first_name,c.player_last_name`,[Number(req.params.id)]);res.json(r.rows);
});
app.post('/api/programs/:id/enroll',adminOnly,async(req,res)=>{
  try{const r=await q(`INSERT INTO enrollments(program_id,contact_id,enrollment_type,payment_method,payment_status,amount_due,amount_paid,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(program_id,contact_id) DO UPDATE SET enrollment_type=EXCLUDED.enrollment_type RETURNING *`,[Number(req.params.id),Number(req.body.contact_id),req.body.enrollment_type||'full_time',nullable(req.body.payment_method),req.body.payment_status||'owing',nullable(req.body.amount_due),nullable(req.body.amount_paid),nullable(clean(req.body.notes))]);res.status(201).json(r.rows[0]);}catch(err){console.error(err);res.status(500).json({error:'Could not enroll player.'});}
});
app.put('/api/enrollments/:id',adminOnly,async(req,res)=>{
  try{const b=req.body;const r=await q(`UPDATE enrollments SET enrollment_type=$1,payment_method=$2,payment_status=$3,amount_due=$4,amount_paid=$5,notes=$6 WHERE id=$7 RETURNING *`,[b.enrollment_type||'full_time',nullable(b.payment_method),b.payment_status||'owing',nullable(b.amount_due),nullable(b.amount_paid),nullable(clean(b.notes)),Number(req.params.id)]);res.json(r.rows[0]);}catch(err){console.error(err);res.status(500).json({error:'Could not update enrollment.'});}
});
app.delete('/api/enrollments/:id',adminOnly,async(req,res)=>{await q('DELETE FROM enrollments WHERE id=$1',[Number(req.params.id)]);res.json({ok:true});});

app.get('/api/sessions',adminOnly,async(req,res)=>{
  const params=[];let w='WHERE 1=1'; if(req.query.programId){params.push(Number(req.query.programId));w+=` AND s.program_id=$${params.length}`;} if(req.query.from){params.push(req.query.from);w+=` AND s.session_date >= $${params.length}`;} if(req.query.to){params.push(req.query.to);w+=` AND s.session_date <= $${params.length}`;}
  const r=await q(`SELECT s.*,p.name program_name,COUNT(a.id)::int expected,COUNT(a.id) FILTER(WHERE a.status='attending')::int attending,COUNT(a.id) FILTER(WHERE a.status='not_attending')::int not_attending,COUNT(a.id) FILTER(WHERE a.status='no_reply')::int no_reply,COUNT(a.id) FILTER(WHERE a.status='wants_spot')::int wants_spot FROM sessions s JOIN programs p ON p.id=s.program_id LEFT JOIN attendance a ON a.session_id=s.id ${w} GROUP BY s.id,p.name ORDER BY s.session_date,s.start_time`,params);res.json(r.rows);
});
app.post('/api/sessions',adminOnly,async(req,res)=>{
  try{const b=req.body;const r=await q(`INSERT INTO sessions(program_id,session_date,start_time,end_time,arena,title,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[Number(b.program_id),b.session_date,nullable(b.start_time),nullable(b.end_time),nullable(clean(b.arena)),nullable(clean(b.title)),nullable(clean(b.notes))]);await ensureAttendance(r.rows[0].id);res.status(201).json(r.rows[0]);}catch(err){if(err.code==='23505')return res.status(409).json({error:'That session already exists.'});console.error(err);res.status(500).json({error:'Could not create session.'});}
});
app.post('/api/programs/:id/generate-sessions',adminOnly,async(req,res)=>{
  const program=(await q('SELECT * FROM programs WHERE id=$1',[Number(req.params.id)])).rows[0]; if(!program)return res.status(404).json({error:'Program not found.'});
  const start=new Date(`${req.body.start_date||program.start_date}T12:00:00`); const weeks=Math.min(30,Math.max(1,Number(req.body.weeks||10))); if(Number.isNaN(start.getTime()))return res.status(400).json({error:'A valid start date is required.'});
  const created=[]; for(let i=0;i<weeks;i++){const d=new Date(start);d.setDate(d.getDate()+i*7);const ds=d.toISOString().slice(0,10);const r=await q(`INSERT INTO sessions(program_id,session_date,start_time,end_time,arena,title) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(program_id,session_date,start_time) DO NOTHING RETURNING *`,[program.id,ds,program.default_start_time,program.default_end_time,program.arena,program.name]); if(r.rowCount){await ensureAttendance(r.rows[0].id);created.push(r.rows[0]);}}
  res.json({ok:true,created:created.length,sessions:created});
});

async function ensureAttendance(sessionId){
  await q(`INSERT INTO attendance(session_id,enrollment_id,response_token)
    SELECT $1,e.id,encode(gen_random_bytes(24),'hex') FROM enrollments e JOIN sessions s ON s.program_id=e.program_id WHERE s.id=$1 AND e.enrollment_type IN ('full_time','drop_in','waitlist')
    ON CONFLICT(session_id,enrollment_id) DO NOTHING`,[sessionId]).catch(async err=>{
      if(err.code==='42883'){
        const ens=(await q(`SELECT e.id FROM enrollments e JOIN sessions s ON s.program_id=e.program_id WHERE s.id=$1 AND e.enrollment_type IN ('full_time','drop_in','waitlist')`,[sessionId])).rows;
        for(const e of ens) await q('INSERT INTO attendance(session_id,enrollment_id,response_token) VALUES($1,$2,$3) ON CONFLICT(session_id,enrollment_id) DO NOTHING',[sessionId,e.id,crypto.randomBytes(24).toString('hex')]);
      } else throw err;
    });
}
app.post('/api/sessions/:id/refresh-attendance',adminOnly,async(req,res)=>{await ensureAttendance(Number(req.params.id));res.json({ok:true});});
app.get('/api/sessions/:id/attendance',adminOnly,async(req,res)=>{
  await ensureAttendance(Number(req.params.id)); const r=await q(`SELECT a.*,e.enrollment_type,e.payment_method,e.payment_status,c.player_first_name,c.player_last_name,c.parent_first_name,c.parent_last_name,c.email,c.phone FROM attendance a JOIN enrollments e ON e.id=a.enrollment_id JOIN contacts c ON c.id=e.contact_id WHERE a.session_id=$1 ORDER BY CASE e.enrollment_type WHEN 'full_time' THEN 1 WHEN 'drop_in' THEN 2 ELSE 3 END,c.player_first_name,c.player_last_name`,[Number(req.params.id)]);res.json(r.rows);
});
app.put('/api/attendance/:id',adminOnly,async(req,res)=>{const r=await q(`UPDATE attendance SET status=$1,responded_at=CASE WHEN $1='no_reply' THEN NULL ELSE NOW() END,updated_at=NOW() WHERE id=$2 RETURNING *`,[req.body.status,Number(req.params.id)]);res.json(r.rows[0]);});



app.get('/api/public/programs', async (_req, res) => {
  try {
    const result = await q(`
      SELECT p.id,p.name,p.season,p.skill_level,p.min_birth_year,p.max_birth_year,
             p.arena,p.default_start_time,p.default_end_time,p.capacity,p.start_date,p.end_date,
             COUNT(e.id) FILTER (WHERE e.enrollment_type IN ('full_time','drop_in'))::int AS enrolled_count
      FROM programs p
      LEFT JOIN enrollments e ON e.program_id=p.id
      WHERE p.active=TRUE AND (p.end_date IS NULL OR p.end_date >= CURRENT_DATE)
      GROUP BY p.id
      ORDER BY p.start_date NULLS LAST,p.name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load available programs.' });
  }
});

app.post('/api/public/signup', async (req, res) => {
  const b = req.body || {};
  if (clean(b.website)) return res.status(400).json({ error: 'Invalid submission.' });
  const required = ['player_first_name','player_last_name','dob','parent_first_name','parent_last_name','email','phone','program_id','payment_method'];
  if (required.some(key => !clean(b[key]))) return res.status(400).json({ error: 'Please complete all required fields.' });
  if (!['etransfer','cash'].includes(b.payment_method)) return res.status(400).json({ error: 'Choose E-transfer or cash.' });
  const email = String(b.email).trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the selected program row first. PostgreSQL does not allow
    // SELECT ... FOR UPDATE on a grouped query.
    const programResult = await client.query(`
      SELECT *
      FROM programs
      WHERE id=$1 AND active=TRUE
      FOR UPDATE
    `, [Number(b.program_id)]);
    if (!programResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That program is no longer available.' });
    }
    const program = programResult.rows[0];
    const enrollmentCountResult = await client.query(`
      SELECT COUNT(*)::int AS enrolled_count
      FROM enrollments
      WHERE program_id=$1
        AND enrollment_type IN ('full_time','drop_in')
    `, [program.id]);
    program.enrolled_count = enrollmentCountResult.rows[0].enrolled_count;

    const duplicate = await client.query(`
      SELECT c.id FROM contacts c
      JOIN enrollments e ON e.contact_id=c.id
      WHERE e.program_id=$1 AND LOWER(c.email)=LOWER($2)
        AND LOWER(c.player_first_name)=LOWER($3) AND LOWER(c.player_last_name)=LOWER($4)
      LIMIT 1
    `, [program.id,email,clean(b.player_first_name),clean(b.player_last_name)]);
    if (duplicate.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This player is already registered for that program.' });
    }

    const contact = await client.query(`
      INSERT INTO contacts(player_first_name,player_last_name,dob,skill_level,parent_first_name,parent_last_name,email,phone,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [clean(b.player_first_name),clean(b.player_last_name),b.dob,nullable(clean(b.skill_level)),clean(b.parent_first_name),clean(b.parent_last_name),email,clean(b.phone),nullable(clean(b.notes))]);

    const capacity = Number(program.capacity || 0);
    const enrollmentType = capacity > 0 && Number(program.enrolled_count || 0) >= capacity ? 'waitlist' : 'full_time';
    const enrollment = await client.query(`
      INSERT INTO enrollments(program_id,contact_id,enrollment_type,payment_method,payment_status,notes)
      VALUES($1,$2,$3,$4,'owing',$5) RETURNING id
    `, [program.id,contact.rows[0].id,enrollmentType,b.payment_method,nullable(clean(b.notes))]);

    const sessions = await client.query('SELECT id FROM sessions WHERE program_id=$1 AND session_date >= CURRENT_DATE',[program.id]);
    for (const session of sessions.rows) {
      await client.query(`INSERT INTO attendance(session_id,enrollment_id,response_token)
        VALUES($1,$2,$3) ON CONFLICT(session_id,enrollment_id) DO NOTHING`,
        [session.id,enrollment.rows[0].id,crypto.randomBytes(24).toString('hex')]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ok:true, enrollment_type: enrollmentType, program_name: program.name });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Registration could not be completed.' });
  } finally {
    client.release();
  }
});

app.get('/api/calendar', async(req,res)=>{
  const from=req.query.from||new Date().toISOString().slice(0,8)+'01'; const to=req.query.to||'2999-12-31';
  const r=await q(`SELECT s.id,s.session_date,s.start_time,s.end_time,s.arena,s.title,s.cancelled,p.name program_name,p.skill_level,p.min_birth_year,p.max_birth_year FROM sessions s JOIN programs p ON p.id=s.program_id WHERE s.session_date BETWEEN $1 AND $2 AND p.active=TRUE ORDER BY s.session_date,s.start_time`,[from,to]);res.json(r.rows);
});

app.get('/r/:token', async(req,res)=> res.sendFile(path.join(__dirname,'..','public','parent.html')));
app.get('/api/public/response/:token',async(req,res)=>{
  const r=await q(`SELECT a.id attendance_id,a.status,a.response_token,s.id session_id,s.session_date,s.start_time,s.end_time,s.arena,s.title,p.name program_name,e.id enrollment_id,e.enrollment_type,e.payment_method,c.player_first_name,c.player_last_name,c.parent_first_name,c.email FROM attendance a JOIN sessions s ON s.id=a.session_id JOIN programs p ON p.id=s.program_id JOIN enrollments e ON e.id=a.enrollment_id JOIN contacts c ON c.id=e.contact_id WHERE a.response_token=$1`,[req.params.token]); if(!r.rowCount)return res.status(404).json({error:'This response link is invalid or expired.'});res.json(r.rows[0]);
});
app.post('/api/public/response/:token',async(req,res)=>{
  const allowed=['attending','not_attending','wants_spot','not_available']; if(!allowed.includes(req.body.status))return res.status(400).json({error:'Invalid response.'});
  const client=await pool.connect();try{await client.query('BEGIN');const a=await client.query(`UPDATE attendance SET status=$1,responded_at=NOW(),updated_at=NOW() WHERE response_token=$2 RETURNING enrollment_id`,[req.body.status,req.params.token]);if(!a.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Response link not found.'});} if(['etransfer','cash'].includes(req.body.payment_method)) await client.query('UPDATE enrollments SET payment_method=$1 WHERE id=$2',[req.body.payment_method,a.rows[0].enrollment_id]);await client.query('COMMIT');res.json({ok:true});}catch(err){await client.query('ROLLBACK');console.error(err);res.status(500).json({error:'Could not save response.'});}finally{client.release();}
});

async function selectRecipients(filters={}){
  const params=[];const where=['c.active=TRUE'];
  let joins='';
  if(filters.programId||filters.enrollmentType||filters.sessionId||filters.attendanceStatus){joins+=' JOIN enrollments e ON e.contact_id=c.id'; if(filters.programId){params.push(Number(filters.programId));where.push(`e.program_id=$${params.length}`);} if(filters.enrollmentType){params.push(filters.enrollmentType);where.push(`e.enrollment_type=$${params.length}`);} }
  if(filters.sessionId||filters.attendanceStatus){joins+=' JOIN attendance a ON a.enrollment_id=e.id'; if(filters.sessionId){params.push(Number(filters.sessionId));where.push(`a.session_id=$${params.length}`);} if(filters.attendanceStatus){params.push(filters.attendanceStatus);where.push(`a.status=$${params.length}`);} }
  if(filters.birthYear){params.push(Number(filters.birthYear));where.push(`EXTRACT(YEAR FROM c.dob)=$${params.length}`);} if(filters.skill){params.push(filters.skill);where.push(`c.skill_level=$${params.length}`);} if(filters.groupId){params.push(Number(filters.groupId));where.push(`EXISTS(SELECT 1 FROM contact_group_members gm WHERE gm.contact_id=c.id AND gm.group_id=$${params.length})`);} if(Array.isArray(filters.contactIds)&&filters.contactIds.length){params.push(filters.contactIds.map(Number));where.push(`c.id=ANY($${params.length}::int[])`);}
  const r=await q(`SELECT DISTINCT c.id,c.player_first_name,c.player_last_name,c.parent_first_name,c.parent_last_name,c.email,c.phone${filters.sessionId?',a.response_token,e.enrollment_type':''} FROM contacts c ${joins} WHERE ${where.join(' AND ')} ORDER BY c.player_first_name,c.player_last_name`,params);return r.rows;
}
app.post('/api/messages/preview',adminOnly,async(req,res)=>{const recipients=await selectRecipients(req.body.filters||{});res.json(recipients);});
app.post('/api/messages/send',adminOnly,async(req,res)=>{
  try{
    const {channel,subject,body,filters={}}=req.body; if(!['email','sms'].includes(channel))return res.status(400).json({error:'Choose email or SMS.'}); if(!clean(body))return res.status(400).json({error:'Message body is required.'});
    const recipients=await selectRecipients(filters); if(!recipients.length)return res.status(400).json({error:'No recipients match those filters.'});
    const results=[];
    for(const r of recipients){let text=body; if(r.response_token) text += `\n\nRespond here: ${APP_BASE_URL}/r/${r.response_token}`; if(channel==='email'&&r.email)results.push(await sendEmail(r.email,subject||'Skating School',text)); else if(channel==='sms'&&r.phone)results.push(await sendSms(r.phone,text));}
    const sent=results.filter(x=>x.ok).length; const configured=results.some(x=>x.configured!==false);
    await q(`INSERT INTO message_log(channel,subject,body,recipient_count,filter_json,status,provider_response) VALUES($1,$2,$3,$4,$5,$6,$7)`,[channel,nullable(subject),body,recipients.length,JSON.stringify(filters),sent===recipients.length?'sent':sent?'partial':(configured?'failed':'not_configured'),JSON.stringify(results.slice(0,25))]);
    res.json({ok:true,matched:recipients.length,sent,results});
  }catch(err){console.error(err);res.status(500).json({error:'Could not send message.'});}
});
app.get('/api/messages',adminOnly,async(_req,res)=>{const r=await q('SELECT * FROM message_log ORDER BY created_at DESC LIMIT 100');res.json(r.rows);});

async function sendEmail(to,subject,body){
  if(!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM)return {ok:false,configured:false,to,error:'Email provider not configured.'};
  try{const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[to],subject,text:body})});const data=await response.json().catch(()=>({}));return {ok:response.ok,configured:true,to,data};}catch(err){return {ok:false,configured:true,to,error:err.message};}
}
async function sendSms(to,body){
  const sid=process.env.TWILIO_ACCOUNT_SID,token=process.env.TWILIO_AUTH_TOKEN,from=process.env.TWILIO_FROM_NUMBER; if(!sid||!token||!from)return {ok:false,configured:false,to,error:'SMS provider not configured.'};
  try{const form=new URLSearchParams({To:to,From:from,Body:body});const response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${sid}:${token}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:form});const data=await response.json().catch(()=>({}));return {ok:response.ok,configured:true,to,sid:data.sid,status:data.status,error:data.message};}catch(err){return {ok:false,configured:true,to,error:err.message};}
}

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Unexpected server error.'});});

initDb().then(()=>app.listen(PORT,()=>console.log(`Skating School running on port ${PORT}`))).catch(err=>{console.error('Database initialization failed:',err);process.exit(1);});
