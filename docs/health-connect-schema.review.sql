-- PRE-DEPLOYMENT REVIEW DRAFT ONLY. Do not execute in production.
-- When approved, create an actual migration file with: supabase migration new health_connect_records
-- Then copy the reviewed SQL into the CLI-created migration and apply only after approval.
create table if not exists public.health_connect_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  metric text not null check (metric in ('steps_daily','sleep_session','heart_rate','exercise_session')),
  record_key text not null check (length(record_key) between 1 and 128),
  origin_package text,
  observed_at timestamptz not null,
  ended_at timestamptz,
  local_date date,
  unit text not null check (unit in ('steps','seconds','bpm')),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,metric,record_key),
  check (ended_at is null or ended_at >= observed_at)
);
create index if not exists health_connect_owner_observed_idx
  on public.health_connect_records(user_id,observed_at desc);
alter table public.health_connect_records enable row level security;
revoke all on table public.health_connect_records from anon, authenticated;
grant select on table public.health_connect_records to authenticated;
create policy health_connect_owner_read on public.health_connect_records
  for select to authenticated
  using ((select auth.uid()) = user_id);
comment on table public.health_connect_records is
  'Authorized per-user Health Connect measurements; server-side writes only, owner-only reads.';
-- Rollback, only after data-retention approval:
-- drop table if exists public.health_connect_records;
