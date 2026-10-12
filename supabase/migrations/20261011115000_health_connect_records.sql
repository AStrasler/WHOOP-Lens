-- Reviewed, additive Health Connect schema candidate. DO NOT apply to production
-- until migration, security advisor, rollback and private beta release approval.
-- This migration only creates a new table. Legacy samsung_health_records is untouched.
create table public.health_connect_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  metric text not null check (metric in ('steps_daily','sleep_session','heart_rate','exercise_session')),
  record_key text not null check (record_key ~ '^[A-Za-z0-9_.:+-]{1,128}$'),
  origin_package text check (origin_package is null or length(origin_package) <= 160),
  observed_at timestamptz not null,
  ended_at timestamptz,
  local_date date,
  unit text not null,
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hc_metric_unit_check check (
    (metric = 'steps_daily' and unit = 'steps') or
    (metric in ('sleep_session','exercise_session') and unit = 'seconds') or
    (metric = 'heart_rate' and unit = 'bpm')
  ),
  constraint hc_dates_check check (ended_at is null or ended_at >= observed_at),
  constraint hc_owner_metric_record_unique unique (user_id,metric,record_key)
);
create index health_connect_owner_date_idx on public.health_connect_records
  (user_id, observed_at desc, record_key desc);
alter table public.health_connect_records enable row level security;
-- Authenticated clients can SELECT their own rows. They cannot write directly.
revoke all on table public.health_connect_records from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select on table public.health_connect_records to authenticated;
-- The authorized edge function verifies the bearer, derives user_id from Auth,
-- then performs server-side writes. No service-role credential is ever in Android.
grant select, insert, update, delete on table public.health_connect_records to service_role;
create policy health_connect_select_own on public.health_connect_records
  for select to authenticated
  using ((select auth.uid()) = user_id);
comment on table public.health_connect_records is
  'Private per-user Health Connect records, separately sourced from Samsung SDK; server writes only.';
-- CAUTION: rollback drops users' measurements. Obtain explicit data-retention
-- approval before using: DROP TABLE public.health_connect_records;
