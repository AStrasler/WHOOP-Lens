-- Private, user-reviewed medical context (Issue #7, Build PR 4 / draft PR #10).
-- Additive: creates one new table. Does not touch WHOOP, Samsung or Health Connect tables.
-- DO NOT apply to production until review, staging RLS test, security advisors and explicit approval.
-- Clients may only SELECT their own reviewed rows; all writes go through the
-- authenticated medical-context Edge Function (service_role), never directly.
create table public.medical_context_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('condition','medication','allergy','note')),
  detail_json jsonb not null check (
    jsonb_typeof(detail_json) = 'object' and octet_length(detail_json::text) <= 8000
  ),
  source_type text not null check (source_type in ('self_reported','provider_document')),
  source_label text check (source_label is null or length(source_label) <= 120),
  source_date date,
  reviewed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index medical_context_owner_created_idx
  on public.medical_context_entries (user_id, created_at desc);

alter table public.medical_context_entries enable row level security;
revoke all privileges on table public.medical_context_entries from public, anon, authenticated;
grant select on table public.medical_context_entries to authenticated;
grant select, insert, update, delete on table public.medical_context_entries to service_role;
create policy medical_context_owner_select on public.medical_context_entries
  for select to authenticated using ((select auth.uid()) = user_id);

comment on table public.medical_context_entries is
  'Private, explicitly user-reviewed self-reported or provider-sourced context; server writes only. No raw documents.';

-- ROLLBACK (destructive: deletes every user's saved medical context).
-- Only with explicit data-retention/deletion approval, and after the
-- medical-context function and get_medical_context tool are undeployed:
--   drop policy if exists medical_context_owner_select on public.medical_context_entries;
--   drop table if exists public.medical_context_entries;
