-- REVIEW ONLY. Must be put in an approved Supabase CLI-generated migration before execution.
-- Separate from WHOOP and Health Connect measurements. No public document storage.
create table if not exists public.medical_context_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('condition','medication','allergy','note')),
  detail_json jsonb not null check (jsonb_typeof(detail_json)='object'),
  source_type text not null check (source_type in ('self_reported','provider_document')),
  source_label text,
  source_date date,
  reviewed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists medical_context_owner_created_idx
  on public.medical_context_entries(user_id,created_at desc);
alter table public.medical_context_entries enable row level security;
revoke all on table public.medical_context_entries from anon,authenticated;
grant select on table public.medical_context_entries to authenticated;
create policy medical_context_owner_select on public.medical_context_entries
  for select to authenticated using ((select auth.uid()) = user_id);
comment on table public.medical_context_entries is
  'Private, explicitly user-reviewed self-reported or provider-sourced context; server writes only.';
-- Rollback only with retention and deletion approval: drop table public.medical_context_entries;
