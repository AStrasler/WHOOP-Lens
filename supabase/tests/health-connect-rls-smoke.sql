\set ON_ERROR_STOP on
-- Disposable PostgreSQL smoke environment, never real WHOOP records.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$fn$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
insert into auth.users values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

\ir ../migrations/20261011115000_health_connect_records.sql
\ir ../migrations/20261013120000_health_connect_consent_and_ingest.sql

-- Verify least-privilege SQL grants and owner-only SELECT.
do $test$
begin
  if has_table_privilege('anon','public.health_connect_records','SELECT') then
    raise exception 'anon unexpectedly has SELECT';
  end if;
  if has_table_privilege('authenticated','public.health_connect_records','INSERT') or
     has_table_privilege('authenticated','public.health_connect_records','UPDATE') or
     has_table_privilege('authenticated','public.health_connect_records','DELETE') then
    raise exception 'authenticated client has direct writes';
  end if;
  if not has_table_privilege('authenticated','public.health_connect_records','SELECT') then
    raise exception 'owner SELECT grant missing';
  end if;
  if (select not relrowsecurity from pg_class where oid = 'public.health_connect_records'::regclass) then
    raise exception 'RLS disabled';
  end if;
end
$test$;

set role service_role;
insert into public.health_connect_records
(user_id,metric,record_key,observed_at,local_date,unit,payload)
values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','steps_daily','daily:2026-10-10:local','2026-10-10T05:00:00Z','2026-10-10','steps','{"count":4100}'::jsonb),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','steps_daily','daily:2026-10-10:local','2026-10-10T05:00:00Z','2026-10-10','steps','{"count":9999}'::jsonb);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
do $test$
declare row_count int; actual_count int;
begin
  select count(*), max((payload->>'count')::int) into row_count, actual_count
    from public.health_connect_records;
  if row_count <> 1 or actual_count <> 4100 then
    raise exception 'user A sees another user or cannot read own rows';
  end if;
  begin
    insert into public.health_connect_records
      (user_id,metric,record_key,observed_at,unit,payload)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','heart_rate','no-write','2026-10-10T05:00:00Z','bpm','{"bpm":60}');
    raise exception 'unauthorized direct write succeeded';
  exception when insufficient_privilege then null;
  end;
end
$test$;

select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false);
do $test$
declare row_count int; actual_count int;
begin
  select count(*), max((payload->>'count')::int) into row_count, actual_count
    from public.health_connect_records;
  if row_count <> 1 or actual_count <> 9999 then
    raise exception 'user B sees another user or cannot read own rows';
  end if;
end
$test$;
reset role;

-- Verified replay semantics: same owner/metric/key updates rather than duplicates.
set role service_role;
insert into public.health_connect_records
(user_id,metric,record_key,observed_at,local_date,unit,payload)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','steps_daily','daily:2026-10-10:local','2026-10-10T05:00:00Z','2026-10-10','steps','{"count":4500}')
on conflict (user_id,metric,record_key) do update
  set payload=excluded.payload;
reset role;
do $test$
begin
  if (select count(*) from public.health_connect_records) <> 2 then
    raise exception 'idempotent import inserted a duplicate row';
  end if;
end $test$;
select 'Health Connect RLS owner isolation, grants and replay verified' as smoke_result;

-- Ingest tokens store a SHA-256 digest only. Clients cannot read or write them.
do $test$
begin
  if has_table_privilege('anon','public.health_connect_ingest_tokens','SELECT')
     or has_table_privilege('authenticated','public.health_connect_ingest_tokens','SELECT')
     or has_table_privilege('anon','public.health_import_consent','SELECT')
     or has_table_privilege('authenticated','public.health_import_consent','SELECT') then
    raise exception 'client role can read ingest secrets or consent';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'health_connect_ingest_tokens'
      and column_name in ('token','bearer','secret','header_value')
  ) then
    raise exception 'plaintext ingest token column exists';
  end if;
  if (select not relrowsecurity from pg_class where oid = 'public.health_connect_ingest_tokens'::regclass)
     or (select not relrowsecurity from pg_class where oid = 'public.health_import_consent'::regclass) then
    raise exception 'ingest RLS disabled';
  end if;
end
$test$;

set role authenticated;
do $test$
begin
  begin
    perform public.issue_health_connect_ingest_token(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '2026-10-13T03:00:00Z'
    );
    raise exception 'authenticated client issued an ingest token';
  exception when insufficient_privilege then null;
  end;
end
$test$;
reset role;

set role service_role;
select public.issue_health_connect_ingest_token(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  '2026-10-13T03:00:00Z'
);
select public.issue_health_connect_ingest_token(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  '2026-10-13T03:00:00Z'
);
select public.upsert_health_connect_webhook_batch(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  jsonb_build_array(jsonb_build_object(
    'id','11111111-1111-4111-8111-111111111111',
    'metric','steps_daily',
    'record_key','hc:step-1',
    'origin_package','com.sec.android.app.shealth',
    'observed_at','2026-10-12T00:00:00Z',
    'ended_at','2026-10-13T00:00:00Z',
    'local_date','2026-10-12',
    'unit','steps',
    'payload', jsonb_build_object('count',250,'ingest','hc_webhook','last_modified','2026-10-13T02:00:00.000Z')
  ))
);
select public.upsert_health_connect_webhook_batch(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  jsonb_build_array(jsonb_build_object(
    'id','22222222-2222-4222-8222-222222222222',
    'metric','steps_daily',
    'record_key','hc:step-1',
    'origin_package','com.sec.android.app.shealth',
    'observed_at','2026-10-12T00:00:00Z',
    'ended_at','2026-10-13T00:00:00Z',
    'local_date','2026-10-12',
    'unit','steps',
    'payload', jsonb_build_object('count',1,'ingest','hc_webhook','last_modified','2026-10-13T01:00:00.000Z')
  ))
);
do $test$
declare actual int; active_count int;
begin
  select (payload->>'count')::int into actual
    from public.health_connect_records
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and record_key = 'hc:step-1';
  if actual <> 250 then
    raise exception 'stale webhook upsert replaced a newer row';
  end if;
  select count(*) into active_count from public.health_connect_ingest_tokens
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and revoked_at is null;
  if active_count <> 1 then
    raise exception 'expected one active ingest token';
  end if;
  begin
    insert into public.health_connect_ingest_tokens (token_hash, user_id)
    values ('zzzz', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'plaintext digest was stored';
  exception when check_violation or unique_violation then null;
  end;
end
$test$;

select public.issue_health_connect_ingest_token(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  '2026-10-13T04:00:00Z'
);
do $test$
declare active_count int; first_revoked timestamptz;
begin
  select count(*) into active_count from public.health_connect_ingest_tokens
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and revoked_at is null;
  if active_count <> 1 then
    raise exception 'rotation left more than one active token';
  end if;
  select revoked_at into first_revoked from public.health_connect_ingest_tokens
    where token_hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  if first_revoked is null then
    raise exception 'rotated digest stayed active';
  end if;
end
$test$;

select public.withdraw_health_connect_import('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
do $test$
declare a_rows int; b_rows int; a_active int; b_active int;
begin
  select count(*) into a_rows from public.health_connect_records
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  select count(*) into b_rows from public.health_connect_records
    where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  select count(*) into a_active from public.health_connect_ingest_tokens
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and revoked_at is null;
  select count(*) into b_active from public.health_connect_ingest_tokens
    where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and revoked_at is null;
  if a_rows <> 0 or b_rows <> 1 or a_active <> 0 or b_active <> 1 then
    raise exception 'withdrawal crossed accounts or left an active token';
  end if;
end
$test$;
reset role;

\ir ../migrations/20261013120000_health_connect_consent_and_ingest.sql
do $test$
declare b_active int;
begin
  select count(*) into b_active from public.health_connect_ingest_tokens
    where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and revoked_at is null;
  if b_active <> 1 then
    raise exception 'reapplying the ingest migration removed a token';
  end if;
end
$test$;
select 'Health Connect consent, ingest token and webhook upsert verified' as smoke_result;
