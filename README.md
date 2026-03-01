# Career GPS — Backend

## Setup

```bash
npm install
```

## Environment Variables

Create a `.env` file or set these environment variables:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-or-service-role-key
OPENAI_API_KEY=your-openai-api-key
PORT=3001
```

## Supabase Schema

Run these SQL commands in your Supabase project:

```sql
-- Market data cache table
CREATE TABLE market_data (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_title text NOT NULL,
  technical_skills jsonb,
  soft_skills jsonb,
  compagnies jsonb,
  fetched_at timestamptz DEFAULT now()
);

-- Gap reports table
CREATE TABLE gap_reports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id uuid,
  missing_skills jsonb,
  created_at timestamptz DEFAULT now()
);
```

## Run

```bash
npm run dev    # development with nodemon
npm start      # production
```

## API Endpoints

### POST /api/analyze
```json
{
  "profile_id": "cc6f70eb-9d60-4fa2-9f44-acced3fe056c",
  "user_skills": ["Linux", "Git"],
  "target_job": "DevOps Engineer"
}
```

### GET /api/reports/:profile_id
Returns all gap reports for a user.
