-- 67 SPEED shared leaderboard schema
-- Run this once in the Supabase SQL Editor for the dedicated 67 SPEED project.

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  score integer not null,
  mode text not null,
  -- True only for the winner of a duel. Solo runs and dead heats stay false.
  -- The MOST WINS board is counted from this column.
  won boolean not null default false,
  created_at timestamptz not null default now(),

  constraint scores_name_format check (name ~ '^[A-Z]{3}$'),
  constraint scores_score_range check (score between 1 and 500),
  constraint scores_mode_check check (mode in ('solo', 'duel'))
);

-- Matches the frontend query: highest score first, then oldest score for ties.
create index if not exists scores_score_created_idx
  on public.scores (score desc, created_at asc);

alter table public.scores enable row level security;

grant usage on schema public to anon;

-- Start from no public table privileges, then grant only what the browser needs.
revoke all on table public.scores from public;
revoke all on table public.scores from anon;
revoke all on table public.scores from authenticated;

grant select (name, score, mode, won, created_at) on table public.scores to anon;
grant insert (name, score, mode, won) on table public.scores to anon;

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
    -- A solo run can never be a "win"; without this a crafted request could
    -- farm the MOST WINS board without ever playing a duel.
    and (won = false or mode = 'duel')
  );

create index if not exists scores_wins_idx on public.scores (name) where won;

-- MOST WINS board. Aggregated in the database so it stays correct as rows pile
-- up. security_invoker makes the view run with the CALLER's RLS rather than the
-- owner's, so it cannot become a way to read past the table policies above.
drop view if exists public.win_counts;
create view public.win_counts with (security_invoker = on) as
  select
    name,
    count(*)::int as wins,
    max(score)::int as best_score,
    max(created_at) as last_win
  from public.scores
  where mode = 'duel' and won
  group by name;

grant select on public.win_counts to anon;

-- There are intentionally no UPDATE or DELETE grants/policies for the browser.
