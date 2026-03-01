require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- Config ---
const SUPABASE_URL    = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY    = process.env.SUPABASE_KEY    || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const N8N_ROADMAP_URL = process.env.N8N_ROADMAP_URL || '';
const N8N_CV_URL      = process.env.N8N_CV_URL      || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─────────────────────────────────────────────────────────────
// Auth middleware — verifies Supabase JWT from Authorization header
// ─────────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  // If no token provided, continue as anonymous (n8n still triggers)
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.split(' ')[1];
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    req.user = (!error && user) ? user : null;
  } catch (e) {
    req.user = null;
  }
  next();
}

// ─────────────────────────────────────────────────────────────
// POST /api/sync-user
// Called after signup or signin — upserts the authenticated user
// into public.users (and creates an empty public.profiles row)
// ─────────────────────────────────────────────────────────────
app.post('/api/sync-user', requireAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { id, email } = req.user;

  // Upsert into public.users
  const { error: userErr } = await supabase
    .from('users')
    .upsert({ id, email, created_at: new Date().toISOString() }, { onConflict: 'id' });

  if (userErr) console.warn('[sync-user] users upsert:', userErr.message);

  // Insert an empty profiles row only if none exists yet for this user
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', id)
    .maybeSingle();

  if (!existing) {
    const { error: profErr } = await supabase
      .from('profiles')
      .insert({ user_id: id, created_at: new Date().toISOString() });
    if (profErr) console.warn('[sync-user] profiles insert:', profErr.message);
  }

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /api/analyze
// Receives user profile from the frontend and forwards it to n8n
// ─────────────────────────────────────────────────────────────
app.post('/api/analyze', requireAuth, async (req, res) => {
  // profile_id is ALWAYS sourced from the verified JWT — never from the request body
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required to run analysis.' });
  }

  const {
    user_skills, target_job,
    job_title, education, years,
    industry, work_mode, location,
    constraints, context
  } = req.body;

  if (!target_job) {
    return res.status(400).json({ error: 'Missing required field: target_job' });
  }

  // Join profiles by user_id (FK), then use profiles.id as profile_id
  const user_id = req.user.id;
  let profile_id = null;
  let user_profile = { email: req.user.email };
  try {
    const { data: profileRow } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user_id)
      .single();
    if (profileRow) {
      profile_id = profileRow.id;  // the actual profiles PK
      const { id: _omit, ...rest } = profileRow;
      user_profile = { ...user_profile, ...rest };
    }
  } catch (_) {
    // profiles row not found — continue with user_id as fallback
  }

  const payload = {
    action: 'new_analysis_request',
    profile_id: profile_id || user_id,   // profiles.id, fallback to users.id
    user_id,                              // always the auth user's UUID
    user_profile,
    target_job,
    job_title:   job_title   || '',
    education:   education   || '',
    years:       years       || '',
    industry:    industry    || '',
    work_mode:   work_mode   || '',
    location:    location    || '',
    user_skills: user_skills || [],
    constraints: constraints || [],
    context:     context     || '',
    submitted_at: new Date().toISOString()
  };

  if (!N8N_WEBHOOK_URL) {
    return res.status(503).json({ error: 'N8N_WEBHOOK_URL is not configured in .env' });
  }

  try {
    const n8nRes = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const n8nText = await n8nRes.text();
    let n8nData = {};
    try { n8nData = JSON.parse(n8nText); } catch (_) { n8nData = { raw: n8nText }; }

    console.log('[n8n] Response:', n8nRes.status, n8nText.slice(0, 200));

    // n8n workflow not yet active / not in test-listen mode
    if (n8nRes.status === 404 || n8nRes.status === 405) {
      return res.status(503).json({
        error: 'Engine A workflow is not active. In n8n open the career-gps workflow and click "Listen for test event", or activate the workflow for production.',
        n8n_status: n8nRes.status
      });
    }

    // Deep-unwrap helper — n8n sometimes double/triple-encodes JSON
    function deepParse(val) {
      let v = val;
      for (let i = 0; i < 6; i++) {
        if (typeof v !== 'string') break;
        const t = v.trim();
        if (!(t.startsWith('{') || t.startsWith('[') || t.startsWith('"'))) break;
        try { v = JSON.parse(t); } catch (_) { break; }
      }
      return v;
    }

    const unwrapped = deepParse(n8nData);
    const base = (typeof unwrapped === 'object' && unwrapped !== null) ? unwrapped : n8nData;

    // Normalize missing_skills — may be array, comma-string, or nested JSON string
    let missingSkills = base.missing_skills || base.missingSkills || null;
    const parsedSkills = deepParse(missingSkills);
    if (Array.isArray(parsedSkills)) {
      missingSkills = parsedSkills;
    } else if (typeof parsedSkills === 'string') {
      missingSkills = parsedSkills.split(',').map(s => s.trim()).filter(Boolean);
    }

    // Return whatever n8n sends back, or a default confirmation
    return res.json({
      success: true,
      message: 'Profile sent to n8n successfully.',
      n8n_status: n8nRes.status,
      // Explicit fields the frontend needs
      report_text:    deepParse(base.report_text) || deepParse(base.message) || null,
      missing_skills: missingSkills,
      report_id:      base.id             || null,
      target_job:     payload.target_job,
      n8n_response:   base
    });

  } catch (err) {
    console.error('[n8n] Error:', err.message);
    return res.status(502).json({ error: 'Failed to reach n8n: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/roadmap
// Engine B — receives gap data and triggers the Action Roadmap
// workflow in n8n; returns missions / learning_path synchronously
// if n8n responds right away, or a queued status otherwise.
// ─────────────────────────────────────────────────────────────
app.post('/api/roadmap', requireAuth, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const {
    report_id,
    target_job,
    missing_skills,
    constraints,
    context,
    job_title,
    years,
    work_mode,
    location
  } = req.body;

  if (!target_job || !missing_skills || missing_skills.length === 0) {
    return res.status(400).json({ error: 'Missing target_job or missing_skills.' });
  }

  const user_id = req.user.id;

  // Resolve profile_id from profiles table
  let profile_id = user_id;
  try {
    const { data: profileRow } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', user_id)
      .single();
    if (profileRow) profile_id = profileRow.id;
  } catch (_) {}

  const payload = {
    action:         'generate_roadmap',    // n8n can route on this
    report_id:      report_id   || null,
    profile_id,
    user_id,
    user_email:     req.user.email,
    target_job,
    missing_skills,
    gap_count:      missing_skills.length,
    job_title:      job_title   || '',
    years:          years       || '',
    work_mode:      work_mode   || '',
    location:       location    || '',
    constraints:    constraints || [],
    context:        context     || '',
    requested_at:   new Date().toISOString()
  };

  const webhookUrl = N8N_ROADMAP_URL || N8N_WEBHOOK_URL; // fall back to same webhook
  if (!webhookUrl) {
    return res.status(503).json({ error: 'N8N_ROADMAP_URL is not configured in .env' });
  }

  try {
    const n8nRes = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    const n8nText = await n8nRes.text();
    let n8nData = {};
    try { n8nData = JSON.parse(n8nText); } catch (_) { n8nData = { raw: n8nText }; }

    console.log('[n8n/roadmap] Response:', n8nRes.status, n8nText.slice(0, 300));

    if (n8nRes.status === 404 || n8nRes.status === 405) {
      return res.status(503).json({
        error: 'Engine B workflow is not active. In n8n open the career-gps-roadmap workflow and click "Listen for test event", or activate it for production.',
        n8n_status: n8nRes.status
      });
    }

    // ── Recursive JSON unwrapper ─────────────────────────────────────────────
    // n8n often double/triple-encodes its output. Keep parsing until we reach
    // a non-string value OR something that doesn't look like JSON.
    function deepParse(val, depth) {
      if (!depth) depth = 0;
      if (depth > 8 || val === null || val === undefined) return val;
      if (typeof val !== 'string') return val;
      const t = val.trim();
      if (!(t.startsWith('{') || t.startsWith('[') || t.startsWith('"'))) return val;
      try {
        const parsed = JSON.parse(t);
        if (parsed === val) return val;          // nothing changed, stop
        return deepParse(parsed, depth + 1);
      } catch (_) { return val; }
    }

    // ── Array extractor ──────────────────────────────────────────────────────
    // Recursively digs through objects / nested strings to find the missions
    // array, however deep n8n has buried it.
    function extractArray(val, depth) {
      if (!depth) depth = 0;
      if (depth > 10 || val === null || val === undefined) return null;

      const v = deepParse(val);

      if (Array.isArray(v)) return v;

      if (v && typeof v === 'object') {
        // Priority field names n8n or OpenAI might use
        const keys = ['missions', 'roadmap_missions', 'message', 'data',
                      'result', 'output', 'content', 'roadmap', 'items'];
        for (const k of keys) {
          if (v[k] !== undefined) {
            const found = extractArray(v[k], depth + 1);
            if (found) return found;
          }
        }
        // Walk remaining string values that might contain a JSON array
        for (const k of Object.keys(v)) {
          if (typeof v[k] === 'string' && v[k].includes('[')) {
            const found = extractArray(v[k], depth + 1);
            if (found) return found;
          }
        }
      }

      // Last resort: regex-extract the first [...] block from any string
      if (typeof v === 'string') {
        const match = v.match(/\[[\s\S]*\]/);
        if (match) {
          try {
            const arr = JSON.parse(match[0]);
            if (Array.isArray(arr) && arr.length > 0) return arr;
          } catch (_) {}
        }
      }

      return null;
    }

    // ── Build base object ────────────────────────────────────────────────────
    const base = (typeof n8nData === 'object' && n8nData !== null) ? n8nData : {};

    // Extract missions from anywhere in the response
    let missions = extractArray(base);

    // Extract markdown/text fallbacks
    let roadmap    = null;
    let reportText = null;
    const textCandidates = [base.roadmap, base.learning_path, base.report_text,
                            base.message_text, base.text];
    for (const c of textCandidates) {
      const p = deepParse(c);
      if (typeof p === 'string' && p.length > 10) { roadmap = p; break; }
    }
    const rtCandidates = [base.report_text, base.message_text];
    for (const c of rtCandidates) {
      const p = deepParse(c);
      if (typeof p === 'string' && p.length > 10) { reportText = p; break; }
    }

    // ── Normalise mission shape ──────────────────────────────────────────────
    if (Array.isArray(missions)) {
      missions = missions.map(function(m) {
        if (typeof m === 'string') {
          // Sometimes missions come back as plain strings
          return { title: m, skill: '', timeframe: '24h', type: 'build',
                   description: '', resource: '', url: '', tool: '' };
        }
        return {
          title:       m.title       || m.skill       || m.name       || 'Mission',
          skill:       m.skill       || m.gap          || '',
          timeframe:   m.timeframe   || m.duration     || '24h',
          type:        m.type        || m.category     || m.kind       || 'build',
          description: m.description || m.objective    || m.summary    || '',
          resource:    m.resource    || m.url          || m.link       || '',
          url:         m.url         || m.resource     || m.link       || '',
          tool:        m.tool        || m.platform     || ''
        };
      });
    }

    console.log('[n8n/roadmap] Extracted missions:', missions ? missions.length : 0);

    return res.json({
      success:      true,
      roadmap_id:   base.id         || base.roadmap_id || null,
      report_id:    report_id       || base.report_id  || null,
      target_job,
      gap_count:    missing_skills.length,
      missions:     Array.isArray(missions) ? missions : null,
      roadmap:      roadmap    || null,
      report_text:  reportText || null,
      n8n_status:   n8nRes.status,
      n8n_response: base
    });

  } catch (err) {
    console.error('[n8n/roadmap] Error:', err.message);
    return res.status(502).json({ error: 'Failed to reach n8n roadmap workflow: ' + err.message });
  }
});

// GET /api/reports/:profile_id — fetch all gap reports for a profile
app.get('/api/reports/:profile_id', requireAuth, async (req, res) => {
  const { profile_id } = req.params;
  const { data, error } = await supabase
    .from('gap_reports')
    .select('*')
    .eq('profile_id', profile_id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// ─────────────────────────────────────────────────────────────
// POST /api/n8n/webhook
// Endpoint for n8n to send processed data/results back
// e.g. updating the gap report with generated content
// ─────────────────────────────────────────────────────────────
app.post('/api/n8n/webhook', async (req, res) => {
  const { profile_id, report_id, learning_path, custom_analysis } = req.body;
  
  if (!report_id) {
    return res.status(400).json({ error: 'Missing report_id from n8n payload' });
  }

  try {
    const { data, error } = await supabase
      .from('gap_reports')
      .update({
        // adjust these columns depending on what's in your Supabase schema
        learning_path: learning_path || null,
        custom_analysis: custom_analysis || null,
        status: 'processed_by_n8n'
      })
      .eq('id', report_id);

    if (error) throw error;

    return res.json({ success: true, message: 'Record updated from n8n workflow' });
  } catch (err) {
    console.error('n8n webhook callback error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/profile — fetch the authenticated user's profile row
// ─────────────────────────────────────────────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || {});
});

// ─────────────────────────────────────────────────────────────
// PUT /api/profile — update the authenticated user's profile
// ─────────────────────────────────────────────────────────────
app.put('/api/profile', requireAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const allowed = [
    'full_name', 'bio', 'current_role', 'target_role',
    'years_experience', 'industry', 'location', 'education',
    'work_mode', 'linkedin_url', 'portfolio_url'
  ];
  const updates = {};
  allowed.forEach(function(k) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  });
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('user_id', req.user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, profile: data });
});

// ─────────────────────────────────────────────────────────────
// GET /api/my-reports — all gap reports for the authenticated user
// Resolves profile_id server-side so the frontend doesn't need it
// ─────────────────────────────────────────────────────────────
app.get('/api/my-reports', requireAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  // Resolve the profiles.id for this user
  const { data: profileRow } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', req.user.id)
    .maybeSingle();

  const profile_id = profileRow ? profileRow.id : req.user.id;

  const { data, error } = await supabase
    .from('gap_reports')
    .select('*')
    .eq('profile_id', profile_id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || []);
});

// ─────────────────────────────────────────────────────────────
// GET /api/config — returns public supabase credentials for the frontend
// ─────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/cv-analyze
// Receives extracted CV text from the frontend (PDF/DOCX/TXT parsed
// client-side), enriches it with user context, and forwards the
// full payload to the n8n CV analysis workflow.
// n8n is expected to extract structured profile data, run a gap
// analysis against the target job, and return a report.
// Configure N8N_CV_URL in .env to point to a dedicated CV webhook,
// or it falls back to N8N_WEBHOOK_URL.
// ─────────────────────────────────────────────────────────────
app.post('/api/cv-analyze', requireAuth, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { cv_text, file_name, target_job, context } = req.body;

  if (!cv_text || cv_text.trim().length < 20) {
    return res.status(400).json({ error: 'cv_text is missing or too short.' });
  }

  const user_id    = req.user.id;
  const user_email = req.user.email;

  // Resolve profile_id
  let profile_id   = user_id;
  let user_profile = { email: user_email };
  try {
    const { data: profileRow } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user_id)
      .single();
    if (profileRow) {
      profile_id = profileRow.id;
      const { id: _omit, ...rest } = profileRow;
      user_profile = { ...user_profile, ...rest };
    }
  } catch (_) {}

  const payload = {
    action:       'cv_analysis_request',
    profile_id,
    user_id,
    user_email,
    user_profile,
    file_name:    file_name  || 'cv',
    cv_text:      cv_text.trim(),
    target_job:   target_job || '',
    context:      context    || '',
    submitted_at: new Date().toISOString()
  };

  // Use dedicated CV webhook if configured, otherwise fall back to main webhook
  const webhookUrl = N8N_CV_URL || N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(503).json({
      error: 'N8N_CV_URL (or N8N_WEBHOOK_URL) is not configured in .env'
    });
  }

  try {
    const n8nRes = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    const n8nText = await n8nRes.text();
    let n8nData = {};
    try { n8nData = JSON.parse(n8nText); } catch (_) { n8nData = { raw: n8nText }; }

    console.log('[n8n/cv] Response:', n8nRes.status, n8nText.slice(0, 300));

    if (n8nRes.status === 404 || n8nRes.status === 405) {
      return res.status(503).json({
        error: 'Engine C workflow is not active. In n8n open the career-gps-cv workflow and click "Listen for test event", or activate it for production.',
        n8n_status: n8nRes.status
      });
    }

    // Recursive unwrapper
    function deepParse(val, depth) {
      if (!depth) depth = 0;
      if (depth > 8 || val === null || val === undefined) return val;
      if (typeof val !== 'string') return val;
      const t = val.trim();
      if (!(t.startsWith('{') || t.startsWith('[') || t.startsWith('"'))) return val;
      try {
        const parsed = JSON.parse(t);
        if (parsed === val) return val;
        return deepParse(parsed, depth + 1);
      } catch (_) { return val; }
    }

    const base      = (typeof n8nData === 'object' && n8nData !== null) ? n8nData : {};
    const unwrapped = deepParse(base.output || base.result || base.message || null);
    const finalBase = (typeof unwrapped === 'object' && unwrapped !== null) ? unwrapped : base;

    // Structured fields n8n may have extracted from the CV
    const extracted = {
      name:             finalBase.name             || finalBase.full_name    || null,
      current_role:     finalBase.current_role     || finalBase.job_title    || null,
      years_experience: finalBase.years_experience || finalBase.years        || null,
      education:        finalBase.education                                   || null,
      skills:           Array.isArray(finalBase.skills)         ? finalBase.skills         : null,
      missing_skills:   Array.isArray(finalBase.missing_skills) ? finalBase.missing_skills : null
    };

    return res.json({
      success:      true,
      n8n_status:   n8nRes.status,
      target_job:   target_job || finalBase.target_job || '',
      extracted,
      report_text:  deepParse(finalBase.report_text) || deepParse(finalBase.message) ||
                    deepParse(finalBase.analysis)    || deepParse(finalBase.result)  || null,
      n8n_response: finalBase
    });

  } catch (err) {
    console.error('[n8n/cv] Error:', err.message);
    return res.status(502).json({ error: 'Failed to reach n8n CV workflow: ' + err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Career GPS backend running on http://localhost:${PORT}`));
