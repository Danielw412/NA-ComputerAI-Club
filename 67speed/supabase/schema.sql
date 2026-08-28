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

  -- Full names: first name, last name optional. Letters plus spaces, hyphens
  -- and apostrophes so real names (O'Brien, Anne-Marie) work, while markup and
  -- pasted paragraphs do not. Inappropriate entries are moderated by deleting
  -- individual rows -- a substring blocklist would reject real surnames.
  constraint scores_name_format check (
    char_length(name) between 2 and 24
    and name ~ '^[A-Za-z][A-Za-z'' -]*[A-Za-z]$'
  ),
  constraint scores_score_range check (score between 1 and 500),
  constraint scores_mode_check check (mode in ('solo', 'duel')),
  -- Only a duel can be won. Enforced as a CHECK, not just in the RLS policy,
  -- so it holds no matter which policy or role does the insert. Verified live:
  -- without this, a crafted solo row with won=true was accepted (2026-08-27).
  constraint scores_won_only_duel check (won = false or mode = 'duel')
);

-- Matches the frontend query: highest score first, then oldest score for ties.
create index if not exists scores_score_created_idx
  on public.scores (score desc, created_at asc);

-- `create table if not exists` above is a no-op on an existing table, so the
-- constraint has to be added separately when upgrading a live database.
-- This fails if violating rows exist - delete them first, that is intentional.
do $$
declare
  legacy text;
begin
  if not exists (
    select 1 from pg_constraint where conname = 'scores_won_only_duel'
  ) then
    alter table public.scores
      add constraint scores_won_only_duel check (won = false or mode = 'duel');
  end if;

  -- Upgrade the name rule from the original 3-letter initials to full names.
  -- Dropped and re-added unconditionally so re-running this file always leaves
  -- the current rule in place. Existing 3-letter rows stay valid.
  if exists (select 1 from pg_constraint where conname = 'scores_name_format') then
    alter table public.scores drop constraint scores_name_format;
  end if;

  -- Drop ANY other surviving CHECK constraint on this table that still enforces
  -- the old 3-letter initials rule. An early draft of this schema declared the
  -- rule inline on the column, so Postgres auto-named it `scores_name_check`,
  -- and a database created from that draft kept silently rejecting full names
  -- long after this file stopped mentioning it. Matching on the constraint's
  -- definition rather than a hardcoded name catches every such leftover.
  for legacy in
    select conname
    from pg_constraint
    where conrelid = 'public.scores'::regclass
      and contype = 'c'
      and conname <> 'scores_name_format'
      and pg_get_constraintdef(oid) like '%A-Z%'
  loop
    execute format('alter table public.scores drop constraint %I', legacy);
  end loop;
  alter table public.scores
    add constraint scores_name_format check (
      char_length(name) between 2 and 24
      and name ~ '^[A-Za-z][A-Za-z'' -]*[A-Za-z]$'
    );
end $$;

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
    char_length(name) between 2 and 24
    and name ~ '^[A-Za-z][A-Za-z'' -]*[A-Za-z]$'
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
-- Also case-insensitive, so a player's wins are not split across "Alex"/"alex".
-- min(name) picks one spelling to display.
create view public.win_counts with (security_invoker = on) as
  select
    min(name) as name,
    count(*)::int as wins,
    max(score)::int as best_score,
    max(created_at) as last_win
  from public.scores
  where mode = 'duel' and won
  group by lower(name);

grant select on public.win_counts to anon;

-- FASTEST board: one row per name, keeping that name's best run.
--
-- Done as a view rather than by letting the browser UPDATE an existing row.
-- Granting anon UPDATE would let anybody overwrite anybody else's score, which
-- is a far worse problem than duplicate names. The table stays append-only, so
-- every run is still recorded and nothing is destroyed; the board just shows
-- each name once.
--
-- distinct on (name) keeps the FIRST row per name under this ORDER BY, so the
-- ordering is what selects the best run: highest score, and on a tie the
-- earliest one (whoever got there first keeps it).
drop view if exists public.best_scores;
-- Matched case-insensitively: "Alex" and "alex" are one player, which is also
-- what the offline client does. The two must agree or the board appears to
-- change when the network drops.
create view public.best_scores with (security_invoker = on) as
  select distinct on (lower(name))
    name,
    score,
    mode,
    won,
    created_at
  from public.scores
  order by lower(name), score desc, created_at asc;

grant select on public.best_scores to anon;

-- There are intentionally no UPDATE or DELETE grants/policies for the browser.
