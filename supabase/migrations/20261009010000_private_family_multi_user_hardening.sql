-- Family/private multi-user hardening for WHOOP Lens.
-- All users share the same tables and are separated by user_id + RLS.
-- The Edge Function uses service_role for server-side writes.

alter table public.whoop_connections enable row level security;
alter table public.whoop_recovery enable row level security;
alter table public.whoop_sleep enable row level security;
alter table public.whoop_members enable row level security;
alter table public.whoop_oauth_states enable row level security;
alter table public.samsung_health_records enable row level security;
alter table public.whoop_waitlist enable row level security;

-- Recovery and sleep are read-only to signed-in clients.
revoke all privileges on table public.whoop_recovery from anon;
revoke all privileges on table public.whoop_sleep from anon;

revoke all privileges on table public.whoop_recovery from authenticated;
revoke all privileges on table public.whoop_sleep from authenticated;
grant select on table public.whoop_recovery to authenticated;
grant select on table public.whoop_sleep to authenticated;

-- Samsung Health rows are also client read-only; writes stay server-side.
revoke all privileges on table public.samsung_health_records from anon;
revoke all privileges on table public.samsung_health_records from authenticated;
grant select on table public.samsung_health_records to authenticated;

-- Connection secrets, membership controls, OAuth state, and waitlist intake
-- are server-side only.
revoke all privileges on table public.whoop_connections from anon, authenticated;
revoke all privileges on table public.whoop_members from anon, authenticated;
revoke all privileges on table public.whoop_oauth_states from anon, authenticated;
revoke all privileges on table public.whoop_waitlist from anon, authenticated;

-- OAuth state lookups/cleanup stay efficient as the private user count grows.
create index if not exists whoop_oauth_states_user_id_idx
  on public.whoop_oauth_states (user_id);
create index if not exists whoop_oauth_states_expires_at_idx
  on public.whoop_oauth_states (expires_at);

comment on table public.whoop_connections is
  'Shared multi-user table. One row per Supabase user; server-side only because it contains encrypted WHOOP credentials.';
comment on table public.samsung_health_records is
  'Shared multi-user table. Rows are scoped by Supabase user_id; authenticated clients can read only their own rows through RLS.';
