# CareerGPS — n8n Workflows Build Prompt

> **Use this prompt** by pasting it (or sections of it) into an AI assistant
> (ChatGPT, Claude, Copilot, etc.) to get step-by-step n8n workflow instructions.
> Or read it yourself as the full technical specification.

---

## Context & Role

You are an expert n8n automation engineer and AI prompt designer.
You are building the backend automation layer for **CareerGPS** — a career
intelligence platform. The Node.js/Express backend (`server.js`) already calls
your n8n webhooks and handles the HTTP handshake. Your job is to build **3
n8n workflows** that receive the payloads, call OpenAI, and return structured
JSON responses.

The platform has **3 AI engines**, each with its own n8n workflow and webhook URL:

| Engine | Purpose | Webhook path |
|--------|---------|-------------|
| **Engine A** | Gap Analysis — compare user skills vs target role | `/webhook/career-gps` |
| **Engine B** | Action Roadmap — turn skill gaps into 24/48h micro-missions | `/webhook/career-gps-roadmap` |
| **Engine C** | CV Extraction — parse raw CV text → structured fields | `/webhook/career-gps-cv` |

> During development use `webhook-test` instead of `webhook`.
> Activate the workflow in n8n for production (`webhook`).

---

## Supabase Schema (for context / optional DB writes)

```
Table: profiles
  id                UUID  (PK)
  user_id           UUID  (FK → auth.users)
  full_name         TEXT
  bio               TEXT
  current_role      TEXT
  target_role       TEXT
  years_experience  INT
  industry          TEXT
  education         TEXT
  location          TEXT
  work_mode         TEXT   -- 'Remote' | 'Hybrid' | 'On-site' | 'Flexible'
  linkedin_url      TEXT
  portfolio_url     TEXT
  created_at        TIMESTAMPTZ
  updated_at        TIMESTAMPTZ

Table: gap_reports
  id               UUID  (PK, default gen_random_uuid())
  profile_id       UUID  (FK → profiles.id)
  target_job       TEXT
  missing_skills   JSONB  -- string[]
  gap_score        INT    -- 0-100
  report_text      TEXT
  status           TEXT   -- 'submitted' | 'processed' | 'complete'
  created_at       TIMESTAMPTZ
```

The backend's callback endpoint (for n8n to write back results) is:
`POST http://localhost:3001/api/n8n/webhook`
with body `{ report_id, learning_path, custom_analysis }`.

---

---

# WORKFLOW 1 — Engine A: Gap Analysis

## Webhook URL
```
https://haki.app.n8n.cloud/webhook-test/career-gps
```

## Trigger
**Webhook node** — Method: POST, Path: `career-gps`, Response mode: `Last node`

## Input Payload (sent by the Express backend)

```json
{
  "action": "new_analysis_request",
  "profile_id": "uuid-of-profiles-row",
  "user_id": "uuid-of-auth-user",
  "user_profile": {
    "email": "user@example.com",
    "full_name": "Jean Dupont",
    "current_role": "Junior Web Developer",
    "bio": "3 years web dev, looking to move to DevOps",
    "years_experience": 3,
    "industry": "Fintech",
    "location": "Paris",
    "work_mode": "Hybrid"
  },
  "target_job": "DevOps Engineer",
  "job_title": "Junior Web Developer",
  "education": "BSc Computer Science",
  "years": "3",
  "industry": "Fintech",
  "work_mode": "Hybrid",
  "location": "Paris",
  "user_skills": ["HTML", "CSS", "JavaScript", "React", "Git"],
  "constraints": ["budget", "time"],
  "context": "I want to transition in the next 6 months",
  "submitted_at": "2026-03-01T10:00:00.000Z"
}
```

### Constraint codes the user can send
- `budget` — Cannot invest in paid courses
- `mobility` — Cannot relocate
- `time` — Part-time availability only
- `equipment` — Limited hardware/internet
- `accessibility` — Health or disability factors
- `language` — Non-native in target market

## Workflow Steps

### Step 1 — Webhook (Trigger)
Receive POST. Pass body to next node as `{{ $json.body }}`.

### Step 2 — Code node: Build AI Prompt
```javascript
const body = $input.first().json.body || $input.first().json;

const skills       = (body.user_skills || []).join(', ') || 'not specified';
const constraints  = (body.constraints || []).join(', ') || 'none';
const profile      = body.user_profile || {};

const systemPrompt = `You are CareerGPS Engine A — a world-class career strategist
and skills gap analyser. You receive a user's current skill set, career background,
and their target job. You return a precise, actionable JSON analysis.
Always respond with valid JSON only — no markdown, no explanation outside the JSON.`;

const userPrompt = `Analyse the skills gap for this career transition:

USER PROFILE:
- Current Role: ${body.job_title || profile.current_role || 'Unknown'}
- Education: ${body.education || 'Not specified'}
- Years of Experience: ${body.years || profile.years_experience || 'Not specified'}
- Industry: ${body.industry || profile.industry || 'Not specified'}
- Location: ${body.location || profile.location || 'Not specified'}
- Work Mode: ${body.work_mode || profile.work_mode || 'Not specified'}
- Bio / Context: ${profile.bio || body.context || 'Not provided'}

CURRENT SKILLS:
${skills}

TARGET JOB: ${body.target_job}

CONSTRAINTS: ${constraints}

ADDITIONAL CONTEXT: ${body.context || 'None'}

Return ONLY valid JSON with this exact structure:
{
  "target_job": "${body.target_job}",
  "current_level": "brief assessment of current level",
  "gap_score": <integer 0-100 — how large the gap is, 100 = very large>,
  "missing_skills": ["skill1", "skill2", "skill3", ...],
  "strengths": ["strength1", "strength2", ...],
  "report_text": "A detailed markdown report (use ##, ###, **bold**, bullet lists). Cover: Executive Summary, Current Profile Assessment, Skills Gap Analysis, Priority Learning Areas, Career Trajectory, Recommendations. Min 400 words."
}`;

return [{
  json: {
    systemPrompt,
    userPrompt,
    body
  }
}];
```

### Step 3 — OpenAI Chat node (or HTTP Request to OpenAI)
- **Model**: `gpt-4o` (recommended) or `gpt-4o-mini` for speed
- **System message**: `{{ $json.systemPrompt }}`
- **User message**: `{{ $json.userPrompt }}`
- **Temperature**: `0.4`
- **Max tokens**: `2000`
- Output: connect to next node

### Step 4 — Code node: Parse & Structure Response
```javascript
const raw     = $input.first().json.message?.content
             || $input.first().json.choices?.[0]?.message?.content
             || $input.first().json.content
             || '';

let parsed = {};
try {
  // Strip markdown fences if model wrapped in ```json ... ```
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  parsed = JSON.parse(cleaned);
} catch(e) {
  parsed = {
    target_job:     $input.first().json.body?.target_job || '',
    gap_score:      50,
    missing_skills: [],
    strengths:      [],
    report_text:    raw || 'Analysis unavailable.',
    current_level:  'Unknown'
  };
}

return [{
  json: {
    target_job:     parsed.target_job     || '',
    gap_score:      parsed.gap_score      || 0,
    missing_skills: parsed.missing_skills || [],
    strengths:      parsed.strengths      || [],
    current_level:  parsed.current_level  || '',
    report_text:    parsed.report_text    || '',
    id:             crypto.randomUUID?.() || Date.now().toString()
  }
}];
```

### Step 5 — (Optional) Supabase node: Insert gap_reports row
- Table: `gap_reports`
- Data:
  - `profile_id`: `{{ $('Step 1 Webhook').item.json.body.profile_id }}`
  - `target_job`: `{{ $json.target_job }}`
  - `missing_skills`: `{{ JSON.stringify($json.missing_skills) }}`
  - `gap_score`: `{{ $json.gap_score }}`
  - `report_text`: `{{ $json.report_text }}`
  - `status`: `submitted`

### Step 6 — Respond to Webhook node
Return the structured JSON back to the Express server.
The **"Respond to Webhook"** node body should return `{{ $json }}` (entire output of Step 4).

## Expected Response (what Express receives + returns to the browser)

```json
{
  "id": "report-uuid",
  "target_job": "DevOps Engineer",
  "gap_score": 72,
  "missing_skills": [
    "Docker", "Kubernetes", "Terraform", "CI/CD", "Linux Administration",
    "Bash scripting", "AWS fundamentals", "Monitoring (Prometheus/Grafana)",
    "Networking basics", "Ansible"
  ],
  "strengths": ["JavaScript", "React", "Git", "Problem Solving"],
  "current_level": "Junior Frontend Developer with strong web fundamentals",
  "report_text": "## Executive Summary\n\n..."
}
```

---

---

# WORKFLOW 2 — Engine B: Action Roadmap

## Webhook URL
```
https://haki.app.n8n.cloud/webhook-test/career-gps-roadmap
```

## Trigger
**Webhook node** — Method: POST, Path: `career-gps-roadmap`, Response mode: `Last node`

## Input Payload (sent by the Express backend)

```json
{
  "action": "generate_roadmap",
  "report_id": "uuid-of-gap-report",
  "profile_id": "uuid",
  "user_id": "uuid",
  "user_email": "user@example.com",
  "target_job": "DevOps Engineer",
  "missing_skills": ["Docker", "Kubernetes", "Terraform", "CI/CD", "Linux Administration"],
  "gap_count": 5,
  "job_title": "Junior Web Developer",
  "years": "3",
  "work_mode": "Hybrid",
  "location": "Paris",
  "constraints": ["time"],
  "context": "Available evenings and weekends only",
  "requested_at": "2026-03-01T10:05:00.000Z"
}
```

## Workflow Steps

### Step 1 — Webhook (Trigger)

### Step 2 — Code node: Build Roadmap Prompt
```javascript
const body       = $input.first().json.body || $input.first().json;
const skills     = (body.missing_skills || []).join(', ');
const constraints= (body.constraints || []).join(', ') || 'none';

const systemPrompt = `You are CareerGPS Engine B — an elite career coach
specialising in fast, actionable learning roadmaps. You take a list of skill
gaps and design hyper-focused 24h/48h micro-missions. Each mission is one
concrete task someone can execute immediately.
Respond ONLY with valid JSON. No markdown. No explanation outside JSON.`;

const userPrompt = `Create a personalised action roadmap for this career transition:

TARGET JOB: ${body.target_job}
CURRENT ROLE: ${body.job_title || 'Not specified'}
EXPERIENCE: ${body.years || 'Not specified'} years
WORK MODE: ${body.work_mode || 'Not specified'}
LOCATION: ${body.location || 'Not specified'}
CONSTRAINTS: ${constraints}
ADDITIONAL CONTEXT: ${body.context || 'None'}

SKILLS TO BRIDGE (ordered by priority):
${skills}

Create 8-12 micro-missions. Each mission must be a specific, executable task.
For each mission choose the most impactful skill from the list above.

Return ONLY valid JSON:
{
  "target_job": "${body.target_job}",
  "total_missions": <number>,
  "estimated_weeks": <number>,
  "missions": [
    {
      "title": "concrete mission title",
      "skill": "which skill gap this addresses",
      "timeframe": "24h" or "48h",
      "type": "build" | "watch" | "read" | "practice",
      "description": "exactly what to do — be specific (tool, URL, action)",
      "tool": "primary tool/platform (e.g. Docker Desktop, Terraform, GitHub Actions)",
      "resource": "best free resource URL",
      "url": "best free resource URL"
    }
  ],
  "report_text": "A short markdown summary of the roadmap (2-3 paragraphs)"
}`;

return [{ json: { systemPrompt, userPrompt, body } }];
```

### Step 3 — OpenAI Chat node
- **Model**: `gpt-4o` or `gpt-4o-mini`
- **Temperature**: `0.5`
- **Max tokens**: `3000`

### Step 4 — Code node: Parse Missions
```javascript
const raw = $input.first().json.message?.content
         || $input.first().json.choices?.[0]?.message?.content
         || $input.first().json.content || '';

let parsed = {};
try {
  const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  parsed = JSON.parse(cleaned);
} catch(e) {
  parsed = {
    target_job:        $input.first().json.body?.target_job || '',
    missions:          [],
    report_text:       raw || 'Roadmap unavailable.',
    total_missions:    0,
    estimated_weeks:   0
  };
}

const missions = (parsed.missions || []).map(m => ({
  title:       m.title       || 'Mission',
  skill:       m.skill       || '',
  timeframe:   m.timeframe   || '24h',
  type:        m.type        || 'build',
  description: m.description || '',
  tool:        m.tool        || '',
  resource:    m.resource    || m.url || '',
  url:         m.url         || m.resource || ''
}));

return [{
  json: {
    target_job:       parsed.target_job      || '',
    total_missions:   missions.length,
    estimated_weeks:  parsed.estimated_weeks || Math.ceil(missions.length / 3),
    missions,
    report_text:      parsed.report_text     || '',
    roadmap_id:       crypto.randomUUID?.()  || Date.now().toString()
  }
}];
```

### Step 5 — Respond to Webhook node
Return `{{ $json }}`.

## Expected Response

```json
{
  "roadmap_id": "uuid",
  "target_job": "DevOps Engineer",
  "total_missions": 10,
  "estimated_weeks": 4,
  "missions": [
    {
      "title": "Run your first Docker container",
      "skill": "Docker",
      "timeframe": "24h",
      "type": "build",
      "description": "Install Docker Desktop, pull the nginx image, run it on port 8080, then build a custom Dockerfile for a simple Node.js app.",
      "tool": "Docker Desktop",
      "resource": "https://docs.docker.com/get-started/",
      "url": "https://docs.docker.com/get-started/"
    }
  ],
  "report_text": "## Your DevOps Roadmap\n\n..."
}
```

---

---

# WORKFLOW 3 — Engine C: CV Extraction & Field Fill

## Webhook URL
```
https://haki.app.n8n.cloud/webhook-test/career-gps-cv
```

## Trigger
**Webhook node** — Method: POST, Path: `career-gps-cv`, Response mode: `Last node`

## Input Payload

```json
{
  "action": "cv_analysis_request",
  "profile_id": "uuid",
  "user_id": "uuid",
  "user_email": "user@example.com",
  "user_profile": { "email": "user@example.com" },
  "file_name": "jean_dupont_cv.pdf",
  "cv_text": "Jean Dupont\njean@email.com\n+33 6 00 00 00 00\n\nEXPERIENCE\n2022-Present: Junior Web Developer at Startup XYZ...",
  "target_job": "DevOps Engineer",
  "context": "extract_fields_for_form",
  "submitted_at": "2026-03-01T10:10:00.000Z"
}
```

> **Key field:** `context`
> - `"extract_fields_for_form"` → fast extraction only (fill the analysis form)
> - any other value (or empty) → full CV analysis report

## Workflow Steps

### Step 1 — Webhook (Trigger)

### Step 2 — IF node: Route by context
- **Condition**: `{{ $json.body.context }}` equals `extract_fields_for_form`
- **True branch** → Step 3A (Field Extraction — fast, no full report)
- **False branch** → Step 3B (Full CV Analysis — complete report)

---

### Branch A — Field Extraction

#### Step 3A — Code node: Build Extraction Prompt
```javascript
const body = $input.first().json.body || $input.first().json;

const systemPrompt = `You are a CV parser. Extract structured profile data from CV text.
Respond ONLY with valid JSON. No markdown fences. No explanation.`;

const userPrompt = `Extract structured career information from this CV:

CV TEXT:
---
${(body.cv_text || '').slice(0, 6000)}
---

TARGET JOB (if provided): ${body.target_job || 'not specified'}

Return ONLY valid JSON:
{
  "name": "full name or null",
  "email": "email or null",
  "phone": "phone or null",
  "current_role": "most recent job title or null",
  "years_experience": <integer or null>,
  "education": "highest degree + field + school, or null",
  "skills": ["skill1", "skill2", ...],
  "industry": "primary industry or null",
  "location": "city/country or null",
  "work_mode": "Remote" | "Hybrid" | "On-site" | null,
  "target_job": "suggested target role based on CV trajectory, or use the provided target if given",
  "linkedin_url": "url or null",
  "summary": "2-sentence career summary"
}`;

return [{ json: { systemPrompt, userPrompt, body } }];
```

#### Step 4A — OpenAI Chat node
- **Model**: `gpt-4o-mini` (fast + cheap for extraction)
- **Temperature**: `0.1`
- **Max tokens**: `800`

#### Step 5A — Code node: Parse & Return Fields
```javascript
const raw = $input.first().json.message?.content
         || $input.first().json.choices?.[0]?.message?.content || '';

let extracted = {};
try {
  const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  extracted = JSON.parse(cleaned);
} catch(e) {
  extracted = { summary: raw };
}

return [{
  json: {
    extracted: {
      name:             extracted.name             || null,
      email:            extracted.email            || null,
      current_role:     extracted.current_role     || null,
      years_experience: extracted.years_experience || null,
      education:        extracted.education        || null,
      skills:           extracted.skills           || [],
      industry:         extracted.industry         || null,
      location:         extracted.location         || null,
      work_mode:        extracted.work_mode        || null,
      linkedin_url:     extracted.linkedin_url     || null,
      summary:          extracted.summary          || null
    },
    target_job: extracted.target_job || '',
    report_text: null
  }
}];
```

---

### Branch B — Full CV Analysis

#### Step 3B — Code node: Build Full Analysis Prompt
```javascript
const body = $input.first().json.body || $input.first().json;

const systemPrompt = `You are CareerGPS Engine C — an expert career analyst
specialising in CV assessment and career gap analysis. You receive the raw text
of a CV, analyse the person's career trajectory, and produce both structured
extraction AND a detailed analysis report.
Respond ONLY with valid JSON. No markdown fences outside the report_text value.`;

const userPrompt = `Perform a full career analysis on this CV:

CV TEXT:
---
${(body.cv_text || '').slice(0, 8000)}
---

TARGET JOB: ${body.target_job || 'infer from CV trajectory'}
ADDITIONAL CONTEXT: ${body.context || 'none'}

Return ONLY valid JSON:
{
  "name": "full name or null",
  "current_role": "most recent job title",
  "years_experience": <integer>,
  "education": "degree + institution",
  "skills": ["skill1", ...],
  "industry": "primary industry",
  "location": "city/country",
  "work_mode": "Remote" | "Hybrid" | "On-site" | null,
  "target_job": "best target role for this profile",
  "missing_skills": ["gap1", "gap2", ...],
  "gap_score": <0-100>,
  "strengths": ["strength1", ...],
  "report_text": "Full markdown career analysis report using ##, ###, **bold**, bullets. Min 500 words. Cover: Profile Summary, Career Trajectory, Key Strengths, Skills Gap vs Target Role, Recommended Next Steps."
}`;

return [{ json: { systemPrompt, userPrompt, body } }];
```

#### Step 4B — OpenAI Chat node
- **Model**: `gpt-4o`
- **Temperature**: `0.4`
- **Max tokens**: `2500`

#### Step 5B — Code node: Parse Full Analysis
```javascript
const raw = $input.first().json.message?.content
         || $input.first().json.choices?.[0]?.message?.content || '';

let parsed = {};
try {
  const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  parsed = JSON.parse(cleaned);
} catch(e) {
  parsed = { report_text: raw };
}

return [{
  json: {
    extracted: {
      name:             parsed.name             || null,
      current_role:     parsed.current_role     || null,
      years_experience: parsed.years_experience || null,
      education:        parsed.education        || null,
      skills:           parsed.skills           || [],
      industry:         parsed.industry         || null,
      location:         parsed.location         || null,
      work_mode:        parsed.work_mode        || null
    },
    target_job:     parsed.target_job     || '',
    missing_skills: parsed.missing_skills || [],
    gap_score:      parsed.gap_score      || 0,
    strengths:      parsed.strengths      || [],
    report_text:    parsed.report_text    || ''
  }
}];
```

---

### Step 6 — Merge node
Merge output of both branches (A and B) back into one stream.

### Step 7 — Respond to Webhook node
Return `{{ $json }}`.

## Expected Response (Field Extraction mode)

```json
{
  "extracted": {
    "name": "Jean Dupont",
    "current_role": "Junior Web Developer",
    "years_experience": 3,
    "education": "BSc Computer Science — Université Paris Saclay",
    "skills": ["JavaScript", "React", "CSS", "Git", "Node.js"],
    "industry": "Fintech",
    "location": "Paris, France",
    "work_mode": "Hybrid",
    "linkedin_url": null,
    "summary": "3-year web developer with frontend focus seeking transition to backend/DevOps."
  },
  "target_job": "DevOps Engineer",
  "report_text": null
}
```

## Expected Response (Full Analysis mode)

```json
{
  "extracted": { "...": "same as above" },
  "target_job": "DevOps Engineer",
  "missing_skills": ["Docker", "Kubernetes", "Terraform", "CI/CD"],
  "gap_score": 65,
  "strengths": ["JavaScript", "React", "Problem-solving", "Git workflow"],
  "report_text": "## Profile Summary\n\nJean Dupont is a..."
}
```

---

---

# Summary: What Each Workflow Must Return

| Field | Engine A | Engine B | Engine C |
|-------|----------|----------|----------|
| `report_text` | ✅ markdown | ✅ short summary | ✅ full analysis (mode B) |
| `missing_skills` | ✅ string[] | — | ✅ string[] (mode B) |
| `gap_score` | ✅ 0-100 | — | ✅ (mode B) |
| `missions` | — | ✅ object[] | — |
| `extracted` | — | — | ✅ object |
| `target_job` | ✅ | ✅ | ✅ |
| `id` / `roadmap_id` | ✅ uuid | ✅ uuid | — |

---

# n8n Setup Checklist

1. **Create 3 workflows** in your n8n instance at `haki.app.n8n.cloud`
2. **Add Webhook trigger** to each — set Response mode to `Last node`
3. **Add "Respond to Webhook" node** as the final node in each workflow (critical — without it the HTTP call will hang)
4. **Add OpenAI credentials** in n8n Settings → Credentials → OpenAI API
5. **Test each workflow** by:
   - Opening the workflow in n8n
   - Clicking "Listen for test event" on the Webhook node
   - Triggering from the CareerGPS app
   - Verifying the response in n8n's execution log
6. **Activate workflows** when ready for production (toggle ON in n8n)
7. **Change URLs in `.env`** from `webhook-test` to `webhook`:
   ```
   N8N_WEBHOOK_URL=https://haki.app.n8n.cloud/webhook/career-gps
   N8N_ROADMAP_URL=https://haki.app.n8n.cloud/webhook/career-gps-roadmap
   N8N_CV_URL=https://haki.app.n8n.cloud/webhook/career-gps-cv
   ```
8. **Restart the Node.js server** after updating `.env`

---

# Recommended n8n Node Sequence (visual layout)

```
Engine A:
  [Webhook] → [Code: Build Prompt] → [OpenAI Chat] → [Code: Parse] → [Supabase: Insert] → [Respond to Webhook]

Engine B:
  [Webhook] → [Code: Build Prompt] → [OpenAI Chat] → [Code: Parse] → [Respond to Webhook]

Engine C:
  [Webhook] → [IF: context=extract?]
                    YES → [Code: Extraction Prompt] → [OpenAI gpt-4o-mini] → [Code: Parse fields] → [Merge] → [Respond to Webhook]
                    NO  → [Code: Full Analysis Prompt] → [OpenAI gpt-4o] → [Code: Parse full] → [Merge] → [Respond to Webhook]
```

---

*Generated for CareerGPS · March 2026*
