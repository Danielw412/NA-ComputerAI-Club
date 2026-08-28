-- 67 SPEED shared leaderboard schema
-- Run this once in the Supabase SQL Editor for the dedicated 67 SPEED project.

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  score integer not null,
  mode text not null,
  created_at timestamptz not null default now(),

  constraint scores_name_format check (name ~ '^[A-Z]{3}$'),
  constraint scores_score_range check (score between 1 and 500),
  constraint scores_mode_check check (mode in ('solo', 'duel'))
);

-- Matches the frontend query: highest score first, then oldest score for ties.
create index if not exists scores_score_created_idx
  on public.scores (score desc, created_at asc);

alter table public.scores enable row level security;

-- Start from no public table privileges, then grant only what the browser needs.
revoke all on table public.scores from anon;
revoke all on table public.scores from authenticated;

grant select (name, score, mode, created_at) on table public.scores to anon;
grant insert (name, score, mode) on table public.scores to anon;

drop policy if exists "scores_public_read" on public.scores;
create policy "scores_public_read"
  on public.scores
  for select
  to anon
  using (true);

drop policy if exists "scores_public_insert" on public.scores;
create policy "scores_public_insert"
  on public.scores
  for insert
  to anon
  with check (
    name ~ '^[A-Z]{3}$'
    and score between 1 and 500
    and mode in ('solo', 'duel')
  );

-- There are intentionally no UPDATE or DELETE grants/policies for the browser.
