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
