-- Health Connect file-import consent and phone ingest tokens for whoop-mcp.
-- DO NOT apply this to the live Supabase project as part of the source change.
-- Existing health_connect_records rows are untouched. The edge function keeps
-- every new tool and the webhook off unless the matching env flag is "true".
-- Apply supabase/migrations/20261011115000_health_connect_records.sql first.
-- The bearer secret is never stored: health_connect_ingest_tokens keeps a
-- SHA-256 hex digest only.

create table if not exists public.health_import_consent (
  user_id uuid primary key references auth.users (id) on delete cascade,
  purpose text not null check (purpose = 'health_connect_file'),
  granted_at timestamptz not null,
  withdrawn_at timestamptz
);

comment on table public.health_import_consent is
  'Per-user consent to store Health Connect records from a file import or phone ingest. Server-side only. No tokens and no health payloads.';

alter table public.health_import_consent enable row level security;
revoke all on table public.health_import_consent from public, anon, authenticated;
grant select, insert, update, delete on table public.health_import_consent to service_role;

create table if not exists public.health_connect_ingest_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  window_started_at timestamptz,
  window_hits integer not null default 0 check (window_hits >= 0)
);

create index if not exists health_connect_ingest_owner
  on public.health_connect_ingest_tokens (user_id);

-- One usable token per member. Revoked rows stay so the old digest cannot be reinserted.
create unique index if not exists health_connect_ingest_one_active
  on public.health_connect_ingest_tokens (user_id) where revoked_at is null;

comment on table public.health_connect_ingest_tokens is
  'SHA-256 hex digests of Health Connect webhook bearers. The hct_ secret is shown once and is not a column.';

alter table public.health_connect_ingest_tokens enable row level security;
revoke all on table public.health_connect_ingest_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.health_connect_ingest_tokens to service_role;

-- Disconnect deletes this member's OAuth state and stored WHOOP credentials together.
-- Tables already exist in production. The disposable smoke database has neither,
-- so the grants are skipped there. The function body is checked at call time.
do $grant$
begin
  if to_regclass('public.whoop_connections') is not null then
    grant select, delete on table public.whoop_connections to service_role;
  end if;
  if to_regclass('public.whoop_oauth_states') is not null then
    grant select, delete on table public.whoop_oauth_states to service_role;
  end if;
end
$grant$;

create or replace function public.disconnect_whoop(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to public
as $$
declare
  removed integer;
begin
  if p_user_id is null then
    raise exception 'Import unavailable';
  end if;
  delete from public.whoop_oauth_states where user_id = p_user_id;
  delete from public.whoop_connections where user_id = p_user_id;
  get diagnostics removed = row_count;
  return jsonb_build_object('disconnected', true, 'removed', removed = 1);
end;
$$;

create or replace function public.import_health_connect_records(
  p_user_id uuid,
  p_granted_at timestamptz,
  p_rows jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path to public
as $$
declare
  row jsonb;
  stored integer := 0;
begin
  if p_user_id is null or p_granted_at is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Import unavailable';
  end if;
  insert into public.health_import_consent as consent (user_id, purpose, granted_at, withdrawn_at)
  values (p_user_id, 'health_connect_file', p_granted_at, null)
  on conflict (user_id) do update
    set purpose = excluded.purpose,
        granted_at = excluded.granted_at,
        withdrawn_at = null;
  for row in select value from jsonb_array_elements(p_rows)
  loop
    insert into public.health_connect_records (
      id, user_id, metric, record_key, origin_package, observed_at, ended_at, local_date, unit, payload
    ) values (
      (row->>'id')::uuid,
      p_user_id,
      row->>'metric',
      row->>'record_key',
      row->>'origin_package',
      (row->>'observed_at')::timestamptz,
      nullif(row->>'ended_at', '')::timestamptz,
      nullif(row->>'local_date', '')::date,
      row->>'unit',
      row->'payload'
    )
    on conflict (user_id, metric, record_key) do update set
      origin_package = excluded.origin_package,
      observed_at = excluded.observed_at,
      ended_at = excluded.ended_at,
      local_date = excluded.local_date,
      unit = excluded.unit,
      payload = excluded.payload,
      updated_at = now();
    stored := stored + 1;
  end loop;
  return jsonb_build_object('stored', stored);
end;
$$;

create or replace function public.withdraw_health_connect_import(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to public
as $$
declare
  deleted integer;
  revoked integer;
begin
  if p_user_id is null then
    raise exception 'Import unavailable';
  end if;
  delete from public.health_connect_records where user_id = p_user_id;
  get diagnostics deleted = row_count;
  update public.health_import_consent
    set withdrawn_at = now()
    where user_id = p_user_id and purpose = 'health_connect_file';
  update public.health_connect_ingest_tokens
    set revoked_at = now()
    where user_id = p_user_id and revoked_at is null;
  get diagnostics revoked = row_count;
  return jsonb_build_object(
    'deleted', deleted,
    'consent', 'withdrawn',
    'source', 'health_connect',
    'ingest_tokens_revoked', revoked
  );
end;
$$;

create or replace function public.issue_health_connect_ingest_token(
  p_user_id uuid,
  p_token_hash text,
  p_granted_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path to public
as $$
declare
  replaced integer;
begin
  if p_user_id is null or p_granted_at is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Import unavailable';
  end if;
  update public.health_connect_ingest_tokens
    set revoked_at = now()
    where user_id = p_user_id and revoked_at is null;
  get diagnostics replaced = row_count;
  insert into public.health_connect_ingest_tokens (token_hash, user_id)
  values (p_token_hash, p_user_id);
  insert into public.health_import_consent (user_id, purpose, granted_at, withdrawn_at)
  values (p_user_id, 'health_connect_file', p_granted_at, null)
  on conflict (user_id) do update
    set purpose = excluded.purpose,
        granted_at = excluded.granted_at,
        withdrawn_at = null;
  return jsonb_build_object('replaced_previous', replaced > 0);
end;
$$;

create or replace function public.revoke_health_connect_ingest_tokens(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to public
as $$
declare
  revoked integer;
begin
  if p_user_id is null then
    raise exception 'Import unavailable';
  end if;
  update public.health_connect_ingest_tokens
    set revoked_at = now()
    where user_id = p_user_id and revoked_at is null;
  get diagnostics revoked = row_count;
  return jsonb_build_object('revoked', revoked);
end;
$$;

create or replace function public.consume_health_connect_ingest_rate(
  p_token_hash text,
  p_now timestamptz,
  p_max_hits integer
)
returns boolean
language plpgsql
security invoker
set search_path to public
as $$
declare
  changed integer;
  cutoff timestamptz := p_now - interval '15 minutes';
begin
  if p_max_hits is null or p_max_hits < 1 or p_now is null then
    raise exception 'Import unavailable';
  end if;
  update public.health_connect_ingest_tokens set
    window_hits = case
      when window_started_at is null or window_started_at <= cutoff then 1
      else window_hits + 1
    end,
    window_started_at = case
      when window_started_at is null or window_started_at <= cutoff then p_now
      else window_started_at
    end
  where token_hash = p_token_hash
    and revoked_at is null
    and (
      window_started_at is null
      or window_started_at <= cutoff
      or window_hits < p_max_hits
    );
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function public.upsert_health_connect_webhook_batch(
  p_user_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path to public
as $$
declare
  row jsonb;
begin
  if p_user_id is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Import unavailable';
  end if;
  for row in select value from jsonb_array_elements(p_rows)
  loop
    insert into public.health_connect_records (
      id, user_id, metric, record_key, origin_package, observed_at, ended_at, local_date, unit, payload
    ) values (
      (row->>'id')::uuid,
      p_user_id,
      row->>'metric',
      row->>'record_key',
      row->>'origin_package',
      (row->>'observed_at')::timestamptz,
      nullif(row->>'ended_at', '')::timestamptz,
      nullif(row->>'local_date', '')::date,
      row->>'unit',
      row->'payload'
    )
    on conflict (user_id, metric, record_key) do update set
      origin_package = excluded.origin_package,
      observed_at = excluded.observed_at,
      ended_at = excluded.ended_at,
      local_date = excluded.local_date,
      unit = excluded.unit,
      payload = excluded.payload,
      updated_at = now()
    where public.health_connect_records.payload->>'last_modified' is null
       or excluded.payload->>'last_modified' is null
       or excluded.payload->>'last_modified' >= public.health_connect_records.payload->>'last_modified';
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.disconnect_whoop(uuid) from public, anon, authenticated;
revoke all on function public.import_health_connect_records(uuid, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.withdraw_health_connect_import(uuid) from public, anon, authenticated;
revoke all on function public.issue_health_connect_ingest_token(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.revoke_health_connect_ingest_tokens(uuid) from public, anon, authenticated;
revoke all on function public.consume_health_connect_ingest_rate(text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.upsert_health_connect_webhook_batch(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.disconnect_whoop(uuid) to service_role;
grant execute on function public.import_health_connect_records(uuid, timestamptz, jsonb) to service_role;
grant execute on function public.withdraw_health_connect_import(uuid) to service_role;
grant execute on function public.issue_health_connect_ingest_token(uuid, text, timestamptz) to service_role;
grant execute on function public.revoke_health_connect_ingest_tokens(uuid) to service_role;
grant execute on function public.consume_health_connect_ingest_rate(text, timestamptz, integer) to service_role;
grant execute on function public.upsert_health_connect_webhook_batch(uuid, jsonb) to service_role;

comment on function public.disconnect_whoop(uuid) is
  'Delete one member''s WHOOP Lens credentials and pending OAuth states. Does not call WHOOP.';
comment on function public.issue_health_connect_ingest_token(uuid, text, timestamptz) is
  'Store a SHA-256 ingest digest, revoke the previous active digest, and grant Health Connect storage consent.';
